// Ask PromptWorkx — Cloudflare Worker
// Sits between the front-end panel and the Anthropic API.
// Secrets (never hardcoded — set via `wrangler secret put`):
//   ANTHROPIC_API_KEY        — Anthropic Console API key
//   RESEND_API_KEY           — email-sending provider for lead notifications
//   LEAD_NOTIFY_EMAIL        — where lead emails get sent (chris@promptworkx.com)
//   TWILIO_ACCOUNT_SID       — Twilio Console main dashboard
//   TWILIO_AUTH_TOKEN        — Twilio Console main dashboard (behind "show" toggle)
//   TWILIO_VERIFY_SERVICE_SID — Verify → Services → your Service's SID (starts VA...)
// Bindings (set in wrangler.toml):
//   ASK_LOGS            — KV namespace for query/lead logging
//                          (also holds phone/email verification state —
//                          awaitingverify:*, awaitingemailverify:*, and
//                          their *attempts:* counters — no separate binding)
//                          — plus, since the 23 August 2026 lead-email
//                          redesign (verification is now a GATE, not a
//                          trust bonus): pendinglead:* (captured lead info,
//                          held until verification succeeds) and
//                          verifiedpending:* (tracks conversation activity
//                          after the lead email fires, so the scheduled()
//                          cron below can send a short follow-up if the
//                          visitor keeps talking).
//                          — plus, since the 24 August 2026 Custom AI Tours
//                          proof-of-mechanic build: tour:* (tour records —
//                          see TOUR_DESTINATIONS below), rasession:* (short-
//                          lived Responsible Authority sessions, used by the
//                          raw-API tour-creation path only), and
//                          ratourpinfails:global (the ORIGINAL single-PIN
//                          lockout counter — still present for backward
//                          compatibility with that raw-API path, superseded
//                          for the in-chat flow below).
//                          — plus, since the 25 August 2026 multi-RA "Book
//                          Tour" build: ra:<email> (one record per
//                          Responsible Authority — name/email/phone/
//                          hashed PIN), rapin:<pinHash> (PIN-hash -> email,
//                          the actual identification lookup), bookflow:*
//                          (in-progress "Book Tour" chat state per browser
//                          session), and rabookfails:<sessionId> (PER-
//                          SESSION PIN lockout for the in-chat flow — see
//                          that section's header for why this is scoped
//                          differently to the original ratourpinfails:global).
//                          — plus, since the 27 August 2026 LiveAsk UI Panel
//                          Upgrade v3 (`+` menu / Admin / Secondary Input
//                          Layer / Manage Tours / Manage Quick Menu) build:
//                          adminsession:<sessionId> (an authenticated RA's
//                          Admin-surface session — same lifetime/shape as
//                          rasession: above, but reached via the NEW,
//                          dedicated body.adminAuth/body.adminAction request
//                          shapes rather than through `messages` at all — see
//                          that section's header comment for why this is a
//                          deliberately SEPARATE mechanism from Book Tour's
//                          in-chat PIN step, not a reuse of bookflow:'s state
//                          machine). Reuses rabookfails:<sessionId> and its
//                          existing lockout functions unchanged for Admin's
//                          own PIN attempts — same primitive, second caller,
//                          not a parallel lockout mechanism. Also
//                          quickmenuitem:<id> (one record per Customer Quick
//                          Menu entry — RA-managed via Manage Quick Menu,
//                          rendered to every visitor in the public `+` menu's
//                          Customer section; no TTL, permanent until
//                          RA-deleted).
// Secrets — also requires (same rule as the others: `wrangler secret put`,
// never hardcoded):
//   RA_PIN_HASH         — SHA-256 hex hash of the Custom AI Tours
//                          Responsible Authority PIN. Never store the raw
//                          PIN anywhere. See hashPin()/validateRaPin() below
//                          for exactly how this is computed and compared.
// Also requires a [triggers] crons entry in wrangler.toml — see the
// scheduled() export near the bottom of this file for what it runs.

import { SYSTEM_PROMPT } from './system-prompt.js';
import { renderLeadEmail } from './email-template.js';

const ALLOWED_ORIGIN = 'https://promptworkx.com';
const RATE_LIMIT_PER_MINUTE = 8; // per visitor (by a rough session id), generous but not abusable
const MAX_TURNS = 16; // hard cap on a single conversation's length — raised from 12, which cut off legitimate follow-up questions right after a lead was already captured

// ---- Sender branding (added 26 August 2026, direct request from Chris) ----
// Every outbound email used to say "Ask PromptWorkx <leads@promptworkx.com>"
// in the visible sender name — a leftover from before LiveAsk existed as its
// own named product. Chris's call, reasoned through directly rather than
// applied reflexively: the chat widget itself already visibly brands as
// "PROMPTWORKX LIVEASK AI" to every visitor (see the "who" span in
// liveask-widget.js), and LiveAsk already has a hard-won SMS Sender ID of
// "LiveAsk" — an email from anything else would be the actual inconsistency,
// not the other way around. Applies to every email this file sends (lead
// notifications, verification codes, tour confirmations, tour outcome
// reports, and the new site-wide chat-copy feature) — one shared constant so
// a future rebrand only ever needs changing in one place. Deliberately only
// the DISPLAY NAME changes, not the actual address — Resend can only send
// from a DNS-verified domain, and leads@promptworkx.com is already verified;
// a real "send as name@theirdomain.com" per future white-label client is a
// genuine future feature (their own DNS work), not something to fake here.
const EMAIL_FROM = '"LiveAsk" <leads@promptworkx.com>';

// Platform-owner visibility (added 26 August 2026, direct request from
// Chris — "I want chris@promptworkx to always get copies of everything for
// now"). BCC, never CC — Chris was explicit that no other recipient should
// see or be able to tell he's getting a copy too. Reuses LEAD_NOTIFY_EMAIL
// (already documented at the top of this file as chris@promptworkx.com)
// rather than a second hardcoded address, so the two can never silently
// drift apart. This is stage 1 of the staged monitoring approach discussed
// with Chris (individual BCC'd emails now; a digest once volume grows; a
// real dashboard once there's a genuine case for one) — see the platform
// monitoring discussion for the fuller picture. Once real business-site
// clients exist, THEIR owner gets their own copies via this same mechanism,
// pointed at their own address instead — flagged for later documentation,
// not solved now.
function platformBcc(env) {
  return (env.LEAD_NOTIFY_EMAIL || 'chris@promptworkx.com').trim();
}

// ---- Custom AI Tours (added 24 August 2026, Phase 0-2 proof-of-mechanic
// build) ----
// See LiveAsk_Custom_AI_Tours_MASTER_SPEC.md. Deliberately scoped down from
// the full spec for this first PromptWorkx testbed pass, per direct
// discussion with Chris and Charlie's product-boundary review the same
// evening:
//   - LINK_PRIVATE only — no guest phone/email verification gates tour
//     access. Possessing the tour link is sufficient, same as any shared
//     URL. The EXISTING Contact-capture verification (Twilio/email OTP)
//     above is completely separate and untouched — it still applies
//     normally if a tour guest goes on to volunteer contact info
//     mid-conversation, same as any other visitor.
//   - Storage is the EXISTING ASK_LOGS KV namespace (tour:* keys), not D1 —
//     a deliberate prototype choice per the spec's own "prototype
//     exception," revisit once real tour-management needs (list/revoke
//     across many tours) actually exist.
//   - Single Responsible Authority (Chris) originally — extended 25 August
//     2026 to a small RA directory (see "Multi-RA directory" section below)
//     once Chris confirmed he wants named colleagues able to book tours of
//     their own, each identified by their own PIN rather than one shared
//     secret. Still no roles/permissions beyond "is a registered RA" —
//     nothing here distinguishes an RA's permissions from any other RA's.
//   - Natural-language tour authoring (the RA describing a tour in plain
//     English) is NOT built yet — tour creation takes a fixed destination
//     choice from TOUR_DESTINATIONS below instead. That authoring layer
//     needs live prompt iteration with Chris present, same as the Quick
//     Replies reliability work did — not something to build blind.
//   - The GO_TO page-move action fires on a WORKER-DECIDED turn (the first
//     real message after the guest consents), not a model-decided one —
//     a deliberate departure from the <lead>/<quickreplies> pattern
//     elsewhere in this file, where the model decides both whether and
//     what. Moving a visitor's browser is exactly the kind of thing that
//     shouldn't depend on the model reliably remembering to ask for it on
//     the right turn — the WHEN is deterministic code; the WHAT (the actual
//     explanation text accompanying the move) stays fully generative, per
//     the spec's "stored intent + governed actions + generative
//     conversation" principle.
//   - The frontend action-dispatcher that actually reads this action field
//     and moves the page is NOT wired yet — held back pending a live
//     deploy/check of today's separate widget-consolidation change before
//     building more on top of it. This Worker-side contract is designed to
//     be consumed by that dispatcher once it exists, and is independently
//     testable without it (see test_tours.js).

const TOUR_EXPIRY_SECONDS = 60 * 60 * 24 * 7; // 7 days — one of the spec's example expiry options
const RA_SESSION_TTL_SECONDS = 60 * 30; // 30 min — RA shouldn't need to re-enter the PIN on every message within one authoring sitting
const RA_PIN_LOCKOUT_THRESHOLD = 5; // same shape as the existing Twilio/email verify-attempts lockout elsewhere in this file
const RA_PIN_LOCKOUT_TTL_SECONDS = 60 * 15;
// ---- Admin surface (added 27 August 2026, LiveAsk UI Panel Upgrade v3) ----
// Same 30-minute "one authoring sitting" reasoning as RA_SESSION_TTL_SECONDS
// above — an RA moving between Create Tour / Manage Tours / Manage Quick
// Menu within one Admin sitting shouldn't need to re-PIN between each.
const ADMIN_SESSION_TTL_SECONDS = 60 * 30;

// ---- PIN redaction (added 25 August 2026) ----
// Real live-test find: the RA's PIN never reaches Claude on the exact turn
// it's typed — that part of the "Book Tour" state machine below was always
// built and tested that way (AWAITING_PIN returns a deterministic reply
// directly, never calling callClaude). What wasn't caught until Chris
// spotted his own PIN sitting in a pasted chat transcript: this site is
// fully stateless — the browser resends the ENTIRE conversation-so-far on
// every request — so without this, the turn right after the PIN prompt
// would still ride along inside `messages` on every LATER request too, and
// eventually reach Claude the moment ordinary chatting resumed. This is
// the backend half of the fix — a defense-in-depth backstop that holds
// regardless of what any given frontend build sends, so it does not rely
// on liveask-widget.js (the other, primary half — see its own header
// comment) having gotten its part right. Applied at every point `messages`
// (or a transcript derived from it) is handed to a real Claude API call —
// see callClaude and attemptQuickReplyCorrection's call sites below.
//
// Deliberately scoped to the PIN ONLY, not the separate phone/email
// verification codes elsewhere in this file — direct decision from Chris:
// a visitor seeing their own just-received verification code echoed back
// is useful, reassuring UX for a single-use value with no standing
// authority attached; an RA's PIN is a real, reusable credential and
// needs to go nowhere near Claude's eyes, ever, on any later turn.
const PIN_PROMPT_TEXT = "Sure — what's your PIN?";
function redactPinFromMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  let redacted = false;
  const out = messages.map((m, i) => {
    const prev = messages[i - 1];
    if (prev && prev.role === 'assistant' && prev.content === PIN_PROMPT_TEXT && m.role === 'user') {
      redacted = true;
      return { ...m, content: '[RA PIN entered — redacted before reaching Claude]' };
    }
    return m;
  });
  return redacted ? out : messages; // no-op fast path — avoids an unnecessary copy on the overwhelming majority of requests, which never contain a PIN turn at all
}

// ---- Site-wide "Get a copy of your chat" trigger (added 26 August 2026,
// direct request from Chris) ----
// Must match liveask-widget.js's own copy of this exact string — same
// "one fixed string both sides check for" pattern as PIN_PROMPT_TEXT above.
// Deliberately worded as something the VISITOR would plausibly have said
// (first person), not an instruction like the button's own on-screen label
// ("Click here to...") — this text also renders as their own visible chat
// bubble when clicked, see submitToPanel's showVisitorBubble handling.
const CHAT_COPY_TRIGGER = "Get a copy of my chat";
function isChatCopyTrigger(text) {
  return (text || '').trim().toLowerCase() === CHAT_COPY_TRIGGER.toLowerCase();
}

// Approved semantic destinations — the AI (and the RA, at tour-creation
// time) may only ever refer to a tour destination by one of these names,
// never a raw CSS selector (spec Section 20/23). Frontend maps each name to
// the real DOM target once the widget's action-dispatcher is wired.
// Every destination now carries `page` (the real site path it lives on —
// '/' for the homepage) and `picker` (a short button label for the RA
// destination-picker below — the full `label` sentence is too long for a
// button). Added 25 August 2026 alongside the first genuine CROSS-PAGE
// destination (LIVEASK_PAGE_HERO) — until now every destination lived on
// the homepage, so nothing needed to track which page it was on. See
// "page-hop" handling in fetch()'s Book Tour flow and in
// buildTourContextNote/buildTourGreeting/buildTourConsentContext below for
// where `page` actually gets used.
// `selector` (added 26 August 2026, alongside the Tour Outcome Report) is
// the real DOM anchor for this destination — kept in sync BY HAND with
// TOUR_DESTINATION_SELECTORS in liveask-widget.js (same duplication that
// file's own header comment already flags for `page`/`selector` generally).
// Backend never uses this to move anyone's page itself (that's still the
// frontend dispatcher's job) — it exists purely so a real navigable
// `${ALLOWED_ORIGIN}${page}${selector}` link can be built for an email a
// guest or RA might open in a fresh tab, with no live conversation state to
// hand it a scroll target the way handleTourAction does in-page. See
// buildDestinationLink below.
const TOUR_DESTINATIONS = {
  LIVEASK_SECTION: {
    label: 'the LiveAsk section on the PromptWorkx homepage',
    // What the model is told about this destination when building the
    // consent-turn explanation prompt — kept short and factual, not
    // marketing copy, since the model still writes the actual sentence.
    context: 'This is the section on the PromptWorkx homepage introducing LiveAsk — the same AI conversation technology the guest is talking to right now, demonstrated live on PromptWorkx itself before being explored further on LiveAsk.au.',
    page: '/',
    picker: 'LiveAsk',
    selector: '#liveask-pillar'
  },
  // Added 24 August 2026 alongside multi-stop tour support — real element
  // ids confirmed present in index.html, previously unused for this.
  GENSEEN_SECTION: {
    label: 'the GenSeen section on the PromptWorkx homepage',
    context: 'This is the section introducing GenSeen, PromptWorkx\'s AI visibility suite — GenCheck (an audit of what AI currently says about a business), GenGrid (the structural fix so AI can find and understand it), and GenGuard (ongoing monitoring).',
    page: '/',
    picker: 'GenSeen',
    selector: '#genseen-pillar'
  },
  ABOUT_SECTION: {
    label: 'the About section on the PromptWorkx homepage',
    context: 'This is PromptWorkx\'s About section — who runs it and the two-pillar philosophy (get you seen, get you leads) behind how the business approaches AI visibility and adoption work.',
    page: '/',
    picker: 'About',
    selector: '#about'
  },
  // Added 25 August 2026 — the first real CROSS-PAGE destination, a direct
  // request from Chris to prove the page-hop mechanism actually works, not
  // just scroll within one page. Lands on the dedicated LiveAsk product
  // page's hero section (a new `id="liveask-page-hero"` added there for
  // exactly this — see the matching frontend selector).
  LIVEASK_PAGE_HERO: {
    label: 'the LiveAsk product page',
    context: 'This is PromptWorkx\'s dedicated LiveAsk page — a deeper, standalone look at LiveAsk specifically (pricing, how it works, what it looks like on a real site), separate from the shorter homepage section already covered.',
    page: '/liveask',
    picker: 'LiveAsk page — Hero',
    selector: '#liveask-page-hero'
  }
};

// Builds a real, openable URL for a destination — used by the Tour Outcome
// Report (and the site-wide chat-copy email, when a guest's chat touched a
// tour) to give the recipient a working link back to the exact place on the
// site something was discussed, per Chris's "maximises engagement/
// re-conversion" reasoning. '/' normalizes to a bare trailing slash before
// the anchor so this never produces the doubled-up 'https://promptworkx.com#...'
// shape (no slash at all between origin and anchor).
function buildDestinationLink(destKey) {
  const dest = TOUR_DESTINATIONS[destKey];
  if (!dest) return null;
  const pagePath = dest.page === '/' ? '/' : dest.page;
  return `${ALLOWED_ORIGIN}${pagePath}${dest.selector}`;
}

// Canonical order the RA destination-picker offers these in (see the
// AWAITING_DESTINATIONS step of the Book Tour flow below) — NOT an
// auto-applied default any more. Until 25 August 2026 this WAS a fixed,
// non-negotiable itinerary every chat-booked tour used automatically; it's
// now purely presentation order for the picker, since the RA chooses their
// own ordered subset instead.
const TOUR_DESTINATION_ORDER = ['LIVEASK_SECTION', 'GENSEEN_SECTION', 'ABOUT_SECTION', 'LIVEASK_PAGE_HERO'];

// Extra system-prompt instruction appended whenever a stop's destination
// lives on a different real page than the homepage — so the model can
// mention the page move plainly ("we'll hop over to our LiveAsk page for
// this") rather than the guest's browser just silently navigating out from
// under them. Returns '' for an ordinary same-page (homepage) destination.
function pageMoveNote(destKey) {
  const dest = TOUR_DESTINATIONS[destKey];
  if (!dest || dest.page === '/') return '';
  return ` Reaching this stop means moving to a different page on the site (${dest.page}), not just scrolling — mention that plainly as a natural part of your explanation (e.g. "we'll hop over to our LiveAsk page for this").`;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return corsResponse(new Response(null, { status: 204 }));
    if (request.method !== 'POST') return corsResponse(new Response('Not found', { status: 404 }));

    let body;
    try {
      body = await request.json();
    } catch {
      return corsResponse(jsonResponse({ error: 'Bad request' }, 400));
    }

    // ---- Custom AI Tours: RA auth + tour creation (added 24 August 2026) ----
    // Both are entirely separate request shapes from an ordinary chat turn —
    // handled and returned early, before the sessionId/messages validation
    // below, since neither one is a chat turn at all. See the RA-auth and
    // tour-storage helper functions (handleTourAuth/handleTourCreate) near
    // the bottom of this file for the full "why".
    if (typeof body.tourAuth === 'string') {
      const result = await handleTourAuth(env, ctx, body.tourAuth);
      return corsResponse(jsonResponse(result, result.ok ? 200 : 401));
    }
    if (body.tourAction === 'create') {
      const result = await handleTourCreate(env, ctx, {
        raSessionToken: body.raSessionToken,
        guestName: body.guestName,
        destination: body.destination,
        destinations: body.destinations
      });
      return corsResponse(jsonResponse(result, result.ok ? 200 : 400));
    }

    // ---- Admin / Secondary Input Layer (added 27 August 2026, LiveAsk UI
    // Panel Upgrade v3) ----
    // Same "entirely separate request shape, handled and returned early,
    // before the ordinary chat-turn validation below" pattern as tourAuth/
    // tourAction above — none of these are chat turns, and body.adminAuth in
    // particular must NEVER touch `messages`/conversationHistory (see
    // handleAdminAuth's own header comment for why that's the whole point of
    // this being a dedicated field rather than an in-chat trigger phrase like
    // "book tour").
    if (body.adminAuth && typeof body.adminAuth === 'object') {
      const result = await handleAdminAuth(env, ctx, body.adminAuth.sessionId, body.adminAuth.pin);
      return corsResponse(jsonResponse(result, result.ok ? 200 : 401));
    }
    if (body.adminAction && typeof body.adminAction === 'object') {
      const result = await handleAdminAction(env, ctx, body.adminAction);
      return corsResponse(jsonResponse(result, result.ok ? 200 : 400));
    }
    // Public — no admin auth required. Every visitor's `+` menu needs this
    // to render the Customer Quick Menu section (Section 6), not just an
    // authenticated RA managing it.
    if (body.getQuickMenu === true) {
      const items = await listQuickMenuItems(env);
      return corsResponse(jsonResponse({ ok: true, items }));
    }
    // Give feedback (Section 5.1.C) — its own request shape for the same
    // reason as Admin above: this is LiveAsk product/experience feedback,
    // not a business enquiry, and must never be interpretable as one by
    // riding through the ordinary conversation path.
    if (body.giveFeedback && typeof body.giveFeedback === 'object') {
      const result = await handleGiveFeedback(env, ctx, body.giveFeedback);
      return corsResponse(jsonResponse(result, result.ok ? 200 : 400));
    }
    // Restart Tour (Section 5.1.D) — resets THIS session's own tourprogress
    // record only; never touches the tour definition or any other visitor's
    // progress on a shared "Multiple" link. See handleRestartTour.
    if (body.restartTour === true) {
      const result = await handleRestartTour(env, ctx, body.sessionId, body.tourToken);
      return corsResponse(jsonResponse(result, result.ok ? 200 : 400));
    }

    const { sessionId, messages, tourToken } = body;
    // messages: [{ role: 'user' | 'assistant', content: string }, ...] — full thread so far, sent fresh each turn (stateless)

    // A tour guest's very first request after opening the link has nothing
    // to send yet — it's a ping to collect the fixed greeting, not a reply
    // to anything — so an empty messages array is valid ONLY in that one
    // specific case, never otherwise.
    const isTourFirstContact = !!tourToken && Array.isArray(messages) && messages.length === 0;

    if (!sessionId || !Array.isArray(messages) || (messages.length === 0 && !isTourFirstContact)) {
      return corsResponse(jsonResponse({ error: 'Bad request' }, 400));
    }

    // ---- Site-wide "Get a copy of your chat" (added 26 August 2026, direct
    // request from Chris) ----
    // Deliberately checked here, before EVERYTHING else — including the
    // tour state machine right below — because this has to work mid-tour
    // exactly as well as in an ordinary conversation (Chris: "site-wide —
    // any conversation"), so it can't live inside, or depend on, either
    // state machine further down. Three fixed, code-authored steps, no
    // Claude call at any point for the mechanics themselves (see
    // sendChatCopyEmail below for the one place a lightweight AI call DOES
    // happen — the summary, not this state machine) — same governing
    // principle as PIN entry/verification elsewhere in this file. Uses its
    // own KV key namespace (chatcopyflow:*/chatcopyverify:*), entirely
    // separate from the existing lead-capture verification flow further
    // down, so the two can never collide even if a visitor somehow has both
    // in flight at once.
    {
      const latestMsgForChatCopy = messages.length > 0 ? messages[messages.length - 1].content.trim() : '';

      // Mid-tour buttons for every reply this block returns below — see
      // currentTourQuickReplies's own header comment for why this exists
      // and what real bug it fixes. Computed once, up front: nothing in
      // this block's own steps changes progress (only the real tour
      // handler further down does), so one read covers every branch.
      const midTourQuickReplies = await currentTourQuickReplies(env, tourToken, sessionId);

      // Step 1 (checked FIRST — a re-trigger always wins): the fixed phrase
      // itself, at ANY point, restarts the flow cleanly from the top,
      // exactly like clicking the persistent control fresh — e.g. to
      // correct a mistyped email, or to back out of an abandoned code
      // entry. Real bug found live, 26 August 2026: this used to be
      // checked LAST, after the awaiting-email/awaiting-code steps below —
      // so once already awaiting an email, re-sending the trigger phrase
      // (typing it again, or clicking a still-visible control) fell
      // straight into email validation and failed as "that doesn't look
      // like an email address", over and over, with no way out short of
      // the 20-minute TTL expiring. Clears BOTH possible prior states
      // (only one is ever actually set at a time, but deleting a
      // non-existent KV key is a harmless no-op) so a re-trigger can never
      // leave an orphaned old flow half-alive behind it.
      if (isChatCopyTrigger(latestMsgForChatCopy)) {
        ctx.waitUntil(env.ASK_LOGS.delete(`chatcopyverify:${sessionId}`));
        ctx.waitUntil(env.ASK_LOGS.delete(`chatcopyverifyattempts:${sessionId}`));
        ctx.waitUntil(env.ASK_LOGS.put(`chatcopyflow:${sessionId}`, JSON.stringify({ step: 'AWAITING_EMAIL' }), { expirationTtl: 60 * 20 }));
        ctx.waitUntil(logEvent(env, sessionId, 'chatcopy_requested', {}));
        return corsResponse(jsonResponse({
          reply: "You'd like a copy of the chat we've just had? Please enter your email…",
          ...(midTourQuickReplies ? { quickReplies: midTourQuickReplies } : {})
        }));
      }

      // Step 2: a code is genuinely awaited AND this message looks like one.
      const awaitingChatCopyRaw = await env.ASK_LOGS.get(`chatcopyverify:${sessionId}`);
      const awaitingChatCopy = awaitingChatCopyRaw ? JSON.parse(awaitingChatCopyRaw) : null;
      if (awaitingChatCopy && /^\d{4,8}$/.test(latestMsgForChatCopy)) {
        const attemptsKey = `chatcopyverifyattempts:${sessionId}`;
        const attempts = parseInt((await env.ASK_LOGS.get(attemptsKey)) || '0', 10);
        if (attempts >= 5) {
          ctx.waitUntil(env.ASK_LOGS.delete(`chatcopyverify:${sessionId}`));
          ctx.waitUntil(env.ASK_LOGS.delete(attemptsKey));
          ctx.waitUntil(logEvent(env, sessionId, 'chatcopy_verify_attempts_exceeded', { email: awaitingChatCopy.email }));
          return corsResponse(jsonResponse({
            reply: "No worries — we'll skip that for now. You're welcome to try again any time.",
            ...(midTourQuickReplies ? { quickReplies: midTourQuickReplies } : {})
          }));
        }
        if (latestMsgForChatCopy === awaitingChatCopy.code) {
          ctx.waitUntil(env.ASK_LOGS.delete(`chatcopyverify:${sessionId}`));
          ctx.waitUntil(env.ASK_LOGS.delete(attemptsKey));
          ctx.waitUntil(logEvent(env, sessionId, 'chatcopy_verified', { email: awaitingChatCopy.email }));
          // THIS request's live, full `messages` (minus the trailing code
          // entry, which isn't real conversation content) — same "no new
          // persistence needed, the stateless resend architecture already
          // has everything" realization as the Tour Outcome Report above.
          // See sendChatCopyEmail's own header comment for the full picture.
          ctx.waitUntil(sendChatCopyEmail(env, { sessionId, toEmail: awaitingChatCopy.email, messages: messages.slice(0, -1), tourToken }));
          return corsResponse(jsonResponse({
            reply: "Thank you. Your chat summary is on its way.",
            ...(midTourQuickReplies ? { quickReplies: midTourQuickReplies } : {})
          }));
        }
        ctx.waitUntil(env.ASK_LOGS.put(attemptsKey, String(attempts + 1), { expirationTtl: 60 * 30 }));
        return corsResponse(jsonResponse({
          reply: "That code didn't match — double-check it and try again.",
          ...(midTourQuickReplies ? { quickReplies: midTourQuickReplies } : {})
        }));
      }

      // Step 3: an email address is genuinely awaited.
      const chatCopyFlowRaw = await env.ASK_LOGS.get(`chatcopyflow:${sessionId}`);
      const chatCopyFlow = chatCopyFlowRaw ? JSON.parse(chatCopyFlowRaw) : null;
      if (chatCopyFlow && chatCopyFlow.step === 'AWAITING_EMAIL') {
        const looksLikeEmail = /@[\w.-]+\.\w+/.test(latestMsgForChatCopy);
        if (!looksLikeEmail) {
          return corsResponse(jsonResponse({
            reply: "That doesn't quite look like an email address — could you double-check it?",
            ...(midTourQuickReplies ? { quickReplies: midTourQuickReplies } : {})
          }));
        }
        const chatCopyEmail = latestMsgForChatCopy;
        const chatCopyCode = generateEmailCode();
        ctx.waitUntil(env.ASK_LOGS.delete(`chatcopyflow:${sessionId}`));
        ctx.waitUntil(env.ASK_LOGS.put(`chatcopyverify:${sessionId}`, JSON.stringify({ email: chatCopyEmail, code: chatCopyCode }), { expirationTtl: 60 * 30 }));
        ctx.waitUntil(logEvent(env, sessionId, 'chatcopy_verify_start_attempted', { email: chatCopyEmail }));
        ctx.waitUntil(
          sendEmailVerificationCode(env, chatCopyEmail, chatCopyCode)
            .then(() => logEvent(env, sessionId, 'chatcopy_verify_start_success', { email: chatCopyEmail }))
            .catch(err => {
              console.error('Chat-copy verification send failed:', err.message);
              return logEvent(env, sessionId, 'chatcopy_verify_start_failed', { error: String(err), email: chatCopyEmail });
            })
        );
        return corsResponse(jsonResponse({
          reply: "Thank you, we'll just send you a quick verification code to that email to make sure we have it right, please enter the code in the panel above",
          ...(midTourQuickReplies ? { quickReplies: midTourQuickReplies } : {})
        }));
      }
    }

    // ---- Custom AI Tours: guest-side state machine (added 24 August 2026) ----
    // Only engages when this request carries a tourToken — every other
    // request (the overwhelming majority: ordinary visitors, and MOST of a
    // tour guest's own turns too, once the destination explanation is done
    // and it's just normal conversation with a contextual note attached)
    // falls straight through to the existing logic below completely
    // unchanged. tourContextForThisTurn/tourActionForThisTurn are plain
    // local variables threaded through the rest of this function — see
    // their use at the callClaude call site and the final response below.
    let tourContextForThisTurn = '';
    let tourActionForThisTurn;
    // Forces the deterministic "Next stop" button onto the final response —
    // added 24 August 2026 for multi-stop tours, direct request from Chris:
    // one single fixed button per stop, not a model-decided closing
    // question. Overrides whatever the model's own <quickreplies> tag
    // produced on a tour turn, same "the WHEN/the control must never depend
    // on the model reliably remembering to offer it" principle as GO_TO
    // itself — see the STARTED-state handling below.
    let tourQuickRepliesOverride;
    if (tourToken) {
      const tour = await getTour(env, tourToken);
      if (!tour) {
        return corsResponse(jsonResponse({
          reply: "This tour link isn't valid or has expired — Chris can send you a fresh one."
        }));
      }
      // Backward-compat shim: a tour created before multi-stop support
      // stored a single `destination` string. Normalize on read so the rest
      // of this block only ever deals with the ordered `destinations` array
      // shape — cheap and avoids needing a one-off KV migration tonight.
      if (!Array.isArray(tour.destinations)) {
        tour.destinations = tour.destination ? [tour.destination] : [];
      }

      // ---- Per-visitor progress (25 August 2026 rewrite — real
      // concurrency bug found live: "Multiple" mode's whole point is one
      // link shared by several real, unrelated people, but the tour's
      // definition and its progress used to live in the SAME record keyed
      // only by the token, so a second visitor opening the link silently
      // reset the first one's progress. See getTourProgress/
      // saveTourProgress's own comment above for the full story. `tour`
      // above is now genuinely read-only after creation — this session's
      // OWN place in it, completely independent of anyone else currently
      // on the same link, lives here instead. ----
      let progress = await getTourProgress(env, tourToken, sessionId);
      if (!progress) {
        // A session's first-ever contact with this specific tour link — a
        // fresh progress record, untouched by and invisible to whatever
        // any other visitor (or the RA's own preview run) is doing on the
        // same link right now.
        // isPreview (added 26 August 2026): stamped once, right here, at the
        // exact moment this session first touches the link — never
        // recomputed later, so a preview session stays a preview even after
        // the RA goes on to lock the tour in during the SAME sitting. See
        // tour.lockedIn's own comment for the full reasoning.
        progress = { status: 'OPENED', currentStopIndex: 0, isPreview: !tour.lockedIn };
        ctx.waitUntil(saveTourProgress(env, tourToken, sessionId, progress));
        ctx.waitUntil(logEvent(env, sessionId, 'tour_opened', { tourToken, isPreview: progress.isPreview }));
      }
      // buildTourGreeting/buildTourConsentContext/buildTourContextNote
      // below are unchanged from before this rewrite — they just read
      // whatever object they're handed, so merging this session's live
      // currentStopIndex onto the tour's fixed fields is all that's
      // needed; no changes required in those three functions themselves.
      const tourView = { ...tour, currentStopIndex: progress.currentStopIndex };

      if (isTourFirstContact) {
        // CREATED -> OPENED: fixed, code-authored greeting — no Claude call
        // needed, nothing here is genuinely context-dependent yet. This
        // session's own progress record was just created above (or already
        // existed, for a same-tab repeat ping) — either way, the greeting
        // reflects only THIS session's position, never anyone else's.
        return corsResponse(jsonResponse({
          reply: buildTourGreeting(tourView),
          action: { type: 'ASK_CONSENT' },
          // A fixed "Start tour" button, added 25 August 2026 direct request
          // from Chris, so the guest can click rather than having to type
          // "yes" — reuses the same generic Quick Reply UI/click path as
          // "Next stop", and the literal text "Start tour" already reads as
          // a clear 'yes' via classifyTourConsentReply's "start" match, so
          // no change needed there.
          quickReplies: ['Start tour']
        }));
      }

      if (progress.status === 'OPENED') {
        // OPENED -> STARTED, deterministically, the moment the guest's reply
        // to the greeting's consent question classifies as a clear yes — see
        // classifyTourConsentReply's own comment for why this is regex-based
        // code, not a model judgement call.
        const latestGuestMsg = messages.length > 0 ? messages[messages.length - 1].content.trim() : '';
        const consent = classifyTourConsentReply(latestGuestMsg);
        if (consent === 'yes') {
          progress.status = 'STARTED';
          progress.currentStopIndex = 0;
          // Real bug found live, 26 August 2026 (Chris's own single-stop
          // test): a tour whose only stop is ALSO its last stop used to
          // never auto-offer the wrap-up feedback buttons on this turn at
          // all — the "reached the final stop" check only lived in the
          // STARTED-state advance handling further below, which never runs
          // on this exact consent-transition turn. A guest on a one-stop
          // tour got an ordinary reply and had to say something else
          // entirely before the buttons showed up, a full turn late and
          // disconnected from actually arriving. See buildTourContextNote's
          // isFinalStop param for the matching text-side half of this fix.
          const isOnlyStop = tour.destinations.length <= 1;
          tourContextForThisTurn = buildTourContextNote(tourView, true, isOnlyStop);
          tourActionForThisTurn = { type: 'GO_TO', target: tour.destinations[0] };
          if (tour.destinations.length > 1) {
            tourQuickRepliesOverride = ['Next stop'];
          } else {
            progress.awaitingFeedback = true;
            tourQuickRepliesOverride = TOUR_FEEDBACK_OPTIONS;
          }
          ctx.waitUntil(logEvent(env, sessionId, 'tour_consent_given', { tourToken }));
          ctx.waitUntil(saveTourProgress(env, tourToken, sessionId, progress));
        } else if (consent === 'no') {
          // Stays OPENED — a hesitant reply shouldn't permanently lock the
          // guest out; they can still say yes later in the same conversation.
          tourContextForThisTurn = `\n\nCUSTOM AI TOUR — DECLINED FOR NOW: The guest just declined the tour invitation. Respond warmly, do not move anywhere, and continue as a normal open conversation. They can still ask to start the tour later if they change their mind.`;
          ctx.waitUntil(logEvent(env, sessionId, 'tour_consent_declined', { tourToken }));
        } else {
          tourContextForThisTurn = buildTourConsentContext(tourView);
        }
      } else if (progress.status === 'STARTED') {
        const latestGuestMsg = messages.length > 0 ? messages[messages.length - 1].content.trim() : '';

        // ---- Tour Outcome Report — feedback reply (added 26 August 2026,
        // direct request from Chris) ----
        // Once awaitingFeedback is set (either by reaching the final stop,
        // or by the guest choosing to end early — both below), this is
        // checked FIRST, ahead of the ordinary next-stop/end-tour handling,
        // since a guest mid-feedback shouldn't also be able to accidentally
        // "advance" a tour that's already wrapping up. Deterministic exact-
        // phrase match against the fixed feedback buttons, same "the WHEN is
        // code, never the model" principle as wantsNextTourStop — a reply
        // that doesn't match one of the three buttons just re-presents them
        // rather than guessing, so free-text chatting can continue right up
        // until the guest actually picks one.
        if (progress.awaitingFeedback) {
          const feedback = classifyTourFeedbackReply(latestGuestMsg);
          if (feedback) {
            progress.status = 'COMPLETED';
            progress.awaitingFeedback = false;
            progress.feedbackGiven = feedback;
            ctx.waitUntil(saveTourProgress(env, tourToken, sessionId, progress));
            ctx.waitUntil(logEvent(env, sessionId, 'tour_completed', { tourToken, feedback, isPreview: !!progress.isPreview }));
            // Skipped entirely for the RA's own preview run — see
            // tour.lockedIn/progress.isPreview's own comments. The
            // mechanism runs identically either way; only the email send
            // is conditional, so a preview run still feels/tests exactly
            // like the real thing.
            if (!progress.isPreview) {
              ctx.waitUntil(sendTourOutcomeReportEmail(env, { tour, tourToken, progress, messages, feedback }));
            }
            // Fully deterministic — no Claude call needed for this turn,
            // same reasoning as the fixed greeting/consent replies above.
            return corsResponse(jsonResponse({
              reply: "Thanks so much for that feedback — really glad you could join the tour. Have a great day!"
            }));
          }
          tourContextForThisTurn = `\n\nCUSTOM AI TOUR — AWAITING WRAP-UP FEEDBACK: The guest is being asked to close out the tour with one of three fixed feedback buttons — do not ask a new question or move anywhere; just respond warmly to whatever they said and let them know the buttons above are how to finish up.`;
          tourQuickRepliesOverride = TOUR_FEEDBACK_OPTIONS;
        } else if (wantsEndTour(latestGuestMsg)) {
          // ---- Tour Outcome Report — guest-initiated early end (added 26
          // August 2026) ----
          // Available at ANY STARTED stop, not just the final one — the
          // "guest 'End tour' button" half of Chris's "Both" trigger choice.
          // Same deterministic, code-decided WHEN as every other governed
          // action in this file.
          progress.awaitingFeedback = true;
          ctx.waitUntil(saveTourProgress(env, tourToken, sessionId, progress));
          ctx.waitUntil(logEvent(env, sessionId, 'tour_end_requested', { tourToken, stopIndex: progress.currentStopIndex }));
          return corsResponse(jsonResponse({
            reply: "No problem — before you go, how was the tour?",
            quickReplies: TOUR_FEEDBACK_OPTIONS
          }));
        } else {
          // ---- Multi-stop advance (added 24 August 2026, direct request
          // from Chris) ----
          // A single fixed button — "Next stop" — attached to every in-tour
          // reply while a further stop remains, exactly mirroring the GO_TO
          // design principle: the WHEN is deterministic code matching this
          // one exact phrase (whether it arrived via the button click, which
          // always sends this literal text, or the guest just typing
          // something equivalent), never a model decision. What the model
          // says at each stop is still fully generative — only the moment of
          // movement is fixed.
          const hasNextStop = progress.currentStopIndex + 1 < tour.destinations.length;
          let justAdvancedThisTurn = false;
          if (hasNextStop && wantsNextTourStop(latestGuestMsg)) {
            progress.currentStopIndex += 1;
            justAdvancedThisTurn = true;
            tourActionForThisTurn = { type: 'GO_TO', target: tour.destinations[progress.currentStopIndex] };
            ctx.waitUntil(logEvent(env, sessionId, 'tour_advanced', { tourToken, stopIndex: progress.currentStopIndex }));
          }
          // Recomputed rather than reusing tourView above — currentStopIndex
          // may have just changed on this exact turn (the advance above).
          const tourViewNow = { ...tour, currentStopIndex: progress.currentStopIndex };
          const hasNextStopNow = progress.currentStopIndex + 1 < tour.destinations.length;
          // isFinalStop passed here too (26 August 2026 fix, see
          // buildTourContextNote's own comment) — this same "reached the
          // final stop" moment via an ordinary advance had the identical
          // defect as the single-stop case above: the buttons appeared
          // correctly, but the model was never told the tour was ending, so
          // its reply had no connection to them either.
          tourContextForThisTurn = buildTourContextNote(tourViewNow, justAdvancedThisTurn, !hasNextStopNow);
          if (hasNextStopNow) {
            // A further stop remains — offer both the way forward and the
            // way to wrap up early, same reasoning as the file-wide "never
            // rely on the model to remember to offer a fixed control".
            tourQuickRepliesOverride = ['Next stop', 'End tour'];
          } else {
            // ---- Tour Outcome Report — auto-trigger at the final stop
            // (added 26 August 2026) ----
            // The "auto at last stop" half of Chris's "Both" trigger choice.
            // Fires once, the first turn this guest is actually AT the
            // final stop (guarded so a guest who keeps chatting there
            // doesn't get re-asked on every subsequent reply) — deliberately
            // not "the instant GO_TO lands them there", since they haven't
            // had a chance to read/engage with it yet; this is the reply
            // immediately after, once whatever they just said has been
            // answered.
            progress.awaitingFeedback = true;
            tourQuickRepliesOverride = TOUR_FEEDBACK_OPTIONS;
          }
          ctx.waitUntil(saveTourProgress(env, tourToken, sessionId, progress));
        }
      }
    }

    // ---- "Book Tour" — RA-initiated tour setup via the ordinary chat panel
    // (added 25 August 2026, direct request from Chris) ----
    // Lets a Responsible Authority type "Book Tour" into their OWN site's
    // LiveAsk panel — no separate admin screen, no raw API calls — and be
    // walked through PIN entry, identified by name via the multi-RA
    // directory below, asked how many recipients, and handed a ready
    // tourUrl. Every step here is deterministic code, same governing
    // principle as the Twilio/email verification blocks further down: the
    // PIN especially must never reach Claude or get logged as plain
    // conversation text (see logEvent calls below — never the raw PIN).
    // Only ever engages for an ordinary (non-tour-guest) session — a real
    // tour guest's own conversation always carries a tourToken, so this
    // block and the guest-side state machine above can never fire on the
    // same request.
    if (!tourToken) {
      const existingBookFlow = await getBookFlow(env, sessionId);
      const latestMsgForBooking = messages.length > 0 ? messages[messages.length - 1].content.trim() : '';

      if (!existingBookFlow && isBookTourTrigger(latestMsgForBooking)) {
        if (await checkRaLockout(env, sessionId)) {
          return corsResponse(jsonResponse({
            reply: "Too many incorrect PIN attempts just now — give it about 15 minutes and try again."
          }));
        }
        await saveBookFlow(env, sessionId, { step: 'AWAITING_PIN' });
        ctx.waitUntil(logEvent(env, sessionId, 'book_tour_started', {}));
        return corsResponse(jsonResponse({ reply: PIN_PROMPT_TEXT }));
      }

      if (existingBookFlow && existingBookFlow.step === 'AWAITING_PIN') {
        if (await checkRaLockout(env, sessionId)) {
          ctx.waitUntil(clearBookFlow(env, ctx, sessionId));
          return corsResponse(jsonResponse({
            reply: "Too many incorrect PIN attempts — give it about 15 minutes, then type \"Book Tour\" again."
          }));
        }
        const ra = await findRaByPin(env, latestMsgForBooking);
        if (!ra) {
          ctx.waitUntil(recordRaPinFailure(env, ctx, sessionId));
          ctx.waitUntil(logEvent(env, sessionId, 'book_tour_pin_failed', {}));
          return corsResponse(jsonResponse({ reply: "That PIN didn't match — try again." }));
        }
        ctx.waitUntil(clearRaPinFailures(env, ctx, sessionId));
        await saveBookFlow(env, sessionId, { step: 'AWAITING_RECIPIENT_COUNT', raEmail: ra.email, raName: ra.name });
        ctx.waitUntil(logEvent(env, sessionId, 'book_tour_pin_ok', { raEmail: ra.email }));
        return corsResponse(jsonResponse(raConfirmedRecipientCountPrompt(ra.name)));
      }

      // ---- AWAITING_RECIPIENT_COUNT -> either AWAITING_GUEST_NAME (single)
      // or straight to AWAITING_TOUR_NAME (multiple, no individual to name)
      if (existingBookFlow && existingBookFlow.step === 'AWAITING_RECIPIENT_COUNT') {
        const choice = latestMsgForBooking.toLowerCase();
        if (choice === 'single') {
          await saveBookFlow(env, sessionId, { ...existingBookFlow, mode: 'single', step: 'AWAITING_GUEST_NAME' });
          return corsResponse(jsonResponse({ reply: "What name shall I welcome your guest with, please?" }));
        }
        if (choice === 'multiple') {
          await saveBookFlow(env, sessionId, { ...existingBookFlow, mode: 'multiple', guestName: null, step: 'AWAITING_TOUR_NAME' });
          return corsResponse(jsonResponse({ reply: "Now, can you please enter a name or brief description for this tour?" }));
        }
        // Anything else — re-ask rather than guess. Same fail-closed shape
        // as classifyTourConsentReply's 'unclear' branch.
        return corsResponse(jsonResponse({
          reply: "Just to confirm — single recipient, or multiple?",
          quickReplies: ['Single', 'Multiple']
        }));
      }

      if (existingBookFlow && existingBookFlow.step === 'AWAITING_GUEST_NAME') {
        if (!latestMsgForBooking) {
          return corsResponse(jsonResponse({ reply: "What name shall I welcome your guest with, please?" }));
        }
        await saveBookFlow(env, sessionId, { ...existingBookFlow, guestName: latestMsgForBooking, step: 'AWAITING_GUEST_NAME_CONFIRM' });
        return corsResponse(jsonResponse({
          reply: `Thank you — confirming a single-recipient tour, welcoming your guest as "${latestMsgForBooking}"?`,
          quickReplies: ['Yes', 'Change']
        }));
      }

      if (existingBookFlow && existingBookFlow.step === 'AWAITING_GUEST_NAME_CONFIRM') {
        const answer = latestMsgForBooking.toLowerCase();
        if (answer === 'yes') {
          await saveBookFlow(env, sessionId, { ...existingBookFlow, step: 'AWAITING_TOUR_NAME' });
          return corsResponse(jsonResponse({ reply: "Now, can you please enter a name or brief description for this tour?" }));
        }
        // 'no', 'change', or anything unrecognized — same re-ask-this-step
        // shape throughout this flow: nothing LATER has been asked yet at
        // this point, so there's nothing else to unwind or preserve.
        await saveBookFlow(env, sessionId, { ...existingBookFlow, step: 'AWAITING_GUEST_NAME' });
        return corsResponse(jsonResponse({ reply: "No worries — what name shall I welcome your guest with, please?" }));
      }

      if (existingBookFlow && existingBookFlow.step === 'AWAITING_TOUR_NAME') {
        if (!latestMsgForBooking) {
          return corsResponse(jsonResponse({ reply: "Now, can you please enter a name or brief description for this tour?" }));
        }
        await saveBookFlow(env, sessionId, { ...existingBookFlow, tourName: latestMsgForBooking, step: 'AWAITING_TOUR_NAME_CONFIRM' });
        return corsResponse(jsonResponse({
          reply: `Good — so we're calling it "${latestMsgForBooking}"?`,
          quickReplies: ['Yes', 'Change']
        }));
      }

      if (existingBookFlow && existingBookFlow.step === 'AWAITING_TOUR_NAME_CONFIRM') {
        const answer = latestMsgForBooking.toLowerCase();
        if (answer === 'yes') {
          await saveBookFlow(env, sessionId, { ...existingBookFlow, pickedDestinations: [], step: 'AWAITING_DESTINATIONS' });
          return corsResponse(jsonResponse(buildDestinationPickerPrompt([])));
        }
        await saveBookFlow(env, sessionId, { ...existingBookFlow, step: 'AWAITING_TOUR_NAME' });
        return corsResponse(jsonResponse({ reply: "No worries — what should we call this tour?" }));
      }

      // ---- AWAITING_DESTINATIONS: the ordered picker (added 25 August
      // 2026, direct request from Chris) — each click adds one destination
      // to the running order and re-presents whatever's left, until "Done".
      // Matches against each remaining destination's short `picker` label,
      // case-insensitively, same as every other button match in this file —
      // works whether the RA clicked the button or typed the label by hand.
      if (existingBookFlow && existingBookFlow.step === 'AWAITING_DESTINATIONS') {
        const picked = existingBookFlow.pickedDestinations || [];
        const remaining = TOUR_DESTINATION_ORDER.filter(k => !picked.includes(k));
        const answerLower = latestMsgForBooking.toLowerCase();

        if (answerLower === 'done') {
          if (picked.length === 0) {
            return corsResponse(jsonResponse(buildDestinationPickerPrompt(picked)));
          }
          await saveBookFlow(env, sessionId, { ...existingBookFlow, step: 'AWAITING_DESTINATIONS_CONFIRM' });
          return corsResponse(jsonResponse(buildDestinationsConfirmPrompt(picked)));
        }

        const matchedKey = remaining.find(k => TOUR_DESTINATIONS[k].picker.toLowerCase() === answerLower);
        if (matchedKey) {
          const newPicked = [...picked, matchedKey];
          const stillRemaining = TOUR_DESTINATION_ORDER.filter(k => !newPicked.includes(k));
          if (stillRemaining.length === 0) {
            // Nothing left to offer — go straight to confirm rather than
            // force a click on a picker with only "Done" left in it.
            await saveBookFlow(env, sessionId, { ...existingBookFlow, pickedDestinations: newPicked, step: 'AWAITING_DESTINATIONS_CONFIRM' });
            return corsResponse(jsonResponse(buildDestinationsConfirmPrompt(newPicked)));
          }
          await saveBookFlow(env, sessionId, { ...existingBookFlow, pickedDestinations: newPicked, step: 'AWAITING_DESTINATIONS' });
          return corsResponse(jsonResponse(buildDestinationPickerPrompt(newPicked)));
        }

        // Unrecognized input — re-present the same picker state rather than guess.
        return corsResponse(jsonResponse(buildDestinationPickerPrompt(picked)));
      }

      if (existingBookFlow && existingBookFlow.step === 'AWAITING_DESTINATIONS_CONFIRM') {
        const answer = latestMsgForBooking.toLowerCase();
        if (answer === 'yes') {
          const result = await createTourRecord(env, ctx, {
            destinations: existingBookFlow.pickedDestinations,
            guestName: existingBookFlow.guestName,
            tourName: existingBookFlow.tourName,
            raEmail: existingBookFlow.raEmail,
            raName: existingBookFlow.raName
          });
          ctx.waitUntil(logEvent(env, sessionId, 'book_tour_draft_created', { token: result.token, mode: existingBookFlow.mode, tourName: existingBookFlow.tourName, raEmail: existingBookFlow.raEmail }));
          await saveBookFlow(env, sessionId, { ...existingBookFlow, tourToken: result.token, tourUrl: result.tourUrl, step: 'AWAITING_PREVIEW_OFFER' });
          return corsResponse(jsonResponse({
            reply: "Great — would you like to give the tour a quick run-through before locking it in?",
            quickReplies: ['Yes', 'No']
          }));
        }
        await saveBookFlow(env, sessionId, { ...existingBookFlow, pickedDestinations: [], step: 'AWAITING_DESTINATIONS' });
        return corsResponse(jsonResponse(buildDestinationPickerPrompt([])));
      }

      // ---- Inline dry-run preview (rebuilt 26 August 2026, replacing the
      // token+new-tab version, direct request from Chris: "get rid of the
      // separate link/browser thing and just do a dry-run nav... same
      // browser window, continuous engagement.") ----
      // The RA's OWN browser now moves through the tour's real stops right
      // here, in this same chat/session — no tourToken, no second tab. This
      // works with ZERO frontend changes: the widget's `action: {type:
      // 'GO_TO', ...}` dispatcher already moves whichever browser is
      // running it, guest or RA, and the 26 August cross-page quick-reply
      // fix (see liveask-widget.js's savePendingTourAction/
      // currentTourQuickReplies-adjacent work) already carries "Next
      // stop"/"Lock it in" across a page hop the same way it does for a
      // real guest — this preview gets that protection for free.
      if (existingBookFlow && existingBookFlow.step === 'AWAITING_PREVIEW_OFFER') {
        const answer = latestMsgForBooking.toLowerCase();
        if (answer === 'yes') {
          const picked = existingBookFlow.pickedDestinations;
          const isOnlyStop = picked.length <= 1;
          if (isOnlyStop) {
            // Same "lands directly on its only/last stop" shape as the
            // 26 August guest-side fix — go straight to Lock it in/Make
            // changes on this same turn, no dangling "Next stop" that
            // would never have anywhere to go.
            await saveBookFlow(env, sessionId, { ...existingBookFlow, previewStopIndex: 0, step: 'AWAITING_LOCK_DECISION' });
            return corsResponse(jsonResponse({
              reply: buildPreviewStopNarration(picked, 0, true) + `\n\nThat's the whole tour (just the one stop) — lock it in, or make changes?`,
              action: { type: 'GO_TO', target: picked[0] },
              quickReplies: ['Lock it in', 'Make changes']
            }));
          }
          await saveBookFlow(env, sessionId, { ...existingBookFlow, previewStopIndex: 0, step: 'AWAITING_PREVIEW_RUN' });
          return corsResponse(jsonResponse({
            reply: buildPreviewStopNarration(picked, 0, true),
            action: { type: 'GO_TO', target: picked[0] },
            quickReplies: ['Next stop']
          }));
        }
        await saveBookFlow(env, sessionId, { ...existingBookFlow, step: 'AWAITING_LOCK_DECISION' });
        return corsResponse(jsonResponse({
          reply: "No worries. Would you like to lock that in, or make changes?",
          quickReplies: ['Lock it in', 'Make changes']
        }));
      }

      if (existingBookFlow && existingBookFlow.step === 'AWAITING_PREVIEW_RUN') {
        const picked = existingBookFlow.pickedDestinations;
        const idx = existingBookFlow.previewStopIndex || 0;
        const hasNextStop = idx + 1 < picked.length;
        if (hasNextStop && wantsNextTourStop(latestMsgForBooking)) {
          const newIdx = idx + 1;
          const hasNextStopNow = newIdx + 1 < picked.length;
          if (hasNextStopNow) {
            await saveBookFlow(env, sessionId, { ...existingBookFlow, previewStopIndex: newIdx, step: 'AWAITING_PREVIEW_RUN' });
            return corsResponse(jsonResponse({
              reply: buildPreviewStopNarration(picked, newIdx, false),
              action: { type: 'GO_TO', target: picked[newIdx] },
              quickReplies: ['Next stop']
            }));
          }
          // Last stop reached — same deterministic, code-decided moment as
          // the guest-side auto-trigger, just wrapping up with Lock it
          // in/Make changes instead of feedback buttons.
          await saveBookFlow(env, sessionId, { ...existingBookFlow, previewStopIndex: newIdx, step: 'AWAITING_LOCK_DECISION' });
          return corsResponse(jsonResponse({
            reply: buildPreviewStopNarration(picked, newIdx, false) + `\n\nThat's the last stop — lock it in, or make changes?`,
            action: { type: 'GO_TO', target: picked[newIdx] },
            quickReplies: ['Lock it in', 'Make changes']
          }));
        }
        // Anything else — re-present the current stop rather than guess or
        // silently do nothing, same fail-closed shape as every other step
        // in this flow.
        return corsResponse(jsonResponse({
          reply: `Still at stop ${idx + 1} of ${picked.length} — click Next stop to keep going, or just have a look around this page.`,
          quickReplies: ['Next stop']
        }));
      }

      if (existingBookFlow && existingBookFlow.step === 'AWAITING_LOCK_DECISION') {
        const answer = latestMsgForBooking.toLowerCase();
        if (answer === 'lock it in') {
          // ---- Flip lockedIn (added 26 August 2026) ----
          // Awaited, not fire-and-forget via ctx.waitUntil — this is the one
          // moment that must be genuinely durable BEFORE the confirmation
          // email (the only channel that hands this link to a real guest)
          // goes out, so a guest opening the link a moment later never sees
          // a stale lockedIn:false. See tour.lockedIn's own comment on
          // createTourRecord for the full reasoning.
          const lockedTour = await getTour(env, existingBookFlow.tourToken);
          if (lockedTour) {
            lockedTour.lockedIn = true;
            await saveTour(env, existingBookFlow.tourToken, lockedTour);
          } else {
            // Shouldn't happen (the draft is created earlier in this same
            // flow and never deleted except by Recreate, which restarts the
            // flow entirely) — logged so a real gap here would be visible,
            // rather than silently leaving a tour permanently unlockable.
            ctx.waitUntil(logEvent(env, sessionId, 'book_tour_lock_missing_tour', { token: existingBookFlow.tourToken }));
          }
          ctx.waitUntil(sendTourConfirmationEmail(env, {
            raEmail: existingBookFlow.raEmail,
            raName: existingBookFlow.raName,
            tourName: existingBookFlow.tourName,
            guestName: existingBookFlow.guestName,
            mode: existingBookFlow.mode,
            destinations: existingBookFlow.pickedDestinations,
            tourUrl: existingBookFlow.tourUrl
          }));
          ctx.waitUntil(logEvent(env, sessionId, 'book_tour_locked_in', { token: existingBookFlow.tourToken, raEmail: existingBookFlow.raEmail }));
          ctx.waitUntil(clearBookFlow(env, ctx, sessionId));
          return corsResponse(jsonResponse({
            reply: `Thank you, ${existingBookFlow.raName}, I'll just send you an email with those tour details confirmed. Have a nice day.`
          }));
        }
        // "Make changes" (26 August 2026 — renamed from "Recreate" to match
        // Chris's own wording for the new inline preview's closing buttons).
        // Still also matches the literal word "recreate" for anyone typing
        // freehand instead of clicking, since the underlying action (discard
        // the draft, start the destination picker over) hasn't changed.
        if (answer === 'make changes' || answer === 'recreate') {
          // Discard the draft tour record — it was only ever a working
          // draft, never sent to anyone, so nothing else needs cleaning up.
          ctx.waitUntil(env.ASK_LOGS.delete(`tour:${existingBookFlow.tourToken}`));
          ctx.waitUntil(logEvent(env, sessionId, 'book_tour_recreate', { discardedToken: existingBookFlow.tourToken, raEmail: existingBookFlow.raEmail }));
          await saveBookFlow(env, sessionId, { raEmail: existingBookFlow.raEmail, raName: existingBookFlow.raName, step: 'AWAITING_RECIPIENT_COUNT' });
          return corsResponse(jsonResponse({
            reply: "No problem — let's start again. Will there be one recipient or multiple for this new tour?",
            quickReplies: ['Single', 'Multiple']
          }));
        }
        return corsResponse(jsonResponse({
          reply: "Just to confirm — lock that in, or make changes?",
          quickReplies: ['Lock it in', 'Make changes']
        }));
      }
    }

    // ---- Twilio verification-code check (code-level, deterministic — never the model's job) ----
    // If this session is currently awaiting an SMS code, and the visitor's latest
    // message looks like one (short, all digits), handle it here directly and
    // return early — skip Claude entirely for this turn. Keeps verification a
    // hard, testable state machine rather than something the model interprets.
    const awaitingPhone = await env.ASK_LOGS.get(`awaitingverify:${sessionId}`);
    // Email verification mirrors the phone flow above, but there's no external
    // service (like Twilio) holding the code for us — we generate and store it
    // ourselves, so what's in KV here is a small JSON blob {email, code}, not
    // just the raw address. Check is still fully deterministic code, never the
    // model's job, same principle as phone.
    const awaitingEmailRaw = await env.ASK_LOGS.get(`awaitingemailverify:${sessionId}`);
    const awaitingEmail = awaitingEmailRaw ? JSON.parse(awaitingEmailRaw) : null;
    // Guarded for messages.length === 0 defensively — every real path that
    // reaches this point has at least one message (isTourFirstContact always
    // returns early above), but this keeps that invariant from being a
    // silent trap if the tour state machine above ever grows another branch.
    const latestVisitorMsg = messages.length > 0 ? messages[messages.length - 1].content.trim() : '';
    const looksLikeCode = /^\d{4,8}$/.test(latestVisitorMsg);

    if (awaitingPhone && looksLikeCode) {
      const attemptsKey = `verifyattempts:${sessionId}`;
      const attempts = parseInt((await env.ASK_LOGS.get(attemptsKey)) || '0', 10);

      if (attempts >= 5) {
        // Too many wrong guesses — quietly drop out of verify mode rather than
        // let it become a brute-force vector. Lead is already captured either way.
        ctx.waitUntil(env.ASK_LOGS.delete(`awaitingverify:${sessionId}`));
        ctx.waitUntil(logEvent(env, sessionId, 'verify_attempts_exceeded', { phone: awaitingPhone }));
        return corsResponse(jsonResponse({
          reply: "No worries — we'll skip verification for now, Chris still has your details and will be in touch."
        }));
      }

      let approved = false;
      try {
        approved = await twilioVerifyCheck(env, awaitingPhone, latestVisitorMsg);
      } catch (err) {
        console.error('Twilio verify check failed:', err.message);
        ctx.waitUntil(logEvent(env, sessionId, 'verify_check_error', { error: String(err) }));
        return corsResponse(jsonResponse({
          reply: "That's taking longer than it should to check — try again in a moment, or don't worry about it, Chris still has your details."
        }));
      }

      if (approved) {
        ctx.waitUntil(env.ASK_LOGS.delete(`awaitingverify:${sessionId}`));
        ctx.waitUntil(env.ASK_LOGS.delete(attemptsKey));
        ctx.waitUntil(logEvent(env, sessionId, 'phone_verified', { phone: awaitingPhone }));
        // Pass THIS request's live `messages` (minus the trailing code entry,
        // which isn't real content) rather than whatever was captured back
        // when the lead was first parsed — real test (23 August 2026) showed
        // conversation between capture and verification (e.g. the visitor's
        // actual enquiry detail) was being lost because the email used the
        // stale capture-time snapshot instead of the current full thread.
        ctx.waitUntil(sendLeadEmailOnVerification(env, sessionId, 'phone', awaitingPhone, messages.slice(0, -1)));
        return corsResponse(jsonResponse({
          reply: buildVerifiedReply(messages)
        }));
      } else {
        ctx.waitUntil(env.ASK_LOGS.put(attemptsKey, String(attempts + 1), { expirationTtl: 60 * 20 }));
        return corsResponse(jsonResponse({
          reply: "That code didn't match — double-check it and try again, or just let it go, your details are already through to Chris either way."
        }));
      }
    }

    // ---- Email verification-code check (code-level, deterministic — never the model's job) ----
    // Same shape as the Twilio block above. The comparison itself is a plain
    // string match against the code we generated and stored ourselves — no
    // external API call, so no network-failure branch is needed here, unlike
    // the Twilio check.
    if (awaitingEmail && looksLikeCode) {
      const attemptsKey = `emailverifyattempts:${sessionId}`;
      const attempts = parseInt((await env.ASK_LOGS.get(attemptsKey)) || '0', 10);

      if (attempts >= 5) {
        ctx.waitUntil(env.ASK_LOGS.delete(`awaitingemailverify:${sessionId}`));
        ctx.waitUntil(logEvent(env, sessionId, 'email_verify_attempts_exceeded', { email: awaitingEmail.email }));
        return corsResponse(jsonResponse({
          reply: "No worries — we'll skip verification for now, Chris still has your details and will be in touch."
        }));
      }

      if (latestVisitorMsg === awaitingEmail.code) {
        ctx.waitUntil(env.ASK_LOGS.delete(`awaitingemailverify:${sessionId}`));
        ctx.waitUntil(env.ASK_LOGS.delete(attemptsKey));
        ctx.waitUntil(logEvent(env, sessionId, 'email_verified', { email: awaitingEmail.email }));
        // Same fix as the phone branch above — use the live thread, not the
        // capture-time snapshot.
        ctx.waitUntil(sendLeadEmailOnVerification(env, sessionId, 'email', awaitingEmail.email, messages.slice(0, -1)));
        return corsResponse(jsonResponse({
          reply: buildVerifiedReply(messages)
        }));
      } else {
        ctx.waitUntil(env.ASK_LOGS.put(attemptsKey, String(attempts + 1), { expirationTtl: 60 * 30 }));
        return corsResponse(jsonResponse({
          reply: "That code didn't match — double-check it and try again, or just let it go, your details are already through to Chris either way."
        }));
      }
    }
    if (messages.length > MAX_TURNS * 2) {
      return corsResponse(jsonResponse({
        reply: "We've covered a lot of ground — best to continue this one directly. You can reach me on LinkedIn or at chris@promptworkx.com."
      }));
    }

    // ---- Rate limiting (per session, via KV) ----
    const rateKey = `rate:${sessionId}:${Math.floor(Date.now() / 60000)}`;
    const currentCount = parseInt((await env.ASK_LOGS.get(rateKey)) || '0', 10);
    if (currentCount >= RATE_LIMIT_PER_MINUTE) {
      return corsResponse(jsonResponse({
        reply: "That's a lot of questions in a short time — give it a minute and try again."
      }, 429));
    }
    ctx.waitUntil(env.ASK_LOGS.put(rateKey, String(currentCount + 1), { expirationTtl: 90 }));

    // ---- Call Claude ----
    // messages is redacted here, not reassigned at the top of the request —
    // the RAW array (with a real PIN in it, on the one turn that has one)
    // is still needed above this point for the Book Tour state machine's
    // own deterministic checks (findRaByPin etc.), which never call Claude
    // at all. See redactPinFromMessages' own header comment for the full
    // picture — this is the backend half of the PIN fix.
    let aiReply;
    try {
      aiReply = await callClaude(env, redactPinFromMessages(messages), tourContextForThisTurn);
    } catch (err) {
      // Failure path — graceful fallback, never a broken box on the visitor's screen
      console.error('Claude call failed:', err.name, err.message, err.cause || '', err.stack || '');
      ctx.waitUntil(logEvent(env, sessionId, 'api_error', { error: String(err) }));
      return corsResponse(jsonResponse({
        reply: "That's taking longer than it should — try again, or jump straight to a door below."
      }, 200));
    }

    // ---- Belt-and-braces correction for a recurring known misspelling ----
    // The system prompt instructs the exact spelling "Perplexity", but real
    // testing (25-30 July) has shown multiple different misspellings slip
    // through ("Perplexia", "Perplexus", ...) — a single-typo patch keeps
    // missing the next new one. This catches any "Perpl..." word that isn't
    // already correct and forces it back, regardless of which variant appears.
    aiReply = aiReply.replace(/\bPerpl\w*\b/gi, (match) => /^perplexity$/i.test(match) ? match : 'Perplexity');

    // The system prompt explicitly forbids this exact embellishment (claiming
    // Chris has local-market familiarity just because a visitor named their
    // city) — it has recurred in real testing more than once regardless,
    // meaning the instruction alone isn't reliably stopping it. Strip it at
    // the code level as a backstop rather than keep relying on the prompt.
    aiReply = aiReply.replace(/\s*Chris(?:'s| is)?\s*(?:also\s*)?Brisbane-based[^.!?]*(?:market[^.!?]*)?[.!?]/gi, '');
    aiReply = aiReply.replace(/\s*[Hh]e(?:'ll| will) know (?:the|that) market[^.!?]*[.!?]/gi, '');

    // Diagnostic safety net for the "never say chatbot" guardrail (added
    // 24 August 2026, real Chris directive — brand-critical, LiveAsk is
    // explicitly positioned against "chatbot" framing on its own marketing
    // page). Deliberately NOT an auto-strip like the Brisbane-embellishment
    // fix above — that works because it deletes a whole self-contained
    // sentence; "chatbot" can appear mid-sentence in ways a blind word
    // removal would mangle ("I'm not a chatbot" -> "I'm not a"). Logged
    // instead, so a real pattern of misses is visible rather than silently
    // shipped to a visitor — same diagnostic-not-auto-correct approach used
    // elsewhere in this file when an auto-fix risks doing more harm than
    // the miss itself.
    if (/\bchatbots?\b/i.test(aiReply)) {
      ctx.waitUntil(logEvent(env, sessionId, 'chatbot_word_used', { aiReply }));
    }

    // ---- Quick Reply detection (Customer 000 / GEO 4, added 24 August 2026) ----
    // The system prompt (Section 8) instructs the model to silently emit a
    // <quickreplies>[...]</quickreplies> JSON array when the useful response
    // space for the visitor's next turn is genuinely constrained (a real
    // yes/no, a stated channel choice, a short list of named options) —
    // see "Guided (closed) questions — Quick Replies" in system-prompt.js.
    // This is a deliberately different mechanism from the privacy notice we
    // just moved OFF the model (23 August 2026): that was a fully
    // deterministic yes/no decision that never needed the model's judgement.
    // Quick Reply *content* is genuinely context-dependent — the model has
    // to decide both whether a closed set applies and what the actual
    // choices are — so a model-emitted marker is the right tool here, not a
    // regression to the pattern we just removed.
    // Validation is strict and fails closed: per Chris's brief (24 August
    // 2026), if the marker is absent, malformed, or invalid, normal
    // free-text conversation continues completely unaffected — never a
    // broken box, never a partial/garbled button row. The 4-choice cap is
    // enforced here in code, not trusted to the model, same reasoning as
    // every other code-level backstop in this file (Design Principle 1).
    const QUICK_REPLIES_TAG = /<quickreplies>([\s\S]*?)<\/quickreplies>/i;
    const quickRepliesMatch = aiReply.match(QUICK_REPLIES_TAG);
    let quickReplies = null;
    if (quickRepliesMatch) {
      aiReply = aiReply.replace(QUICK_REPLIES_TAG, '').trim();
      try {
        const parsed = JSON.parse(quickRepliesMatch[1]);
        if (Array.isArray(parsed)) {
          const cleaned = parsed
            .filter((choice) => typeof choice === 'string' && choice.trim().length > 0 && choice.trim().length <= 40)
            .map((choice) => choice.trim())
            .slice(0, 4); // hard cap — Customer 000 spec (24 August 2026)
          if (cleaned.length > 0) quickReplies = cleaned;
        }
      } catch {
        // Malformed JSON — logged so a real pattern is visible, never surfaced
        // to the visitor. Falls through to quickReplies staying null, i.e.
        // ordinary free-text conversation, exactly as required.
        ctx.waitUntil(logEvent(env, sessionId, 'quickreplies_malformed', { raw: quickRepliesMatch[1] }));
      }
    }

    // Defensive truncation guard (added 25 August 2026, real live-test find) —
    // mirrors the <lead> guard further down: a reply that opens a
    // <quickreplies> tag but never reaches its closing tag (max_tokens
    // cutting generation off mid-JSON, same failure mode as the <lead> case,
    // since this tag is also deliberately placed at the very end of a
    // reply) won't match QUICK_REPLIES_TAG at all — which used to mean the
    // raw, half-written tag ('<quickreplies>["How it\'s built","Getting one
    // for my' and all) leaked straight into what the visitor sees. Strips
    // anything from an unclosed "<quickreplies>" onward before the visitor
    // ever sees it, logged separately so a real pattern of truncation is
    // visible going forward.
    if (!quickRepliesMatch) {
      const unclosedQuickRepliesIndex = aiReply.indexOf('<quickreplies>');
      if (unclosedQuickRepliesIndex !== -1) {
        const rawTail = aiReply.slice(unclosedQuickRepliesIndex);
        aiReply = aiReply.slice(0, unclosedQuickRepliesIndex).trim() || "Got that, thanks — one moment.";
        ctx.waitUntil(logEvent(env, sessionId, 'quickreplies_tag_unclosed_truncated', { raw: rawTail }));
      }
    }

    // ---- Quick Reply detect-and-retry backstop (added 24 August 2026) ----
    // Real testing the same day found the tag missing on genuine closed-choice
    // closing questions in at least three unrelated parts of the prompt
    // (Contact-capture — now separately fixed at the wording level — plus the
    // GenCheck and PromptGuide explanations, still open when this was written).
    // Brought in a three-way independent review (Charlie, Gemini, and a second
    // Claude instance) rather than guess at another prompt tweak. Charlie and
    // the second Claude instance independently converged on the same design
    // below; Gemini's alternative (regex-SYNTHESISING button labels straight
    // out of the model's own sentence) was deliberately rejected — splitting
    // free-form natural language on the word "or" risks a garbled, nonsensical
    // button reaching a real visitor, which is a worse failure than today's
    // graceful degradation to plain text. This backstop keeps that same
    // principle: code only ever DETECTS a candidate; the model, on a second,
    // narrow pass, is the only thing that ever writes the actual button text.
    //
    // Only runs when the first pass produced no valid quickReplies at all —
    // deliberately NOT when a tag was already emitted correctly but the model
    // also (redundantly) left the alternatives in the sentence text too. That
    // narrower "self-editing" gap is a separate, lower-severity issue, flagged
    // but out of scope for this specific backstop.
    if (!quickReplies) {
      const replyForDetection = aiReply.replace(/<lead>[\s\S]*?<\/lead>/i, '').trim();
      const candidate = detectQuickReplyCandidate(replyForDetection);
      if (candidate) {
        ctx.waitUntil(logEvent(env, sessionId, 'quickreplies_candidate_detected', candidate));
        try {
          // Same redaction as the main Claude call above — this backstop
          // builds its own plain-text transcript straight from `messages`
          // (see attemptQuickReplyCorrection below), which is exactly as
          // capable of carrying a PIN into Claude as the main call is.
          const corrected = await attemptQuickReplyCorrection(env, redactPinFromMessages(messages), aiReply);
          const correctedMatch = corrected ? corrected.match(QUICK_REPLIES_TAG) : null;
          if (correctedMatch) {
            const correctedReply = corrected.replace(QUICK_REPLIES_TAG, '').trim();
            try {
              const parsed = JSON.parse(correctedMatch[1]);
              const cleaned = Array.isArray(parsed)
                ? parsed
                    .filter((choice) => typeof choice === 'string' && choice.trim().length > 0 && choice.trim().length <= 40)
                    .map((choice) => choice.trim())
                    .slice(0, 4)
                : [];
              if (cleaned.length > 0) {
                // Adopt the corrected reply as the new source of truth — it
                // carries forward untouched to the lead-capture check below,
                // the logged exchange, and the final response.
                aiReply = correctedReply;
                quickReplies = cleaned;
                ctx.waitUntil(logEvent(env, sessionId, 'quickreplies_retry_success', { shape: candidate.shape, choices: cleaned }));
              } else {
                ctx.waitUntil(logEvent(env, sessionId, 'quickreplies_retry_failed', { reason: 'empty_after_clean', raw: correctedMatch[1] }));
              }
            } catch {
              ctx.waitUntil(logEvent(env, sessionId, 'quickreplies_retry_failed', { reason: 'json_parse_error', raw: correctedMatch[1] }));
            }
          } else {
            // Model judged it NO_CHANGE, or came back without a usable tag —
            // either way, silently keep the original first-pass reply. Same
            // fail-closed principle as the primary tag validation above.
            ctx.waitUntil(logEvent(env, sessionId, 'quickreplies_retry_failed', {
              reason: 'no_tag_in_correction',
              shape: candidate.shape,
              correctionRaw: corrected ? corrected.slice(0, 300) : null
            }));
          }
        } catch (err) {
          // The backstop itself failing must never break the primary reply —
          // same principle as every other resilience path in this file.
          console.error('Quick Reply correction attempt failed:', err.message);
          ctx.waitUntil(logEvent(env, sessionId, 'quickreplies_retry_error', { error: String(err) }));
        }
      }
    }

    // ---- Log the exchange ----
    ctx.waitUntil(logEvent(env, sessionId, 'exchange', {
      visitor: messages[messages.length - 1].content,
      ai: aiReply
    }));

    // ---- Bump follow-up activity tracking, if this session's lead email has
    // already fired (i.e. it's verified) ----
    // Keeps verifiedpending:* current so the scheduled() cron near the bottom
    // of this file can tell "gone quiet 2+ minutes since the last email" apart
    // from "still actively typing" — see that function for the full picture.
    ctx.waitUntil((async () => {
      const key = `verifiedpending:${sessionId}`;
      const pendingRaw = await env.ASK_LOGS.get(key);
      if (!pendingRaw) return;
      const pending = JSON.parse(pendingRaw);
      pending.lastActivityAt = Date.now();
      await env.ASK_LOGS.put(key, JSON.stringify(pending), { expirationTtl: 60 * 60 * 24 });
    })());

    // ---- Contact-capture detection ----
    // The model is instructed (system prompt Section 4) to emit a JSON block
    // wrapped in <lead>...</lead> the moment it has captured usable contact info.
    // We extract it here, strip it from what the visitor sees, and fire the email.
    // NOTE: the model can't reliably remember it already sent one — the client only
    // stores the stripped, visible reply in history, not the raw <lead> tag — so we
    // enforce "only one email per session" here, server-side, rather than trusting it.
    const leadMatch = aiReply.match(/<lead>([\s\S]*?)<\/lead>/);
    let visibleReply = aiReply;

    // Defensive truncation guard (added 24 August 2026, real live-test find) —
    // a reply that opens a <lead> tag but never reaches its closing tag (most
    // likely max_tokens cutting generation off mid-JSON, since the prompt
    // deliberately puts this block at the very end of a reply, right where a
    // length limit bites first) won't match the regex above at all — which
    // used to mean the raw, half-written tag ('<lead>{"name":"Chris",' and
    // all) leaked straight into what the visitor sees. Confirmed via a real
    // transcript the same day. This strips anything from an unclosed "<lead>"
    // onward before the visitor ever sees it, with a generic continuer if that
    // leaves nothing visible at all, and logs it separately from the clean,
    // complete-tag path so a real pattern of truncation (vs. the model simply
    // forgetting to close it) is visible going forward.
    if (!leadMatch) {
      const unclosedLeadIndex = aiReply.indexOf('<lead>');
      if (unclosedLeadIndex !== -1) {
        visibleReply = aiReply.slice(0, unclosedLeadIndex).trim() || "Got that, thanks — one moment.";
        ctx.waitUntil(logEvent(env, sessionId, 'lead_tag_unclosed_truncated', { raw: aiReply.slice(unclosedLeadIndex) }));
      }
    }

    // Diagnostic safety net — the prompt instructs the model to emit <lead> the
    // moment it has a phone number, but real testing (Nathan, 28 July) showed
    // this can silently fail to fire even when everything was actually captured
    // in the visible conversation. This won't fix a miss, but it makes sure we'd
    // SEE it happen next time instead of it vanishing without a trace.
    const visitorMsg = messages[messages.length - 1].content;
    const looksLikePhoneNumber = /\b\d{8,10}\b/.test(visitorMsg.replace(/[\s-]/g, ''));
    if (!leadMatch && looksLikePhoneNumber) {
      // Same leadcaptured-or-leadsent check as the duplicate-<lead> guard
      // above, and for the same reason (23 August 2026 redesign): a lead can
      // be genuinely captured (leadcaptured) well before it's verified
      // (leadsent) now, so checking leadsent alone would spuriously flag
      // sessions that actually captured fine and are just mid-verification.
      const alreadyFlagged = (await env.ASK_LOGS.get(`leadcaptured:${sessionId}`)) || (await env.ASK_LOGS.get(`leadsent:${sessionId}`));
      if (!alreadyFlagged) {
        ctx.waitUntil(logEvent(env, sessionId, 'possible_missed_lead', {
          visitorMessage: visitorMsg,
          aiReply
        }));
      }
    }

    if (leadMatch) {
      visibleReply = aiReply.replace(leadMatch[0], '').trim();
      // NOTE (23 August 2026): this used to check leadsent:* directly, back
      // when that flag was set the instant a lead was captured. Now leadsent
      // only gets set once verification actually succeeds (see
      // sendLeadEmailOnVerification), so a duplicate <lead> tag emitted
      // BEFORE verification completes would slip past a leadsent-only check
      // and re-trigger the whole capture flow again — overwriting pendinglead
      // and firing a second verification code. leadcaptured:* is set the
      // moment pendinglead is stored (below) specifically to catch that case
      // too, not just the post-verification one.
      const alreadyCaptured = (await env.ASK_LOGS.get(`leadcaptured:${sessionId}`)) || (await env.ASK_LOGS.get(`leadsent:${sessionId}`));
      if (alreadyCaptured) {
        ctx.waitUntil(logEvent(env, sessionId, 'lead_duplicate_suppressed', { raw: leadMatch[1] }));
      } else {
        try {
          const lead = JSON.parse(leadMatch[1]);

          // Real regression, 5 August 2026 (first live Twilio-approved test):
          // the model emitted <lead> right after capturing a name, before a
          // phone or email was ever asked for or given — and this code sent
          // it anyway, permanently marking the session as "already captured"
          // with blank contact fields. Section 7 of the prompt already says
          // this shouldn't happen, but per Design Principle #1 a prompt rule
          // alone isn't a guaranteed behaviour on a high-stakes moment — this
          // is the code-level backstop, same pattern as the channel-lock and
          // no-backtrack checks already in buildDynamicContext().
          const hasPhone = typeof lead.phone === 'string' && lead.phone.trim().length > 0;
          const hasEmail = typeof lead.email === 'string' && /@[\w.-]+\.\w+/.test(lead.email.trim());
          if (!hasPhone && !hasEmail) {
            ctx.waitUntil(logEvent(env, sessionId, 'lead_incomplete_suppressed', { raw: leadMatch[1] }));
            // Deliberately do NOT set the leadsent flag — the model still
            // gets a real chance to emit a genuinely complete lead later in
            // the same conversation, rather than being permanently locked
            // out by its own premature attempt.
          } else {
            ctx.waitUntil(logEvent(env, sessionId, 'lead_captured', lead));

            // ---- Verification-gated lead email (redesigned 23 August 2026) ----
            // Old behaviour: the full lead email fired the instant contact info
            // was captured, before verification even started — Chris was being
            // notified about leads that might never actually pass verification,
            // and missing anything said after verification succeeded because
            // the email had already gone out before then.
            // New behaviour: nothing is sent yet. Everything needed to build the
            // email is stashed here, and the actual send is triggered by
            // verification succeeding (see sendLeadEmailOnVerification below) —
            // verification is now a gate, not a trust bonus. TTL is longer than
            // the verify windows themselves (20-30 min) as a buffer for retries.
            ctx.waitUntil(env.ASK_LOGS.put(
              `pendinglead:${sessionId}`,
              JSON.stringify({ lead, messages, lastAiReply: aiReply, capturedAt: Date.now() }),
              { expirationTtl: 60 * 60 * 2 }
            ));
            ctx.waitUntil(env.ASK_LOGS.put(`leadcaptured:${sessionId}`, '1', { expirationTtl: 60 * 60 * 24 * 90 }));

            // ---- Kick off phone verification, if a phone number was given ----
            const normalizedPhone = normalizeAuPhone(lead.phone);
            if (normalizedPhone) {
              ctx.waitUntil(env.ASK_LOGS.put(`awaitingverify:${sessionId}`, normalizedPhone, { expirationTtl: 60 * 20 }));
              // Log the attempt BEFORE calling Twilio — if this entry exists
              // but no verify_start_success/failed ever follows it, that
              // proves the failure is in OUR code (the call never resolved
              // either way), not Twilio's. Closes the exact ambiguity that
              // caused real confusion on 5-6 August 2026.
              ctx.waitUntil(logEvent(env, sessionId, 'verify_start_attempted', { phone: normalizedPhone }));
              ctx.waitUntil(
                twilioVerifyStart(env, normalizedPhone)
                  .then(result => logEvent(env, sessionId, 'verify_start_success', {
                    phone: normalizedPhone,
                    twilioSid: result.sid,
                    twilioStatus: result.status
                  }))
                  .catch(err => {
                    console.error('Twilio verify start failed:', err.message);
                    return logEvent(env, sessionId, 'verify_start_failed', { error: String(err), phone: normalizedPhone });
                  })
              );
              visibleReply += "\n\nI've just sent a quick verification code to that number — pop it in here if you get a sec, so we know it's a real line.";
            }

            // ---- Kick off email verification, if an email was given ----
            // Same non-blocking, trust-bonus philosophy as phone — the lead
            // email has already fired regardless. Unlike Twilio, there's no
            // external service to hold the code for us, so we generate a real
            // random 6-digit code (crypto.getRandomValues, not Math.random —
            // this is a security-relevant value) and hold it in KV ourselves.
            // 30-minute window rather than phone's 20 — email delivery is
            // slower and less predictable than SMS, so the visitor needs more
            // realistic time to notice it (including checking spam) and type
            // it back in.
            if (hasEmail) {
              const capturedEmail = lead.email.trim();
              const emailCode = generateEmailCode();
              ctx.waitUntil(env.ASK_LOGS.put(
                `awaitingemailverify:${sessionId}`,
                JSON.stringify({ email: capturedEmail, code: emailCode }),
                { expirationTtl: 60 * 30 }
              ));
              ctx.waitUntil(logEvent(env, sessionId, 'email_verify_start_attempted', { email: capturedEmail }));
              ctx.waitUntil(
                sendEmailVerificationCode(env, capturedEmail, emailCode)
                  .then(() => logEvent(env, sessionId, 'email_verify_start_success', { email: capturedEmail }))
                  .catch(err => {
                    console.error('Email verification send failed:', err.message);
                    return logEvent(env, sessionId, 'email_verify_start_failed', { error: String(err), email: capturedEmail });
                  })
              );
              visibleReply += "\n\nI've also just sent a quick verification code to that email — pop it in here whenever it lands (can take a minute or two, worth a peek in spam) so we know it's a real address.";
            }

            // ---- Safety net: no verification path exists at all ----
            // Only reachable if a phone was given but didn't normalize to a
            // recognisable AU number (odd format, foreign number, etc.) AND no
            // email was given either — hasPhone||hasEmail already guarantees at
            // least one contact method exists, so this is specifically "we have
            // contact info but no way to verify it." Under the new gated design
            // that would otherwise mean this lead NEVER gets emailed, which is a
            // worse outcome than the old always-send behaviour — so this one
            // narrow edge case still sends immediately, unverified, same as the
            // old default. Flagging this in case Chris wants different handling.
            if (!normalizedPhone && !hasEmail) {
              ctx.waitUntil(sendLeadEmail(env, sessionId, lead, messages, aiReply));
              ctx.waitUntil(env.ASK_LOGS.put(`leadsent:${sessionId}`, '1', { expirationTtl: 60 * 60 * 24 * 90 }));
              ctx.waitUntil(logEvent(env, sessionId, 'lead_email_sent_no_verification_path', {}));
            }
          }
        } catch (err) {
          ctx.waitUntil(logEvent(env, sessionId, 'lead_parse_error', { error: String(err), raw: leadMatch[1] }));
        }
      }
    }

    // action is only ever present on a tour guest's turn, and only on the
    // single turn where GO_TO actually fires (tourActionForThisTurn is
    // undefined on every other request) — JSON.stringify drops an undefined
    // property entirely, so this is fully backward-compatible with every
    // existing caller and every non-tour request shape.
    // tourQuickRepliesOverride (the fixed "Next stop" button) always wins
    // over whatever the model's own <quickreplies> tag produced on a tour
    // turn — same reasoning as GO_TO itself: this specific control can't
    // depend on the model remembering to offer it. undefined on every
    // non-tour request, so this is a no-op everywhere else.
    const responsePayload = { reply: visibleReply, quickReplies: tourQuickRepliesOverride || quickReplies };
    if (tourActionForThisTurn) responsePayload.action = tourActionForThisTurn;
    return corsResponse(jsonResponse(responsePayload));
  },

  // ---- Cron: catch conversation content added after a lead's email already
  // went out (added 23 August 2026 alongside the verification-gated redesign) ----
  // Runs on the schedule set in wrangler.toml's [triggers] block (added
  // separately — see the crons snippet noted near the top of this file).
  // Cloudflare Workers can't natively "wait N minutes then act" on their own
  // per-request — a scheduled Cron Trigger is the standard way to get that.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkVerifiedFollowUps(env));
  }
};

async function callClaude(env, messages, extraContext) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await callClaudeOnce(env, messages, extraContext);
    } catch (err) {
      lastErr = err;
      // "Network connection lost" is documented by Cloudflare as an occasional
      // transient runtime error — their own guidance is to catch and retry.
      if (err.message && err.message.includes('Network connection lost') && attempt < 3) {
        console.error(`Attempt ${attempt} failed with network error, retrying...`);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// ---- Verification-success reply: don't steamroll a still-open question ----
// Real test (23 August 2026): the AI asked "today or tomorrow?" for a
// follow-up time, and the visitor's very next message was the verification
// code arriving in their inbox, not an answer to that question. The
// verification-check block above intercepts and handles codes BEFORE Claude
// ever sees the turn (deliberately — same reasoning as the phone/email check
// itself), so the fixed "Perfect, that's verified — thanks" reply was simply
// overwriting a real, still-unanswered question with no way back to it —
// "Best time to call" showed up blank in the lead email as a direct result.
// This checks whether the AI's message immediately before the code entry
// ended in a genuine question, and if so, folds it back into the
// verification reply so nothing pending just silently vanishes. Same
// philosophy as buildDynamicContext() below — a fixed, deterministic reply
// still needs to account for real conversation state, not just assume the
// happy path.
function buildVerifiedReply(messages) {
  const priorMsg = messages.length >= 2 ? messages[messages.length - 2] : null;
  const pendingQuestion = (priorMsg && priorMsg.role === 'assistant')
    ? extractTrailingQuestion(priorMsg.content)
    : null;
  return pendingQuestion
    ? `Perfect, that's verified — thanks! And just to circle back — ${pendingQuestion}`
    : "Perfect, that's verified — thanks. Chris will be in touch as arranged.";
}

// Pulls just the last question-ending sentence out of a longer reply, rather
// than re-showing the whole thing verbatim (which would also drag along
// whatever lead-in sentence came before it, e.g. "Excellent. One last
// thing —"). Returns null if the message doesn't genuinely end on a question.
function extractTrailingQuestion(text) {
  if (!text) return null;
  const sentences = text.trim().split(/(?<=[.?!])\s+/).filter(Boolean);
  const last = sentences[sentences.length - 1];
  return last && /\?\s*$/.test(last) ? last.trim() : null;
}

// ---- Dynamic conversation-state detection ----
// Real testing (31 July) showed the model reliably breaking rules that were
// ALREADY explicit in the static system prompt — asking for phone after an
// email preference was stated, backtracking to re-ask intent right after the
// fixed Contact opener, re-asking for a name already given. Adding more
// static rules hadn't fixed this pattern (three separate instances found in
// one evening). This takes a different approach: detect the actual relevant
// state from the real conversation and inject a short, specific reminder
// right before generation — proven more reliable than a rule buried in a
// long, always-present document, because it's targeted and can't get lost
// in volume the way a static instruction can.
//
// Most notes below are conditional — computed from real signals in the
// conversation history. The Quick Replies note just below is deliberately
// NOT conditional: "is my own closing question about to chain named
// alternatives with 'or'" isn't knowable from history before the model
// writes the reply, so there's no state to detect. It's included on every
// turn anyway, because the underlying failure is the exact one this
// function exists to fix — the static instruction in system-prompt.js
// (with a concrete real-testing example added 24 August 2026) was deployed
// and STILL missed a real case the same day (a three-way "or" chain, a
// different shape from the two-way examples given). This runs on Haiku, not
// a larger model — a short, repeated reminder right before generation is
// worth more than trusting one example to generalise across every phrasing.
function buildDynamicContext(messages) {
  const notes = [];

  notes.push('Before you finish this reply: if your closing question contains the word "or" joining two or more concrete, already-named alternatives, stop — that\'s a Quick Replies case (see "Guided (closed) questions — Quick Replies" and Section 8 in your instructions), not a genuinely open question. Shorten the question itself and put the alternatives in a <quickreplies> array instead of writing them into the sentence.');

  // Channel preference lock — scan in order, most recent signal wins,
  // since a visitor could genuinely change their mind mid-conversation.
  let lastChannel = null;
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const t = m.content.toLowerCase();
    if (/@[\w.-]+\.\w+/.test(m.content) || /\bemail\b/.test(t)) lastChannel = 'email';
    else if (/\bphone\b|\bcall\b|\bmobile\b/.test(t) || /\b0\d{9}\b/.test(m.content.replace(/\s/g, ''))) lastChannel = 'phone';
  }
  if (lastChannel === 'email') {
    notes.push('This visitor has established EMAIL as their contact channel. Do not mention phone calls, ask for a phone number, or offer "give you a call" — reach-out is by email only, unless they explicitly say otherwise from here.');
  } else if (lastChannel === 'phone') {
    notes.push('This visitor has established PHONE as their contact channel. Continue on that basis unless they explicitly ask for email instead.');
  }

  // Fixed Contact opener — don't backtrack and re-ask intent, don't re-ask
  // for a name that was already given as the very next reply.
  // Fixed CTA openers (Contact nav, and the four door-specific buttons added
  // 1 August — Book an Audit, Enquire, Register Interest, Enquire about an
  // Audit) — don't backtrack and re-ask intent, don't re-ask for a name that
  // was already given as the very next reply. All five share the same
  // "already asked for a name" shape, just with a different lead-in sentence
  // naming which door — checking a shared fragment covers all of them.
  // Note: only the first fragment has ever actually matched the real opener
  // text ("Thank you for requesting contact from us. May we start with your
  // name please?") — the second string below was stale/never matched
  // anything, harmless only because .some() just needs one hit. Corrected
  // 5 August 2026 rather than left as silent dead weight.
  const FIXED_OPENER_FRAGMENTS = [
    'Thank you for requesting contact from us.',
    'may we start with your name please?'
  ];
  if (messages.length >= 1 && messages[0].role === 'assistant' &&
      FIXED_OPENER_FRAGMENTS.some(f => messages[0].content.includes(f))) {
    notes.push('This conversation began with the locked Contact opener, which already asked for a name. Do NOT backtrack to ask what they\'re looking for or what brings them in. If the visitor\'s very next message after the opener looks like a name (short, no other content), treat that as their name — do not ask for it again later in the conversation. Your very next reply should move straight into asking how they\'d like to be reached, offered as a real choice via <quickreplies>["Phone","Email"]</quickreplies> — NOT written as a sentence like "phone number or email". A real test on this exact flow (24 August 2026, on Sonnet) produced "What\'s the best phone number or email to reach you on?" as plain text — that specific phrasing is the failure to avoid here.');
  }

  return notes.length ? '\n\nCONVERSATION-STATE REMINDERS (based on what has actually happened in this specific conversation — these override general instructions where they conflict):\n' + notes.map(n => '- ' + n).join('\n') : '';
}

async function callClaudeOnce(env, messages, extraContext) {
  const apiKey = (env.ANTHROPIC_API_KEY || '').trim();
  const nowBrisbane = new Date().toLocaleString('en-AU', {
    timeZone: 'Australia/Brisbane',
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true
  });
  const systemWithTime = SYSTEM_PROMPT
    + `\n\nCurrent date/time in Brisbane right now: ${nowBrisbane}. Use this to reason sensibly about "today" and "this morning/afternoon" — never offer a same-day time window that has already passed.`
    + buildDynamicContext(messages)
    // Tour-turn-only addition (see the guest-side state machine in fetch())
    // — empty string on every non-tour request, so this is a no-op there.
    + (extraContext || '');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5', // switched from claude-haiku-4-5-20251001 on 24 August 2026 — Haiku showed a real, repeated Quick Reply reliability miss (inline "X, or Y?" phrasing instead of the <quickreplies> tag) that survived two rounds of prompt-level escalation (static example, then an unconditional per-turn dynamic reminder in buildDynamicContext). Roughly doubles per-call API cost ($2/$10 vs $1/$5 per million input/output tokens), which stays negligible at PromptWorkx's modeled traffic (~$105/month even at a heavy 1,500-conversation month) — revisit only if real-world cost or latency says otherwise.
      max_tokens: 500, // structural backstop for the "short, conversational" rule, not the primary length control (system-prompt.js's "Response length" rule is) — raised 220 -> 300 -> 500. 300 still wasn't enough: real testing (24 August 2026) cut a legitimate long answer off mid-sentence ("Does that" — a visitor had explicitly asked "How it works", which the prompt's own rule permits going longer for). A longer legitimate reply (headers, a few bullet-style points) genuinely needs more than 300 tokens; 500 gives real headroom without inviting unbounded rambling.
      system: systemWithTime,
      messages: messages.map(m => ({ role: m.role, content: m.content }))
    })
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error('Response status text:', res.statusText);
    throw new Error(`Anthropic API ${res.status}: ${errBody}`);
  }
  const data = await res.json();
  const textBlock = data.content.find(b => b.type === 'text');
  return textBlock ? textBlock.text : '';
}

// ---- Quick Reply detect-and-retry backstop (added 24 August 2026) ----
// See the call site in fetch() for the full "why" — this is the detector half
// of that design. Deliberately conservative and cheap: it only ever raises a
// candidate for the corrective pass below to judge, it never decides on its
// own that Quick Replies are required, and it never writes any of the actual
// button text itself.
function detectQuickReplyCandidate(replyText) {
  const sentences = replyText.trim().split(/(?<=[.?!])\s+/).filter(Boolean);
  const last = sentences[sentences.length - 1];
  if (!last) return null;
  const trimmed = last.trim();
  if (!/\?\s*$/.test(trimmed)) return null; // only consider genuine closing questions

  // Signal A: the closing question joins alternatives with "or" — a useful,
  // high-confidence signal per Charlie's review, but explicitly NOT sufficient
  // on its own to prove a closed set (plenty of genuinely open questions use
  // "or" too) — which is exactly why this only flags a candidate rather than
  // deciding anything.
  const hasOrChain = /\bor\b/i.test(trimmed) && trimmed.length >= 15;

  // Signal B: a short, simple yes/no- or preference-shaped offer with no "or"
  // in it at all — covers the real failure "Want to know what happens after
  // the check, if it turns up a problem?" (24 August 2026), which had zero
  // instances of the word "or" and would be invisible to Signal A alone. This
  // is precisely the case Charlie's review warned "or" alone isn't sufficient
  // signal. Deliberately NOT anchored to the very start of the sentence (first
  // version was — missed "How would you like us to reach you?", a second real
  // failure the same day, because "How" comes before "would you like") —
  // searches anywhere in the closing question instead.
  const looksLikeYesNoOffer = /^(want to|would you like|would you|should i|should we|shall i|shall we|is it|is this|is that|are you|do you|does|did you|have you|has|can i|could i|may i|how would you|how do you|how should|what would you|which (one|of))\b/i.test(trimmed) && trimmed.length <= 160;

  if (hasOrChain) return { shape: 'or-chain', sentence: trimmed };
  if (looksLikeYesNoOffer) return { shape: 'yes-no-offer', sentence: trimmed };
  return null;
}

// Narrow system prompt for the corrective pass — deliberately NOT the full
// SYSTEM_PROMPT. This call has one job (revise a closing question's format),
// not "have a conversation as PromptWorkx," so it gets its own short, focused
// instructions rather than the full ~5,400-token conversational prompt, which
// keeps the call cheap and avoids dragging in irrelevant tone/sales rules.
const CORRECTION_SYSTEM_PROMPT = `You are reviewing a single draft reply from a conversational assistant. This is a narrow editing task, not a fresh conversation turn — you are not talking to the visitor.

Look only at the draft's closing question (its final sentence). If, and only if, it offers a genuinely small, already-named, known set of concrete alternatives (a real yes/no, or 2-4 specific named choices), rewrite the reply so that:
- the closing question is shortened so it no longer spells the alternatives out in the sentence itself
- the alternatives are provided via this exact machine-readable tag at the very end of the reply: <quickreplies>["Choice one","Choice two"]</quickreplies> — a JSON array of 1 to 4 short strings, each under 40 characters, worded the way the visitor would actually say them
- every other part of the draft — the substantive answer, and any <lead>...</lead> block if present — is preserved exactly as written, unchanged

If the closing question is genuinely open-ended, or you cannot confidently and conservatively identify real, already-named alternatives worth boxing, do NOT force it. In that case reply with exactly the text NO_CHANGE and nothing else.

Output nothing except either (a) the complete corrected reply text, or (b) exactly NO_CHANGE. No preamble, no explanation, no commentary, and no surrounding quotation marks of any kind — the draft below is shown to you wrapped in triple quotes purely so you can see where it starts and ends, that wrapping is not part of the reply and must never be echoed back in your output.`;

// Fires one, and only one, corrective API call — never a loop. Returns null on
// any failure (network error, non-OK response) or when the model itself
// declines with NO_CHANGE, so the caller's fail-closed handling is identical
// either way: fall back to the original first-pass reply.
async function attemptQuickReplyCorrection(env, messages, failedReply) {
  const apiKey = (env.ANTHROPIC_API_KEY || '').trim();
  const transcript = messages.map(m => `${m.role === 'user' ? 'Visitor' : 'Assistant'}: ${m.content}`).join('\n');
  const userContent = `Conversation so far:\n${transcript}\n\nDraft reply just generated (needs review):\n"""${failedReply}"""\n\nApply the correction task to this draft now.`;

  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 400,
        system: CORRECTION_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }]
      })
    });
  } catch (err) {
    console.error('Quick Reply correction fetch failed:', err.message);
    return null;
  }

  if (!res.ok) {
    const errBody = await res.text();
    console.error('Quick Reply correction API error:', res.status, errBody);
    return null;
  }
  const data = await res.json();
  const textBlock = data.content.find(b => b.type === 'text');
  let text = textBlock ? textBlock.text.trim() : '';
  if (!text || text === 'NO_CHANGE' || /^NO_CHANGE\b/.test(text)) return null;

  // Defensive strip (added 24 August 2026, real live-test find): the draft
  // above is shown to the model wrapped in """ purely as a delimiter, but a
  // real corrected reply came back with that exact wrapping echoed into the
  // visible output — literal """ marks reaching the visitor. Prompt wording
  // now explicitly forbids it too, but this strips a matching leading/trailing
  // wrapper defensively regardless, same belt-and-braces principle as every
  // other code-level backstop in this file.
  if (text.startsWith('"""') && text.endsWith('"""') && text.length > 6) {
    text = text.slice(3, -3).trim();
  } else if (text.startsWith('"') && text.endsWith('"') && text.length > 2) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

async function sendLeadEmail(env, sessionId, lead, messages, lastAiReply) {
  const transcript = messages.map((m, i) => ({
    visitor: m.role === 'user' ? m.content : null,
    ai: m.role === 'assistant' ? m.content : null
  }));
  const html = renderLeadEmail({ lead, sessionId, transcript, lastAiReply });
  console.log('Email HTML size (chars):', html.length);
  const rawEmail = env.LEAD_NOTIFY_EMAIL || '';
  const toEmail = rawEmail.trim();
  const body = JSON.stringify({
    from: EMAIL_FROM,
    to: toEmail,
    subject: `New enquiry: ${lead.door || 'General'}`,
    html
  });

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${env.RESEND_API_KEY}`
        },
        body
      });

      if (!res.ok) {
        const errBody = await res.text();
        console.error('Resend send failed:', res.status, errBody);
        await logEvent(env, sessionId, 'lead_email_failed', { status: res.status, error: errBody });
        return;
      }
      const data = await res.json();
      console.log('Resend send succeeded, id:', data.id);
      await logEvent(env, sessionId, 'lead_email_sent', { resendId: data.id });
      return;
    } catch (err) {
      lastErr = err;
      // Same documented, occasional Cloudflare Workers transient error we already
      // fixed for the Claude API call — Resend's fetch needs the same protection.
      if (err.message && err.message.includes('Network connection lost') && attempt < 3) {
        console.error(`Resend attempt ${attempt} failed with network error, retrying...`);
        continue;
      }
      console.error('Resend send threw an exception:', err.message);
      await logEvent(env, sessionId, 'lead_email_failed', { error: String(err) });
      return;
    }
  }
}

// ---- Tour lock-in confirmation email (added 25 August 2026, direct
// request from Chris — the final step of the "Book Tour" flow) ----
// Sent to the IDENTIFIED RA (never the guest) the moment they choose "Lock
// it in" — a Governed Action per Chris's own architecture breakdown: fixed,
// deterministic template, never model-generated, same principle as every
// other email in this file. Deliberately a much simpler template than
// sendLeadEmail above (no conversation transcript to render) — built inline
// here rather than added to email-template.js, so this feature stays
// self-contained to this one file.
async function sendTourConfirmationEmail(env, { raEmail, raName, tourName, guestName, mode, destinations, tourUrl }) {
  if (!raEmail) {
    console.error('sendTourConfirmationEmail called with no raEmail — skipping, nothing to send to.');
    return;
  }
  const stopsHtml = destinations.map(k => `<li>${escapeHtml(TOUR_DESTINATIONS[k].picker)}</li>`).join('');
  const recipientLine = mode === 'single'
    ? `Single recipient — welcomed as "${escapeHtml(guestName || '')}"`
    : 'Multiple recipients (generic welcome)';
  const html = `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto">
      <span style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#5f5e5a;">LiveAsk</span>
      <h2 style="margin:4px 0 12px 0">Tour confirmed: ${escapeHtml(tourName || 'Untitled tour')}</h2>
      <p style="color:#555">Hi ${escapeHtml(raName || '')}, this tour is locked in and ready to send.</p>
      <p><strong>Recipients:</strong> ${recipientLine}</p>
      <p><strong>Stops, in order:</strong></p>
      <ol>${stopsHtml}</ol>
      <p><strong>Tour link:</strong> <a href="${escapeHtml(tourUrl)}">${escapeHtml(tourUrl)}</a></p>
      <p style="color:#888;font-size:13px">Valid for 7 days from creation.</p>
    </div>`;

  const body = JSON.stringify({
    from: EMAIL_FROM,
    to: raEmail,
    // BCC chris@ (added 26 August 2026) — "the Tour Setup chat" half of
    // Chris's "I want to see everything for now" ask; the Tour Outcome
    // Report below covers "the final visitor chat" half.
    bcc: [platformBcc(env)],
    subject: `Tour confirmed: ${tourName || 'Untitled tour'}`,
    html
  });

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.RESEND_API_KEY}` },
      body
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error('Tour confirmation email failed:', res.status, errBody);
      return;
    }
    const data = await res.json();
    console.log('Tour confirmation email sent, id:', data.id);
  } catch (err) {
    console.error('Tour confirmation email threw an exception:', err.message);
  }
}

// ---- Tour Outcome Report (added 26 August 2026, direct request from
// Chris) ----
// Sent to the RA once a guest genuinely finishes (or deliberately ends) a
// tour — see the STARTED-state feedback handling in fetch() for the two
// triggers ("Both": auto at the final stop, or the guest's own "End tour").
// Deliberately a fully deterministic, templated recap — NOT a fresh Claude
// call — unlike the site-wide chat-copy email below, which does spend one
// extra lightweight AI call on a short summary. The difference: a tour
// already has fully structured data (which stops, in what order, a fixed
// feedback rating) that a template can recap perfectly on its own; an
// ordinary site-wide chat has no such structure, so a summary genuinely
// needs a model's judgement there. Design Principle 1 (prefer deterministic
// code over model judgement wherever it doesn't strictly need it) — reserve
// the AI call for the one case that actually requires it.
//
// Realized while designing this (worth noting since it changes the scope of
// what needed building): NO new persistence is needed to capture the
// transcript here. The browser resends the full `messages` array fresh on
// every turn — this Worker is completely stateless about conversation
// history — so at the exact moment this fires, `messages` already IS the
// complete relevant conversation. This function just renders what's already
// sitting in the current request.
async function sendTourOutcomeReportEmail(env, { tour, tourToken, progress, messages, feedback }) {
  if (!tour.raEmail) {
    console.error('sendTourOutcomeReportEmail called with no raEmail — skipping, nothing to send to.');
    return;
  }
  const stopsReached = tour.destinations.slice(0, progress.currentStopIndex + 1);
  const endedEarly = stopsReached.length < tour.destinations.length;
  const stopsHtml = stopsReached.map(k => {
    const dest = TOUR_DESTINATIONS[k];
    const link = buildDestinationLink(k);
    return `<li>${link ? `<a href="${escapeHtml(link)}">${escapeHtml(dest.picker)}</a>` : escapeHtml(dest.picker)}</li>`;
  }).join('');

  const transcriptRows = messages.map(m => {
    if (m.role === 'user') {
      return `<tr><td style="padding:10px 14px; background-color:#f0f4f8; border-radius:6px; font-size:14px; color:#1d2b3a;"><strong style="color:#5f5e5a; font-size:12px; text-transform:uppercase;">Guest</strong><br>${escapeHtml(m.content)}</td></tr>`;
    }
    return `<tr><td style="padding:10px 14px; background-color:#f7f6f1; border-radius:6px; font-size:14px; color:#1d2b3a; border-top:1px solid #e0ddd3;"><strong style="color:#5f5e5a; font-size:12px; text-transform:uppercase;">LiveAsk</strong><br>${escapeHtml(m.content)}</td></tr>`;
  }).join('<tr><td style="height:8px;"></td></tr>');

  const recipientLine = tour.guestName
    ? `Guided as "${escapeHtml(tour.guestName)}"`
    : 'Multiple-recipient link (guest not individually named)';

  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
      <span style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#5f5e5a;">LiveAsk</span>
      <h2 style="margin:4px 0 12px 0">Guided Tour Summary: ${escapeHtml(tour.tourName || 'Untitled tour')}</h2>
      <p><strong>Guest:</strong> ${recipientLine}</p>
      <p><strong>Rating:</strong> ${escapeHtml(feedback)}</p>
      <p><strong>Stops reached, in order${endedEarly ? ' (tour ended early, before the final planned stop)' : ''}:</strong></p>
      <ol>${stopsHtml}</ol>
      <p style="margin:20px 0 4px 0;font-size:13px;letter-spacing:0.5px;text-transform:uppercase;color:#5f5e5a;">Full conversation</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${transcriptRows}</table>
      <p style="color:#888;font-size:13px;margin-top:20px;">Session ${escapeHtml(tourToken)}</p>
    </div>`;

  const body = JSON.stringify({
    from: EMAIL_FROM,
    to: tour.raEmail,
    bcc: [platformBcc(env)],
    subject: `Guided tour completed: ${tour.tourName || 'Untitled tour'}`,
    html
  });

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.RESEND_API_KEY}` },
      body
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error('Tour outcome report email failed:', res.status, errBody);
      return;
    }
    const data = await res.json();
    console.log('Tour outcome report email sent, id:', data.id);
  } catch (err) {
    console.error('Tour outcome report email threw an exception:', err.message);
  }
}

// ---- Chat-copy summary (added 26 August 2026) ----
// One lightweight, dedicated Claude call — deliberately NOT the main
// callClaude/callClaudeOnce path (that one carries the full LiveAsk
// persona system prompt and is built for an ongoing visitor conversation,
// not a one-off internal summarization task). Failure here must never block
// the actual email — the transcript itself is the thing the visitor asked
// for; the one-line summary is a nice-to-have on top of it. Returns null on
// any failure so the caller falls back to a generic line instead.
async function generateChatSummary(env, messages) {
  try {
    const apiKey = (env.ANTHROPIC_API_KEY || '').trim();
    const transcript = messages.map(m => `${m.role === 'user' ? 'Visitor' : 'LiveAsk'}: ${m.content}`).join('\n');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 80,
        system: 'Summarize the following conversation between a website visitor and an AI assistant in exactly one short, plain sentence, written for the VISITOR\'s own later reference (second person — e.g. "You asked about..."). No preamble, no quotation marks, no markdown — output nothing except that one sentence.',
        messages: [{ role: 'user', content: transcript || '(no conversation content)' }]
      })
    });
    if (!res.ok) {
      console.error('Chat summary generation failed:', res.status, await res.text());
      return null;
    }
    const data = await res.json();
    const textBlock = data.content.find(b => b.type === 'text');
    const text = textBlock ? textBlock.text.trim() : '';
    return text || null;
  } catch (err) {
    console.error('Chat summary generation threw an exception:', err.message);
    return null;
  }
}

// ---- Site-wide chat-copy email (added 26 August 2026, direct request from
// Chris — "Click here to get a copy of your chat") ----
// Sent to the VISITOR's own verified email once they complete the 3-step
// verification above (see the state machine near the top of fetch()).
// Unlike the Tour Outcome Report above, this spends the one extra
// lightweight Claude call above on a short summary — deliberate, since an
// ordinary site-wide conversation has no structured data a template could
// recap on its own the way a tour's fixed stop list does (Design Principle
// 1: reserve the AI call for the one case that actually needs it). Full
// verbatim transcript included regardless, no length cap — direct call from
// Chris: "it's a chat history - they've asked for it, they'll expect it"
// (unlike the lead-capture email's own 6-entry cap in email-template.js,
// which exists purely for Resend payload-size headroom on an INTERNAL
// notification the visitor never sees — not a rule that applies here).
//
// Navigable links back to the site are only ever included when this
// session's conversation was a Custom AI Tour — a tour already has
// structured destination data (TOUR_DESTINATIONS) to build real links from.
// An ordinary site-wide chat has no equivalent structured data today, so
// this section is silently omitted there rather than guessing a link out of
// free-text conversation — flagged plainly to Chris at design time as a
// real, currently-accepted asymmetry (rich for tour guests, absent for
// ordinary visitors), not a silent gap.
async function sendChatCopyEmail(env, { sessionId, toEmail, messages, tourToken }) {
  const summary = (await generateChatSummary(env, messages)) || 'A summary of your conversation with LiveAsk.';

  const transcriptRows = messages.map(m => {
    if (m.role === 'user') {
      return `<tr><td style="padding:10px 14px; background-color:#f0f4f8; border-radius:6px; font-size:14px; color:#1d2b3a;"><strong style="color:#5f5e5a; font-size:12px; text-transform:uppercase;">You</strong><br>${escapeHtml(m.content)}</td></tr>`;
    }
    return `<tr><td style="padding:10px 14px; background-color:#f7f6f1; border-radius:6px; font-size:14px; color:#1d2b3a; border-top:1px solid #e0ddd3;"><strong style="color:#5f5e5a; font-size:12px; text-transform:uppercase;">LiveAsk</strong><br>${escapeHtml(m.content)}</td></tr>`;
  }).join('<tr><td style="height:8px;"></td></tr>');

  // BCC — chris@ always; the RA too, if this chat happened on a tour link
  // (Chris confirmed both explicitly for this specific feature).
  const bccList = [platformBcc(env)];
  let linksHtml = '';
  if (tourToken) {
    const tour = await getTour(env, tourToken);
    if (tour) {
      if (tour.raEmail) bccList.push(tour.raEmail);
      const progress = await getTourProgress(env, tourToken, sessionId);
      const stopsSeen = progress ? tour.destinations.slice(0, progress.currentStopIndex + 1) : [];
      if (stopsSeen.length > 0) {
        const linkItems = stopsSeen.map(k => {
          const dest = TOUR_DESTINATIONS[k];
          const link = buildDestinationLink(k);
          return `<li>${link ? `<a href="${escapeHtml(link)}">${escapeHtml(dest.picker)}</a>` : escapeHtml(dest.picker)}</li>`;
        }).join('');
        linksHtml = `<p style="margin:20px 0 4px 0;font-size:13px;letter-spacing:0.5px;text-transform:uppercase;color:#5f5e5a;">Where we connected</p><ol>${linkItems}</ol>`;
      }
    }
  }

  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
      <span style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#5f5e5a;">LiveAsk</span>
      <h2 style="margin:4px 0 12px 0">Your Chat Summary</h2>
      <p style="font-size:15px;line-height:1.5;">${escapeHtml(summary)}</p>
      ${linksHtml}
      <p style="margin:20px 0 4px 0;font-size:13px;letter-spacing:0.5px;text-transform:uppercase;color:#5f5e5a;">Full conversation</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${transcriptRows}</table>
      <p style="color:#888;font-size:13px;margin-top:20px;">Sent automatically by LiveAsk — Session ${escapeHtml(sessionId)}</p>
    </div>`;

  const body = JSON.stringify({
    from: EMAIL_FROM,
    to: toEmail,
    bcc: bccList,
    subject: 'Your chat with LiveAsk',
    html
  });

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.RESEND_API_KEY}` },
      body
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error('Chat-copy email failed:', res.status, errBody);
      await logEvent(env, sessionId, 'chatcopy_email_failed', { status: res.status, error: errBody });
      return;
    }
    const data = await res.json();
    console.log('Chat-copy email sent, id:', data.id);
    await logEvent(env, sessionId, 'chatcopy_email_sent', { resendId: data.id });
  } catch (err) {
    console.error('Chat-copy email threw an exception:', err.message);
    await logEvent(env, sessionId, 'chatcopy_email_failed', { error: String(err) });
  }
}

// ---- Verification-triggered lead email (added 23 August 2026) ----
// Called from BOTH the phone and email verify-success branches above —
// whichever channel verifies first is what actually sends Chris the full
// lead email now (this replaced the old instant-on-capture email). If a
// visitor gave both phone and email, only the first one to verify sends the
// full email; the second just gets the existing short "✅ verified" ping, so
// Chris isn't getting the same lead twice.
//
// currentMessages is THIS request's live, full thread (already trimmed of
// the trailing verification-code entry by the caller) — real test (23 August
// 2026, first live run of this redesign) showed that using the messages
// array captured back when the <lead> tag first fired (stored in
// pendinglead) silently dropped anything the visitor said between capture
// and verification succeeding — in the real case, their actual "visibility"
// enquiry detail never reached the email at all. pending.messages is kept
// only as a fallback for the rare case currentMessages isn't usable.
async function sendLeadEmailOnVerification(env, sessionId, channel, contactValue, currentMessages) {
  const alreadySent = await env.ASK_LOGS.get(`leadsent:${sessionId}`);
  if (alreadySent) {
    // Second channel verifying after the first already sent the full email —
    // just the existing short ping, not a duplicate full lead email.
    if (channel === 'phone') await sendVerifiedEmail(env, sessionId, contactValue);
    else await sendEmailVerifiedNotice(env, sessionId, contactValue);
    return;
  }

  const pendingRaw = await env.ASK_LOGS.get(`pendinglead:${sessionId}`);
  if (!pendingRaw) {
    // Shouldn't happen — verification only ever starts right after a lead is
    // captured — but if the pendinglead entry expired or was somehow missed,
    // fall back to the short ping rather than send a broken/empty email, and
    // log it so a real gap here would actually be visible.
    await logEvent(env, sessionId, 'pendinglead_missing_at_verification', { channel, contactValue });
    if (channel === 'phone') await sendVerifiedEmail(env, sessionId, contactValue);
    else await sendEmailVerifiedNotice(env, sessionId, contactValue);
    return;
  }

  const pending = JSON.parse(pendingRaw);
  const transcriptMessages = (Array.isArray(currentMessages) && currentMessages.length > 0)
    ? currentMessages
    : pending.messages; // fallback only
  const lastRealAiReply = [...transcriptMessages].reverse().find(m => m.role === 'assistant');
  await sendLeadEmail(
    env,
    sessionId,
    pending.lead,
    transcriptMessages,
    lastRealAiReply ? lastRealAiReply.content : pending.lastAiReply
  );
  await env.ASK_LOGS.put(`leadsent:${sessionId}`, '1', { expirationTtl: 60 * 60 * 24 * 90 });
  await logEvent(env, sessionId, 'lead_email_sent_at_verification', { channel });

  // ---- Start follow-up tracking ----
  // If the visitor keeps talking after this point, the exchange-logging code
  // in fetch() bumps lastActivityAt on every new message; checkVerifiedFollowUps
  // (cron, below) checks every run for sessions that have gone quiet 2+ minutes
  // since their last email and sends a short update rather than letting it sit
  // only in the logs.
  await env.ASK_LOGS.put(
    `verifiedpending:${sessionId}`,
    JSON.stringify({ lastEmailedAt: Date.now(), lastActivityAt: Date.now() }),
    { expirationTtl: 60 * 60 * 24 }
  );
}

async function logEvent(env, sessionId, type, data) {
  const key = `log:${sessionId}:${Date.now()}`;
  await env.ASK_LOGS.put(key, JSON.stringify({ type, ...data }), { expirationTtl: 60 * 60 * 24 * 90 }); // 90-day retention
}

// ---- Custom AI Tours: RA auth + tour storage (added 24 August 2026) ----
// See the file-header comment and the TOUR_DESTINATIONS block near the top
// for full scope/rationale. Two independent concerns live here:
//   - RA (Responsible Authority) authentication: hashPin/validateRaPin/
//     generateOpaqueToken/handleTourAuth/getRaSession — proving Chris is who
//     he says he is before letting him create a tour, WITHOUT ever sending
//     the raw PIN to the model (same "code, not the model, for anything
//     security-relevant" principle as the Twilio/email verification above).
//   - Tour storage: handleTourCreate/getTour/saveTour — the tour record
//     itself, opaque-token-addressed, KV-backed (tour:<token>).
//   - The guest-side consent gate (classifyTourConsentReply) — see its own
//     comment below for why this, too, is deterministic code and not a
//     model judgement call.
// Both auth and storage are intentionally single-RA-shaped for this testbed
// (no raName input, no roles) — see the file-header comment for why.

// SHA-256 hex digest via Workers' native Web Crypto — same "no external lib
// needed" approach as generateEmailCode()'s crypto.getRandomValues use above.
// Never compares raw PINs directly; only ever compares hashes.
async function hashPin(pin) {
  const data = new TextEncoder().encode(pin);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Fails CLOSED if the secret isn't set (misconfiguration should never mean
// "any PIN works") — same defensive posture as this file takes everywhere
// else a secret gates something. Returns true/false only, never throws on a
// simply-wrong PIN (that's a normal outcome, same as twilioVerifyCheck above).
async function validateRaPin(env, pin) {
  const expectedHash = (env.RA_PIN_HASH || '').trim();
  if (!expectedHash) {
    console.error('RA_PIN_HASH is not set — Tours RA auth will fail closed until it is.');
    return false;
  }
  if (!pin || typeof pin !== 'string') return false;
  const actualHash = await hashPin(pin.trim());
  return actualHash === expectedHash;
}

// 24 bytes (48 hex chars) of CSPRNG randomness — used for BOTH the RA session
// token and the guest tour token. Deliberately opaque (spec Section 20): no
// embedded meaning, no way to enumerate or guess a real one from another.
function generateOpaqueToken() {
  const buf = new Uint8Array(24);
  crypto.getRandomValues(buf);
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---- RA PIN entry (the "Book Tour" -> PIN prompt flow) ----
// Lockout is a single GLOBAL counter (ratourpinfails:global), not per-visitor
// — deliberate for a single-RA testbed where there's exactly one legitimate
// PIN-enterer, so anyone else attempting it is by definition not Chris. Same
// shape as the existing Twilio/email verify-attempts counters, just scoped
// globally instead of per-session since there's no session yet at this point
// in the flow — the RA hasn't started a tour, they're trying to start one.
async function handleTourAuth(env, ctx, pin) {
  const lockoutKey = 'ratourpinfails:global';
  const fails = parseInt((await env.ASK_LOGS.get(lockoutKey)) || '0', 10);
  if (fails >= RA_PIN_LOCKOUT_THRESHOLD) {
    return { ok: false, error: 'Too many incorrect attempts — try again shortly.' };
  }

  const valid = await validateRaPin(env, pin);
  if (!valid) {
    ctx.waitUntil(env.ASK_LOGS.put(lockoutKey, String(fails + 1), { expirationTtl: RA_PIN_LOCKOUT_TTL_SECONDS }));
    // Same generic-error principle as the Twilio/email code-mismatch replies
    // above — never confirm or deny which part of the input was wrong.
    return { ok: false, error: "That PIN didn't match." };
  }

  ctx.waitUntil(env.ASK_LOGS.delete(lockoutKey));
  const raSessionToken = generateOpaqueToken();
  await env.ASK_LOGS.put(
    `rasession:${raSessionToken}`,
    JSON.stringify({ createdAt: Date.now() }),
    { expirationTtl: RA_SESSION_TTL_SECONDS }
  );
  return { ok: true, raSessionToken };
}

async function getRaSession(env, raSessionToken) {
  if (!raSessionToken) return null;
  const raw = await env.ASK_LOGS.get(`rasession:${raSessionToken}`);
  return raw ? JSON.parse(raw) : null;
}

// ---- Tour creation ----
// Accepts an ORDERED list of destinations (added 24 August 2026, direct
// request from Chris — a real multi-stop guided walk, not just one fixed
// destination). `destinations` is the preferred shape: an array of
// TOUR_DESTINATIONS names, walked in that exact order. The original
// single-`destination` shape from tonight's earlier testing still works —
// silently wrapped into a one-item array — so nothing already tested breaks.
// Still fixed-list only, no natural-language authoring — see the
// file-header comment on why that's deliberately not built yet.
async function handleTourCreate(env, ctx, { raSessionToken, guestName, destination, destinations }) {
  const raSession = await getRaSession(env, raSessionToken);
  if (!raSession) {
    return { ok: false, error: 'Your session has expired — please re-enter the PIN.' };
  }

  const list = Array.isArray(destinations) ? destinations : (destination ? [destination] : []);
  if (list.length === 0) {
    return { ok: false, error: 'At least one tour destination is required.' };
  }
  const unknown = list.find(d => !TOUR_DESTINATIONS[d]);
  if (unknown) {
    return { ok: false, error: `Unknown tour destination: ${unknown}` };
  }

  // raSession from this raw-API path (the original single-shared-PIN flow)
  // carries no RA identity — see handleTourAuth — so raEmail/raName just
  // stay null for tours created this way. Only the newer in-chat "Book
  // Tour" flow (which calls createTourRecord directly, below) has an actual
  // identified RA to attach.
  const result = await createTourRecord(env, ctx, { destinations: list, guestName, raEmail: null, raName: null });
  return { ok: true, ...result };
}

// ---- Shared tour-record construction (added 25 August 2026) ----
// Factored out of handleTourCreate so both the original raw-API path above
// and the new in-chat "Book Tour" flow (see the fetch() block above) build
// an identical tour record, rather than maintaining the shape twice.
// raEmail/raName are forward-compatible plumbing for the not-yet-built Tour
// Outcome Report (an email would go to this address once that exists) —
// harmless to carry now, unused by anything else yet.
async function createTourRecord(env, ctx, { destinations, guestName, tourName, raEmail, raName }) {
  const token = generateOpaqueToken();
  // Real bug found live, 25 August 2026: this record used to also carry
  // status/currentStopIndex/lastSessionId — a SINGLE shared "where's the
  // visitor up to" slot for the whole link. "Multiple" mode's whole point
  // is one link shared by several real, unrelated people, so that shared
  // slot was guaranteed to get stomped the moment more than one of them
  // was on the tour at once (see getTourProgress/saveTourProgress's own
  // comment for the full story). This record is now genuinely just the
  // tour's fixed definition — set once here, read-only from then on.
  // Each visitor's own progress lives in its own separate record instead,
  // created the first time their session touches this token.
  const tour = {
    token,
    destinations,
    guestName: (typeof guestName === 'string' && guestName.trim()) ? guestName.trim() : null,
    // A human-readable label for the tour itself (added 25 August 2026,
    // direct request from Chris — once one RA can run several tours at
    // once, they need a way to tell them apart; see the multi-RA directory
    // section for why that's no longer a conflict once names exist).
    // Unused by the guest-facing side entirely — purely for the RA's own
    // reference (the lock-in confirmation email, and any future tour list).
    tourName: (typeof tourName === 'string' && tourName.trim()) ? tourName.trim() : null,
    createdAt: Date.now(),
    raEmail: raEmail || null,
    raName: raName || null,
    // ---- lockedIn (added 26 August 2026) ----
    // Distinguishes the RA's OWN preview run(s) of a tour from a real guest's
    // visit, for the Tour Outcome Report below — replaces an earlier, more
    // complex "separate preview link vs guest link" idea. The tour link
    // itself never changes; what changes is this one flag. False from the
    // moment a draft is created (including through the "quick run-through"
    // preview step, which deliberately runs on this same unlocked link — see
    // the AWAITING_PREVIEW_OFFER step) and flips permanently true the moment
    // the RA chooses "Lock it in" (see that handler below, the only place
    // that ever sets this true). The confirmation email — the only channel
    // that ever hands the real link to anyone else — fires at that exact
    // moment, so any guest session whose progress record is first created
    // while this is still false is unambiguously the RA testing their own
    // link, never a real visitor. Stamped onto that session's own progress
    // record as `isPreview` at first contact — see the guest-side state
    // machine above.
    lockedIn: false
  };
  await saveTour(env, token, tour);
  ctx.waitUntil(logEvent(env, `tour:${token}`, 'tour_created', { destinations, guestName: tour.guestName, tourName: tour.tourName, raEmail: tour.raEmail, raName: tour.raName }));

  const tourUrl = `${ALLOWED_ORIGIN}/?tour=${token}`;
  return { tourUrl, token, expiresAt: Date.now() + TOUR_EXPIRY_SECONDS * 1000 };
}

// ---- Multi-RA directory (added 25 August 2026, direct request from Chris)
// ----
// The original design had exactly one shared PIN for the whole site — fine
// for a single-RA testbed, wrong once real named colleagues need to book
// tours of their own. Each Responsible Authority now gets their own record,
// keyed by email, plus a second lookup entry mapping their PIN's hash
// straight to that email (the actual "who just typed this PIN" step). Two
// KV entries per RA:
//   ra:<email>       -> { name, email, phone, pinHash, createdAt }
//   rapin:<pinHash>  -> email
// Deliberately NOT a raw PIN comparison against a list — same "never
// compare or store the plaintext PIN" rule as hashPin()/validateRaPin()
// above, just extended to more than one PIN.
// Records are created by a one-off local script Chris runs himself (not
// this file — see scripts/add-ra.js in the Worker project), the same shape
// as how the original single RA_PIN_HASH secret was set. A proper in-app
// setup UI for adding/editing RAs is flagged as a future item once there's
// real demand for one, not built now — see the file header.
async function findRaByPin(env, pin) {
  if (!pin || typeof pin !== 'string' || !pin.trim()) return null;
  const hash = await hashPin(pin.trim());
  const email = await env.ASK_LOGS.get(`rapin:${hash}`);
  if (!email) return null;
  const raw = await env.ASK_LOGS.get(`ra:${email}`);
  return raw ? JSON.parse(raw) : null;
}

// ---- Per-session PIN lockout for the in-chat "Book Tour" flow (added 25
// August 2026) ----
// The ORIGINAL handleTourAuth (above) uses one GLOBAL lockout counter —
// correct back when there was exactly one legitimate PIN-enterer, so anyone
// else attempting it was by definition not Chris. That stops being true
// with multiple real RAs: one person mistyping their own PIN five times
// must never lock every OTHER RA out too (direct request from Chris,
// confirmed 25 August 2026: "only the one failed RA gets blocked, other
// users stay ok"). Scoped by the browser tab's own sessionId rather than by
// RA identity, because a WRONG guess can't be attributed to a specific RA —
// only a right one can. The tab that's failing is the only identity
// available before a PIN is confirmed to belong to anyone.
async function checkRaLockout(env, sessionId) {
  const fails = parseInt((await env.ASK_LOGS.get(`rabookfails:${sessionId}`)) || '0', 10);
  return fails >= RA_PIN_LOCKOUT_THRESHOLD;
}
async function recordRaPinFailure(env, ctx, sessionId) {
  const key = `rabookfails:${sessionId}`;
  const fails = parseInt((await env.ASK_LOGS.get(key)) || '0', 10);
  ctx.waitUntil(env.ASK_LOGS.put(key, String(fails + 1), { expirationTtl: RA_PIN_LOCKOUT_TTL_SECONDS }));
}
async function clearRaPinFailures(env, ctx, sessionId) {
  ctx.waitUntil(env.ASK_LOGS.delete(`rabookfails:${sessionId}`));
}

// ---- "Book Tour" in-chat flow state (added 25 August 2026) ----
// A short-lived, per-session state machine — AWAITING_PIN ->
// AWAITING_RECIPIENT_COUNT -> (AWAITING_GUEST_NAME if 'single') -> done —
// tracked entirely server-side so an abandoned flow can't leave the guest's
// OWN ordinary conversation permanently stuck expecting a PIN. 15-minute
// TTL: generous for someone genuinely mid-setup, short enough that an
// abandoned attempt doesn't linger for days.
const BOOK_TOUR_FLOW_TTL_SECONDS = 60 * 15;
async function getBookFlow(env, sessionId) {
  const raw = await env.ASK_LOGS.get(`bookflow:${sessionId}`);
  return raw ? JSON.parse(raw) : null;
}
async function saveBookFlow(env, sessionId, state) {
  await env.ASK_LOGS.put(`bookflow:${sessionId}`, JSON.stringify(state), { expirationTtl: BOOK_TOUR_FLOW_TTL_SECONDS });
}
async function clearBookFlow(env, ctx, sessionId) {
  ctx.waitUntil(env.ASK_LOGS.delete(`bookflow:${sessionId}`));
}
// Deliberately tight (exact phrase, not "contains") to avoid an ordinary
// visitor's unrelated sentence accidentally kicking off RA setup — same
// anchored-match reasoning as wantsNextTourStop() and
// classifyTourConsentReply() elsewhere in this file.
function isBookTourTrigger(text) {
  return /^book\s+tour$/i.test((text || '').trim());
}

// ---- RA destination picker (added 25 August 2026, direct request from
// Chris) ----
// Presents whatever destinations haven't been picked yet as buttons, in
// TOUR_DESTINATION_ORDER, plus "Done" once at least one is picked. A
// cross-page destination's button label already says which page it's on
// (see `picker` in TOUR_DESTINATIONS, e.g. "LiveAsk page — Hero" vs plain
// "LiveAsk") — Chris's "thin divider between pages" idea is a real UI
// polish item deliberately NOT built this round (the current Quick Reply
// component only renders a flat button row, no grouping/divider support —
// that's a genuine frontend interface change, not a one-line addition),
// distinguishing by label text instead so the information is still there.
// Flagged here plainly rather than silently skipped.
function buildDestinationPickerPrompt(picked) {
  const remaining = TOUR_DESTINATION_ORDER.filter(k => !picked.includes(k));
  const choices = remaining.map(k => TOUR_DESTINATIONS[k].picker);
  if (picked.length > 0) choices.push('Done');
  const intro = picked.length === 0
    ? "Now, here's the list of available page sections — pick which ones you'd like to guide your guest to, in order, then choose Done."
    : `Got it — so far: ${picked.map(k => TOUR_DESTINATIONS[k].picker).join(' → ')}. Pick the next stop, or choose Done if that's everything.`;
  // Same 4-choice cap as every other Quick Reply row in this file (see
  // validQuickReplies() on the frontend and the parsing near callClaude
  // below). With exactly 4 destinations total today this never truncates —
  // worst case is 4 remaining + 0 Done, or 3 remaining + 1 Done, always
  // <=4. Adding a 5th destination to TOUR_DESTINATIONS would need this
  // revisited (the 0-picked case would then need 5 buttons at once).
  return { reply: intro, quickReplies: choices.slice(0, 4) };
}

function buildDestinationsConfirmPrompt(picked) {
  const list = picked.map(k => TOUR_DESTINATIONS[k].picker).join(' → ');
  return {
    reply: `So the stops will be: ${list}. Are these correct?`,
    quickReplies: ['Yes', 'Change']
  };
}

// Factored out 27 August 2026 so the in-chat Book Tour PIN step (above) and
// the new Admin "Create Tour" handoff (adminCreateTourStart, below) produce
// byte-identical text/quickReplies from the single point each of them enters
// the SAME proven bookflow AWAITING_RECIPIENT_COUNT state — two different
// front doors into one unchanged engine, not two copies of it.
function raConfirmedRecipientCountPrompt(raName) {
  return {
    reply: `Thanks, ${raName} — confirmed. Firstly, will there be one recipient or multiple for this new tour?`,
    quickReplies: ['Single', 'Multiple']
  };
}

async function getTour(env, token) {
  if (!token) return null;
  const raw = await env.ASK_LOGS.get(`tour:${token}`);
  return raw ? JSON.parse(raw) : null;
}

async function saveTour(env, token, tour) {
  await env.ASK_LOGS.put(`tour:${token}`, JSON.stringify(tour), { expirationTtl: TOUR_EXPIRY_SECONDS });
}

// ====================================================================
// ---- Admin / Secondary Input Layer (added 27 August 2026, LiveAsk UI
// Panel Upgrade v3 — Sections 5.1.E, 7, 8.4) ----
// ====================================================================
//
// Deliberately its OWN request shapes (body.adminAuth / body.adminAction),
// never riding through `messages`/conversationHistory at all — unlike the
// in-chat "Book Tour" PIN step (which still goes through messages, then gets
// masked client-side and redacted server-side — see PIN_PROMPT_TEXT/
// redactPinFromMessages above), the target architecture here is PREVENTION,
// not masking (spec v3 Section 5.1.E: "the PIN should not enter the normal
// chat path" at all). There is nothing to redact because it never arrives.
//
// Reuses, rather than re-implements:
//   - findRaByPin (identity) — same RA records the in-chat flow uses;
//   - checkRaLockout/recordRaPinFailure/clearRaPinFailures — already scoped
//     by browser sessionId, not RA identity or UI surface, so this is a
//     second caller of the exact same primitives, not a parallel lockout
//     mechanism (there is still only ONE rabookfails:<sessionId> counter per
//     tab — a visitor who fails the Admin PIN and then tries "book tour" in
//     the same tab, or vice versa, shares the same lockout, which is the
//     correct, conservative behaviour for one browser tab making repeated
//     bad guesses regardless of which door it tried them through).
//
// adminManageTours* below all resolve Run/Test and Edit WITHOUT any new
// per-session server-side state machine (no adminpreview:/adminedit: KV
// namespace) — both return their full option set in ONE response and let
// the client page/select through it locally:
//   - Run/Test: buildPreviewStopNarration is pure and already takes an
//     explicit index — computing all stops' narration in one array and
//     paging through it client-side is simpler than round-tripping bookflow's
//     AWAITING_PREVIEW_RUN machinery, and just as safe: this NEVER visits the
//     real guest link or touches a tourprogress: record, so it stays exactly
//     as safe to re-run after lock-in as before — the RA is reading fixed,
//     narrated text about their own tour, not opening the URL a guest would.
//   - Edit: with exactly 4 possible destinations total (TOUR_DESTINATION_ORDER),
//     an ordered tap-to-pick multi-select fits the Secondary Input Layer's
//     "small contextual choice set" primitive (spec Section 3.4) better than
//     reusing the one-at-a-time conversational picker built for Tour
//     creation — same underlying data (TOUR_DESTINATIONS), simpler UX for
//     editing an already-existing list.
//
// Every per-token action below re-checks tour.raEmail === admin.raEmail
// (requireOwnedTour) — an authenticated RA must never review/preview/edit/
// duplicate/revoke/extend another RA's tour merely by knowing its token.

async function handleAdminAuth(env, ctx, sessionId, pin) {
  if (!sessionId || typeof sessionId !== 'string') {
    return { ok: false, error: 'Bad request' };
  }
  if (await checkRaLockout(env, sessionId)) {
    return { ok: false, error: 'Too many incorrect attempts — try again shortly.', locked: true };
  }
  const ra = await findRaByPin(env, pin);
  if (!ra) {
    ctx.waitUntil(recordRaPinFailure(env, ctx, sessionId));
    ctx.waitUntil(logEvent(env, sessionId, 'admin_auth_failed', {}));
    return { ok: false, error: "That PIN didn't match." };
  }
  ctx.waitUntil(clearRaPinFailures(env, ctx, sessionId));
  await env.ASK_LOGS.put(
    `adminsession:${sessionId}`,
    JSON.stringify({ raEmail: ra.email, raName: ra.name, createdAt: Date.now() }),
    { expirationTtl: ADMIN_SESSION_TTL_SECONDS }
  );
  ctx.waitUntil(logEvent(env, sessionId, 'admin_auth_ok', { raEmail: ra.email }));
  return { ok: true, raName: ra.name };
}

async function getAdminSession(env, sessionId) {
  if (!sessionId) return null;
  const raw = await env.ASK_LOGS.get(`adminsession:${sessionId}`);
  return raw ? JSON.parse(raw) : null;
}

async function handleAdminAction(env, ctx, params) {
  const { sessionId, action } = params || {};
  if (!sessionId || typeof action !== 'string') {
    return { ok: false, error: 'Bad request' };
  }
  const admin = await getAdminSession(env, sessionId);
  if (!admin) {
    return { ok: false, error: 'Your admin session has expired — please re-enter your PIN.', expired: true };
  }

  switch (action) {
    case 'createTourStart':
      return adminCreateTourStart(env, ctx, sessionId, admin);
    case 'manageToursList':
      return adminManageToursList(env, admin);
    case 'manageToursReview':
      return adminManageToursReview(env, params.token, admin);
    case 'manageToursPreview':
      return adminManageToursPreview(env, params.token, admin);
    case 'manageToursEditOptions':
      return adminManageToursEditOptions(env, params.token, admin);
    case 'manageToursEditConfirm':
      return adminManageToursEditConfirm(env, ctx, sessionId, params.token, params.destinations, admin);
    case 'manageToursDuplicate':
      return adminManageToursDuplicate(env, ctx, sessionId, params.token, admin);
    case 'manageToursRevoke':
      return adminManageToursRevoke(env, ctx, sessionId, params.token, admin);
    case 'manageToursExtend':
      return adminManageToursExtend(env, ctx, sessionId, params.token, admin);
    case 'manageQuickMenuList':
      return { ok: true, items: await listQuickMenuItems(env) };
    case 'manageQuickMenuAdd':
      return adminQuickMenuAdd(env, ctx, sessionId, params.item, admin);
    case 'manageQuickMenuDelete':
      return adminQuickMenuDelete(env, ctx, sessionId, params.id, admin);
    default:
      return { ok: false, error: 'Unknown admin action.' };
  }
}

// Shared ownership check — { ok:true, tour } or { ok:false, error }, never
// throws, never distinguishes "doesn't exist" from "not yours" in the error
// text (same generic-error principle as PIN mismatches elsewhere in this
// file — no reason to confirm to a caller which case it was).
async function requireOwnedTour(env, token, admin) {
  const tour = await getTour(env, token);
  if (!tour || tour.raEmail !== admin.raEmail) {
    return { ok: false, error: "That tour couldn't be found." };
  }
  if (!Array.isArray(tour.destinations)) {
    tour.destinations = tour.destination ? [tour.destination] : [];
  }
  return { ok: true, tour };
}

// ---- Create Tour (Admin entry point, Section 8.3) ----
// Hands off directly into the SAME proven bookflow state machine Tour
// creation already uses, at the exact point the in-chat PIN step would have
// landed on success (AWAITING_RECIPIENT_COUNT) — Admin's own Secondary Input
// PIN already authenticated this RA, so there's no PIN step to repeat. Every
// step from here on (recipient count, guest/tour name, destination picking,
// preview, lock-in) is untouched, ordinary bookflow — the client transitions
// out of the Secondary Input Layer and back into the normal chat panel to
// continue it, exactly as if the RA had typed "book tour" and their PIN.
async function adminCreateTourStart(env, ctx, sessionId, admin) {
  await saveBookFlow(env, sessionId, { step: 'AWAITING_RECIPIENT_COUNT', raEmail: admin.raEmail, raName: admin.raName });
  ctx.waitUntil(logEvent(env, sessionId, 'admin_create_tour_started', { raEmail: admin.raEmail }));
  return { ok: true, ...raConfirmedRecipientCountPrompt(admin.raName) };
}

// ---- Manage Tours: list (Section 8.4) ----
// Documented MVP scalability limitation (confirmed 27 August 2026, see
// docs/LiveAsk_UI_Panel_Upgrade_20260827_v3.md's Addendum): there is no
// per-RA key namespace (tour:<token>, not tour:<raEmail>:<token>), so this
// scans EVERY tour system-wide and filters by raEmail after fetching each
// record — O(all tours in the system) per view, not O(this RA's tours).
// Acceptable at PromptWorkx's current single-RA, low-volume scale; not
// grounds to redesign the Tour KV key structure in this UI phase.
//
// Status is Active/Expired ONLY (no invented Completed/Revoked field, no
// per-guest-derived status), inferred purely from the KV listing's own
// `expiration` (epoch seconds — set automatically from the expirationTtl
// saveTour/createTourRecord already write). Real, honest limitation worth
// documenting here: once Cloudflare KV actually garbage-collects an expired
// key (which happens some further, unspecified time after expiry — list()
// can still surface an already-past-expiration key for a window before
// that), the tour disappears from this list entirely, not just re-labelled
// Expired forever. There is no way to show a permanent history of past
// tours with the current KV-only storage — see the Widget Session
// Architecture doc's own KV-vs-D1 section for the same gap noted elsewhere.
// Legacy tours created via the original raw-API path (handleTourCreate with
// no raSessionToken identity — raEmail: null) never match any RA's email and
// so never appear here — also documented, not a bug.
async function adminManageToursList(env, admin) {
  const nowSeconds = Date.now() / 1000;
  const tours = [];
  let cursor;
  do {
    const listing = await env.ASK_LOGS.list({ prefix: 'tour:', cursor });
    for (const key of listing.keys) {
      const raw = await env.ASK_LOGS.get(key.name);
      if (!raw) continue;
      let tour;
      try { tour = JSON.parse(raw); } catch { continue; }
      if (tour.raEmail !== admin.raEmail) continue;
      const token = key.name.slice('tour:'.length);
      tours.push({
        token,
        tourName: tour.tourName || null,
        guestName: tour.guestName || null,
        status: (key.expiration && key.expiration < nowSeconds) ? 'Expired' : 'Active',
        createdAt: tour.createdAt || null,
        expiresAt: key.expiration ? key.expiration * 1000 : null
      });
    }
    cursor = listing.list_complete ? undefined : listing.cursor;
  } while (cursor);
  return { ok: true, tours };
}

// ---- Manage Tours: Review (Section 8.4 "Review") ----
// Cheap, honest "engagement" signal alongside the stored definition — counts
// tourprogress:<token>:* records (a real, existing, per-token-prefixable KV
// scan, same list()-by-prefix pattern as everything else in this file), and
// splits preview vs real-guest using each record's own isPreview flag
// (stamped once, at first contact — see getTourProgress's own comment).
// This is NOT the Tour Outcome Report (that stays email-only, per the
// Addendum's explicit "omit View outcome/report" decision) — just a live
// count of who has opened this specific link.
async function adminManageToursReview(env, token, admin) {
  const owned = await requireOwnedTour(env, token, admin);
  if (!owned.ok) return owned;
  const tour = owned.tour;
  // Narrow, explicitly-approved exception (28 August 2026 UI refinement
  // pass): expose the already-stored KV expiration for THIS tour so the
  // Tour Detail screen can show it, using the exact same list()-by-prefix
  // pattern adminManageToursList already uses to read key.expiration (a
  // plain get() never returns it — only list() surfaces KV TTL metadata).
  // No new data is created here, nothing else about this response changes.
  let expiresAt = null;
  const expListing = await env.ASK_LOGS.list({ prefix: `tour:${token}` });
  const expKey = expListing.keys.find(k => k.name === `tour:${token}`);
  if (expKey && expKey.expiration) expiresAt = expKey.expiration * 1000;
  let guestSessions = 0, previewSessions = 0;
  let cursor;
  const prefix = `tourprogress:${token}:`;
  do {
    const listing = await env.ASK_LOGS.list({ prefix, cursor });
    for (const key of listing.keys) {
      const raw = await env.ASK_LOGS.get(key.name);
      if (!raw) continue;
      let progress;
      try { progress = JSON.parse(raw); } catch { continue; }
      if (progress.isPreview) previewSessions++; else guestSessions++;
    }
    cursor = listing.list_complete ? undefined : listing.cursor;
  } while (cursor);
  return {
    ok: true,
    tour: {
      token,
      tourName: tour.tourName || null,
      guestName: tour.guestName || null,
      raName: tour.raName || null,
      destinations: tour.destinations.map(k => TOUR_DESTINATIONS[k] ? TOUR_DESTINATIONS[k].picker : k),
      lockedIn: !!tour.lockedIn,
      createdAt: tour.createdAt || null,
      guestSessions,
      previewSessions,
      expiresAt
    }
  };
}

// ---- Manage Tours: Run/Test (Section 8.4 "Run/Test") ----
// Reuses buildPreviewStopNarration exactly as the RA's own creation-time
// preview does (see that function's header) — computed for every stop in
// one response, since it's pure/deterministic and takes an explicit index,
// so the client can page Next/Back locally with no further server round
// trips. Never touches the real `?tour=<token>` guest link or any
// tourprogress: record — this is why it stays safe to re-run at any time,
// including after lock-in: it was never "the guest experience" in the first
// place, only a narrated summary of it inside the RA's own Admin session.
async function adminManageToursPreview(env, token, admin) {
  const owned = await requireOwnedTour(env, token, admin);
  if (!owned.ok) return owned;
  const destinations = owned.tour.destinations;
  const stops = destinations.map((_, i) => ({
    index: i,
    isLast: i === destinations.length - 1,
    text: buildPreviewStopNarration(destinations, i, i === 0)
  }));
  return { ok: true, stops };
}

// ---- Manage Tours: Edit (Section 8.4 "Edit") ----
// Returns every possible destination plus which ones this tour currently
// has, in order — the client renders an ordered tap-to-pick multi-select
// (same TOUR_DESTINATION_ORDER/`picker` labels the creation-time picker
// already uses) and submits the whole new list in one shot via
// manageToursEditConfirm below, rather than round-tripping one destination
// at a time. See this file's header comment on this design choice.
async function adminManageToursEditOptions(env, token, admin) {
  const owned = await requireOwnedTour(env, token, admin);
  if (!owned.ok) return owned;
  return {
    ok: true,
    allDestinations: TOUR_DESTINATION_ORDER.map(k => ({ key: k, picker: TOUR_DESTINATIONS[k].picker })),
    current: owned.tour.destinations
  };
}

// Same validation as handleTourCreate (non-empty, every key known) — this is
// the one place besides tour creation itself that writes `destinations`, so
// it must hold to the same rule. Explicitly refreshes the 7-day TTL on save
// (same as Extend expiry) rather than trying to preserve whatever time was
// left — the simpler, honestly-documented behaviour: editing a tour also
// renews it, consistent with "you just touched this record."
async function adminManageToursEditConfirm(env, ctx, sessionId, token, destinations, admin) {
  const owned = await requireOwnedTour(env, token, admin);
  if (!owned.ok) return owned;
  if (!Array.isArray(destinations) || destinations.length === 0) {
    return { ok: false, error: 'At least one tour destination is required.' };
  }
  const unknown = destinations.find(d => !TOUR_DESTINATIONS[d]);
  if (unknown) {
    return { ok: false, error: `Unknown tour destination: ${unknown}` };
  }
  const updated = { ...owned.tour, destinations };
  await saveTour(env, token, updated);
  ctx.waitUntil(logEvent(env, sessionId, 'admin_tour_edited', { token, raEmail: admin.raEmail }));
  return { ok: true, destinations: destinations.map(k => TOUR_DESTINATIONS[k].picker) };
}

// ---- Manage Tours: Duplicate (Section 8.4 "Duplicate") ----
// Reads the existing record and calls the existing, unchanged
// createTourRecord — no new tour-storage capability required, per the
// Addendum. A fresh token/link, not a rename of the original.
async function adminManageToursDuplicate(env, ctx, sessionId, token, admin) {
  const owned = await requireOwnedTour(env, token, admin);
  if (!owned.ok) return owned;
  const tour = owned.tour;
  const result = await createTourRecord(env, ctx, {
    destinations: tour.destinations,
    guestName: tour.guestName,
    tourName: tour.tourName ? `${tour.tourName} (copy)` : null,
    raEmail: admin.raEmail,
    raName: admin.raName
  });
  ctx.waitUntil(logEvent(env, sessionId, 'admin_tour_duplicated', { fromToken: token, newToken: result.token, raEmail: admin.raEmail }));
  return { ok: true, ...result };
}

// ---- Manage Tours: Revoke (Section 8.4 "Revoke") — MVP behaviour,
// explicitly documented as such (confirmed 27 August 2026, see the
// Addendum): an immediate KV delete of the tour record. There is no soft-
// revoke/status flag — this is not "final", just what the current storage
// supports today. Effect: the guest link fails the exact same way an
// already-expired link does, IMMEDIATELY, including for a guest mid-tour on
// it right now. The explicit "this will stop working immediately, including
// for anyone currently using it" warning is a CLIENT-side confirmation-
// dialog responsibility (see the frontend Manage Tours UI) — this function
// only performs the already-confirmed deletion.
async function adminManageToursRevoke(env, ctx, sessionId, token, admin) {
  const owned = await requireOwnedTour(env, token, admin);
  if (!owned.ok) return owned;
  await env.ASK_LOGS.delete(`tour:${token}`);
  ctx.waitUntil(logEvent(env, sessionId, 'admin_tour_revoked', { token, raEmail: admin.raEmail }));
  return { ok: true };
}

// ---- Manage Tours: Extend expiry (Section 8.4 "Extend expiry") ----
// Genuinely new small capability, per the Addendum: no prior code path
// re-put an existing tour record. Re-writes the SAME record unchanged with a
// fresh TOUR_EXPIRY_SECONDS TTL.
async function adminManageToursExtend(env, ctx, sessionId, token, admin) {
  const owned = await requireOwnedTour(env, token, admin);
  if (!owned.ok) return owned;
  await saveTour(env, token, owned.tour);
  ctx.waitUntil(logEvent(env, sessionId, 'admin_tour_extended', { token, raEmail: admin.raEmail }));
  return { ok: true, expiresInDays: TOUR_EXPIRY_SECONDS / (60 * 60 * 24) };
}

// ====================================================================
// ---- Customer Quick Menu (Section 6/7.1) ----
// ====================================================================
// One record per item, keyed by an opaque id (not RA-scoped — Section 6.2:
// the LiveAsk section is platform-owned and never RA-editable, but the
// entire Quick Menu namespace below the divider belongs to "the customer",
// which for this single-customer build is simply "whichever RA is
// authenticated" — there is no multi-tenant customer concept to scope by
// yet, matching Section 6.3's explicit instruction not to build one
// speculatively). No TTL — permanent config, not session state, until an RA
// deletes it.
const QUICKMENU_ACTION_TYPES = ['page', 'chat', 'contact']; // Go to page / Start conversation / Contact action — Section 7.1

async function listQuickMenuItems(env) {
  const items = [];
  let cursor;
  do {
    const listing = await env.ASK_LOGS.list({ prefix: 'quickmenuitem:', cursor });
    for (const key of listing.keys) {
      const raw = await env.ASK_LOGS.get(key.name);
      if (!raw) continue;
      try { items.push(JSON.parse(raw)); } catch { /* skip a corrupt record rather than fail the whole menu */ }
    }
    cursor = listing.list_complete ? undefined : listing.cursor;
  } while (cursor);
  // Stable, predictable order for a small hand-managed list — oldest first.
  items.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  return items;
}

// Single-shot add: the client collects title/type/target across its own
// Secondary Input Layer steps (Section 7.1's "title, then behaviour, then
// confirm" sequence) entirely in memory, and only calls the Worker once with
// the complete, already-confirmed draft — no per-step server-side state
// machine needed for a form this small (contrast with Tour creation's
// bookflow, which genuinely needs to survive across many separate chat
// turns). Validates the same governed action types Section 7.1 specifies —
// "Contact action" is deliberately NOT free text (Section 7.1: "bind only to
// an existing approved contact mechanism, do not invent a contact
// destination") — it must name one of the site's existing NAV_INTENTS
// contact-shaped entries, not an arbitrary string.
async function adminQuickMenuAdd(env, ctx, sessionId, item, admin) {
  if (!item || typeof item !== 'object') return { ok: false, error: 'Bad request' };
  const title = (item.title || '').trim();
  if (!title || title.length > 40) {
    return { ok: false, error: 'The menu option needs a short title (up to 40 characters).' };
  }
  if (!QUICKMENU_ACTION_TYPES.includes(item.type)) {
    return { ok: false, error: 'Unknown menu option type.' };
  }
  let record = { id: generateOpaqueToken().slice(0, 16), title, type: item.type, createdAt: Date.now(), raEmail: admin.raEmail };
  if (item.type === 'page') {
    const target = (item.target || '').trim();
    if (!target) return { ok: false, error: 'Choose a destination page for this option.' };
    record.target = target;
  } else if (item.type === 'chat') {
    const prompt = (item.prompt || '').trim();
    if (!prompt) return { ok: false, error: "Describe what LiveAsk should help the visitor with when they choose this." };
    record.prompt = prompt;
  } else if (item.type === 'contact') {
    // Bind only to an existing approved contact NAV_INTENT — see this
    // function's header comment. The approved set mirrors NAV_INTENTS in
    // liveask-widget.js (contact, book-audit, enquire-build,
    // register-protocol, enquire-opportunity) — kept in sync by hand, same
    // "small duplicated list, flagged plainly" approach TOUR_DESTINATION_SELECTORS
    // already uses in that same file for tour destinations.
    const APPROVED_CONTACT_INTENTS = ['contact', 'book-audit', 'enquire-build', 'register-protocol', 'enquire-opportunity'];
    if (!APPROVED_CONTACT_INTENTS.includes(item.contactIntent)) {
      return { ok: false, error: 'Unknown contact action.' };
    }
    record.contactIntent = item.contactIntent;
  }
  await env.ASK_LOGS.put(`quickmenuitem:${record.id}`, JSON.stringify(record));
  ctx.waitUntil(logEvent(env, sessionId, 'admin_quickmenu_item_added', { id: record.id, title, type: item.type, raEmail: admin.raEmail }));
  return { ok: true, item: record };
}

async function adminQuickMenuDelete(env, ctx, sessionId, id, admin) {
  if (!id || typeof id !== 'string') return { ok: false, error: 'Bad request' };
  await env.ASK_LOGS.delete(`quickmenuitem:${id}`);
  ctx.waitUntil(logEvent(env, sessionId, 'admin_quickmenu_item_deleted', { id, raEmail: admin.raEmail }));
  return { ok: true };
}

// ====================================================================
// ---- Give feedback (Section 5.1.C) ----
// ====================================================================
// Uses the existing 90-day structured logEvent mechanism — no new storage
// system, per the Addendum. type: 'liveask_feedback' clearly distinguishes
// this from ordinary conversation logging ('exchange' etc.) and from a
// visitor business enquiry, so nothing downstream (the lead email, the
// chat-copy summary, any future analytics read of log:* entries) could ever
// mistake a 1-5 product rating for something a visitor said to the business.
async function handleGiveFeedback(env, ctx, { sessionId, rating, comment }) {
  if (!sessionId || typeof sessionId !== 'string') return { ok: false, error: 'Bad request' };
  const ratingNum = parseInt(rating, 10);
  if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
    return { ok: false, error: 'Rating must be between 1 and 5.' };
  }
  const cleanComment = typeof comment === 'string' ? comment.trim().slice(0, 1000) : '';
  await logEvent(env, sessionId, 'liveask_feedback', { rating: ratingNum, comment: cleanComment });
  return { ok: true };
}

// ====================================================================
// ---- Restart Tour (Section 5.1.D) — contextual only, shown when a Tour
// is currently active ----
// ====================================================================
// Resets THIS session's own tourprogress record back to the exact shape a
// brand-new visit creates (see the isTourFirstContact/OPENED handling in
// fetch() above) — never touches the tour definition itself (tour:<token>,
// untouched — same definition, same authorised relationship, per Section
// 5.1.D's explicit "do not create a new Tour; do not edit the Tour
// definition"), and never touches any OTHER session's progress on a shared
// "Multiple" link, since tourprogress: is already keyed by token AND
// sessionId together (see that record's own header comment for the real
// concurrency bug this separation was built to fix).
async function handleRestartTour(env, ctx, sessionId, tourToken) {
  if (!sessionId || !tourToken) return { ok: false, error: 'Bad request' };
  const tour = await getTour(env, tourToken);
  if (!tour) return { ok: false, error: "This tour link isn't valid or has expired." };
  const freshProgress = { status: 'OPENED', currentStopIndex: 0, isPreview: false };
  await saveTourProgress(env, tourToken, sessionId, freshProgress);
  ctx.waitUntil(logEvent(env, sessionId, 'tour_restarted', { tourToken }));
  if (!Array.isArray(tour.destinations)) {
    tour.destinations = tour.destination ? [tour.destination] : [];
  }
  return { ok: true, reply: buildTourGreeting({ ...tour, currentStopIndex: 0 }), quickReplies: ['Start tour'] };
}

// ---- Per-visitor tour progress (added 25 August 2026, real concurrency
// bug found live) ----
// Real bug: getTour/saveTour above used to hold BOTH the tour's fixed
// definition (stops, names — set once at creation, never meant to change)
// AND the one currently-in-progress visitor's mutable state (status,
// currentStopIndex) in the SAME record, identified only by the tour
// token. Every new session opening that link — a second "Multiple"
// recipient, or the RA re-opening their own link to check on it — was
// treated as "a fresh arrival" and silently reset that ONE shared record,
// stomping whatever progress whoever was there before had made. That's
// not a rare edge case: "Multiple" mode's whole design intent is one link
// shared by several real, unrelated visitors, so this was guaranteed to
// bite in normal use, not just when an RA happened to test their own
// link at the wrong moment (see this file's git history for the actual
// live incident this was found from).
//
// Fix: each session gets its OWN progress record, keyed by token AND
// sessionId together — completely independent of whoever else is using
// the same link. The tour's fixed definition (getTour/saveTour above)
// goes back to being genuinely read-only after creation; nothing in the
// guest-side state machine below writes to it any more. Same TTL as the
// tour definition itself — no reason for one visitor's progress to
// outlive the link that got them there.
async function getTourProgress(env, token, sessionId) {
  if (!token || !sessionId) return null;
  const raw = await env.ASK_LOGS.get(`tourprogress:${token}:${sessionId}`);
  return raw ? JSON.parse(raw) : null;
}

async function saveTourProgress(env, token, sessionId, progress) {
  await env.ASK_LOGS.put(`tourprogress:${token}:${sessionId}`, JSON.stringify(progress), { expirationTtl: TOUR_EXPIRY_SECONDS });
}

// ---- Mid-tour Quick Replies for the chat-copy detour (added 26 August
// 2026, real bug found live: "the chat nicely allows interruption and
// discussion and keeps Next Stop & End Tour buttons... BUT not when the
// user requests email of chat midstream - then they don't repopulate.")
// The chat-copy block returns early for every one of its own steps, before
// ever reaching the STARTED-state tour handling further down that actually
// sets tourQuickRepliesOverride — so without this, a guest mid-tour who
// starts the chat-copy flow loses their Next stop/End tour (or feedback)
// buttons for the whole detour, with no visible way to keep going. This is
// a read-only mirror of exactly what that STARTED-state handling would
// compute for the CURRENT saved progress (never mutates progress itself —
// only the real tour handler owns transitions), so every chat-copy reply
// mid-tour keeps showing the right buttons throughout, not just before and
// after. Returns undefined (no override) for any non-tour or non-STARTED
// session, same as the ordinary flow would show nothing extra there either.
async function currentTourQuickReplies(env, tourToken, sessionId) {
  if (!tourToken) return undefined;
  const tour = await getTour(env, tourToken);
  if (!tour) return undefined;
  if (!Array.isArray(tour.destinations)) {
    tour.destinations = tour.destination ? [tour.destination] : [];
  }
  const progress = await getTourProgress(env, tourToken, sessionId);
  if (!progress || progress.status !== 'STARTED') return undefined;
  if (progress.awaitingFeedback) return TOUR_FEEDBACK_OPTIONS;
  const hasNextStop = progress.currentStopIndex + 1 < tour.destinations.length;
  return hasNextStop ? ['Next stop', 'End tour'] : TOUR_FEEDBACK_OPTIONS;
}

// ---- Fixed, deterministic RA-preview stop narration (rebuilt 26 August
// 2026, replacing the token+new-tab preview — see the AWAITING_PREVIEW_OFFER/
// AWAITING_PREVIEW_RUN handling above for the full story) ----
// Same "deterministic code, not a model judgement call" principle as
// buildTourGreeting below — the RA is previewing their OWN just-created
// tour, so there's nothing genuinely conversational happening yet; a short,
// fixed sentence per stop, reusing each destination's existing factual
// `context` field, is all this needs. Deliberately its own function rather
// than reusing buildTourContextNote — that one is written as an
// INSTRUCTION for the model to turn into a generated guest-facing reply,
// addressed to "the guest"; this is the actual fixed text itself, addressed
// to the RA previewing their own work.
function buildPreviewStopNarration(destinations, index, isFirst) {
  const dest = TOUR_DESTINATIONS[destinations[index]];
  const stopLabel = `Stop ${index + 1} of ${destinations.length}`;
  const intro = isFirst
    ? `Let's do a quick run-through — this is exactly what your guest will see, right here in this same window. ${stopLabel}: `
    : `${stopLabel}: `;
  return `${intro}${dest.label}. ${dest.context}`;
}

// ---- Fixed, deterministic guest-arrival greeting ----
// Spec principle: "stored intent + governed actions + generative
// conversation" — the greeting and consent ask are the "governed" part,
// fixed and code-authored, not model-generated, since nothing about them is
// genuinely context-dependent yet at this point — the guest hasn't said
// anything yet for a model to respond to.
function buildTourGreeting(tour) {
  const namePart = tour.guestName ? `, ${tour.guestName}` : '';
  const dest = TOUR_DESTINATIONS[tour.destinations[0]];
  // This whole function is FIXED, guest-facing text — no Claude call
  // happens for it (see the file-header comment above) — so unlike
  // pageMoveNote() (a system-prompt INSTRUCTION for the model, used in the
  // two functions below), a page-hopping stop 0 needs its own plain,
  // guest-facing sentence here instead.
  const pageNote = dest.page === '/' ? '' : ` That one's on our dedicated ${dest.page.replace('/', '')} page, so we'll hop over there together.`;
  return `Hi${namePart} — welcome! Chris set up a short guided tour for you, starting with ${dest.label}.${pageNote} `
    + `I'll walk the page over there and explain as we go — is that okay to start?`;
}

// Consent-turn-only context — appended to the system prompt only when the
// guest's reply to buildTourGreeting()'s question came back genuinely
// ambiguous (see classifyTourConsentReply below). Kept separate from
// buildTourContextNote() because the model's job here is narrowly "ask a
// short clarifying question", not "explain the destination" yet — that only
// happens once consent is actually established.
function buildTourConsentContext(tour) {
  const dest = TOUR_DESTINATIONS[tour.destinations[0]];
  return `\n\nCUSTOM AI TOUR — CONSENT UNCLEAR: You just asked the guest for consent to start a guided tour to ${dest.label}, and their reply didn't clearly read as a yes or a no. Ask a short, friendly clarifying question to find out if they'd like to proceed — do not describe the destination or move anywhere yet.${pageMoveNote(tour.destinations[0])}`;
}

// Ongoing-turn context, once the tour is underway (STARTED) — reminds the
// model where the guest now is right now (tour.destinations[currentStopIndex]
// — this stop only, not the whole itinerary) and what it's already
// explained, without re-triggering the consent framing on every subsequent
// turn. Whether there's a further stop after this one is handled entirely
// in code (the "Next stop" button, see fetch()) — the model is never told
// how many stops remain or asked to manage pacing itself.
//
// justArrived (added 25 August 2026, real live-test find) — the caller now
// tells this function explicitly whether THIS exact turn is the one that
// just fired GO_TO (consent's "yes", or a "Next stop" advance), rather than
// leaving the model to infer "is this my first message at this stop" from
// conversation history alone. Real testing showed that inference reliably
// failed: on the very turn a guest's "Next stop" click had just advanced
// the tour and fired GO_TO, the model treated the guest's own "Next stop"
// message as a request TO be moved rather than the trigger that already
// DID move them — producing "click the button to continue" replies even
// though the button had just been clicked and the page was already moving.
// Passing the flag explicitly removes the guesswork.
// isFinalStop (added 26 August 2026 — real bug found live: a guest reaching
// the tour's last stop got an ordinary reply with zero acknowledgement the
// tour was ending, then three feedback buttons appeared underneath it with
// no textual connection to anything — "to a user, make absolutely NO sense
// at all in the conversation context," Chris's own words from a real
// single-stop test). Without this, the model has no idea the fixed wrap-up
// buttons are about to be bolted onto its reply, so it just answers
// normally and the buttons land as a non sequitur. This is the text-side
// half of the fix — see the two call sites (OPENED->STARTED landing
// directly on a tour's only stop, and the STARTED-state advance reaching
// the actual final stop) for the state-side half: making sure
// awaitingFeedback/tourQuickRepliesOverride actually get set on the SAME
// turn this note is used, not a turn later.
function buildTourContextNote(tour, justArrived, isFinalStop) {
  const dest = TOUR_DESTINATIONS[tour.destinations[tour.currentStopIndex]];
  const arrivalInstruction = justArrived
    ? `The guest's own last message is EXACTLY what just triggered this move — the page has already scrolled to this stop as part of this same reply, right now. Do NOT tell them to click anything or wait for a button; that already happened and moving is not something you need to ask them to do again. Warmly confirm you've arrived here and give a brief, natural explanation using the context above.`
    : `You already gave the arrival explanation for this stop earlier in this conversation — do not re-introduce it or re-narrate arriving here again. Just continue the conversation naturally, grounded in what's visible here.`;
  const closingInstruction = isFinalStop
    ? `This is the LAST stop on this guided tour. After your explanation (and after actually answering whatever the guest just said, if it was a question), let them know in your own natural words that this wraps up the tour — do not literally name or describe the buttons themselves, just make it clear the tour is concluding, so the three fixed feedback buttons that will appear right after your reply make sense in context. Do not invite them to keep exploring the tour or ask if they'd like to see more stops — there are none.`
    : `Do not offer to move to a next stop yourself, or ask "want me to keep going" — that's handled by a fixed button outside your reply, never something to propose in your own words.`;
  return `\n\nCUSTOM AI TOUR — IN PROGRESS: This guest is on a live guided tour, currently at ${dest.label}. `
    + `${dest.context} Keep answers grounded in what's actually visible there unless the guest asks something unrelated. `
    + `${arrivalInstruction}${justArrived ? pageMoveNote(tour.destinations[tour.currentStopIndex]) : ''} `
    + `${closingInstruction}`;
}

// ---- Deterministic "advance to the next stop" signal (added 24 August
// 2026) ----
// The frontend's "Next stop" button always resubmits this exact text as the
// guest's next message (same mechanism Quick Reply buttons already use) —
// matched here as the primary, highest-confidence signal. The looser
// phrases below exist only because a guest might type something equivalent
// by hand instead of clicking; deliberately anchored to the START of the
// message (not "contains anywhere") to avoid a false match buried inside an
// unrelated longer sentence.
function wantsNextTourStop(text) {
  const t = (text || '').trim().toLowerCase();
  return /^(next stop|next|continue|keep going|go on|carry on|move on|what'?s next|show me (the )?next)\b/.test(t);
}

// ---- Deterministic yes/no classifier for the guest's reply to the tour
// invitation ----
// Deliberately regex-based rather than a model judgement call — same "the
// WHEN must be deterministic code, not something the model has to reliably
// remember to signal" principle documented at the top of this file for the
// GO_TO action generally. A genuinely ambiguous reply falls through to
// 'unclear', which keeps the tour in OPENED and asks the guest to clarify
// (via buildTourConsentContext above) rather than guessing either way.
function classifyTourConsentReply(text) {
  const t = (text || '').trim().toLowerCase();
  if (/^(yes|yeah|yep|yup|sure|ok|okay|k|go ahead|go for it|please|let'?s go|lets go|start|sounds good|why not)\b/.test(t)) return 'yes';
  if (/^(no|nah|nope|not now|not yet|later|skip|maybe later)\b/.test(t)) return 'no';
  return 'unclear';
}

// ---- Tour Outcome Report — feedback buttons (added 26 August 2026, direct
// request from Chris) ----
// Fixed, deterministic set — never model-generated, same principle as every
// other Governed Action control in this file. Also the exact set the
// frontend Quick Reply component renders when the Worker sends them.
const TOUR_FEEDBACK_OPTIONS = ['Great', 'It was OK', 'Not for me'];

// ---- Deterministic "end the tour now" signal (added 26 August 2026) ----
// Mirrors wantsNextTourStop's own shape and reasoning exactly — the
// frontend's "End tour" button always resubmits this exact text; the looser
// phrase exists only for a guest who types their own equivalent by hand.
// Anchored to the start of the message for the same false-match reason.
function wantsEndTour(text) {
  const t = (text || '').trim().toLowerCase();
  return /^(end tour|finish tour|that's (it|all)|i'?m done|stop( the)? tour)\b/.test(t);
}

// ---- Deterministic classifier for the guest's reply to the Tour Outcome
// Report's feedback prompt ----
// Exact match against TOUR_FEEDBACK_OPTIONS (button click sends the literal
// label), case/whitespace-insensitive so a guest typing it by hand still
// matches. Returns the canonical label (for storage/the report email) or
// null for anything else — a non-matching reply just re-presents the same
// three buttons rather than guessing, same fail-closed shape as
// classifyTourConsentReply's 'unclear' branch.
function classifyTourFeedbackReply(text) {
  const t = (text || '').trim().toLowerCase();
  return TOUR_FEEDBACK_OPTIONS.find(opt => opt.toLowerCase() === t) || null;
}

// ---- Twilio Verify integration ----

// Twilio requires E.164 format (e.g. +61437140727). Visitors will type an
// Australian number in all sorts of local formats — this normalizes the
// common ones. Returns null (not throws) if it can't confidently convert,
// so a weird/foreign number just silently skips verification rather than
// breaking the lead capture that already happened.
function normalizeAuPhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, '');
  if (/^\+61\d{9}$/.test(digits)) return digits;
  if (/^61\d{9}$/.test(digits)) return '+' + digits;
  if (/^0\d{9}$/.test(digits)) return '+61' + digits.slice(1);
  return null; // not a recognisable AU mobile/landline shape — skip verification, don't guess
}

async function twilioVerifyStart(env, phoneE164) {
  const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
  const res = await fetch(
    `https://verify.twilio.com/v2/Services/${env.TWILIO_VERIFY_SERVICE_SID}/Verifications`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ To: phoneE164, Channel: 'sms' })
    }
  );
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Twilio start ${res.status}: ${errBody}`);
  }
  // Real regression, 6 August 2026: this used to discard Twilio's response
  // entirely on success, so a "successful" call and a silently-broken one
  // were indistinguishable from our own logs. Returning the real body closes
  // that gap — status here is Twilio's own reported state ("pending",
  // "canceled", etc.), not just "the HTTP request didn't error."
  return await res.json();
}

// Returns true/false for approved/not — throws only on a genuine request failure
// (network, bad credentials), not on a simply-wrong code, which is a normal outcome.
async function twilioVerifyCheck(env, phoneE164, code) {
  const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
  const res = await fetch(
    `https://verify.twilio.com/v2/Services/${env.TWILIO_VERIFY_SERVICE_SID}/VerificationCheck`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ To: phoneE164, Code: code })
    }
  );
  if (!res.ok) {
    // Twilio returns 404/400 for an expired or already-used verification —
    // treat that as "not approved" rather than a hard error, since it's a
    // normal outcome (code expired, visitor mistyped, etc.), not a system fault.
    if (res.status === 404 || res.status === 400) return false;
    const errBody = await res.text();
    throw new Error(`Twilio check ${res.status}: ${errBody}`);
  }
  const data = await res.json();
  return data.status === 'approved';
}

async function sendVerifiedEmail(env, sessionId, phoneE164) {
  const toEmail = (env.LEAD_NOTIFY_EMAIL || '').trim();
  const body = JSON.stringify({
    from: EMAIL_FROM,
    to: toEmail,
    subject: `✅ Phone verified — ${phoneE164}`,
    html: `<p>The lead at <strong>${phoneE164}</strong> just verified their number via SMS code — session <code>${sessionId}</code>.</p>`
  });
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.RESEND_API_KEY}`
      },
      body
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error('Verified-email send failed:', res.status, errBody);
      await logEvent(env, sessionId, 'verified_email_failed', { status: res.status, error: errBody });
      return;
    }
    await logEvent(env, sessionId, 'verified_email_sent', {});
  } catch (err) {
    console.error('Verified-email send threw:', err.message);
    await logEvent(env, sessionId, 'verified_email_failed', { error: String(err) });
  }
}

// ---- Email verification (Resend-based, self-managed code) ----

// 6-digit numeric code. crypto.getRandomValues, not Math.random() — this is
// a security-relevant value (proves the visitor controls that mailbox), and
// Workers' native Web Crypto API gives us a real CSPRNG for free.
function generateEmailCode() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % 1000000).padStart(6, '0');
}

// Sends the actual code TO THE VISITOR — distinct from sendEmailVerifiedNotice
// below, which notifies Chris once it's confirmed. Throws on failure so the
// caller's .catch() can log it — mirrors how twilioVerifyStart's failure is
// surfaced, rather than swallowing it silently.
async function sendEmailVerificationCode(env, toEmail, code) {
  const body = JSON.stringify({
    from: EMAIL_FROM,
    to: toEmail,
    subject: `Your LiveAsk verification code: ${code}`,
    html: `<p>Your verification code is:</p>`
      + `<p style="font-size:28px;font-weight:700;letter-spacing:4px;">${code}</p>`
      + `<p>Pop this back into the chat to confirm it's really you. This code expires in 30 minutes.</p>`
      + `<p style="color:#888;font-size:13px;">If you didn't request this, you can safely ignore this email.</p>`
  });
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.RESEND_API_KEY}`
    },
    body
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Resend ${res.status}: ${errBody}`);
  }
  return await res.json();
}

// Internal notification to Chris once a visitor's email is confirmed —
// mirrors sendVerifiedEmail's phone equivalent above.
async function sendEmailVerifiedNotice(env, sessionId, email) {
  const toEmail = (env.LEAD_NOTIFY_EMAIL || '').trim();
  const body = JSON.stringify({
    from: EMAIL_FROM,
    to: toEmail,
    subject: `✅ Email verified — ${email}`,
    html: `<p>The lead at <strong>${email}</strong> just verified their email via code — session <code>${sessionId}</code>.</p>`
  });
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.RESEND_API_KEY}`
      },
      body
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error('Email-verified notice send failed:', res.status, errBody);
      await logEvent(env, sessionId, 'email_verified_notice_failed', { status: res.status, error: errBody });
      return;
    }
    await logEvent(env, sessionId, 'email_verified_notice_sent', {});
  } catch (err) {
    console.error('Email-verified notice send threw:', err.message);
    await logEvent(env, sessionId, 'email_verified_notice_failed', { error: String(err) });
  }
}

// ---- Post-verification follow-up cron (added 23 August 2026) ----

const FOLLOWUP_QUIET_MS = 2 * 60 * 1000; // 2 minutes of silence before a follow-up fires

// Sweeps every verifiedpending:* entry — one per session whose lead email has
// already fired — and sends a short follow-up for any that picked up new
// visitor activity since their last email and have now gone quiet for
// FOLLOWUP_QUIET_MS. Runs on the Cron Trigger schedule (see scheduled() above).
async function checkVerifiedFollowUps(env) {
  let cursor;
  do {
    const listing = await env.ASK_LOGS.list({ prefix: 'verifiedpending:', cursor });
    for (const key of listing.keys) {
      const sessionId = key.name.slice('verifiedpending:'.length);
      try {
        await maybeSendFollowUp(env, sessionId, key.name);
      } catch (err) {
        console.error(`Follow-up check failed for ${sessionId}:`, err.message);
        await logEvent(env, sessionId, 'followup_check_error', { error: String(err) });
      }
    }
    cursor = listing.list_complete ? undefined : listing.cursor;
  } while (cursor);
}

async function maybeSendFollowUp(env, sessionId, kvKey) {
  const raw = await env.ASK_LOGS.get(kvKey);
  if (!raw) return; // expired between list() and get() — fine, nothing to do

  const pending = JSON.parse(raw);
  if (pending.lastActivityAt <= pending.lastEmailedAt) return; // nothing new since the last email
  if (Date.now() - pending.lastActivityAt < FOLLOWUP_QUIET_MS) return; // still actively talking — wait

  // Reconstructs new content from the same log:* entries logEvent() already
  // writes for every turn — no new storage format needed just for this.
  const newExchanges = await getExchangesSince(env, sessionId, pending.lastEmailedAt);
  if (newExchanges.length === 0) return; // shouldn't happen given the check above, but don't send an empty email

  await sendFollowUpEmail(env, sessionId, newExchanges);
  pending.lastEmailedAt = Date.now();
  await env.ASK_LOGS.put(kvKey, JSON.stringify(pending), { expirationTtl: 60 * 60 * 24 });
  await logEvent(env, sessionId, 'lead_followup_email_sent', { exchangeCount: newExchanges.length });
}

// Strips a <lead>...</lead> block the same way the live-chat path does, plus
// the truncation case that path was patched for on 24 August 2026: a reply
// that opens a <lead> tag but never reaches its closing tag (most likely
// max_tokens cutting generation off mid-JSON) won't match the first regex at
// all, and the raw, half-written fragment would otherwise ride straight
// through into whatever reads it. Confirmed via a real follow-up email that
// went out with exactly that fragment in it, from THIS function specifically
// — getExchangesSince reads raw log:* 'exchange' entries directly, unlike
// every other email in this file, which reuses the front-end's already-
// stripped visibleReply.
function stripLeadTag(text) {
  if (typeof text !== 'string') return text;
  let cleaned = text.replace(/<lead>[\s\S]*?<\/lead>/g, '').trim();
  const unclosedIndex = cleaned.indexOf('<lead>');
  if (unclosedIndex !== -1) {
    cleaned = cleaned.slice(0, unclosedIndex).trim();
  }
  return cleaned;
}

async function getExchangesSince(env, sessionId, sinceMs) {
  const exchanges = [];
  const prefix = `log:${sessionId}:`;
  let cursor;
  do {
    const listing = await env.ASK_LOGS.list({ prefix, cursor });
    for (const key of listing.keys) {
      const ts = parseInt(key.name.slice(prefix.length), 10);
      if (!Number.isFinite(ts) || ts <= sinceMs) continue;
      const raw = await env.ASK_LOGS.get(key.name);
      if (!raw) continue;
      const entry = JSON.parse(raw);
      if (entry.type === 'exchange') {
        // logEvent('exchange', ...) stores the RAW Claude reply, <lead>...
        // tag and all — that's fine for analytics (the whole point of the
        // logs), but real test (23 August 2026, first live run of the
        // follow-up feature) showed it leaking straight into this email
        // verbatim, since this is the first thing that ever read log:*
        // 'exchange' entries to build visitor-facing content. Every other
        // email in this file uses the front-end's own conversationHistory
        // (visibleReply only, already stripped server-side) — this is the
        // one path that reads raw logs instead, so it needs its own strip.
        exchanges.push({ ts, visitor: entry.visitor, ai: stripLeadTag(entry.ai) });
      }
    }
    cursor = listing.list_complete ? undefined : listing.cursor;
  } while (cursor);
  exchanges.sort((a, b) => a.ts - b.ts);
  return exchanges;
}

async function sendFollowUpEmail(env, sessionId, exchanges) {
  const toEmail = (env.LEAD_NOTIFY_EMAIL || '').trim();
  const rows = exchanges.map(e =>
    `<p><strong>Visitor:</strong> ${escapeHtml(e.visitor || '')}</p>` +
    (e.ai ? `<p><strong>LiveAsk:</strong> ${escapeHtml(e.ai)}</p>` : '')
  ).join('<hr style="border:none;border-top:1px solid #eee;margin:12px 0;">');
  const body = JSON.stringify({
    from: EMAIL_FROM,
    to: toEmail,
    subject: `Update on verified lead — session ${sessionId.slice(0, 8)}`,
    html: `<p>This verified lead kept talking after their confirmation email went out. Here's what's new:</p>${rows}`
  });
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.RESEND_API_KEY}` },
      body
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error('Follow-up email send failed:', res.status, errBody);
      await logEvent(env, sessionId, 'lead_followup_email_failed', { status: res.status, error: errBody });
      return;
    }
    await logEvent(env, sessionId, 'lead_followup_email_sent_ok', {});
  } catch (err) {
    console.error('Follow-up email send threw:', err.message);
    await logEvent(env, sessionId, 'lead_followup_email_failed', { error: String(err) });
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

function corsResponse(res) {
  const headers = new Headers(res.headers);
  headers.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'content-type');
  return new Response(res.body, { status: res.status, headers });
}
