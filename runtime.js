// LiveAsk Platform Runtime — assets/liveask-widget.js migrated for Stage A.
//
// Consolidated 24 August 2026 from three near-identical inline copies
// (index.html, /liveask, /ai-tips); migrated 30 August 2026 into the
// reusable Platform runtime per LIVEASK_PLATFORM_HANDOFF_20260830 and the
// approved Shadow DOM architecture. State machine, Tour/Admin/Quick-Menu
// logic and event wiring are preserved exactly from that known-good
// implementation — extraction, not a rewrite. What changed is WHERE this
// file's elements live (runtime-constructed into a shadow root instead of
// assumed pre-existing customer HTML) and HOW they're queried (see the
// panel.$ / host.$ separation below), not what they do.
//
// This file is loaded by platform/loader.js, which creates the mount
// element, attaches the shadow root, and hands off configuration via
// window.__liveAskPendingConfig immediately before appending this script —
// NOT via document.currentScript, which returns null for scripts executing
// inside a shadow tree per spec, and would in any case no longer reliably
// identify "this script" once loader and runtime are two separate files.
(function(){
  'use strict';

  var cfg = window.__liveAskPendingConfig || {};
  var shadowRoot = cfg.shadowRoot;
  var mountEl = cfg.mountEl;
  if (!shadowRoot || !mountEl) {
    console.error('LiveAsk runtime: loader did not hand off a shadow root/mount element. Aborting.');
    return;
  }

  // ---- Deployment identity ----
  // Stage A: no live tenant-config resolution service exists yet (see
  // LiveAsk_Deployment_Handover.md) — data-liveask-site is read by the
  // loader for routing/identification only (never authorization; that is
  // strictly a backend Origin-validation responsibility, out of scope for
  // this frontend work) and is not yet resolved against a real backend
  // registry. Until that service exists, the company name and Worker URL
  // are supplied directly as data attributes on the loader's own script
  // tag and passed through here. Platform runtime intentionally has NO
  // hardcoded customer default — no tenant identity appears below,
  // since baking Customer 000 branding into Platform core is exactly what
  // this migration exists to avoid.
  var DEPLOYMENT_COMPANY_NAME = cfg.companyName || 'this business';
  // Platform-controlled constant — never derived from DEPLOYMENT_COMPANY_NAME.
  // "LiveAsk AI" is platform branding, not customer-specific, and must
  // never carry the deployment name. Used by the transient thinking/
  // answering identity (.ask-identity, see beginIdentity() below) — no
  // longer a permanent per-message label; the Conversation Panel
  // redesign (31 August 2026) removed the old .ask-msg .who treatment
  // that used to display this on every historical AI reply.
  var AI_SPEAKER_LABEL = 'LiveAsk AI';

  // ---- Worker URL resolution ----
  // No fallback of any kind, to any customer's Worker — CHANNEL Core must
  // never silently route a deployment to any specific customer's backend.
  // If data-worker-url is missing,
  // this fails visibly rather than guessing at a default that would
  // inevitably be wrong for someone. The `return` below stops all further
  // initialization cleanly — this file is one big IIFE, so a plain
  // top-level return here is safe and doesn't throw into the host page.
  var WORKER_URL = cfg.workerUrl;
  if (!WORKER_URL) {
    if (shadowRoot) {
      shadowRoot.innerHTML = '<div style="font-family:sans-serif;background:#fff3f3;color:#7a1f1f;border:1px solid #e0b4b4;border-radius:6px;padding:14px 18px;font-size:14px;line-height:1.5;max-width:480px;">LiveAsk configuration error: no Worker URL is set for this deployment (missing data-worker-url). LiveAsk cannot start without this — contact the site administrator.</div>';
    }
    return;
  }

  // ---- Internal vs. host DOM query separation ----
  // Not a mechanical global replace of document.* — an explicit, named
  // distinction applied deliberately at each call site, per the approved
  // architecture:
  //   panel.$ / panel.$$ / panel.byId  → always resolve against LiveAsk's
  //     own shadow tree. Used for everything that is LiveAsk's own
  //     interface: composer, thread, quick replies, the + popover, and
  //     every Admin/Tour secondary panel, since those render inside this
  //     same shadow tree.
  //   host.$ / host.$$  → always resolve against the real host document.
  //     Reserved for the small, deliberate set of intentional host-page
  //     interactions: Tour destination scrolling/highlighting and
  //     [data-nav-intent] scanning. Tour destinations, page navigation,
  //     contextual highlighting and other deliberate interactions with
  //     customer content must continue to operate against the host
  //     website — that is not something Shadow DOM should, or does,
  //     prevent.
  var panel = {
    $: function (sel) { return shadowRoot.querySelector(sel); },
    $$: function (sel) { return shadowRoot.querySelectorAll(sel); },
    byId: function (id) {
      return shadowRoot.getElementById ? shadowRoot.getElementById(id) : shadowRoot.querySelector('#' + id);
    }
  };
  var host = {
    $: function (sel) { return document.querySelector(sel); },
    $$: function (sel) { return document.querySelectorAll(sel); }
  };

  // ---- CSS delivery ----
  // Deliberately not an inline <style> element with textContent — that
  // is exactly what forces a customer's strict CSP into allowing
  // 'unsafe-inline' for style-src, an avoidable and disproportionately
  // broad ask. Constructable Stylesheets applied via adoptedStyleSheets
  // is the primary mechanism; an externally linked stylesheet (a small,
  // specific, auditable style-src addition rather than a blanket
  // allowance) is the fallback for any environment where that API isn't
  // available.
  //
  // 31 August 2026 font-loading correction: a real-browser test found
  // Barlow silently falling back to a generic sans-serif on the
  // rendered page, despite the font files genuinely being present in
  // the package and widget.css correctly declaring them. Root cause —
  // CSSStyleSheet.replaceSync() does not carry an implicit base URL the
  // way a native <link>-loaded stylesheet does; relative url(...)
  // references inside JS-constructed stylesheet text resolve against
  // the HOST PAGE's own location, not against widget.css's own path.
  // On an actual customer site this means url('fonts/barlow-400.woff2')
  // would try to load from the customer's own domain, not LiveAsk's —
  // failing silently to a fallback font with no visible error. Fixed
  // by rewriting relative url(...) references to absolute, prefixed
  // with the loader's own baseUrl, before constructing the stylesheet.
  // The <link> fallback path below needs no equivalent fix — a
  // genuinely linked stylesheet already resolves its own relative URLs
  // correctly and natively.
  function resolveRelativeCssUrls(cssText, base) {
    return cssText.replace(/url\((['"]?)([^'")]+)\1\)/g, function (match, quote, url) {
      if (/^([a-z]+:)?\/\//i.test(url) || url.indexOf('data:') === 0) return match;
      return 'url(' + quote + base + url + quote + ')';
    });
  }

  (function loadStyles() {
    var cssUrl = (cfg.baseUrl || '') + 'widget.css?v=20260912-voice-prompt-stage2-3';
    function linkFallback() {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = cssUrl;
      shadowRoot.appendChild(link);
    }
    if ('adoptedStyleSheets' in Document.prototype && typeof CSSStyleSheet === 'function') {
      fetch(cssUrl)
        .then(function (r) { return r.text(); })
        .then(function (cssText) {
          var sheet = new CSSStyleSheet();
          sheet.replaceSync(resolveRelativeCssUrls(cssText, cfg.baseUrl || ''));
          shadowRoot.adoptedStyleSheets = [sheet];
        })
        .catch(linkFallback);
    } else {
      linkFallback();
    }
  })();

  // ---- Font registration ----
  // 1 September 2026 correction. Root cause established by controlled
  // A/B browser testing (not re-investigated here, per instruction):
  // the exact same genuine Barlow binary, the exact same UIP recipe,
  // renders correctly in light DOM but silently falls back to Arial
  // once the identical @font-face rule is delivered via a Constructed
  // Stylesheet applied through shadowRoot.adoptedStyleSheets — the
  // mechanism widget.css's own @font-face rules rely on above. This is
  // a real, documented browser inconsistency: @font-face declared
  // inside a stylesheet constructed via the CSSStyleSheet API and
  // applied via adoptedStyleSheets can be present in that stylesheet's
  // own rule list without the browser actually registering the face
  // for rendering — the declaration alone is not the same thing as the
  // font actually being available, which is exactly why a computed
  // font-family string is not meaningful evidence of this bug's
  // absence: the CSS can say "LiveAsk Body" while the glyphs painted
  // on screen are still whatever system fallback stepped in.
  //
  // Fixed by registering every face explicitly via the FontFace API
  // and document.fonts.add() — deliberately not something that lives
  // inside widget.css or depends on adoptedStyleSheets at all.
  // document.fonts is the HOST DOCUMENT's own font face set, and font
  // resolution for rendering text consults that set regardless of
  // which shadow tree the text lives in — Shadow DOM scopes style
  // rules and DOM queries, not the browser's font registry, so a
  // single registration here correctly serves the UIP textarea, the
  // Conversation Panel, and anything else in this shadow tree that
  // references these family names, without any of those other places
  // needing their own copy of this logic. widget.css's own @font-face
  // rules are left in place, not removed — harmless redundancy for the
  // <link> fallback path above, where @font-face works normally and
  // this bug does not apply, and for any future browser environment
  // where the FontFace API itself might be unavailable.
  (function loadFonts() {
    if (typeof FontFace !== 'function' || !document.fonts) return;
    var base = cfg.baseUrl || '';
    var faces = [
      { family: 'LiveAsk Body', url: base + 'fonts/barlow-400.woff2', weight: '400' },
      { family: 'LiveAsk Body', url: base + 'fonts/barlow-600.woff2', weight: '600' },
      { family: 'LiveAsk Body', url: base + 'fonts/barlow-700.woff2', weight: '700' },
      { family: 'LiveAsk Mono', url: base + 'fonts/ibm-plex-mono-500.woff2', weight: '500' }
    ];
    faces.forEach(function (f) {
      try {
        var fontFace = new FontFace(f.family, "url('" + f.url + "') format('woff2')", { weight: f.weight });
        fontFace.load().then(function (loaded) {
          document.fonts.add(loaded);
        }).catch(function (err) {
          console.error('LiveAsk: font failed to load —', f.url, err);
        });
      } catch (err) {
        console.error('LiveAsk: FontFace construction failed —', f.url, err);
      }
    });
  })();

  // ---- Runtime-constructed panel DOM ----
  // The entire panel tree that used to be static markup baked into the
  // customer's own HTML (see LiveAsk_Customer_Specific_Coupling_Audit.md)
  // is built here instead, and injected into the shadow root. Structure,
  // ids and classes are preserved exactly from the known-good reference
  // markup — only WHERE this markup lives has changed, not what it is.
  // The known, accepted temporary exception this replaces — a hand-edited
  // static pre-JS placeholder/aria-label duplicated across three HTML
  // files — no longer applies at all: there is no static host-page markup
  // left for it to be a fallback for.
  shadowRoot.appendChild((function buildPanelDom() {
    var wrap = document.createElement('div');
    wrap.innerHTML =
      '<section class="ask-panel" id="ask-panel">' +
        '<div class="wrap">' +
          '<div class="ask-box">' +
            '<div class="ask-output-panel">' +
              '<div class="ask-thread" id="askThread">' +
              '</div>' +
            '</div>' +
            '<div class="ask-uip">' +
              '<div class="ask-input-row">' +
                '<img class="ask-liveask-inline" src="data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0nMS4wJyBlbmNvZGluZz0nVVRGLTgnIHN0YW5kYWxvbmU9J25vJz8+CjwhLS0gR2VuZXJhdG9yOiBBZG9iZSBJbGx1c3RyYXRvciAyNy4zLjEsIFNWRyBFeHBvcnQgUGx1Zy1JbiAuIFNWRyBWZXJzaW9uOiA2LjAwIEJ1aWxkIDApICAtLT48c3ZnIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgeG1sbnM6eGxpbms9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkveGxpbmsiIHZlcnNpb249IjEuMSIgaWQ9IkxheWVyXzEiIHg9IjBweCIgeT0iMHB4IiB2aWV3Qm94PSI0LjIgMjIuNiAzNzIuOCA5My4yIiBzdHlsZT0iZW5hYmxlLWJhY2tncm91bmQ6bmV3IDQuMiAyMi42IDM3Mi44IDkzLjI7IiB4bWw6c3BhY2U9InByZXNlcnZlIj4KPHN0eWxlIHR5cGU9InRleHQvY3NzIj4KCS5zdDB7ZmlsbDojMDA1RkFFO30KCS5zdDF7ZmlsbDpub25lO3N0cm9rZTojNDg0ODRBO3N0cm9rZS13aWR0aDozLjMxNTE7c3Ryb2tlLW1pdGVybGltaXQ6MTA7fQoJLnN0MntlbmFibGUtYmFja2dyb3VuZDpuZXcgICAgO30KCS5zdDN7ZmlsbDojNDg0ODRBO3N0cm9rZTojNDg0ODRBO3N0cm9rZS13aWR0aDoxLjM0ODg7c3Ryb2tlLW1pdGVybGltaXQ6MTA7fQoJLnN0NHtmaWxsOiMwMDVGQUU7c3Ryb2tlOiMwMDVGQUU7c3Ryb2tlLXdpZHRoOjEuMzQ4ODtzdHJva2UtbWl0ZXJsaW1pdDoxMDt9Cgkuc3Q1e2ZpbGw6IzAwNUZBRTtzdHJva2U6IzAwNUZBRTtzdHJva2Utd2lkdGg6MS4zNDg4O3N0cm9rZS1saW5lY2FwOnJvdW5kO3N0cm9rZS1taXRlcmxpbWl0OjEwO30KPC9zdHlsZT4KPGc+Cgk8Zz4KCQk8Zz4KCQkJCgkJCQk8cmVjdCB4PSIzNjMuMzQiIHk9IjMyLjk1IiB0cmFuc2Zvcm09Im1hdHJpeCg0LjQ4NjkwNmUtMTEgLTEgMSA0LjQ4NjkwNmUtMTEgMzQwLjUzODIgNDA5Ljg1NDMpIiBjbGFzcz0ic3QwIiB3aWR0aD0iMjMuNzIiIGhlaWdodD0iMy40MiIvPgoJCQk8cmVjdCB4PSIzNTMuMTkiIHk9IjIyLjgiIGNsYXNzPSJzdDAiIHdpZHRoPSIyMy43MiIgaGVpZ2h0PSIzLjQyIi8+CgkJPC9nPgoJCTxnPgoJCQkKCQkJCTxyZWN0IHg9IjM2My4zNCIgeT0iMTAyLjA5IiB0cmFuc2Zvcm09Im1hdHJpeCg0LjQ4Njg4MWUtMTEgMSAtMSA0LjQ4Njg4MWUtMTEgNDc4Ljk5ODggLTI3MS4zOTM3KSIgY2xhc3M9InN0MCIgd2lkdGg9IjIzLjcyIiBoZWlnaHQ9IjMuNDIiLz4KCQkJPHJlY3QgeD0iMzUzLjE5IiB5PSIxMTIuMjUiIGNsYXNzPSJzdDAiIHdpZHRoPSIyMy43MiIgaGVpZ2h0PSIzLjQyIi8+CgkJPC9nPgoJPC9nPgoJPGc+CgkJPGcgY2xhc3M9InN0MiI+CgkJCTxwYXRoIGNsYXNzPSJzdDMiIGQ9Ik00LjkzLDEwNi42NnYtNzQuMWg3LjExdjY3Ljc4aDM1LjIxdjYuMzJINC45M3oiLz4KCQkJPHBhdGggY2xhc3M9InN0MyIgZD0iTTY0LjU2LDQwLjc2Yy0xLjMzLDAtMi40OC0wLjQ2LTMuNDYtMS4zOWMtMC45OC0wLjkzLTEuNDctMi4wNC0xLjQ3LTMuMzNjMC0xLjMzLDAuNDktMi40NCwxLjQ3LTMuMzYgICAgIGMwLjk4LTAuOTEsMi4xMy0xLjM3LDMuNDYtMS4zN2MxLjM2LDAsMi41MiwwLjQ2LDMuNDgsMS4zN2MwLjk2LDAuOTEsMS40NCwyLjAzLDEuNDQsMy4zNmMwLDEuMjktMC40OCwyLjQtMS40NCwzLjMzICAgICBDNjcuMDgsNDAuMyw2NS45Miw0MC43Niw2NC41Niw0MC43NnogTTYxLjEzLDEwNi42NnYtNTUuNmg2Ljc2djU1LjZINjEuMTN6Ii8+CgkJCTxwYXRoIGNsYXNzPSJzdDMiIGQ9Ik0xMDEuMDcsMTA2LjY2bC0yMS4yNC01NS42aDcuMzZsMTIuODMsMzQuOTZjMS4xNiwzLjEyLDIuMTksNi4yMywzLjA4LDkuMzVjMC44OSwzLjEyLDEuODQsNi4xNSwyLjgzLDkuMSAgICAgaC0yLjM5YzAuOTYtMi45NSwxLjg5LTUuOTgsMi43OS05LjFjMC44OS0zLjExLDEuOTItNi4yMywzLjA4LTkuMzVsMTIuODMtMzQuOTZoNy4zMWwtMjEuMjQsNTUuNkgxMDEuMDd6Ii8+CgkJCTxwYXRoIGNsYXNzPSJzdDMiIGQ9Ik0xNjIuMDksMTA3Ljg1Yy01LjIxLDAtOS43MS0xLjIyLTEzLjUtMy42NmMtMy44LTIuNDQtNi43My01LjgxLTguOC0xMC4xMmMtMi4wNy00LjMxLTMuMTEtOS4yNy0zLjExLTE0Ljg3ICAgICBjMC01LjYsMS4wMi0xMC41OCwzLjA2LTE0LjkyYzIuMDQtNC4zNCw0Ljg5LTcuNzYsOC41NS0xMC4yNWMzLjY2LTIuNDksNy45Mi0zLjczLDEyLjc2LTMuNzNjMy4wNSwwLDUuOTgsMC41Niw4LjgsMS42NyAgICAgYzIuODIsMS4xMSw1LjM1LDIuOCw3LjYxLDUuMDdjMi4yNSwyLjI3LDQuMDMsNS4xNSw1LjMyLDguNjNjMS4yOSwzLjQ4LDEuOTQsNy41OCwxLjk0LDEyLjI4djIuOTNIMTQxLjF2LTUuODJoMzkuOThMMTc4LDc3LjI3ICAgICBjMC0zLjk4LTAuNjgtNy41NC0yLjA0LTEwLjY5Yy0xLjM2LTMuMTUtMy4zLTUuNjQtNS44Mi03LjQ2Yy0yLjUyLTEuODItNS41NS0yLjczLTkuMS0yLjczYy0zLjUxLDAtNi41OSwwLjkzLTkuMjIsMi43OCAgICAgYy0yLjY0LDEuODYtNC42OSw0LjMxLTYuMTcsNy4zNmMtMS40OCwzLjA1LTIuMjEsNi40LTIuMjEsMTAuMDV2My40OGMwLDQuMzQsMC43Niw4LjE1LDIuMjksMTEuNDFjMS41MiwzLjI3LDMuNjksNS44LDYuNDksNy42MSAgICAgYzIuOCwxLjgxLDYuMTEsMi43MSw5LjkyLDIuNzFjMi41OSwwLDQuODYtMC40MSw2Ljg0LTEuMjRjMS45Ny0wLjgzLDMuNjMtMS45Myw0Ljk3LTMuMzFjMS4zNC0xLjM4LDIuMzUtMi44OCwzLjAxLTQuNSAgICAgbDYuNDIsMi4wNGMtMC44NiwyLjMyLTIuMjUsNC40OC00LjE1LDYuNDdjLTEuOTEsMS45OS00LjMsMy41OS03LjE5LDQuOEMxNjkuMTUsMTA3LjI1LDE2NS44MywxMDcuODUsMTYyLjA5LDEwNy44NXoiLz4KCQkJPHBhdGggY2xhc3M9InN0NCIgZD0iTTE4OS40OSwxMDYuNjZsMjcuMTUtNzQuMUgyMjVsMjcuNCw3NC4xaC03LjQ2bC0xNy42MS00OC40NGMtMC45OS0yLjY5LTIuMDgtNS44My0zLjI2LTkuNDIgICAgIGMtMS4xOC0zLjYtMi41My03LjkzLTQuMDUtMTNoMS40OWMtMS41Miw1LjExLTIuODgsOS40OC00LjA4LDEzLjEzYy0xLjE5LDMuNjUtMi4yNCw2Ljc1LTMuMTMsOS4zTDE5NywxMDYuNjZIMTg5LjQ5eiAgICAgIE0yMDIuMTIsODQuNjN2LTYuMjdoMzcuNjV2Ni4yN0gyMDIuMTJ6Ii8+CgkJCTxwYXRoIGNsYXNzPSJzdDQiIGQ9Ik0yODEuNDQsMTA3Ljg1Yy0zLjY1LDAtNi44OC0wLjU2LTkuNy0xLjY3Yy0yLjgyLTEuMTEtNS4xNC0yLjczLTYuOTYtNC44N2MtMS44Mi0yLjE0LTMuMDctNC43Ny0zLjczLTcuODggICAgIGw2LjQ3LTEuNTRjMC44LDMuMzUsMi4zOCw1Ljg0LDQuNzUsNy40OGMyLjM3LDEuNjQsNS40LDIuNDYsOS4wNywyLjQ2YzQuMjEsMCw3LjU4LTAuOTQsMTAuMTItMi44MyAgICAgYzIuNTQtMS44OSwzLjgxLTQuMjQsMy44MS03LjA2YzAtMi4yNi0wLjc2LTQuMTMtMi4yNi01LjYyYy0xLjUxLTEuNDktMy43Ny0yLjYtNi43OS0zLjMzbC05LjA1LTIuMTkgICAgIGMtNC43OC0xLjE2LTguMzUtMi45Ny0xMC43Mi01LjQ0Yy0yLjM3LTIuNDctMy41Ni01LjU4LTMuNTYtOS4zM2MwLTMuMTIsMC44NC01Ljg1LDIuNTEtOC4yMWMxLjY3LTIuMzUsMy45OC00LjE5LDYuOTEtNS41MiAgICAgYzIuOTMtMS4zMyw2LjI3LTEuOTksMTAuMDItMS45OWMzLjUxLDAsNi41MywwLjU0LDkuMDUsMS42MmMyLjUyLDEuMDgsNC42LDIuNTksNi4yNCw0LjU1YzEuNjQsMS45NiwyLjg3LDQuMjgsMy43MSw2Ljk2ICAgICBsLTYuMTcsMS41OWMtMC44Ni0yLjU1LTIuMy00LjY3LTQuMy02LjM0Yy0yLjAxLTEuNjctNC44My0yLjUxLTguNDgtMi41MWMtMy42OCwwLTYuNzEsMC44OC05LjEsMi42NCAgICAgYy0yLjM5LDEuNzYtMy41OCw0LjAzLTMuNTgsNi44MWMwLDIuMzUsMC44LDQuMjgsMi40MSw1Ljc3YzEuNjEsMS40OSw0LjEyLDIuNjUsNy41MywzLjQ4bDguNSwyLjA0ICAgICBjNC43MSwxLjE2LDguMjMsMi45NywxMC41Nyw1LjQyYzIuMzQsMi40NSwzLjUxLDUuNTIsMy41MSw5LjJjMCwzLjE4LTAuODgsNi0yLjYzLDguNDZjLTEuNzYsMi40NS00LjIsNC4zOC03LjM0LDUuNzcgICAgIEMyODkuMTMsMTA3LjE2LDI4NS41MiwxMDcuODUsMjgxLjQ0LDEwNy44NXoiLz4KCQk8L2c+CgkJPGc+CgkJCTxnPgoJCQkJPHBhdGggY2xhc3M9InN0NSIgZD0iTTMxNy42LDEwNi42NnYtNzQuMWg3LjA2djI1LjcxbC0wLjEsMTYuNzFsMC4xLDMuNjN2MjguMDVIMzE3LjZ6IE0zMjIuNjIsODMuNjNsLTAuMjUtNy41MSAgICAgIGMxLjc5LTIuMjUsMy41NS00LjQyLDUuMjctNi40OWMxLjcyLTIuMDcsMy40Ny00LjEyLDUuMjUtNi4xNGMxLjc3LTIuMDIsMy42MS00LjA1LDUuNS02LjA3bDMwLjg3LTMyLjQzbDYuMjQsMi4yOSAgICAgIGwtMzYuMDYsMzguODRsLTAuNSwwLjE1TDMyMi42Miw4My42M3ogTTM2Ny45MiwxMTMuNTdsLTMzLjIxLTQ1Ljc2bDQuNTMtNS4zMmwzNi4xOCw1MC44NEwzNjcuOTIsMTEzLjU3eiIvPgoJCQk8L2c+CgkJPC9nPgoJPC9nPgo8L2c+Cjwvc3ZnPg==" alt="LiveAsk" width="80" height="20">' +
                '<span class="ask-fake-placeholder" id="askPlaceholder"></span>' +
                '<span class="ask-voice-status" id="askVoiceStatus" aria-live="polite"></span>' +
                '<textarea id="askInput" aria-label="' + ('Ask ' + DEPLOYMENT_COMPANY_NAME) + '" rows="1"></textarea>' +
              '</div>' +
              '<div class="ask-row2" id="askRow2">' +
                '<button type="button" class="ask-row2-plus" id="askPlusBtn" aria-label="More options" aria-haspopup="true" aria-expanded="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg></button>' +
                '<div class="ask-row2-left" id="askRow2Left"></div>' +
                '<div class="ask-row2-right">' +
                  '<button type="button" class="ask-mic" id="askMic" aria-label="Dictate message"><span class="ask-mic-surface"><span class="ask-mic-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg><span class="ask-mute-slash"></span></span><span class="ask-mic-label" id="askMicLabel">Dictate</span><span class="ask-dictation-stop" aria-hidden="true"></span></span></button>' +
                  '<button type="button" class="ask-send" id="askSend" aria-label="Start Voice"><span class="ask-connection-spinner" aria-hidden="true"></span><span class="ask-voice-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><svg class="ask-send-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="6 11 12 5 18 11"></polyline></svg><span class="ask-cancel-cross" aria-hidden="true">&times;</span><span class="ask-stop-square" aria-hidden="true"></span></button>' +
                '</div>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</section>';
    return wrap.firstElementChild;
  })());

  // 1 September 2026 correction: the four example prompts that used to
  // rotate alongside the opening one were a prior tenant's business
  // content (GEO, ChatGPT visibility, competitors in AI search) — the
  // same category of hangover already flagged and removed from the
  // post-submission placeholder, just missed here at the time since
  // only "the opening question" was named explicitly. Reduced to the
  // one universal, customer-agnostic entry actually specified, rather
  // than inventing new generic example prompts to fill the rotation
  // back up — that's new copy nobody has asked for yet. The rotation
  // mechanism itself is untouched and still safe with one entry
  // (i = (i+1) % 1 always resolves to the same index), it just has
  // nothing left to rotate through until real example content exists.
  const prompts = [
    "Ask LiveAsk AI a question...",
    "...by typing, dictating or talking!"
  ];
  let i = 0;
  const ph = panel.byId('askPlaceholder');
  const voiceStatus = panel.byId('askVoiceStatus');
  const input = panel.byId('askInput');
  const thread = panel.byId('askThread');
  const askPanel = panel.byId('ask-panel');
  const row2 = panel.byId('askRow2');
  // 26 August 2026, third correction: Row 2 now also permanently hosts mic
  // + send (moved down from Row 1) inside .ask-row2-right — so quickReply
  // buttons must be appended into this LEFT cluster specifically, not into
  // #askRow2 directly, or they'd land after mic/send in the DOM and break
  // the always-mic/send-pinned-right layout.
  const row2Left = panel.byId('askRow2Left');
  const uip = askPanel.querySelector('.ask-uip');
  const sendBtn = panel.byId('askSend');
  const micBtn = panel.byId('askMic');
  const micLabel = panel.byId('askMicLabel');

  // Contextual data-entry guidance. A normal instruction is amber; an
  // instruction following a validation failure is red. This is deliberately
  // a frontend presentation aid only: it does not alter the conversation,
  // submit data, or change any Worker/API behaviour.
  let activeInputInstructionEl = null;
  let activeInputInstruction = null;
  let inputInstructionAttentionTimer = null;
  let voicePromptEnabled = false;
  let voicePromptButton = null;
  const INPUT_INSTRUCTION_RULES = [
    { kind: 'name-business', label: 'Enter your name and business name', term: /\bname\s+and\s+business\s+name\b/i },
    { kind: 'email', label: 'Enter your email address', term: /\b(?:email|e-mail)(?:\s+address)?\b/i },
    { kind: 'phone', label: 'Enter your phone number', term: /\b(?:phone|mobile)(?:\s+(?:number|no\.?))?\b/i },
    { kind: 'name', label: 'Enter your name', term: /\b(?:full\s+)?name\b/i },
    // A direct request may say only "enter the code" after the preceding
    // clause has already established that it is a verification code.
    { kind: 'code', label: 'Enter your verification code', term: /\b(?:verification|validation|security|one[- ]time)\s+code\b|\bOTP\b|\b(?:the\s+)?code\b/i }
  ];

  function detectInputInstruction(text){
    const value = String(text || '');
    // These two governed prompts use natural conversational wording rather
    // than repeating the field name after the imperative. Resolve them
    // explicitly before the general request/field matcher.
    if (/\bwho should i say is enquiring\b/i.test(value)) {
      return { kind: 'name', label: 'Enter name here', isError: false };
    }
    if (/\b(?:verification|validation|security|one[- ]time)\s+code\b[\s\S]{0,180}\b(?:enter|type|provide)\s+(?:it|that|the code)\b/i.test(value)) {
      return {
        kind: 'code',
        label: 'Enter validation code here',
        isError: /\b(?:code|entry|value)\s+(?:is|was)\s+(?:invalid|incorrect|wrong|not valid)\b|\b(?:invalid|incorrect|wrong)\s+(?:code|entry|value)\b|\bdidn['’]?t match\b/i.test(value)
      };
    }
    // Find explicit request phrases first, then select the field nearest to
    // each request. This prevents an earlier explanatory noun from winning
    // over the real next action — for example, "send a verification code to
    // that email; please enter the code" must resolve to CODE, not EMAIL.
    const requestPattern = /\b(?:enter|type|provide|share|tell me|send me|confirm|may i have|may we (?:start with|have)|can i have|could i have|what(?:'s| is) your)\b/ig;
    const requests = [];
    let requestMatch;
    while ((requestMatch = requestPattern.exec(value)) !== null) {
      requests.push({ index: requestMatch.index, end: requestPattern.lastIndex });
    }
    if (!requests.length) return null;

    let selected = null;
    requests.forEach(function(request){
      // Stop at the next explicit request so each candidate field belongs to
      // one instruction rather than leaking in from a later instruction.
      const nextRequest = requests.find(function(candidate){ return candidate.index > request.index; });
      const end = nextRequest ? nextRequest.index : value.length;
      const clause = value.slice(request.end, end);
      INPUT_INSTRUCTION_RULES.forEach(function(candidate, ruleOrder){
        const termMatch = candidate.term.exec(clause);
        if (!termMatch) return;
        const choice = {
          rule: candidate,
          requestIndex: request.index,
          distance: termMatch.index,
          ruleOrder: ruleOrder
        };
        if (!selected || choice.requestIndex > selected.requestIndex ||
            (choice.requestIndex === selected.requestIndex && choice.distance < selected.distance) ||
            (choice.requestIndex === selected.requestIndex && choice.distance === selected.distance && choice.ruleOrder < selected.ruleOrder)) {
          selected = choice;
        }
      });
    });
    if (!selected) return null;
    const fieldErrorPattern = new RegExp(
      '(?:' + selected.rule.term.source + ')[\\s\\S]{0,48}\\b(?:invalid|incorrect|wrong|didn[’\\\']?t match|not valid)\\b' +
      '|\\b(?:invalid|incorrect|wrong)\\b[\\s\\S]{0,48}(?:' + selected.rule.term.source + ')',
      'i'
    );
    return {
      kind: selected.rule.kind,
      label: selected.rule.label,
      isError: fieldErrorPattern.test(value)
    };
  }

  function completeInputInstruction(){
    clearTimeout(inputInstructionAttentionTimer);
    inputInstructionAttentionTimer = null;
    if (activeInputInstructionEl) {
      activeInputInstructionEl.classList.remove('ask-instruction-active', 'ask-instruction-attention', 'ask-instruction-error');
      activeInputInstructionEl = null;
    }
    ph.classList.remove('ask-fake-placeholder--instruction', 'ask-fake-placeholder--instruction-error');
    activeInputInstruction = null;
    renderVoicePromptControl();
  }

  function renderVoicePromptControl(){
    if (!activeInputInstruction) {
      if (voicePromptButton) voicePromptButton.remove();
      voicePromptButton = null;
      return;
    }
    if (!voicePromptButton) {
      voicePromptButton = document.createElement('button');
      voicePromptButton.type = 'button';
      voicePromptButton.className = 'ask-voice-prompt-btn';
      voicePromptButton.addEventListener('click', function(){
        if (!voicePromptEnabled) {
          voicePromptEnabled = true;
          renderVoicePromptControl();
          startVoice({ instruction: activeInputInstruction });
        } else {
          voicePromptEnabled = false;
          renderVoicePromptControl();
        }
        if (!voicePromptEnabled && (voiceMode === 'connecting' || voiceMode === 'listening' || voiceMode === 'speaking' || voiceMode === 'muted')) {
          finishVoice({ showEnding: true });
        }
      });
      row2Left.appendChild(voicePromptButton);
    }
    voicePromptButton.textContent = voicePromptEnabled ? 'Turn Voice Off' : 'Turn Voice On';
    voicePromptButton.classList.toggle('is-off', voicePromptEnabled);
    voicePromptButton.setAttribute('aria-pressed', voicePromptEnabled ? 'true' : 'false');
    voicePromptButton.setAttribute('aria-label', voicePromptEnabled ? 'Turn Voice off.' : 'Turn Voice on and speak this instruction.');
  }

  function activateInputInstruction(text, messageEl){
    const instruction = detectInputInstruction(text);
    if (!instruction) return false;
    clearInterval(rotateTimer);
    rotateTimer = null;
    clearTimeout(rotateFadeTimeout);
    rotateFadeTimeout = null;
    completeInputInstruction();
    activeInputInstruction = instruction;
    activeInputInstructionEl = messageEl || null;
    if (activeInputInstructionEl) {
      activeInputInstructionEl.classList.add('ask-instruction-active', 'ask-instruction-attention');
      if (instruction.isError) activeInputInstructionEl.classList.add('ask-instruction-error');
    }
    ph.textContent = instruction.label;
    ph.classList.remove('fade');
    ph.classList.add('ask-fake-placeholder--instruction');
    if (instruction.isError) ph.classList.add('ask-fake-placeholder--instruction-error');
    renderVoicePromptControl();
    inputInstructionAttentionTimer = setTimeout(function(){
      if (activeInputInstructionEl) activeInputInstructionEl.classList.remove('ask-instruction-attention');
      inputInstructionAttentionTimer = null;
    }, 3200);
    return true;
  }


  // 1 September 2026 correction: this used to interpolate the
  // customer's business name and force a specific 3-line manual break
  // on narrow viewports — both tenant-specific hangovers that
  // should never have been treated as universal Platform behaviour.
  // Simplified to a fixed, short, single-line string using the exact
  // same base .ask-fake-placeholder styling as every other placeholder
  // state (no more dedicated --final treatment, no right-alignment,
  // no viewport branching) — consistent with everything else rather
  // than a one-off special case.
  function setFinalPlaceholder(){
    ph.classList.remove('ask-fake-placeholder--instruction', 'ask-fake-placeholder--instruction-error');
    ph.textContent = 'Ask another question';
  }

  // Sticky panel — pinned via CSS (position:sticky). The panel and its
  // response thread stay fully visible at all times once a conversation's
  // active — the page content scrolls past the panel, not the other way
  // around. Only job here is the subtle "pinned" border cue once it's
  // actually stuck to the top, for a bit of visual feedback.
  window.addEventListener('scroll', function(){
    askPanel.classList.toggle('pinned', window.scrollY > 4);
  }, { passive: true });
  let rotateFadeTimeout = null;
  let rotateTimer = null;
  function startRotation(){
    rotateTimer = setInterval(function(){
      ph.classList.add('fade');
      rotateFadeTimeout = setTimeout(function(){
        i = (i + 1) % prompts.length;
        ph.textContent = prompts[i];
        ph.classList.remove('fade');
      }, 600);
    }, 3000);
  }

  function pauseRotation(){
    ph.classList.add('fade');
  }
  // Real bug fix, 7 August 2026: the placeholder previously only faded on
  // typing or submit — simply clicking into the empty field left it fully
  // visible, cluttering the real native caret rendering right on top of it.
  // 7 August 2026, later: the panel now auto-focuses on page load so the
  // real cursor is blinking immediately, not only after a tap. That first,
  // script-triggered focus must NOT fade the placeholder (visitors should
  // still see the rotating prompt suggestions) — only a genuine user tap
  // should trigger the fade. autoFocusPending tracks that distinction.
  // ---- Reveal-on-interaction (added 25 August 2026, replaces the removed
  // "Reopen chat" tab) ----
  // Expands the panel to show what's already in conversationHistory — but
  // ONLY when there's actually something to show. Historical note: an
  // earlier version of this expand logic had a real bug here because
  // the now-removed floating close button was positioned absolute
  // against .ask-box, which only grows tall enough to fit an
  // absolutely-positioned child once .ask-thread.active has real
  // content — expanding with zero history briefly left a short box
  // with that button landing on top of the send button. The button
  // itself is gone (31 August 2026, replaced by the persistent
  // footer's "Hide Chat ⌃" control), but the underlying box-growth
  // timing insight this comment records is still accurate for
  // anything else that might ever be absolutely positioned here.
  // There's also nothing meaningful to "reveal" for a brand new
  // visitor anyway — the rotating placeholder already is their
  // experience.
  function revealPanel(){
    if (conversationHistory.length === 0) return;
    askPanel.querySelector('.ask-box').classList.add('expanded');
    thread.classList.add('active');
  }

  let autoFocusPending = true;
  input.addEventListener('focus', function(){
    if (autoFocusPending) {
      autoFocusPending = false;
    } else {
      // Real bug fix, 7 August 2026: this was previously outside the
      // if/else, so it fired on the very first auto-triggered landing
      // focus too — killing rotation before it ever got to cycle even
      // once, freezing the placeholder on its first static prompt. Moved
      // here so only a genuine subsequent tap (or the post-submit refocus,
      // which is itself gated by autoFocusPending) stops it.
      //
      // Real bug fix, 26 August 2026: pauseRotation() was unconditional
      // here, so a genuine tap into an EMPTY box — with no rotation even
      // running (e.g. the "final"/post-conversation placeholder, or the
      // brief window before the first reply lands) — still added the
      // shared 'fade' class. Since the logo and the textarea's own left
      // padding now key off that same class (see the CSS :has() rules), a
      // plain tap with zero characters typed was enough to start the logo
      // fading and the padding collapsing — the exact glitch reported live:
      // a half-transparent logo with the moving caret cutting through it,
      // triggered purely by focusing, not by actually typing anything.
      // Guarding on rotateTimer restricts the fade to when rotation is
      // genuinely active (the only case this was ever meant to cover) —
      // real typing still fades things correctly regardless, via the
      // separate 'input' listener below, which checks input.value.length.
      if (rotateTimer) { pauseRotation(); }
      clearInterval(rotateTimer); rotateTimer = null;
      clearTimeout(rotateFadeTimeout);
      // Covers a genuinely NEW focus — e.g. tabbing into the field with a
      // keyboard when it wasn't already focused. See the separate 'click'
      // listener below for why this alone isn't enough.
      revealPanel();
    }
  });
  // Real bug found testing this exact addition (25 August 2026): the page
  // auto-focuses the input on load (see the 'load' listener below), so by
  // the time a real visitor actually clicks into it, it's usually ALREADY
  // focused — and clicking an already-focused element fires no new 'focus'
  // event at all, so the reveal logic above silently never ran on a plain
  // click. Same root cause as the documented 7 August fix for rotation-
  // stop below (input event vs. focus event) — a genuine 'click' fires
  // every single time regardless of prior focus state, which 'focus'
  // fundamentally cannot guarantee. autoFocusPending doesn't need
  // checking here: the landing autofocus is triggered from script via
  // input.focus(), never a real click, so this listener is naturally never
  // reached by it.
  input.addEventListener('click', revealPanel);
  input.addEventListener('blur', function(){
    if (input.value.length === 0) {
      ph.classList.remove('fade');
    }
  });
  // Auto-focus on landing so the real cursor blinks immediately — desktop
  // only. Real bug found live on mobile, 25 August 2026 (Jolene's tour
  // link): this used to run unconditionally on every page load, phone or
  // not. On a touch device that queues the on-screen keyboard to open the
  // instant the page finishes loading — often not even visibly firing
  // until later, once page layout/scrolling settles (Android was seen
  // popping the keyboard exactly when the tour's first scroll-to-stop
  // animation ran, well after the actual focus() call). A tour guest
  // landing on a personalised link is never expected to type immediately;
  // neither, really, is an ordinary visitor just arriving on their phone.
  // (pointer: coarse) is the standard, UA-sniff-free way to detect a
  // touch-primary device — skip the auto-focus there entirely. Desktop
  // (pointer: fine, no on-screen keyboard to disturb) keeps the original
  // courteous cursor-ready-on-landing touch, unchanged.
  //
  // IMPORTANT — this ONLY ever gates this one script-triggered focus() call
  // on page load. A visitor's own genuine tap into the input still opens
  // the keyboard exactly as any text field always does on any device —
  // that's native browser behaviour, entirely separate from this code, and
  // nothing here touches it (see the 'click' listener above, which only
  // reveals the panel and never blocks or replaces the browser's own
  // focus-on-tap handling).
  window.addEventListener('load', function(){
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return;
    input.blur();
    requestAnimationFrame(function(){
      input.focus({ preventScroll: true }); // real paint gap before refocus — back-to-back blur/focus can get coalesced by the browser with no gap between them
    });
  });
  function autoGrow(){
    input.style.height = 'auto';
    input.style.height = input.scrollHeight + 'px';
  }
  input.addEventListener('input', function(){
    const hasText = input.value.length > 0;
    ph.classList.toggle('fade', hasText);
    input.closest('.ask-input-row').classList.toggle('has-text', hasText);
    // Real bug fix, 7 August 2026: rotation-stop only ever lived inside the
    // 'focus' event handler — but clicking into an ALREADY-focused element
    // (which it is, after page-load autofocus) never fires a new focus
    // event at all. So typing directly after landing never stopped
    // rotation, even though it looked like it should. The 'input' event
    // fires on every real keystroke regardless of focus history — the
    // actually reliable signal for "user is genuinely typing."
    clearInterval(rotateTimer); rotateTimer = null;
    clearTimeout(rotateFadeTimeout);
    autoGrow();
    updatePrimaryControlState();
    updatePrimaryControlState();
  });

  // WORKER_URL is now resolved once, near DEPLOYMENT_COMPANY_NAME above —
  // see the "Worker URL resolution" comment there. (Extraction, 30 August
  // 2026: this used to be the hardcoded declaration; left this note in
  // place rather than silently vanishing the line, since anyone comparing
  // against the original reference file would otherwise wonder where it
  // went.)

  // ---- RA PIN masking (added 25 August 2026) ----
  // Must match index-worker.js's own PIN_PROMPT_TEXT constant exactly —
  // this is the one fixed string submitToPanel checks for to know "the
  // very next thing typed is a PIN, not an ordinary message." See
  // submitToPanel's own comment at the point this is used for the full
  // picture of what does and doesn't get masked/stored/sent.
  const PIN_PROMPT_TEXT = "Sure — what's your PIN?";

  // ---- "Get a copy of your chat" trigger string ----
  // Must match index-worker.js's own CHAT_COPY_TRIGGER constant exactly.
  const CHAT_COPY_TRIGGER = "Get a copy of my chat";

  // ============================================================
  // Conversation Panel redesign, 31 August 2026, per
  // LiveAsk_Conversation_Panel_UX_Spec_CANONICAL_20260831.md.
  //
  // Persistent footer (Section 12) — appended ONCE as a direct sibling
  // of #askThread inside .ask-box, never as a member of the thread
  // itself. This is the actual fix for the render-order defect named
  // in the spec: the old approach appended a "copy" control as the
  // LAST child of #askThread and re-appended it after every reply to
  // keep it last — fragile by construction, since any code path that
  // added thread content without also calling that refresh function
  // would leave it stranded mid-transcript. A sibling of the thread,
  // never a member of it, cannot be reordered relative to thread
  // content at all, by construction, not by discipline.
  // ============================================================
  function ensureFooter(){
    let footer = panel.byId('ask-footer');
    if (footer) return footer;
    footer = document.createElement('div');
    footer.id = 'ask-footer';
    footer.className = 'ask-footer';
    footer.innerHTML =
      '<button type="button" class="ask-footer-overflow" id="askFooterOverflow" aria-label="More options">&bull;&bull;&bull;</button>' +
      '<button type="button" class="ask-footer-copy" id="askFooterCopy">Get a copy of this conversation</button>' +
      '<button type="button" class="ask-footer-hide" id="askFooterHide">Hide Chat <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"></polyline></svg></button>';
    // Footer lives INSIDE .ask-output-panel, as a sibling of #askThread
    // (1 September 2026 correction) — the footer belongs to the chat
    // output panel itself, not as a separate box sitting between it and
    // the UIP. Appending here (last child of .ask-output-panel) is
    // correct without needing insertBefore, since #askThread is
    // .ask-output-panel's only other child.
    askPanel.querySelector('.ask-output-panel').appendChild(footer);

    footer.querySelector('#askFooterCopy').addEventListener('click', function(){
      if (footerCopyState !== 'available') return;
      footerCopyState = 'requested';
      // Text stays "Get a copy of this conversation" through the
      // request (1 September 2026 correction) — the "Requesting…"
      // label was invented in an earlier pass and was never part of
      // any actual spec; disabling the button is enough to prevent a
      // double-click without introducing new copy that wasn't asked for.
      this.disabled = true;
      submitToPanel(CHAT_COPY_TRIGGER, { showVisitorBubble: true });
    });
    footer.querySelector('#askFooterHide').addEventListener('click', function(){
      askPanel.querySelector('.ask-box').classList.remove('expanded');
      thread.classList.remove('active');
    });
    return footer;
  }

  // Available -> requested -> sent. Deliberately the simpler two-
  // transition version, not a fuller mid-flow "verification in
  // progress, then sent" state machine — the existing backend contract
  // only exposes this as an ordinary conversational exchange (send the
  // trigger phrase, get an ordinary reply back), not a dedicated status
  // signal this footer button could key off for a genuine third state.
  // Building that would mean designing a new backend signal, which is
  // exactly the kind of separate discovery/design work this pass was
  // told not to undertake. Flagged here plainly rather than silently
  // narrowed: a real "verification in progress" distinct footer state
  // needs a backend contract change first.
  let footerCopyState = 'available';
  function markFooterCopySent(){
    footerCopyState = 'sent';
    const btn = panel.byId('askFooterCopy');
    if (!btn) return;
    btn.textContent = '✓ Conversation copy sent';
    btn.classList.add('ask-footer-copy--sent');
    btn.disabled = true;
  }
  function showFooter(){
    ensureFooter().classList.add('active');
  }

  // ---- Message rendering (no permanent speaker labels, per Section
  // 3/4/20) ----
  function createVisitorMessageEl(text){
    const v = document.createElement('div');
    v.className = 'ask-msg visitor';
    const p = document.createElement('p');
    p.textContent = text;
    v.appendChild(p);
    return v;
  }

  // ---- Menu/interface-action receipt (1 September 2026 correction) ----
  // Deliberately NOT a normal visitor bubble and NOT the old centred/
  // uppercase/arrow .ask-sysnote treatment either — a distinct third
  // kind of turn, for a distinct kind of visitor action: clicking a
  // LiveAsk interface action (a + menu item, a nav-intent shortcut)
  // rather than typing or choosing a conversational Quick Reply. Both
  // of those still render as ordinary right-aligned visitor bubbles via
  // the existing paths — this is specifically for the "clicked an
  // interface action" case, left-aligned, reading as "you clicked
  // [action]" rather than a spoken message. `label` is the bare action
  // name only (e.g. "Contact", "How to use LiveAsk") — every call site
  // was updated to pass this instead of the old pre-formatted
  // "→ You clicked X" string, so there is nothing left to parse or
  // strip here.
  function createActionReceiptEl(label){
    const el = document.createElement('div');
    el.className = 'ask-action-receipt';
    el.innerHTML = '<span class="ask-action-receipt-label">you clicked</span><span class="ask-action-receipt-pill"></span>';
    el.querySelector('.ask-action-receipt-pill').textContent = label;
    return el;
  }

  // showPrivacyNotice inserted before the reply paragraph, inside the
  // same message element — satisfies the required render order
  // (Section 9): the notice is part of the first AI message's own
  // render group, not a separately-timed insertion that could race
  // against it.
  //
  // Rendering here is plain text with paragraph breaks preserved
  // (CSS white-space:pre-line), matching what the current backend
  // contract actually emits. The spec's Section 7 describes what long
  // responses may VISUALLY contain (lists, headings, links, emphasis)
  // if the content contains them — the CSS above supports rendering
  // that content correctly. Actually converting the model's raw text
  // into that markup (a markdown-to-HTML pass) is a separate, materially
  // larger feature the backend doesn't currently emit structured content
  // for, and building it isn't part of this bounded Conversation Panel
  // pass — flagged here rather than silently added or silently skipped.
  function createAiMessageEl(text, showPrivacyNotice){
    const a = document.createElement('div');
    a.className = 'ask-msg ai';
    const p = document.createElement('p');
    if (showPrivacyNotice) a.appendChild(buildPrivacyNoticeEl());
    a.appendChild(p);
    p.textContent = text;
    return a;
  }

  // ---- Transient thinking/answering identity (Section 8) ----
  // One stable element for the life of an active response — created
  // once per turn, its emoji/text content changed in place for the
  // 🤔 -> 🙂 transition, never removed and recreated mid-turn. The
  // wrapper's own min-height (see widget.css .ask-identity) reserves
  // its layout slot so the ~5s completion fade cannot cause existing
  // content to jump when it's eventually removed.
  function beginIdentity(){
    // 1 September 2026 correction: the actual LiveAsk SVG mark, reused
    // byte-for-byte from the same asset the UIP composer's own logo
    // uses (.ask-liveask-inline) — not the "LiveAsk AI" text label this
    // previously showed. AI_SPEAKER_LABEL still exists and is still
    // used elsewhere for accessibility (see aria-label below), but is
    // deliberately never rendered as visible transcript text here or
    // anywhere in the historical transcript, per the approved
    // transient-indicator-only treatment.
    const el = document.createElement('div');
    el.className = 'ask-identity';
    el.innerHTML = '<img class="ask-identity-logo" src="data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0nMS4wJyBlbmNvZGluZz0nVVRGLTgnIHN0YW5kYWxvbmU9J25vJz8+CjwhLS0gR2VuZXJhdG9yOiBBZG9iZSBJbGx1c3RyYXRvciAyNy4zLjEsIFNWRyBFeHBvcnQgUGx1Zy1JbiAuIFNWRyBWZXJzaW9uOiA2LjAwIEJ1aWxkIDApICAtLT48c3ZnIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgeG1sbnM6eGxpbms9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkveGxpbmsiIHZlcnNpb249IjEuMSIgaWQ9IkxheWVyXzEiIHg9IjBweCIgeT0iMHB4IiB2aWV3Qm94PSI0LjIgMjIuNiAzNzIuOCA5My4yIiBzdHlsZT0iZW5hYmxlLWJhY2tncm91bmQ6bmV3IDQuMiAyMi42IDM3Mi44IDkzLjI7IiB4bWw6c3BhY2U9InByZXNlcnZlIj4KPHN0eWxlIHR5cGU9InRleHQvY3NzIj4KCS5zdDB7ZmlsbDojMDA1RkFFO30KCS5zdDF7ZmlsbDpub25lO3N0cm9rZTojNDg0ODRBO3N0cm9rZS13aWR0aDozLjMxNTE7c3Ryb2tlLW1pdGVybGltaXQ6MTA7fQoJLnN0MntlbmFibGUtYmFja2dyb3VuZDpuZXcgICAgO30KCS5zdDN7ZmlsbDojNDg0ODRBO3N0cm9rZTojNDg0ODRBO3N0cm9rZS13aWR0aDoxLjM0ODg7c3Ryb2tlLW1pdGVybGltaXQ6MTA7fQoJLnN0NHtmaWxsOiMwMDVGQUU7c3Ryb2tlOiMwMDVGQUU7c3Ryb2tlLXdpZHRoOjEuMzQ4ODtzdHJva2UtbWl0ZXJsaW1pdDoxMDt9Cgkuc3Q1e2ZpbGw6IzAwNUZBRTtzdHJva2U6IzAwNUZBRTtzdHJva2Utd2lkdGg6MS4zNDg4O3N0cm9rZS1saW5lY2FwOnJvdW5kO3N0cm9rZS1taXRlcmxpbWl0OjEwO30KPC9zdHlsZT4KPGc+Cgk8Zz4KCQk8Zz4KCQkJCgkJCQk8cmVjdCB4PSIzNjMuMzQiIHk9IjMyLjk1IiB0cmFuc2Zvcm09Im1hdHJpeCg0LjQ4NjkwNmUtMTEgLTEgMSA0LjQ4NjkwNmUtMTEgMzQwLjUzODIgNDA5Ljg1NDMpIiBjbGFzcz0ic3QwIiB3aWR0aD0iMjMuNzIiIGhlaWdodD0iMy40MiIvPgoJCQk8cmVjdCB4PSIzNTMuMTkiIHk9IjIyLjgiIGNsYXNzPSJzdDAiIHdpZHRoPSIyMy43MiIgaGVpZ2h0PSIzLjQyIi8+CgkJPC9nPgoJCTxnPgoJCQkKCQkJCTxyZWN0IHg9IjM2My4zNCIgeT0iMTAyLjA5IiB0cmFuc2Zvcm09Im1hdHJpeCg0LjQ4Njg4MWUtMTEgMSAtMSA0LjQ4Njg4MWUtMTEgNDc4Ljk5ODggLTI3MS4zOTM3KSIgY2xhc3M9InN0MCIgd2lkdGg9IjIzLjcyIiBoZWlnaHQ9IjMuNDIiLz4KCQkJPHJlY3QgeD0iMzUzLjE5IiB5PSIxMTIuMjUiIGNsYXNzPSJzdDAiIHdpZHRoPSIyMy43MiIgaGVpZ2h0PSIzLjQyIi8+CgkJPC9nPgoJPC9nPgoJPGc+CgkJPGcgY2xhc3M9InN0MiI+CgkJCTxwYXRoIGNsYXNzPSJzdDMiIGQ9Ik00LjkzLDEwNi42NnYtNzQuMWg3LjExdjY3Ljc4aDM1LjIxdjYuMzJINC45M3oiLz4KCQkJPHBhdGggY2xhc3M9InN0MyIgZD0iTTY0LjU2LDQwLjc2Yy0xLjMzLDAtMi40OC0wLjQ2LTMuNDYtMS4zOWMtMC45OC0wLjkzLTEuNDctMi4wNC0xLjQ3LTMuMzNjMC0xLjMzLDAuNDktMi40NCwxLjQ3LTMuMzYgICAgIGMwLjk4LTAuOTEsMi4xMy0xLjM3LDMuNDYtMS4zN2MxLjM2LDAsMi41MiwwLjQ2LDMuNDgsMS4zN2MwLjk2LDAuOTEsMS40NCwyLjAzLDEuNDQsMy4zNmMwLDEuMjktMC40OCwyLjQtMS40NCwzLjMzICAgICBDNjcuMDgsNDAuMyw2NS45Miw0MC43Niw2NC41Niw0MC43NnogTTYxLjEzLDEwNi42NnYtNTUuNmg2Ljc2djU1LjZINjEuMTN6Ii8+CgkJCTxwYXRoIGNsYXNzPSJzdDMiIGQ9Ik0xMDEuMDcsMTA2LjY2bC0yMS4yNC01NS42aDcuMzZsMTIuODMsMzQuOTZjMS4xNiwzLjEyLDIuMTksNi4yMywzLjA4LDkuMzVjMC44OSwzLjEyLDEuODQsNi4xNSwyLjgzLDkuMSAgICAgaC0yLjM5YzAuOTYtMi45NSwxLjg5LTUuOTgsMi43OS05LjFjMC44OS0zLjExLDEuOTItNi4yMywzLjA4LTkuMzVsMTIuODMtMzQuOTZoNy4zMWwtMjEuMjQsNTUuNkgxMDEuMDd6Ii8+CgkJCTxwYXRoIGNsYXNzPSJzdDMiIGQ9Ik0xNjIuMDksMTA3Ljg1Yy01LjIxLDAtOS43MS0xLjIyLTEzLjUtMy42NmMtMy44LTIuNDQtNi43My01LjgxLTguOC0xMC4xMmMtMi4wNy00LjMxLTMuMTEtOS4yNy0zLjExLTE0Ljg3ICAgICBjMC01LjYsMS4wMi0xMC41OCwzLjA2LTE0LjkyYzIuMDQtNC4zNCw0Ljg5LTcuNzYsOC41NS0xMC4yNWMzLjY2LTIuNDksNy45Mi0zLjczLDEyLjc2LTMuNzNjMy4wNSwwLDUuOTgsMC41Niw4LjgsMS42NyAgICAgYzIuODIsMS4xMSw1LjM1LDIuOCw3LjYxLDUuMDdjMi4yNSwyLjI3LDQuMDMsNS4xNSw1LjMyLDguNjNjMS4yOSwzLjQ4LDEuOTQsNy41OCwxLjk0LDEyLjI4djIuOTNIMTQxLjF2LTUuODJoMzkuOThMMTc4LDc3LjI3ICAgICBjMC0zLjk4LTAuNjgtNy41NC0yLjA0LTEwLjY5Yy0xLjM2LTMuMTUtMy4zLTUuNjQtNS44Mi03LjQ2Yy0yLjUyLTEuODItNS41NS0yLjczLTkuMS0yLjczYy0zLjUxLDAtNi41OSwwLjkzLTkuMjIsMi43OCAgICAgYy0yLjY0LDEuODYtNC42OSw0LjMxLTYuMTcsNy4zNmMtMS40OCwzLjA1LTIuMjEsNi40LTIuMjEsMTAuMDV2My40OGMwLDQuMzQsMC43Niw4LjE1LDIuMjksMTEuNDFjMS41MiwzLjI3LDMuNjksNS44LDYuNDksNy42MSAgICAgYzIuOCwxLjgxLDYuMTEsMi43MSw5LjkyLDIuNzFjMi41OSwwLDQuODYtMC40MSw2Ljg0LTEuMjRjMS45Ny0wLjgzLDMuNjMtMS45Myw0Ljk3LTMuMzFjMS4zNC0xLjM4LDIuMzUtMi44OCwzLjAxLTQuNSAgICAgbDYuNDIsMi4wNGMtMC44NiwyLjMyLTIuMjUsNC40OC00LjE1LDYuNDdjLTEuOTEsMS45OS00LjMsMy41OS03LjE5LDQuOEMxNjkuMTUsMTA3LjI1LDE2NS44MywxMDcuODUsMTYyLjA5LDEwNy44NXoiLz4KCQkJPHBhdGggY2xhc3M9InN0NCIgZD0iTTE4OS40OSwxMDYuNjZsMjcuMTUtNzQuMUgyMjVsMjcuNCw3NC4xaC03LjQ2bC0xNy42MS00OC40NGMtMC45OS0yLjY5LTIuMDgtNS44My0zLjI2LTkuNDIgICAgIGMtMS4xOC0zLjYtMi41My03LjkzLTQuMDUtMTNoMS40OWMtMS41Miw1LjExLTIuODgsOS40OC00LjA4LDEzLjEzYy0xLjE5LDMuNjUtMi4yNCw2Ljc1LTMuMTMsOS4zTDE5NywxMDYuNjZIMTg5LjQ5eiAgICAgIE0yMDIuMTIsODQuNjN2LTYuMjdoMzcuNjV2Ni4yN0gyMDIuMTJ6Ii8+CgkJCTxwYXRoIGNsYXNzPSJzdDQiIGQ9Ik0yODEuNDQsMTA3Ljg1Yy0zLjY1LDAtNi44OC0wLjU2LTkuNy0xLjY3Yy0yLjgyLTEuMTEtNS4xNC0yLjczLTYuOTYtNC44N2MtMS44Mi0yLjE0LTMuMDctNC43Ny0zLjczLTcuODggICAgIGw2LjQ3LTEuNTRjMC44LDMuMzUsMi4zOCw1Ljg0LDQuNzUsNy40OGMyLjM3LDEuNjQsNS40LDIuNDYsOS4wNywyLjQ2YzQuMjEsMCw3LjU4LTAuOTQsMTAuMTItMi44MyAgICAgYzIuNTQtMS44OSwzLjgxLTQuMjQsMy44MS03LjA2YzAtMi4yNi0wLjc2LTQuMTMtMi4yNi01LjYyYy0xLjUxLTEuNDktMy43Ny0yLjYtNi43OS0zLjMzbC05LjA1LTIuMTkgICAgIGMtNC43OC0xLjE2LTguMzUtMi45Ny0xMC43Mi01LjQ0Yy0yLjM3LTIuNDctMy41Ni01LjU4LTMuNTYtOS4zM2MwLTMuMTIsMC44NC01Ljg1LDIuNTEtOC4yMWMxLjY3LTIuMzUsMy45OC00LjE5LDYuOTEtNS41MiAgICAgYzIuOTMtMS4zMyw2LjI3LTEuOTksMTAuMDItMS45OWMzLjUxLDAsNi41MywwLjU0LDkuMDUsMS42MmMyLjUyLDEuMDgsNC42LDIuNTksNi4yNCw0LjU1YzEuNjQsMS45NiwyLjg3LDQuMjgsMy43MSw2Ljk2ICAgICBsLTYuMTcsMS41OWMtMC44Ni0yLjU1LTIuMy00LjY3LTQuMy02LjM0Yy0yLjAxLTEuNjctNC44My0yLjUxLTguNDgtMi41MWMtMy42OCwwLTYuNzEsMC44OC05LjEsMi42NCAgICAgYy0yLjM5LDEuNzYtMy41OCw0LjAzLTMuNTgsNi44MWMwLDIuMzUsMC44LDQuMjgsMi40MSw1Ljc3YzEuNjEsMS40OSw0LjEyLDIuNjUsNy41MywzLjQ4bDguNSwyLjA0ICAgICBjNC43MSwxLjE2LDguMjMsMi45NywxMC41Nyw1LjQyYzIuMzQsMi40NSwzLjUxLDUuNTIsMy41MSw5LjJjMCwzLjE4LTAuODgsNi0yLjYzLDguNDZjLTEuNzYsMi40NS00LjIsNC4zOC03LjM0LDUuNzcgICAgIEMyODkuMTMsMTA3LjE2LDI4NS41MiwxMDcuODUsMjgxLjQ0LDEwNy44NXoiLz4KCQk8L2c+CgkJPGc+CgkJCTxnPgoJCQkJPHBhdGggY2xhc3M9InN0NSIgZD0iTTMxNy42LDEwNi42NnYtNzQuMWg3LjA2djI1LjcxbC0wLjEsMTYuNzFsMC4xLDMuNjN2MjguMDVIMzE3LjZ6IE0zMjIuNjIsODMuNjNsLTAuMjUtNy41MSAgICAgIGMxLjc5LTIuMjUsMy41NS00LjQyLDUuMjctNi40OWMxLjcyLTIuMDcsMy40Ny00LjEyLDUuMjUtNi4xNGMxLjc3LTIuMDIsMy42MS00LjA1LDUuNS02LjA3bDMwLjg3LTMyLjQzbDYuMjQsMi4yOSAgICAgIGwtMzYuMDYsMzguODRsLTAuNSwwLjE1TDMyMi42Miw4My42M3ogTTM2Ny45MiwxMTMuNTdsLTMzLjIxLTQ1Ljc2bDQuNTMtNS4zMmwzNi4xOCw1MC44NEwzNjcuOTIsMTEzLjU3eiIvPgoJCQk8L2c+CgkJPC9nPgoJPC9nPgo8L2c+Cjwvc3ZnPg==" alt="" aria-hidden="true"><span class="ask-identity-emoji" role="img" aria-label="' + AI_SPEAKER_LABEL + ' is thinking">🤔</span>';
    thread.appendChild(el);
    maybeScrollToBottom();
    return el;
  }
  function beginAnswering(identityEl){
    if (!identityEl) return;
    const emoji = identityEl.querySelector('.ask-identity-emoji');
    if (emoji) {
      emoji.textContent = '🙂';
      emoji.setAttribute('aria-label', AI_SPEAKER_LABEL + ' is answering');
    }
  }
  // Called once a reply has fully landed. Starts the ~5s hold, then a
  // smooth opacity fade, then a smooth height collapse, then removes
  // the element — three separate steps specifically so nothing ever
  // disappears in a single abrupt frame that could read as a jump.
  function completeIdentity(identityEl){
    if (!identityEl) return;
    setTimeout(function(){
      identityEl.classList.add('ask-identity--fading');
      setTimeout(function(){
        identityEl.style.transition = 'max-height .3s ease, margin .3s ease, min-height .3s ease';
        identityEl.style.maxHeight = '0px';
        identityEl.style.minHeight = '0px';
        identityEl.style.marginBottom = '0px';
        identityEl.style.overflow = 'hidden';
        setTimeout(function(){ identityEl.remove(); }, 320);
      }, 400);
    }, 5000);
  }

  // ---- Scroll-state machine (Section 14) ----
  // Two explicit states, regardless of internal naming: FOLLOWING_LATEST
  // (new content may auto-scroll into view) and READING_HISTORY (the
  // visitor deliberately scrolled up; nothing may pull them back down
  // except their own action). BOTTOM_TOLERANCE is deliberately small —
  // "sufficiently near the bottom" per spec, not an exact pixel match,
  // since sub-pixel layout rounding would otherwise falsely trigger
  // READING_HISTORY on an ordinary render.
  const BOTTOM_TOLERANCE = 24;
  let scrollState = 'FOLLOWING_LATEST';
  function isNearBottom(){
    return (thread.scrollHeight - thread.scrollTop - thread.clientHeight) <= BOTTOM_TOLERANCE;
  }
  function updateScrollLatestVisibility(){
    const btn = panel.byId('askScrollLatest');
    if (!btn) return;
    btn.classList.toggle('visible', scrollState === 'READING_HISTORY');
  }
  // Every existing unconditional "thread.scrollTop = thread.scrollHeight"
  // call site in this file is being replaced with a call to this
  // function — auto-follow only applies while the visitor hasn't
  // deliberately scrolled away, per spec. New tokens, streaming
  // completion, the identity fade, Quick Reply changes and UIP focus
  // must not by themselves force READING_HISTORY back to
  // FOLLOWING_LATEST — none of them call this function with any special
  // override, they just call it plainly, so a visitor in READING_HISTORY
  // stays there through all of them.
  function maybeScrollToBottom(){
    if (scrollState !== 'FOLLOWING_LATEST') return;
    thread.scrollTop = thread.scrollHeight;
  }
  function returnToLatest(){
    scrollState = 'FOLLOWING_LATEST';
    thread.scrollTo({ top: thread.scrollHeight, behavior: 'smooth' });
    updateScrollLatestVisibility();
  }
  thread.addEventListener('scroll', function(){
    if (isNearBottom()) {
      if (scrollState !== 'FOLLOWING_LATEST') {
        scrollState = 'FOLLOWING_LATEST';
        updateScrollLatestVisibility();
      }
    } else if (scrollState !== 'READING_HISTORY') {
      scrollState = 'READING_HISTORY';
      updateScrollLatestVisibility();
    }
  });

  function ensureScrollLatestButton(){
    let btn = panel.byId('askScrollLatest');
    if (btn) return btn;
    // 1 September 2026 third correction: position:sticky (the previous
    // attempt) has now failed in actual observed rendering too — not
    // just the position:absolute-inside-a-scrolling-container attempt
    // before it. Rather than keep guessing at a more clever CSS
    // mechanism I can't directly verify renders correctly in every
    // context, reverting to the simplest, most predictable technique:
    // a plain position:absolute child of .ask-output-panel, which does
    // NOT scroll (only #askThread inside it does) — anchored with a
    // bottom offset computed from the footer's actual, known CSS
    // (13px font-size x the 1.6 base line-height + 10px+10px padding
    // = ~41px), not a round guess. The footer's height is stable
    // (single-line utility bar, not user-content-driven), so a
    // computed fixed offset here is a reasonable tradeoff for a
    // mechanism that's easy to reason about and verify, over an
    // elegant-but-unverified one that has now broken twice.
    btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'askScrollLatest';
    btn.className = 'ask-scroll-latest';
    btn.setAttribute('aria-label', 'Return to latest');
    // A genuine full arrow (shaft + arrowhead), deliberately distinct in
    // shape from Hide Chat's bare chevron — the two controls do
    // different things and must not be visually confusable.
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="4" x2="12" y2="18"></line><polyline points="6 13 12 19 18 13"></polyline></svg>';
    btn.addEventListener('click', returnToLatest);
    askPanel.querySelector('.ask-output-panel').appendChild(btn);
    return btn;
  }

  // ---- Cross-page session persistence (added 24 August 2026, alongside
  // this file's consolidation) ----
  // sessionStorage is per-tab, per-origin, and survives a real page
  // navigation but not a closed tab or a fresh one — exactly the lifetime
  // wanted here: the same visitor moving between tenant pages in
  // one sitting keeps talking to the same AI with the same history; a new
  // tab or a later visit starts clean, same as today.
  const SESSION_KEY = 'liveask_session_v1';
  function loadSession(){
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.sessionId !== 'string' || !Array.isArray(parsed.conversationHistory)) return null;
      return parsed;
    } catch (e) {
      return null; // corrupt/unavailable storage — fall back to a fresh session, never throw
    }
  }
  function saveSession(){
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({ sessionId: sessionId, conversationHistory: conversationHistory, tourToken: tourToken, voiceAuthority: voiceAuthority }));
    } catch (e) {
      // Storage unavailable or full (private-browsing modes, quota) — the
      // conversation still works fine for this page, it just won't survive
      // a navigation. Fail silent rather than break the chat over it.
    }
  }

  const restoredSession = loadSession();

  // ---- Custom AI Tours: guest entry (added 24 August 2026) ----
  // A tour link always carries ?tour=<token> (see TOUR_DESTINATIONS /
  // handleTourCreate in index-worker.js — the guest link is literally
  // `${ALLOWED_ORIGIN}/?tour=<token>`). If this URL's token doesn't match
  // whatever tour token (if any) this same browser tab already had stored,
  // treat it as a brand new tour visit and start completely fresh — a tour
  // guest should never have an unrelated earlier conversation in this tab
  // silently merged into their tour.
  const urlTourToken = new URLSearchParams(window.location.search).get('tour');
  const isFreshTourEntry = !!urlTourToken && (!restoredSession || restoredSession.tourToken !== urlTourToken);

  let sessionId, conversationHistory, tourToken, voiceAuthority;
  if (isFreshTourEntry) {
    sessionId = 'web-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    conversationHistory = [];
    tourToken = urlTourToken;
    voiceAuthority = null;
  } else {
    sessionId = (restoredSession && restoredSession.sessionId) || ('web-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    conversationHistory = (restoredSession && restoredSession.conversationHistory) || [];
    tourToken = (restoredSession && restoredSession.tourToken) || null;
    voiceAuthority = (restoredSession && restoredSession.voiceAuthority) || null;
  }

  function rememberVoiceAuthority(data){
    if (!data || !data.voiceAuthority || typeof data.voiceAuthority.token !== 'string') return;
    voiceAuthority = {
      token: data.voiceAuthority.token,
      expiresAt: Number(data.voiceAuthority.expiresAt) || 0
    };
    saveSession();
  }

  // Rebuilds the thread's DOM content from a restored conversationHistory
  // after a same-tab page navigation or reload, so it's fully ready the
  // instant the visitor actually opens the panel again — but does NOT
  // open it itself. Redesigned 25 August 2026: the original version also
  // force-expanded the panel here, which meant simply reloading the page
  // (or navigating to another page) yanked the full conversation back into
  // view even if the visitor had just closed it, with no chance to browse
  // quietly. Remembering the conversation and deciding whether to SHOW it
  // are now two separate concerns — content persists always; visibility
  // only ever changes because of a real, deliberate action (focusing the
  // input, sending a message, a defined nav trigger, or a fresh tour
  // link — see each of those call sites for their own .expanded handling).
  // Rotation still needs stopping and the placeholder still needs updating
  // regardless of visibility, so a visitor who returns to a history-
  // carrying tab never sees the initial rotating suggestions
  // — they'd be wrong the moment there's already a real conversation on
  // record, collapsed or not.
  function replaySession(){
    let replayLastAssistantEl = null;
    conversationHistory.forEach(function(m){
      if (m.role === 'user') {
        const v = document.createElement('div');
        v.className = 'ask-msg visitor';
        v.innerHTML = '<p></p>';
        v.querySelector('p').textContent = m.content;
        thread.appendChild(v);
      } else if (m.role === 'assistant') {
        const a = document.createElement('div');
        a.className = 'ask-msg ai';
        a.innerHTML = '<p></p>';
        a.querySelector('p').textContent = m.content;
        thread.appendChild(a);
        replayLastAssistantEl = a;
      }
    });
    clearInterval(rotateTimer); rotateTimer = null;
    clearTimeout(rotateFadeTimeout);
    setFinalPlaceholder();
    ph.classList.remove('fade');
    const replayLastTurn = conversationHistory.length ? conversationHistory[conversationHistory.length - 1] : null;
    if (replayLastTurn && replayLastTurn.role === 'assistant') {
      activateInputInstruction(replayLastTurn.content, replayLastAssistantEl);
    }
    // Persistent chat-copy control — restored on a same-tab reload/nav same
    // as everything else in this replay, so it's not missing until the next
    // reply happens to land.
    if (conversationHistory.some(function(m){ return m.role === 'assistant'; })) {
      showFooter();
    }
    // Row 2 never persisted quickReplies across a reload even in the old
    // one-shot design (they were never part of conversationHistory/
    // saveSession to begin with) — explicit clear here just guarantees
    // Row 2 comes back showing nothing stale (only the static '+') rather
    // than whatever it happened to hold in memory before the reload.
    renderRow2([]);
    maybeScrollToBottom();
  }

  // ---- Custom AI Tours: guest-side action dispatcher (added 24 August
  // 2026; extended 25 August 2026 for real cross-page destinations) ----
  // Approved semantic destination names -> real on-page targets. Keep this
  // in sync with TOUR_DESTINATIONS in index-worker.js — the Worker only
  // ever sends a semantic name (e.g. "LIVEASK_OVERVIEW"), never a raw
  // selector, so a destination added there needs a matching entry here
  // before it can actually move anyone's page. Each entry now carries
  // `page` (the real site path it lives on) alongside `selector` — until 25
  // August 2026 every destination lived on the homepage, so this was a bare
  // selector string; now a destination can point at a genuinely different
  // page, which needs a full navigation, not just a scroll.
  //
  // CUSTOMER-SPECIFIC CONTENT — the dispatcher mechanics below that read
  // TOUR_DESTINATION_SELECTORS[...] are reusable Core behaviour. These
  // values are the verified LiveAsk.au deployment map; a clean reusable
  // Core export must replace only this map with the destination keys,
  // page paths and selectors defined for that customer.
  const TOUR_DESTINATION_SELECTORS = {
    LIVEASK_OVERVIEW: { page: '/', selector: '#liveask-overview' },
    LIVEASK_COMPARISON: { page: '/', selector: '#comparison' },
    LIVEASK_GOVERNANCE: { page: '/', selector: '#liveask-governance' },
    LIVEASK_ENHANCEMENTS: { page: '/', selector: '#liveask-enhancements' }
  };

  // Same "treat home specially" normalization as ABOUT_HREF above, reused
  // here to compare a destination's configured `page` against where the
  // guest actually is right now. '/' and '/index.html' are the same place;
  // everything else compares as its own literal path with any trailing
  // slash stripped, so '/liveask' and '/liveask/' count as the same page.
  function normalizedCurrentPath(){
    const p = window.location.pathname;
    if (p === '/' || p === '/index.html') return '/';
    return p.replace(/\/$/, '');
  }
  function normalizedDestPage(page){
    if (page === '/' || page === '/index.html') return '/';
    return page.replace(/\/$/, '');
  }

  // Persists across the hard navigation a cross-page GO_TO needs — a real
  // page load destroys this whole script's running state, so "there's a
  // scroll-and-highlight still owed once we land" has to survive in
  // sessionStorage, same storage already relied on for cross-page
  // conversation continuity (SESSION_KEY above). Cleared the moment it's
  // been carried out, or on any first-contact tour ping starting fresh, so
  // a stale pending action can never fire on the wrong page later.
  const PENDING_ACTION_KEY = 'liveask_pending_tour_action_v1';
  // quickReplies (added 26 August 2026 — real bug found live: "The Tour
  // Conclusion buttons flash up and immediately disappear again before any
  // action is taken and cannot be retrieved.") A stop's just-offered
  // buttons (Next stop/End tour, or the final-stop feedback options) were
  // already appended to the OLD page's thread before this same hard
  // navigation fires — a real page load destroys that DOM before the
  // visitor can ever click them, and replaySession() only ever replays
  // plain message text, never quick-replies, so they were gone for good.
  // Carrying just the CHOICES (not the DOM) across the hop, same idea as
  // the scroll target itself, lets the resume path below render a genuine,
  // fresh, clickable set once this new page has actually settled.
  function savePendingTourAction(target, quickReplies){
    try {
      const payload = { target: target };
      if (Array.isArray(quickReplies) && quickReplies.length > 0) payload.quickReplies = quickReplies;
      sessionStorage.setItem(PENDING_ACTION_KEY, JSON.stringify(payload));
    } catch (e) { /* ignore, same fail-silent rule as saveSession */ }
  }
  function takePendingTourAction(){
    try {
      const raw = sessionStorage.getItem(PENDING_ACTION_KEY);
      if (!raw) return null;
      sessionStorage.removeItem(PENDING_ACTION_KEY);
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.target !== 'string') return null;
      return {
        target: parsed.target,
        quickReplies: Array.isArray(parsed.quickReplies) ? parsed.quickReplies : null
      };
    } catch (e) { return null; }
  }

  // The actual same-page scroll-and-highlight — unchanged from the original
  // 24 August version, just split out so both the same-page path below AND
  // the "just landed after a cross-page hop" resume path (see near the
  // bottom of this file) can call the identical, already-tested logic.
  function scrollAndHighlight(selector){
    const el = host.$(selector);
    if (!el) return;
    // Real live-test find (24 August 2026): the ask panel is pinned
    // (position: sticky) at the top of the viewport at all times — a plain
    // scrollIntoView({block:'start'}) aligns the destination's top edge
    // with the viewport's top edge, which is exactly where the panel
    // already sits, so the destination lands hidden behind it. Read the
    // panel's own CURRENT rendered height (varies by viewport width and
    // whether it's expanded) rather than a fixed guess, and scroll to just
    // below it with a little breathing room.
    const panelHeight = askPanel.getBoundingClientRect().height;
    const targetTop = el.getBoundingClientRect().top + window.scrollY - panelHeight - 16;
    window.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
    const prev = { transition: el.style.transition, outline: el.style.outline, outlineOffset: el.style.outlineOffset };
    el.style.transition = 'outline-color 0.3s ease';
    el.style.outline = '3px solid #1e6fd9';
    el.style.outlineOffset = '4px';
    setTimeout(function(){
      el.style.outline = prev.outline;
      el.style.outlineOffset = prev.outlineOffset;
      el.style.transition = prev.transition;
    }, 2600);
  }

  // Executes the Worker's GO_TO action. Fails completely silently on an
  // unknown destination name (never breaks the reply that came with it) —
  // same principle as the original same-page-only version.
  function handleTourAction(action, pendingQuickReplies){
    if (!action || action.type !== 'GO_TO') return;
    const dest = TOUR_DESTINATION_SELECTORS[action.target];
    if (!dest) return;
    if (normalizedDestPage(dest.page) === normalizedCurrentPath()) {
      scrollAndHighlight(dest.selector);
      return;
    }
    // Cross-page destination (added 25 August 2026): the explanation text
    // accompanying this same action has already been delivered in this
    // same reply, so nothing more needs saying — just remember what's
    // still owed, then navigate. sessionStorage (not the in-memory
    // conversationHistory push, which already happened by this point)
    // carries the pending scroll-and-highlight across the reload; the
    // resume check near the bottom of this file picks it up once the new
    // page's own copy of this script starts running. pendingQuickReplies
    // (26 August 2026) rides along the same way — see savePendingTourAction's
    // own comment for the bug this fixes.
    savePendingTourAction(action.target, pendingQuickReplies);
    window.location.href = dest.page;
  }

  // A tour guest's very first load: no conversation to replay yet, and the
  // ordinary rotating placeholder makes no sense for someone who arrived
  // via a tour link,
  // not organically — fetch and show the fixed greeting instead (see
  // buildTourGreeting in index-worker.js). No Claude call happens for this
  // specific request; the Worker returns the greeting immediately.
  function beginTourEntry(){
    askPanel.querySelector('.ask-box').classList.add('expanded');
    thread.classList.add('active');
    clearInterval(rotateTimer); rotateTimer = null;
    clearTimeout(rotateFadeTimeout);
    setFinalPlaceholder();
    ph.classList.remove('fade');

    const thinking = beginIdentity();

    fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionId, messages: [], tourToken: tourToken })
    })
      .then(function(res){ return res.json(); })
      .then(function(data){
        rememberVoiceAuthority(data);
        beginAnswering(thinking);
        completeIdentity(thinking);
        const replyText = data.reply || "Welcome! Something went wrong setting up your tour — try refreshing, or just ask a question below.";
        const showPrivacyNotice = isFirstAiReply();
        conversationHistory.push({ role: 'assistant', content: replyText });
        saveSession();
        const a = document.createElement('div');
        a.className = 'ask-msg ai';
        a.innerHTML = '<p></p>';
        const replyP = a.querySelector('p');
        if (showPrivacyNotice) {
          a.insertBefore(buildPrivacyNoticeEl(), replyP);
        }
        replyP.textContent = replyText;
        // Real gap found 25 August 2026: this greeting path never rendered
        // data.quickReplies at all (only submitToPanel's success handler
        // did) — so the Worker's new fixed "Start tour" button silently had
        // nowhere to go, leaving the guest to type "yes" regardless. Same
        // validated Quick Reply rendering as everywhere else, now landing
        // in the persistent Row 2 zone rather than the bubble itself.
        const quickReplyChoices = validQuickReplies(data);
        renderRow2(quickReplyChoices);
        thread.appendChild(a);
        showFooter();
        maybeScrollToBottom();
        if (data.action) handleTourAction(data.action, quickReplyChoices);
        // Real bug found live on mobile, 25 August 2026: this used to
        // force-focus the text input the instant a guest's tour greeting
        // landed — before they'd tapped or typed anything at all. On a
        // phone that meant the keyboard shot open the moment the tour
        // page finished loading, with nothing to type yet. Removed, same
        // reasoning as the nav-intent handler and the quick-reply path in
        // submitToPanel above — only a genuine typed submission should
        // pull the keyboard back open.
      })
      .catch(function(){
        thinking.remove();
        const a = document.createElement('div');
        a.className = 'ask-msg ai';
        a.innerHTML = '<p></p>';
        a.querySelector('p').textContent = "That's taking longer than it should to load your tour — try refreshing, or just ask a question below.";
        thread.appendChild(a);
        renderRow2([]);
        showFooter();
        maybeScrollToBottom();
      });
  }

  if (conversationHistory.length > 0) {
    replaySession();
  } else if (tourToken) {
    beginTourEntry();
  } else {
    startRotation();
  }

  // ---- Cross-page GO_TO resume (added 25 August 2026) ----
  // The other half of handleTourAction's cross-page branch above: a
  // pending action was stashed in sessionStorage right before the
  // navigation that brought us to THIS page load. If one is sitting there
  // and its destination's page matches where we actually are now, carry
  // out the scroll-and-highlight it was always meant to do — same
  // function, same visual result as an in-page GO_TO, just fired after a
  // real page load instead of a same-page reply. A short delay lets the
  // page's own layout (images, fonts, anything above the target that
  // shifts height on load) settle before measuring positions — the
  // in-page path never needed this since nothing above the target moves
  // mid-conversation, but a fresh page load can still be reflowing right
  // after DOMContentLoaded.
  //
  // Any mismatch — no pending action, unknown target, or a pending
  // action whose page doesn't match here (shouldn't happen, but a
  // guest could always intervene by hand) — is a silent no-op, same
  // fail-quiet rule as the rest of this dispatcher. Read once via
  // takePendingTourAction() itself, so a stale flag can never fire twice.
  //
  // pendingQuickReplies (added 26 August 2026 — see savePendingTourAction's
  // own comment for the real bug this fixes: a cross-page hop landing on
  // the final stop used to carry the just-offered feedback buttons across
  // in the DOM, which the hard navigation always destroyed before they
  // could be clicked, with no way to get them back). A genuine, freshly
  // built set — same renderRow2/submitToPanel machinery as every other
  // quick-reply row in the app — renders into Row 2 here instead, once the
  // page has actually settled, right after the scroll-and-highlight.
  (function(){
    const pending = takePendingTourAction();
    if (!pending) return;
    const dest = TOUR_DESTINATION_SELECTORS[pending.target];
    if (!dest) return;
    if (normalizedDestPage(dest.page) !== normalizedCurrentPath()) return;
    // 26 August 2026: a guided tour hopping someone to a new page IS the
    // deliberate action — per Chris, this should deterministically reveal
    // the thread (so the tour's own narration is actually visible here),
    // unlike ordinary same-tab navigation elsewhere on the site, which
    // stays collapsed on arrival per replaySession's 25 August redesign.
    // Called immediately, ahead of the scroll/highlight delay below, so
    // the panel is already open by the time the highlight lands rather
    // than visibly popping open a beat later.
    revealPanel();
    setTimeout(function(){
      scrollAndHighlight(dest.selector);
      if (pending.quickReplies && pending.quickReplies.length > 0) {
        renderRow2(pending.quickReplies);
        maybeScrollToBottom();
      }
    }, 300);
  })();

  // "About" nav-intent needs a different link target depending on which
  // page it's clicked from — "#about" when already on the homepage,
  // "/#about" (back to the homepage's section) from a subpage. Computed
  // once here instead of hardcoded per page copy, which is exactly the
  // kind of thing that silently drifts when duplicated (see file header).
  const ABOUT_HREF = (function(){
    const p = window.location.pathname;
    return (p === '/' || p === '/index.html') ? '#about' : '/#about';
  })();

  // "Close" button — 10 August 2026. Purely visual collapse: removes the
  // .expanded/.active classes that make the box tall and the thread
  // visible, but never touches thread.innerHTML or conversationHistory.
  // Both submitToPanel and the nav-intent handler already independently
  // re-add .expanded/.active on every new message — so the next message
  // (typed or another nav click) naturally re-expands the box with the
  // full prior history still sitting there underneath, untouched. The
  // only thing that actually clears any of this is a real page reload,
  // which resets the JS variables themselves — nothing in this button
  // does that.
  //
  // ---- Open/close redesign (25 August 2026, replacing the 24 August
  // "hide/reopen tab" pattern after real live-testing found it worse than
  // no affordance at all) ----
  // The 24 August version added a floating "Reopen chat" tab plus a hint
  // label next to the X, specifically so a visitor who'd closed the panel
  // had a visible way back in. Real testing surfaced three separate
  // problems with it: the tab and hint collided/misaligned on both mobile
  // and desktop; a page reload forced the FULL panel back open regardless
  // of whether the visitor had just closed it (session persistence and
  // panel VISIBILITY were wrongly tied together — see replaySession's own
  // comment); and clicking an unrelated nav button reopened the whole
  // conversation even when the visitor only wanted to browse elsewhere on
  // the page.
  //
  // The actual fix, per Chris (25 August 2026): stop treating "closed" as
  // a thing that needs its own dedicated escape hatch at all, and instead
  // make opening/closing behave the way visitors already expect from any
  // search-bar-like control on the web — focusing the input reveals what's
  // already there (no separate button needed), and clicking anywhere else
  // The floating X is fully removed (31 August 2026, Conversation Panel
  // redesign) — replaced by the persistent footer's "Hide Chat ⌃"
  // control (ensureFooter(), wired above). No collapse-handler wiring
  // lives here anymore; the input bar remains the reopen affordance,
  // unchanged from before.
  ensureFooter();
  ensureScrollLatestButton();

  // Click-outside-to-collapse. Only fires when the panel is actually open,
  // and deliberately ignores two categories of "outside" click rather than
  // collapsing on every single one: anything inside #ask-panel itself
  // (the input, the thread, quick-reply buttons, the mic, the X, the +
  // menu, every Admin/Tour secondary panel — all appended as descendants
  // of askPanel's own .ask-box, so none of them should close it), and any
  // of the site's own defined nav-intent triggers (About, Contact, etc. —
  // see NAV_INTENTS below), which have their own click handler that
  // deliberately OPENS the panel; without this exclusion, that handler's
  // own expand and this listener's collapse would both fire on the same
  // click and fight each other. Every other click on the page — page text,
  // whitespace, a plain link that isn't a defined trigger — collapses it.
  //
  // Shadow-DOM correction (30 August 2026): this listener lives on the
  // ordinary host document, but askPanel now lives inside the LiveAsk
  // shadow tree. Events that originate inside a shadow tree are
  // RETARGETED once they cross out of it to a listener on an ancestor
  // outside that tree — e.target here no longer reports the actual
  // clicked element, it reports the shadow host, so
  // e.target.closest('#ask-panel') could never find it and every click
  // anywhere inside the panel looked identical to a click genuinely
  // outside it. composedPath() returns the real, un-retargeted path the
  // event actually travelled, including everything inside the shadow
  // tree, in order — checking that path directly against the real
  // askPanel element reference (not a selector string, which would face
  // the same shadow-boundary problem all over again) is the correct fix.
  document.addEventListener('click', function(e){
    const askBox = askPanel.querySelector('.ask-box');
    if (!askBox.classList.contains('expanded')) return;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [e.target];
    if (path.indexOf(askPanel) !== -1) return;
    if (e.target.closest('[data-nav-intent]')) return;
    askBox.classList.remove('expanded');
    thread.classList.remove('active');
  });

  // ---- JIT privacy/collection notice (added 23 August 2026, simplified
  // 23 August 2026) ----
  // Wording and the Privacy link are owned entirely here, front-end,
  // deterministic — never generated by the model (see
  // liveaskbehaviourexpectations doc, "Core implementation principle": this
  // is a governed interface behaviour, not something left to model
  // improvisation).
  // Originally shown only when the backend detected the AI was asking for
  // information (a model-emitted tag plus a regex fallback) — real testing
  // showed that detection miss in ways that were hard to fully close.
  // Simplified per Chris's observation (23 August 2026): this system's
  // design already guarantees every AI-generated reply ends by moving the
  // conversation forward with a question (system-prompt.js, "Never end a
  // reply as a dead end"), so there's no need to detect WHICH replies ask
  // for something — showing it unconditionally on the session's very first
  // AI-generated reply covers every real case, with zero dependency on
  // model behaviour or pattern-matching. See isFirstAiReply() below.
  function buildPrivacyNoticeEl(){
    const p = document.createElement('p');
    p.className = 'ask-privacynotice';
    p.appendChild(document.createTextNode("We'll use the details you provide to respond to your enquiry. Please don't share sensitive information. "));
    const link = document.createElement('a');
    link.href = '/privacy-index.html';
    link.textContent = 'Privacy';
    p.appendChild(link);
    return p;
  }

  // True until the first assistant turn has actually landed in
  // conversationHistory — must always be called BEFORE that turn is pushed,
  // in every call site, or it'll never see "no assistant turns yet". A
  // restored session with a prior assistant turn already in history
  // correctly makes this false from the start, so the notice never
  // re-shows after a page-hop — it already ran once, earlier in this same
  // browser tab's session.
  function isFirstAiReply(){
    return !conversationHistory.some(function(m){ return m.role === 'assistant'; });
  }

  // ---- Quick Replies / Row 2 (Customer 000 / GEO 4, added 24 August 2026;
  // moved into the persistent Row 2 zone as part of the LiveAsk UI Panel
  // Upgrade, 26 August 2026) ----
  // Renders the model's offered closed-choice buttons (data.quickReplies —
  // see system-prompt.js "Guided (closed) questions — Quick Replies" and
  // Section 8). Distinct from NAV_INTENTS: a Quick Reply click is ordinary
  // conversational input, not a fixed opener — it goes back through the
  // exact same submitToPanel() path as if the visitor had typed the
  // button's own text, and can lead to a normal Claude reply (including
  // another round of Quick Replies, or none). Also distinct from Governed
  // Actions (lead capture, verification) — selecting a choice never itself
  // triggers a consequential action, only ordinary conversation input.
  //
  // Until 26 August 2026 this rendered a one-shot button row appended
  // inside whichever AI message bubble had just landed — meaning the
  // buttons for a mid-tour turn, or a tour-conclusion turn, lived and died
  // with that one bubble, and any turn that crossed a hard page navigation
  // lost them outright unless something (see savePendingTourAction) went
  // out of its way to carry them across by hand. Row 2 replaces that: one
  // persistent zone, immediately below the composer, always reflecting the
  // CURRENT turn's valid choices — cleared and rebuilt on every call, never
  // tied to a specific historical bubble. The '+' placeholder to its left
  // is static markup, not touched here — it's a reserved-but-inert spot
  // for the Phase 2 capability menu, per the approved UI Panel Upgrade
  // sequence.
  //
  // The old wrap.remove()-on-click dance (and the mobile race it was
  // working around — a self-removing button detaching itself from the
  // page before the outside-click-to-collapse listener could see the click
  // as "inside the panel") no longer applies: Row 2's buttons are never
  // removed synchronously on click, only disabled, and the container gets
  // wiped and rebuilt by the next renderRow2() call once a response (or a
  // failure) actually lands.
  function renderRow2(choices){
    Array.prototype.forEach.call(row2Left.querySelectorAll('.ask-quickreply-btn'), function(b){ b.remove(); });
    (choices || []).forEach(function(choice){
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ask-quickreply-btn';
      btn.textContent = choice;
      btn.addEventListener('click', function(){
        // Scoped to quickreply buttons only — mic/send now live in this
        // same #askRow2 (in .ask-row2-right) and must stay usable while a
        // choice submission is in flight, not get swept up by this guard.
        Array.prototype.forEach.call(row2Left.querySelectorAll('.ask-quickreply-btn'), function(b){ b.disabled = true; });
        submitToPanel(choice, { showVisitorBubble: true });
      });
      row2Left.appendChild(btn);
    });
  }

  // Defensive client-side re-validation of data.quickReplies — the Worker
  // already validates strictly (system-prompt.js Section 8 / index-worker.js),
  // but never trust a network response blindly for something rendered as
  // clickable UI. Same fail-closed rule as the backend: anything invalid
  // here just means no Quick Reply row renders, never a broken one.
  function validQuickReplies(data){
    if (!Array.isArray(data.quickReplies)) return [];
    return data.quickReplies
      .filter(function(c){ return typeof c === 'string' && c.trim().length > 0 && c.trim().length <= 40; })
      .map(function(c){ return c.trim(); })
      .slice(0, 4);
  }

  // Shared core — both manual typing and nav-triggered prompts flow through
  // this single, already-tested path. `showVisitorBubble` controls whether
  // the actual prompt text renders as a "You" bubble (real typed messages)
  // or stays invisible behind a plain system note (nav clicks) — a nav click
  // should never look like the visitor typed words they didn't type.
  function submitToPanel(promptText, opts){
    opts = opts || {};
    // The visitor has acted on the currently highlighted request. Restore
    // that historical message to normal styling before rendering the next
    // turn (which may itself contain a fresh instruction).
    completeInputInstruction();
    pauseRotation();
    thread.classList.add('active');
    askPanel.querySelector('.ask-box').classList.add('expanded');

    if(opts.systemNote){
      thread.appendChild(createActionReceiptEl(opts.systemNote));
    }

    // ---- RA PIN masking (added 25 August 2026, real live-test find) ----
    // Detected purely by checking whether the fixed, exact PIN-prompt text
    // was the AI's most recent turn — deterministic, no guessing at intent,
    // same "code decides, model never does" principle as everything else
    // security-relevant in this flow. The real PIN still has to reach the
    // server this one time (that's the whole point — the server is what
    // actually checks it against a stored hash), but nothing else about it
    // survives past this single request: the visible bubble shows a fixed
    // mask instead of the digits (a FIXED mask, not one sized to the PIN's
    // own length — a variable-length mask would leak how many digits it
    // was), and conversationHistory — which gets saved into this browser's
    // own sessionStorage AND resent in full on every later request — never
    // holds the real value, not even for a moment. See index-worker.js's
    // redactPinFromMessages for this same fix's backend half (a
    // defense-in-depth backstop that doesn't rely on this file having done
    // its part correctly).
    const lastAiTurn = conversationHistory.length > 0 ? conversationHistory[conversationHistory.length - 1] : null;
    const isPinAnswer = !!lastAiTurn && lastAiTurn.role === 'assistant' && lastAiTurn.content === PIN_PROMPT_TEXT;

    if(opts.showVisitorBubble !== false){
      const v = document.createElement('div');
      v.className = 'ask-msg visitor';
      v.innerHTML = '<p></p>';
      v.querySelector('p').textContent = isPinAnswer ? '••••••' : promptText;
      thread.appendChild(v);
    }

    clearInterval(rotateTimer); rotateTimer = null;
    clearTimeout(rotateFadeTimeout);
    setFinalPlaceholder();
    ph.classList.remove('fade');
    input.closest('.ask-input-row').classList.remove('has-text');

    // The array actually persisted to sessionStorage and resent on every
    // future turn gets a redacted placeholder, never the real PIN.
    conversationHistory.push({ role: 'user', content: isPinAnswer ? '[PIN entered]' : promptText });
    saveSession();

    const thinking = beginIdentity();
    // Real fix, 7 August 2026: this refocus previously ran BEFORE the
    // thinking-bubble append and scroll above — both real DOM mutations
    // that immediately undid it, so the cursor never actually stayed
    // visible long enough to be seen. Moved to after every synchronous
    // mutation in this function completes.
    // Real bug found live on mobile, 25 August 2026: this refocus used to
    // be unconditional — meaning it ran even when this turn came from a
    // quick-reply BUTTON tap, not typed text. Focusing a text input is
    // exactly what pops a phone's on-screen keyboard, so a visitor who'd
    // only ever tapped buttons kept getting the keyboard shoved open at
    // them for no reason. Now only opted into by the actual typed-message
    // path (send(), via opts.refocusInput) — a quick-reply choice never
    // asked for a keyboard, so it no longer summons one. See the matching
    // gates further down in this function's success/catch handlers.
    if (opts.refocusInput) {
      autoFocusPending = true;
      input.blur();
      requestAnimationFrame(function(){
        input.focus({ preventScroll: true }); // real paint gap before refocus — back-to-back blur/focus can get coalesced by the browser with no gap between them
      });
    }

    // The real PIN goes to the server in THIS one request only, spliced
    // back in on top of a copy of conversationHistory (which itself only
    // ever holds the redacted placeholder) — the one and only place the
    // actual value needs to exist at all is the single request the server
    // uses to check it against a stored hash.
    const outgoingMessages = isPinAnswer
      ? conversationHistory.slice(0, -1).concat([{ role: 'user', content: promptText }])
      : conversationHistory;

    fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionId, messages: outgoingMessages, tourToken: tourToken })
    })
      .then(function(res){ return res.json(); })
      .then(function(data){
        rememberVoiceAuthority(data);
        beginAnswering(thinking);
        completeIdentity(thinking);
        const replyText = data.reply || "Something went wrong on my end — try again in a moment.";
        // Must be checked BEFORE this reply is pushed to conversationHistory
        // below — see isFirstAiReply().
        const showPrivacyNotice = isFirstAiReply();
        conversationHistory.push({ role: 'assistant', content: replyText });
        saveSession();
        const a = document.createElement('div');
        a.className = 'ask-msg ai';
        a.innerHTML = '<p></p>';
        // Capture the reply <p> BEFORE inserting the notice paragraph — real
        // bug found in testing (23 August 2026): insertBefore adds a SECOND
        // <p>, so a querySelector('p') called afterward grabs whichever one
        // is now first in DOM order (the notice), not the reply — silently
        // overwriting the notice text and leaving the real reply empty.
        const replyP = a.querySelector('p');
        if (showPrivacyNotice) {
          a.insertBefore(buildPrivacyNoticeEl(), replyP);
        }
        replyP.textContent = replyText;
        const quickReplyChoices = validQuickReplies(data);
        renderRow2(quickReplyChoices);
        thread.appendChild(a);
        activateInputInstruction(replyText, a);
        showFooter();
        maybeScrollToBottom();
        // Custom AI Tours: only ever present on a tour guest's turn, and
        // only on the specific turn the Worker's guest-state-machine
        // decided to fire it (see handleTourAction above and the guest
        // state machine in index-worker.js's fetch()) — undefined/absent
        // on every ordinary reply, so this is a no-op there.
        if (data.action) handleTourAction(data.action, quickReplyChoices);
        // Real fix, 7 August 2026: the async reply lands well after the
        // earlier submit-time refocus, and appending it here is a real DOM
        // mutation that can reset the caret blink a second time — same
        // underlying browser behaviour as the rotation-text issue, just
        // triggered later in the flow. Refocus again once the reply is
        // actually in. Gated the same way as the submit-time refocus above
        // (25 August 2026) — same reasoning: don't summon the phone
        // keyboard on the back of a quick-reply tap.
        if (opts.refocusInput) {
          autoFocusPending = true;
          input.blur();
          requestAnimationFrame(function(){
            input.focus({ preventScroll: true }); // real paint gap before refocus
          });
        }
      })
      .catch(function(){
        thinking.remove();
        const a = document.createElement('div');
        a.className = 'ask-msg ai';
        a.innerHTML = '<p></p>';
        a.querySelector('p').textContent = "That's taking longer than it should — try again, or jump straight to a door below.";
        thread.appendChild(a);
        renderRow2([]);
        showFooter();
        maybeScrollToBottom();
        if (opts.refocusInput) {
          autoFocusPending = true;
          input.blur();
          requestAnimationFrame(function(){
            input.focus({ preventScroll: true }); // real paint gap before refocus
          });
        }
      });
  }

  function send(){
    const q = input.value.trim();
    if(!q) return;
    input.value = '';
    input.closest('.ask-input-row').classList.remove('has-text');
    input.style.height = 'auto';
    updatePrimaryControlState();
    updatePrimaryControlState();
    // refocusInput: true — this is the one real "the visitor was just
    // typing" path (see submitToPanel's own comment on the flag), so
    // keeping the keyboard open/refocused here is the wanted behaviour,
    // not the bug.
    submitToPanel(q, { showVisitorBubble: true, refocusInput: true });
  }

  input.addEventListener('keydown', function(e){ if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); send(); } });

  // ---- SearchAction deep-link handler ----
  // Makes the WebSite/SearchAction schema entry genuinely functional, not
  // just decorative markup. When an AI engine constructs a URL like
  // https://customer.example/?q=some+question#ask-panel from that schema,
  // this reads the query, scrolls to the panel, and submits it through the
  // exact same tested pipeline as if the visitor had typed it themselves —
  // same lead capture, same verification flow, nothing new to maintain.
  // REMOVED during Stage A Platform migration (30 August 2026): a
  // "Generative AIs" term-explainer modal previously lived here,
  // originally added 10 August 2026. Traced during migration and
  // confirmed, per its own removed comment, to only ever operate on
  // trigger/modal markup that exists solely on a prior tenant's own
  // homepage — genuinely tenant page content bundled into this
  // shared file for convenience, not LiveAsk panel functionality. It
  // does not belong in the reusable Platform runtime and has been
  // excluded rather than migrated. If that production site
  // still needs this behaviour, it belongs in that site's own page-level
  // JavaScript going forward, not in Platform core.

  (function handleSearchActionDeepLink(){
    const params = new URLSearchParams(window.location.search);
    const q = params.get('q');
    if(!q) return;
    const cleanUrl = window.location.pathname + window.location.hash;
    window.history.replaceState({}, '', cleanUrl); // avoid re-submitting on refresh
    panel.byId('ask-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(function(){ submitToPanel(q, { showVisitorBubble: true }); }, 400);
  })();

  // ---- Nav-intent triggers ("Services", "About", "Contact", etc.) — the
  // click handler below (reading NAV_INTENTS[...] off each element's
  // data-nav-intent attribute) is reusable Core mechanics; the object
  // itself is CUSTOMER-SPECIFIC CONTENT and MUST be replaced per
  // deployment. Genericized 1 September 2026 — this previously held
  // a tenant's actual product names and real prices verbatim (a
  // genuine cross-customer contamination risk, not just messy example
  // content). Every value below is placeholder text, deliberately
  // written so it cannot be mistaken for real business data — replace
  // this entire object with the actual deployment's real service names,
  // pricing, and copy. Each key here must also correspond to a real
  // `data-nav-intent="..."` attribute somewhere in the customer's own
  // HTML — that markup lives on their site, not in this file.
  const NAV_INTENTS = {
    services: {
      note: 'Services',
      reply: "Here's an overview of what we offer:\n\nExample Service A — from $X · one or two sentences describing what this service does and who it's for\nExample Service B — from $X · one or two sentences describing what this service does and who it's for\nExample Service C — from $X · one or two sentences describing what this service does and who it's for\n\nWhich would you like to know more about?"
    },
    about: {
      note: 'About',
      reply: "A short paragraph introducing this business — who they are, what they do differently, and why a visitor should care. Replace with the deployment's real About copy.",
      linkText: "Click here for our full About section",
      linkHref: ABOUT_HREF
    },
    contact: {
      note: 'Contact',
      reply: "Thank you for requesting contact from us.\nMay we start with your name please?"
    },
    'book-audit': {
      note: 'Example Enquiry A',
      reply: "Thank you for your interest — may I have your name and business name please?"
    },
    'enquire-build': {
      note: 'Example Enquiry B',
      reply: "Thank you for enquiring — may I have your name and business name please?"
    },
    'register-protocol': {
      note: 'Example Enquiry C',
      reply: "Thank you for enquiring — may I have your name and business name please?"
    },
    'enquire-opportunity': {
      note: 'Example Enquiry D',
      reply: "Thank you for enquiring — may I have your name and business name please?"
    }
  };
  // Whether the notice shows for a nav-intent opener (including "About",
  // which doesn't ask the visitor anything) is now decided purely by
  // isFirstAiReply() at the click handler below, same as every other AI
  // reply path — no per-entry flag needed any more.
  host.$$('[data-nav-intent]').forEach(function(el){
    el.addEventListener('click', function(e){
      e.preventDefault();
      const cfg = NAV_INTENTS[el.getAttribute('data-nav-intent')];
      if(!cfg) return;
      panel.byId('ask-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
      pauseRotation();
      // Real bug fix, 7 August 2026: this handler's own refocus deliberately
      // sets autoFocusPending=true (to protect the "Ask another question..."
      // text from immediately re-fading) — but that also skips the focus
      // handler's clearInterval/clearTimeout, since both live in the same
      // branch. Rotation was NEVER actually stopping after a nav click like
      // Contact — it kept firing every 8s in the background indefinitely,
      // explaining both the text-ghosting and the cursor disruption. Made
      // unconditional here, not dependent on that shared branch at all.
      clearInterval(rotateTimer); rotateTimer = null;
      clearTimeout(rotateFadeTimeout);
      thread.classList.add('active');
      askPanel.querySelector('.ask-box').classList.add('expanded');

      const note = createActionReceiptEl(cfg.note);
      thread.appendChild(note);

      const a = document.createElement('div');
      a.className = 'ask-msg ai';
      a.innerHTML = '<p></p>';
      // Capture the reply <p> BEFORE inserting the notice — see the matching
      // comment in submitToPanel's success handler above for why. Must be
      // checked BEFORE the assistant turn is pushed to conversationHistory
      // further down — see isFirstAiReply().
      const replyP = a.querySelector('p');
      if (isFirstAiReply()) {
        a.insertBefore(buildPrivacyNoticeEl(), replyP);
      }
      replyP.textContent = cfg.reply;
      // Optional real, genuinely clickable link — a separate element, not
      // text smuggled inside cfg.reply (which renders as inert plain text
      // via textContent). Only fires when a config entry actually supplies
      // linkText/linkHref; every other nav-intent reply is untouched.
      if (cfg.linkText && cfg.linkHref) {
        const linkPara = document.createElement('p');
        const link = document.createElement('a');
        link.href = cfg.linkHref;
        link.textContent = cfg.linkText;
        linkPara.appendChild(link);
        a.appendChild(linkPara);
      }
      thread.appendChild(a);
      showFooter();
      maybeScrollToBottom();

      // Fed into history as an assistant turn so the visitor's next reply
      // (e.g. giving their name after Contact) continues naturally through
      // the normal, already-tested flow — no separate Claude call for
      // this fixed opener itself, no cost, no drift, no AI improvisation.
      conversationHistory.push({ role: 'assistant', content: cfg.reply });
      saveSession();

      setFinalPlaceholder();
      ph.classList.remove('fade');
      // Real bug found live on mobile, 25 August 2026: this handler used to
      // end with a forced refocus of the text input (see this file's git
      // history / the PIN/quick-reply fix notes above for the fuller story)
      // — but clicking a nav button (About/Services/Contact etc.) is a
      // button tap, not typed text, and focusing a text input is exactly
      // what pops a phone's on-screen keyboard. Removed outright rather
      // than gated, since a nav-intent click is never the "visitor was
      // just typing" case submitToPanel's refocusInput flag exists for.
    });
  });

  // ====================================================================
  // ---- `+` capability menu / Secondary Input Layer / Admin (LiveAsk UI
  // Panel Upgrade v3, added 27 August 2026) ----
  // ====================================================================
  // One shared popover shell — a discreet upward-opening popover on
  // desktop, a capped-height bottom sheet with a scrim on mobile (spec
  // Section 4) — reused for the public `+` menu itself, the Secondary Input
  // Layer (masked PIN entry, Give Feedback's rating/comment, Restart Tour's
  // confirmation), and every RA Admin sub-view (Create Tour handoff, Manage
  // Tours, Manage Quick Menu). Built entirely as dynamic DOM, same
  // established pattern as refreshChatCopyLink/buildPrivacyNoticeEl above —
  // nothing new baked into the three pages' static markup beyond the `+`
  // button itself.
  //
  // Design note on "conversational" vs "structured": Tour CREATION keeps
  // its existing fully-conversational bookflow engine untouched (spec
  // Section 8.3, Section 12's "do not convert generative Tour authoring
  // into a rigid form wizard") — Admin's "Create Tour" below is only a
  // front door into that same engine (see adminCreateTourStart in
  // index-worker.js). Everything else here (Manage Tours' Run/Test and
  // Edit, Manage Quick Menu's Add) genuinely IS structured admin data entry
  // — Section 3.4 explicitly lists "small contextual choice sets" as a
  // Secondary Input primitive, and these fit that better than a multi-turn
  // chat exchange would.

  const scrim = document.createElement('div');
  scrim.className = 'ask-panel-scrim';
  scrim.id = 'askPanelScrim';
  const popover = document.createElement('div');
  popover.className = 'ask-popover';
  popover.id = 'askPopover';
  askPanel.querySelector('.ask-box').appendChild(scrim);
  askPanel.querySelector('.ask-box').appendChild(popover);

  const plusBtn = panel.byId('askPlusBtn');

  // Admin session state — mirrors the server's adminsession:<sessionId>
  // record only loosely (raName, for display; the actual authority lives
  // server-side and is re-checked on every adminAction call). Cleared
  // whenever the popover fully closes, same "don't linger" principle as the
  // server's own 30-minute TTL — a closed panel means this sitting is over.
  let adminAuthed = null; // { raName } | null

  function closePlusMenu(){
    popover.classList.remove('open');
    scrim.classList.remove('open');
    plusBtn.setAttribute('aria-expanded', 'false');
    popover.classList.remove('ask-popover--root-menu');
    adminAuthed = null;
  }

  // Stage 1 correction, 10 September 2026: every secondary surface now
  // overlays the LiveAsk box and shares the UIP's bottom edge. It no longer
  // opens below the UIP and consumes the host website. Horizontal placement
  // remains anchored to the real + control and is clamped inside the box.
  function positionPopover(){
    const boxRect = askPanel.querySelector('.ask-box').getBoundingClientRect();
    const btnRect = plusBtn.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const edgeGap = 8;
    // Leave the invoking + control visible immediately to the menu's left;
    // this preserves the familiar press-again-to-close option without the
    // icon colliding with the menu's final row.
    const requestedLeft = btnRect.right - boxRect.left + edgeGap;
    const maximumLeft = Math.max(edgeGap, boxRect.width - popoverRect.width - edgeGap);

    popover.style.left = Math.max(edgeGap, Math.min(requestedLeft, maximumLeft)) + 'px';
    // Secondary controls belong to the LiveAsk surface, not the host page.
    // Overlay the UIP and align the two bottom borders instead of opening
    // beneath it and consuming the customer's website area.
    popover.style.bottom = '0px';
    popover.style.top = 'auto';
  }

  // Renders one "screen" into the shared popover — a title, an optional
  // Back control, and whatever the caller builds into the body container.
  // Every menu/sub-view below calls this rather than manipulating popover
  // directly, so opening a new screen always starts from a clean slate.
  // opts.progress = { step, total } — Phase 2 UI refinement pass: renders
  // a small "n/total" + filled bar above the title, used by the two-step
  // Give Feedback flow. Purely presentational — carries no state of its
  // own beyond what the caller already tracks (rating/comment).
  function renderSecondaryPanel(title, buildFn, opts){
    opts = opts || {};
    popover.classList.toggle('ask-popover--root-menu', opts.rootMenu === true);
    popover.innerHTML = '';
    if (opts.onBack) {
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'ask-popover-back';
      back.textContent = '← Back';
      back.addEventListener('click', opts.onBack);
      popover.appendChild(back);
    }
    if (opts.progress) {
      const wrap = document.createElement('div');
      wrap.className = 'ask-popover-progress';
      const lbl = document.createElement('div');
      lbl.className = 'ask-popover-progress-label';
      lbl.textContent = opts.progress.step + '/' + opts.progress.total;
      const bar = document.createElement('div');
      bar.className = 'ask-popover-progress-bar';
      const fill = document.createElement('div');
      fill.className = 'ask-popover-progress-fill';
      fill.style.width = Math.round((opts.progress.step / opts.progress.total) * 100) + '%';
      bar.appendChild(fill);
      wrap.appendChild(lbl);
      wrap.appendChild(bar);
      popover.appendChild(wrap);
    }
    if (title) {
      const h = document.createElement('div');
      h.className = 'ask-popover-title';
      h.textContent = title;
      popover.appendChild(h);
    }
    const body = document.createElement('div');
    popover.appendChild(body);
    buildFn(body);
    popover.classList.add('open');
    scrim.classList.add('open');
    plusBtn.setAttribute('aria-expanded', 'true');
    positionPopover();
  }

  function renderPopoverError(container, message){
    const existing = container.querySelector('.ask-popover-error');
    if (existing) existing.remove();
    if (!message) return;
    const e = document.createElement('div');
    e.className = 'ask-popover-error';
    e.textContent = message;
    container.appendChild(e);
  }

  function renderChoiceButtons(container, choices, onPick){
    choices.forEach(function(choice){
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ask-popover-item';
      btn.textContent = choice.label !== undefined ? choice.label : choice;
      btn.addEventListener('click', function(){ onPick(choice.value !== undefined ? choice.value : choice); });
      container.appendChild(btn);
    });
  }

  // Phase 2 UI refinement pass — full-width navigation rows with a trailing
  // chevron, used for Admin Home and Tour Detail's action list (Section 6
  // and 8 of the pass brief: "navigation, not a form/CTA buttons"). Rows
  // are plain data objects: { label, value, danger }. `danger` gets the
  // same visually-separated destructive treatment as Revoke everywhere
  // else — never an ordinary row, per the pass brief's explicit carve-out.
  function renderNavRows(container, rows, onPick){
    rows.forEach(function(row){
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ask-popover-navrow' + (row.danger ? ' ask-popover-navrow--danger' : '');
      const lbl = document.createElement('span');
      lbl.textContent = row.label;
      const chev = document.createElement('span');
      chev.className = 'chev';
      chev.setAttribute('aria-hidden', 'true');
      chev.textContent = '›';
      btn.appendChild(lbl);
      btn.appendChild(chev);
      btn.addEventListener('click', function(){ onPick(row.value !== undefined ? row.value : row); });
      container.appendChild(btn);
    });
  }

  // opts.multiline → <textarea> instead of <input> (Give Feedback's comment
  // step wants a generously sized field, Section 4 of the pass brief).
  // Autofocuses on render and, when opts.onEnter is given, Enter submits —
  // both requested explicitly for Admin PIN (Section 5) and applied to
  // every other single-field popover step for the same reason: "apply
  // consistent treatment... for inputs" (Global Phase 2 UI System). Shift+
  // Enter still inserts a newline in the textarea case, as expected.
  function renderTextField(container, opts){
    opts = opts || {};
    const field = document.createElement(opts.multiline ? 'textarea' : 'input');
    field.className = 'ask-popover-field' + (opts.multiline ? ' ask-popover-field--textarea' : '');
    if (!opts.multiline) {
      field.type = opts.masked ? 'password' : 'text';
      if (opts.numeric) field.setAttribute('inputmode', 'numeric');
    } else {
      field.rows = 4;
    }
    if (opts.placeholder) field.placeholder = opts.placeholder;
    if (opts.maxLength) field.maxLength = opts.maxLength;
    if (opts.onEnter) {
      field.addEventListener('keydown', function(e){
        if (e.key === 'Enter' && !(opts.multiline && !e.metaKey && !e.ctrlKey)) {
          e.preventDefault();
          opts.onEnter();
        }
      });
    }
    container.appendChild(field);
    setTimeout(function(){ try { field.focus(); } catch (e) {} }, 0);
    return field;
  }

  // Primary actions use the LiveAsk blue system (--logo-blue, via the
  // existing site-wide .btn--liveask class) rather than the site's
  // burgundy .btn--primary — confirmed 28 August 2026: burgundy stays
  // reserved for the rest of the tenant site, not this component
  // family. Destructive primary actions (Revoke, delete-confirm) pass
  // `danger:true` instead, which gets the dedicated --danger treatment
  // rather than looking like an ordinary blue primary action.
  function renderActions(container, actions){
    const row = document.createElement('div');
    row.className = 'ask-popover-actions';
    actions.forEach(function(a){
      const btn = document.createElement('button');
      btn.type = 'button';
      const variant = a.danger ? 'btn--danger' : (a.primary ? 'btn--liveask' : 'btn--ghost');
      btn.className = 'btn btn--compact ' + variant;
      btn.textContent = a.label;
      btn.addEventListener('click', a.onClick);
      row.appendChild(btn);
    });
    container.appendChild(row);
  }

  // Generic POST-and-parse helper — every Admin/Feedback/Restart request
  // below is small and stateless from the client's point of view (unlike
  // the ordinary chat pipeline, none of these touch conversationHistory),
  // so they share this rather than each hand-rolling fetch/json().
  function postWorker(bodyObj){
    return fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bodyObj)
    }).then(function(res){ return res.json(); });
  }

  // ---- Public Customer Quick Menu (Section 6) — fetched once per page
  // load and re-fetched every time the + menu is (re)opened at the root, so
  // an RA's just-added/deleted item shows up for this same visitor without
  // needing a reload. No admin auth on this request — every visitor sees
  // it. ----
  function fetchQuickMenuItems(){
    return postWorker({ getQuickMenu: true }).then(function(data){
      return (data && data.ok) ? data.items : [];
    }).catch(function(){ return []; });
  }

  function runQuickMenuItem(item){
    closePlusMenu();
    if (item.type === 'page') {
      window.location.href = item.target;
    } else if (item.type === 'chat') {
      panel.byId('ask-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
      submitToPanel(item.prompt, { showVisitorBubble: false, systemNote: item.title });
    } else if (item.type === 'contact') {
      const trigger = host.$('[data-nav-intent="' + item.contactIntent + '"]');
      if (trigger) trigger.click();
    }
  }

  // ---- LiveAsk section item: How to use LiveAsk (Section 5.1.A) ----
  // Fixed, code-authored explanation — no Claude call, same "code decides
  // fixed governed copy" principle as NAV_INTENTS above. Rendered as an
  // ordinary AI bubble in the main thread (not inside the popover) since
  // this is genuinely part of the conversation, just triggered by a menu
  // click instead of typed text.
  function showHowToUseLiveAsk(){
    closePlusMenu();
    thread.classList.add('active');
    askPanel.querySelector('.ask-box').classList.add('expanded');
    const note = createActionReceiptEl('How to use LiveAsk');
    thread.appendChild(note);
    const replyText = "I can answer questions about this website, help you find what you're looking for, walk you through a Guided Tour of the site if one's available, and help you get in touch with the team when you're ready. Just ask me anything, or use the choices below.";
    const a = document.createElement('div');
    a.className = 'ask-msg ai';
    a.innerHTML = '<p></p>';
    const replyP = a.querySelector('p');
    if (isFirstAiReply()) a.insertBefore(buildPrivacyNoticeEl(), replyP);
    replyP.textContent = replyText;
    thread.appendChild(a);
    conversationHistory.push({ role: 'assistant', content: replyText });
    saveSession();
    // 'What can you help with?' replaces the previous 'Find the right
    // service' (1 September 2026 correction) — that phrasing assumed a
    // services-based business model, which won't fit every deployment
    // (a retail or SaaS customer may have no "services" to find at all).
    const choices = tourToken ? [] : ['What can you help with?', 'Contact'];
    renderRow2(choices);
    showFooter();
    maybeScrollToBottom();
  }

  // ---- LiveAsk section item: Start new chat (Section 5.1.B) ----
  // Omitted from the menu entirely while a Tour is active (confirmed 27
  // August 2026 — see the v3 Addendum) — openPlusMenu below never even
  // renders this item in that case, so there is nothing to gate here.
  function startNewChatConfirm(){
    renderSecondaryPanel('Start a new chat?', function(body){
      const p = document.createElement('div');
      p.className = 'ask-popover-note';
      p.textContent = 'This will clear the current conversation from this browser tab.';
      body.appendChild(p);
      renderActions(body, [
        { label: 'Start new chat', primary: true, onClick: function(){
          conversationHistory = [];
          try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
          saveSession();
          thread.innerHTML = '';
          askPanel.querySelector('.ask-box').classList.remove('expanded');
          thread.classList.remove('active');
          ph.classList.remove('ask-fake-placeholder--final');
          ph.textContent = prompts[0];
          i = 0;
          ph.classList.remove('fade');
          startRotation();
          closePlusMenu();
        } },
        { label: 'Cancel', onClick: closePlusMenu }
      ]);
    }, { onBack: openPlusMenu });
  }

  // ---- LiveAsk section item: Give feedback (Section 5.1.C) ----
  // Two-step flow with a shared progress treatment (Phase 2 UI refinement
  // pass, Sections 3-4) — quality/interaction reference only, LiveAsk's own
  // visual identity throughout: large circular rating controls in place of
  // the previous bare vertical "1 2 3 4 5" list, selection advances
  // immediately to step 2 exactly as before (no change to that behaviour).
  function giveFeedbackFlow(){
    renderSecondaryPanel('How would you rate your overall conversation with LiveAsk?', function(body){
      const row = document.createElement('div');
      row.className = 'ask-popover-rating-row';
      ['1', '2', '3', '4', '5'].forEach(function(n){
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ask-popover-rating-btn';
        btn.textContent = n;
        btn.setAttribute('aria-label', 'Rate ' + n + ' of 5');
        btn.addEventListener('click', function(){ giveFeedbackCommentStep(parseInt(n, 10)); });
        row.appendChild(btn);
      });
      const scale = document.createElement('div');
      scale.className = 'ask-popover-rating-scale';
      scale.innerHTML = '<span>Not satisfied</span><span>Very satisfied</span>';
      body.appendChild(row);
      body.appendChild(scale);
    }, { onBack: openPlusMenu, progress: { step: 1, total: 2 } });
  }
  function giveFeedbackCommentStep(rating){
    renderSecondaryPanel("Anything you'd like to add?", function(body){
      const field = renderTextField(body, { placeholder: 'Optional comment', multiline: true });
      renderActions(body, [
        { label: 'Submit', primary: true, onClick: function(){
          postWorker({ giveFeedback: { sessionId: sessionId, rating: rating, comment: field.value } })
            .then(function(){
              renderSecondaryPanel('Thanks for the feedback!', function(body2){
                renderActions(body2, [{ label: 'Done', primary: true, onClick: closePlusMenu }]);
              });
            })
            .catch(function(){ renderPopoverError(body, "That didn't send — please try again."); });
        } },
        { label: 'Cancel', onClick: closePlusMenu }
      ]);
    }, { onBack: function(){ giveFeedbackFlow(); }, progress: { step: 2, total: 2 } });
  }

  // ---- LiveAsk section item: Restart Tour (Section 5.1.D) — contextual
  // only, only ever offered by openPlusMenu when tourToken is set. ----
  function restartTourConfirm(){
    renderSecondaryPanel('Restart this Tour from the beginning?', function(body){
      renderActions(body, [
        { label: 'Restart', primary: true, onClick: function(){
          postWorker({ restartTour: true, sessionId: sessionId, tourToken: tourToken })
            .then(function(data){
              closePlusMenu();
              if (!data.ok) return;
              conversationHistory = [{ role: 'assistant', content: data.reply }];
              saveSession();
              thread.innerHTML = '';
              thread.classList.add('active');
              askPanel.querySelector('.ask-box').classList.add('expanded');
              const a = document.createElement('div');
              a.className = 'ask-msg ai';
              a.innerHTML = '<p></p>';
              a.querySelector('p').textContent = data.reply;
              thread.appendChild(a);
              renderRow2(data.quickReplies || []);
              showFooter();
              maybeScrollToBottom();
            });
        } },
        { label: 'Cancel', onClick: closePlusMenu }
      ]);
    }, { onBack: openPlusMenu });
  }

  // ====================================================================
  // ---- Admin (Section 5.1.E, 7, 8) ----
  // ====================================================================
  function adminPinEntry(){
    renderSecondaryPanel('Admin', function(body){
      const field = renderTextField(body, { masked: true, placeholder: 'PIN', numeric: true, onEnter: function(){ submitPin(); } });
      function submitPin(){
        // The raw PIN travels in THIS one request only, via a dedicated
        // field never touching messages/conversationHistory — see
        // handleAdminAuth's own header comment in index-worker.js for why
        // that's the whole point of this being a separate mechanism from
        // the in-chat Book Tour PIN step.
        postWorker({ adminAuth: { sessionId: sessionId, pin: field.value } }).then(function(data){
          if (!data.ok) { renderPopoverError(body, data.error || "That didn't work."); field.value = ''; return; }
          adminAuthed = { raName: data.raName };
          adminMenu();
        });
      }
      renderActions(body, [
        { label: 'Continue', primary: true, onClick: submitPin },
        { label: 'Cancel', onClick: closePlusMenu }
      ]);
    }, { onBack: openPlusMenu });
  }

  function adminAction(action, extra){
    return postWorker({ adminAction: Object.assign({ sessionId: sessionId, action: action }, extra || {}) });
  }

  function adminMenu(){
    renderSecondaryPanel('Admin — ' + adminAuthed.raName, function(body){
      renderNavRows(body, [
        { label: 'Create Tour', value: 'create' },
        { label: 'Manage Tours', value: 'manage' },
        { label: 'Manage Quick Menu', value: 'quickmenu' }
      ], function(choice){
        if (choice === 'create') adminCreateTour();
        else if (choice === 'manage') adminManageToursList();
        else if (choice === 'quickmenu') adminQuickMenuList();
      });
    }, { onBack: closePlusMenu });
  }

  // ---- Create Tour (Section 8.3) — hands off into the SAME proven
  // bookflow engine Tour creation already uses (see adminCreateTourStart in
  // index-worker.js). From here on, the RA continues in the ORDINARY chat
  // panel, not the Secondary Input Layer — exactly as if they'd typed
  // "book tour" and their PIN in chat. ----
  function adminCreateTour(){
    adminAction('createTourStart').then(function(data){
      closePlusMenu();
      if (!data.ok) return;
      thread.classList.add('active');
      askPanel.querySelector('.ask-box').classList.add('expanded');
      const note = document.createElement('div');
      note.className = 'ask-sysnote';
      note.textContent = 'Admin: Create Tour';
      thread.appendChild(note);
      const a = document.createElement('div');
      a.className = 'ask-msg ai';
      a.innerHTML = '<p></p>';
      a.querySelector('p').textContent = data.reply;
      thread.appendChild(a);
      conversationHistory.push({ role: 'assistant', content: data.reply });
      saveSession();
      renderRow2(data.quickReplies || []);
      showFooter();
      maybeScrollToBottom();
    });
  }

  // ---- Manage Tours (Section 8.4) ----
  function adminManageToursList(){
    renderSecondaryPanel('Manage Tours', function(body){
      body.textContent = 'Loading…';
      adminAction('manageToursList').then(function(data){
        body.innerHTML = '';
        if (!data.ok) { renderPopoverError(body, data.error); return; }
        const active = data.tours.filter(function(t){ return t.status === 'Active'; });
        const expired = data.tours.filter(function(t){ return t.status === 'Expired'; });
        function renderGroup(label, list){
          if (list.length === 0) return;
          const lbl = document.createElement('div');
          lbl.className = 'ask-popover-section-label';
          lbl.textContent = label;
          body.appendChild(lbl);
          list.forEach(function(t){
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'ask-popover-tourrow';
            row.innerHTML = '<div class="txt"><div class="ttl"></div><div class="meta"></div></div><span class="chev" aria-hidden="true">›</span>';
            row.querySelector('.ttl').textContent = t.tourName || t.guestName || '(untitled tour)';
            row.querySelector('.meta').textContent = t.guestName ? ('Guest: ' + t.guestName) : 'Multiple recipients';
            row.addEventListener('click', function(){ adminManageToursDetail(t.token); });
            body.appendChild(row);
          });
        }
        renderGroup('Active', active);
        renderGroup('Expired', expired);
        if (active.length === 0 && expired.length === 0) {
          const p = document.createElement('div');
          p.className = 'ask-popover-note';
          p.textContent = "You haven't created any tours yet.";
          body.appendChild(p);
        }
      });
    }, { onBack: adminMenu });
  }

  // Tour Detail (Phase 2 UI refinement pass, Section 8) — a proper detail
  // layer (name + status pill, then labelled metadata rows, then a
  // clearly-separated actions area) rather than the previous flat text
  // dump. `expiresAt` comes from the narrow, explicitly-approved backend
  // exception in adminManageToursReview (index-worker.js) — Active/Expired
  // here is derived client-side from that same already-stored value, the
  // identical derivation adminManageToursList already does server-side;
  // nothing here invents data the backend doesn't provide.
  function adminManageToursDetail(token){
    renderSecondaryPanel(null, function(body){
      body.textContent = 'Loading…';
      adminAction('manageToursReview', { token: token }).then(function(data){
        body.innerHTML = '';
        if (!data.ok) { renderPopoverError(body, data.error); return; }
        const t = data.tour;
        const expired = !!(t.expiresAt && t.expiresAt < Date.now());

        const head = document.createElement('div');
        head.className = 'ask-popover-detail-head';
        const title = document.createElement('div');
        title.className = 'ask-popover-detail-title';
        title.textContent = t.tourName || t.guestName || '(untitled tour)';
        const pill = document.createElement('span');
        pill.className = 'ask-popover-status-pill ' + (expired ? 'ask-popover-status-pill--expired' : 'ask-popover-status-pill--active');
        pill.textContent = expired ? 'Expired' : 'Active';
        head.appendChild(title);
        head.appendChild(pill);
        body.appendChild(head);

        const meta = document.createElement('div');
        meta.className = 'ask-popover-detail-meta';
        const rows = [
          ['Guest', t.guestName || 'Multiple recipients'],
          ['Stops', t.destinations.join(' → ')],
          ['Locked in', t.lockedIn ? 'Yes' : 'No (still a draft)'],
          ['Guest visits recorded', String(t.guestSessions)],
          ['RA preview runs recorded', String(t.previewSessions)]
        ];
        if (t.expiresAt) {
          rows.push([expired ? 'Expired' : 'Expires', new Date(t.expiresAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })]);
        }
        rows.forEach(function(pair){
          const row = document.createElement('div');
          row.className = 'ask-popover-detail-row';
          const k = document.createElement('span');
          k.className = 'k';
          k.textContent = pair[0];
          const v = document.createElement('span');
          v.className = 'v';
          v.textContent = pair[1];
          row.appendChild(k);
          row.appendChild(v);
          meta.appendChild(row);
        });
        body.appendChild(meta);

        const actions = document.createElement('div');
        actions.className = 'ask-popover-detail-actions';
        body.appendChild(actions);
        // Ordinary actions get the standard nav-row treatment; Revoke is
        // visually separated toward the bottom with the destructive
        // treatment (Section 8's explicit requirement) via danger:true.
        renderNavRows(actions, [
          { label: 'Run/Test', value: 'preview' },
          { label: 'Edit', value: 'edit' },
          { label: 'Duplicate', value: 'duplicate' },
          { label: 'Extend expiry', value: 'extend' },
          { label: 'Revoke', value: 'revoke', danger: true }
        ], function(choice){
          if (choice === 'preview') adminManageToursPreview(token);
          else if (choice === 'edit') adminManageToursEdit(token);
          else if (choice === 'duplicate') adminManageToursDuplicate(token);
          else if (choice === 'extend') adminManageToursExtend(token);
          else if (choice === 'revoke') adminManageToursRevokeConfirm(token);
        });
      });
    }, { onBack: adminManageToursList });
  }

  // Run/Test — pages through the server's already-computed narration for
  // every stop, entirely client-side (see adminManageToursPreview's own
  // header comment in index-worker.js: this NEVER touches the real guest
  // link or a tourprogress: record, so it stays safe to re-run any time,
  // including after lock-in).
  function adminManageToursPreview(token){
    renderSecondaryPanel('Run/Test', function(body){
      body.textContent = 'Loading…';
      adminAction('manageToursPreview', { token: token }).then(function(data){
        body.innerHTML = '';
        if (!data.ok) { renderPopoverError(body, data.error); return; }
        let idx = 0;
        const textEl = document.createElement('div');
        textEl.className = 'ask-popover-note';
        body.appendChild(textEl);
        function render(){ textEl.textContent = data.stops[idx].text; }
        render();
        renderActions(body, [
          { label: 'Next', primary: true, onClick: function(){
            if (idx < data.stops.length - 1) { idx++; render(); }
          } },
          { label: 'Done', onClick: function(){ adminManageToursDetail(token); } }
        ]);
      });
    }, { onBack: function(){ adminManageToursDetail(token); } });
  }

  // Edit — an ordered tap-to-pick multi-select over all 4 possible
  // destinations (see adminManageToursEditOptions's header comment in
  // index-worker.js for why this is a one-shot select rather than the
  // one-at-a-time conversational picker Tour creation uses).
  function adminManageToursEdit(token){
    renderSecondaryPanel('Edit stops', function(body){
      body.textContent = 'Loading…';
      adminAction('manageToursEditOptions', { token: token }).then(function(data){
        body.innerHTML = '';
        if (!data.ok) { renderPopoverError(body, data.error); return; }
        let picked = data.current.slice();
        const list = document.createElement('div');
        body.appendChild(list);
        function renderList(){
          list.innerHTML = '';
          data.allDestinations.forEach(function(d){
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ask-popover-item';
            const order = picked.indexOf(d.key);
            btn.textContent = (order === -1 ? '☐ ' : ('☑ ' + (order + 1) + '. ')) + d.picker;
            btn.addEventListener('click', function(){
              if (order === -1) picked.push(d.key); else picked.splice(order, 1);
              renderList();
            });
            list.appendChild(btn);
          });
        }
        renderList();
        renderActions(body, [
          { label: 'Save', primary: true, onClick: function(){
            adminAction('manageToursEditConfirm', { token: token, destinations: picked }).then(function(res){
              if (!res.ok) { renderPopoverError(body, res.error); return; }
              adminManageToursDetail(token);
            });
          } },
          { label: 'Cancel', onClick: function(){ adminManageToursDetail(token); } }
        ]);
      });
    }, { onBack: function(){ adminManageToursDetail(token); } });
  }

  function adminManageToursDuplicate(token){
    adminAction('manageToursDuplicate', { token: token }).then(function(data){
      renderSecondaryPanel('Tour duplicated', function(body){
        if (!data.ok) { renderPopoverError(body, data.error); return; }
        const p = document.createElement('div');
        p.className = 'ask-popover-note';
        p.textContent = 'A new copy has been created: ' + data.tourUrl;
        body.appendChild(p);
        renderActions(body, [{ label: 'Done', primary: true, onClick: adminManageToursList }]);
      });
    });
  }

  function adminManageToursExtend(token){
    adminAction('manageToursExtend', { token: token }).then(function(data){
      renderSecondaryPanel('Expiry extended', function(body){
        if (!data.ok) { renderPopoverError(body, data.error); return; }
        const p = document.createElement('div');
        p.className = 'ask-popover-note';
        p.textContent = 'This tour now expires ' + data.expiresInDays + ' days from today.';
        body.appendChild(p);
        renderActions(body, [{ label: 'Done', primary: true, onClick: function(){ adminManageToursDetail(token); } }]);
      });
    });
  }

  // Revoke — MVP behaviour, explicitly documented as such (see
  // adminManageToursRevoke's header comment in index-worker.js): an
  // immediate KV delete, no soft-revoke. The confirmation wording below is
  // the spec's own required explicit warning (Section 8.4/Addendum), not a
  // generic "are you sure".
  function adminManageToursRevokeConfirm(token){
    renderSecondaryPanel('Revoke this tour?', function(body){
      const p = document.createElement('div');
      p.className = 'ask-popover-note';
      p.textContent = 'This link will stop working immediately, including for anyone currently using it. This cannot be undone.';
      body.appendChild(p);
      renderActions(body, [
        { label: 'Revoke', primary: true, danger: true, onClick: function(){
          adminAction('manageToursRevoke', { token: token }).then(function(data){
            if (!data.ok) { renderPopoverError(body, data.error); return; }
            adminManageToursList();
          });
        } },
        { label: 'Cancel', onClick: function(){ adminManageToursDetail(token); } }
      ]);
    }, { onBack: function(){ adminManageToursDetail(token); } });
  }

  // ---- Manage Quick Menu (Section 7.1) ----
  // Shared with the "Contact action" step of Add below, so the label an RA
  // picks when adding an item and the label shown back to them in an
  // existing item's detail view can never drift apart.
  //
  // 1 September 2026 correction: the four enquiry-type labels below used
  // to be separately hardcoded here, duplicating NAV_INTENTS' own `note`
  // values verbatim — a real risk of the two silently drifting apart
  // (exactly what happened: NAV_INTENTS was genericized in this same
  // pass, and this list would otherwise have kept the old tenant
  // wording, invisibly, since nothing here referenced NAV_INTENTS at
  // all). Now derived directly from NAV_INTENTS at the four matching
  // keys, so there is exactly one place these labels are ever written.
  // 'contact' keeps its own distinct "General contact" label deliberately
  // — that's an admin-UI clarity choice, not customer content, and isn't
  // part of what needed fixing here.
  const CONTACT_INTENT_OPTIONS = [
    { label: 'General contact', value: 'contact' },
    { label: NAV_INTENTS['book-audit'].note, value: 'book-audit' },
    { label: NAV_INTENTS['enquire-build'].note, value: 'enquire-build' },
    { label: NAV_INTENTS['register-protocol'].note, value: 'register-protocol' },
    { label: NAV_INTENTS['enquire-opportunity'].note, value: 'enquire-opportunity' }
  ];
  function contactIntentLabel(intent){
    const found = CONTACT_INTENT_OPTIONS.find(function(o){ return o.value === intent; });
    return found ? found.label : intent;
  }
  // One-line secondary summary shown under an item's title in the list —
  // Phase 2 UI refinement pass, Section 9 — built entirely from fields the
  // backend already returns on every item, no new data required.
  function humanizeQuickMenuItem(item){
    if (item.type === 'page') return 'Opens page: ' + (item.target || '');
    if (item.type === 'chat') return 'Starts a conversation: ' + (item.prompt || '');
    if (item.type === 'contact') return 'Contact action: ' + contactIntentLabel(item.contactIntent);
    return '';
  }

  function adminQuickMenuList(){
    renderSecondaryPanel('Manage Quick Menu', function(body){
      body.textContent = 'Loading…';
      adminAction('manageQuickMenuList').then(function(data){
        body.innerHTML = '';
        if (!data.ok) { renderPopoverError(body, data.error); return; }
        if (data.items.length === 0) {
          const p = document.createElement('div');
          p.className = 'ask-popover-note';
          p.textContent = "You haven't added any Quick Menu items yet.";
          body.appendChild(p);
        } else {
          data.items.forEach(function(item){
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'ask-popover-itemrow';
            row.innerHTML = '<div class="txt"><div class="ttl"></div><div class="meta"></div></div><span class="chev" aria-hidden="true">›</span>';
            row.querySelector('.ttl').textContent = item.title;
            row.querySelector('.meta').textContent = humanizeQuickMenuItem(item);
            row.addEventListener('click', function(){ adminQuickMenuItemDetail(item); });
            body.appendChild(row);
          });
        }
        renderActions(body, [{ label: '+ Add menu item', primary: true, onClick: adminQuickMenuAddTitle }]);
      });
    }, { onBack: adminMenu });
  }

  // Item detail/manage view (Section 9): tap an existing item to see its
  // current title/type/target, with Delete available here rather than a
  // permanent red control sitting directly in the list. True field-level
  // editing is explicitly deferred — this pass only restructures how an
  // existing item is inspected and removed, no new backend action.
  function adminQuickMenuItemDetail(item){
    renderSecondaryPanel(item.title, function(body){
      const meta = document.createElement('div');
      meta.className = 'ask-popover-detail-meta';
      const typeLabel = item.type === 'page' ? 'Opens page' : (item.type === 'chat' ? 'Starts a conversation' : 'Contact action');
      const valueLabel = item.type === 'page' ? item.target : (item.type === 'chat' ? item.prompt : contactIntentLabel(item.contactIntent));
      [['Type', typeLabel], ['Detail', valueLabel || '—']].forEach(function(pair){
        const row = document.createElement('div');
        row.className = 'ask-popover-detail-row';
        const k = document.createElement('span');
        k.className = 'k';
        k.textContent = pair[0];
        const v = document.createElement('span');
        v.className = 'v';
        v.textContent = pair[1];
        row.appendChild(k);
        row.appendChild(v);
        meta.appendChild(row);
      });
      body.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'ask-popover-detail-actions';
      body.appendChild(actions);
      renderNavRows(actions, [{ label: 'Delete', value: 'delete', danger: true }], function(){
        adminQuickMenuItemDeleteConfirm(item);
      });
    }, { onBack: adminQuickMenuList });
  }

  function adminQuickMenuItemDeleteConfirm(item){
    renderSecondaryPanel('Delete this menu item?', function(body){
      const p = document.createElement('div');
      p.className = 'ask-popover-note';
      p.textContent = '"' + item.title + '" will no longer appear in the Quick Menu.';
      body.appendChild(p);
      renderActions(body, [
        { label: 'Delete', primary: true, danger: true, onClick: function(){
          adminAction('manageQuickMenuDelete', { id: item.id }).then(function(){ adminQuickMenuList(); });
        } },
        { label: 'Cancel', onClick: function(){ adminQuickMenuItemDetail(item); } }
      ]);
    }, { onBack: function(){ adminQuickMenuItemDetail(item); } });
  }

  function adminQuickMenuAddTitle(){
    renderSecondaryPanel('What should the menu option say?', function(body){
      const field = renderTextField(body, { placeholder: 'e.g. Get a Quote', maxLength: 40 });
      renderActions(body, [
        { label: 'Next', primary: true, onClick: function(){
          if (!field.value.trim()) { renderPopoverError(body, 'A title is required.'); return; }
          adminQuickMenuAddType(field.value.trim());
        } },
        { label: 'Cancel', onClick: adminQuickMenuList }
      ]);
    }, { onBack: adminQuickMenuList });
  }

  function adminQuickMenuAddType(title){
    renderSecondaryPanel('What should this option do?', function(body){
      renderChoiceButtons(body, [
        { label: 'Go to page', value: 'page' },
        { label: 'Start conversation', value: 'chat' },
        { label: 'Contact action', value: 'contact' }
      ], function(type){ adminQuickMenuAddDetail(title, type); });
    }, { onBack: function(){ adminQuickMenuAddTitle(); } });
  }

  function adminQuickMenuAddDetail(title, type){
    if (type === 'page') {
      renderSecondaryPanel('Which page?', function(body){
        const field = renderTextField(body, { placeholder: '/your-page' });
        renderActions(body, [
          { label: 'Next', primary: true, onClick: function(){ adminQuickMenuAddConfirm(title, type, { target: field.value.trim() }); } },
          { label: 'Cancel', onClick: adminQuickMenuList }
        ]);
      }, { onBack: function(){ adminQuickMenuAddType(title); } });
    } else if (type === 'chat') {
      renderSecondaryPanel('What should LiveAsk help the visitor with when they choose this?', function(body){
        const field = renderTextField(body, { placeholder: 'e.g. Help them understand our pricing' });
        renderActions(body, [
          { label: 'Next', primary: true, onClick: function(){ adminQuickMenuAddConfirm(title, type, { prompt: field.value.trim() }); } },
          { label: 'Cancel', onClick: adminQuickMenuList }
        ]);
      }, { onBack: function(){ adminQuickMenuAddType(title); } });
    } else {
      renderSecondaryPanel('Which contact action?', function(body){
        renderChoiceButtons(body, CONTACT_INTENT_OPTIONS, function(contactIntent){ adminQuickMenuAddConfirm(title, type, { contactIntent: contactIntent }); });
      }, { onBack: function(){ adminQuickMenuAddType(title); } });
    }
  }

  function adminQuickMenuAddConfirm(title, type, detail){
    renderSecondaryPanel('Add this menu option?', function(body){
      const p = document.createElement('div');
      p.className = 'ask-popover-note';
      p.textContent = '"' + title + '" will appear in the Quick Menu.';
      body.appendChild(p);
      renderActions(body, [
        { label: 'Confirm', primary: true, onClick: function(){
          const item = Object.assign({ title: title, type: type }, detail);
          adminAction('manageQuickMenuAdd', { item: item }).then(function(data){
            if (!data.ok) { renderPopoverError(body, data.error); return; }
            adminQuickMenuList();
          });
        } },
        { label: 'Cancel', onClick: adminQuickMenuList }
      ]);
    }, { onBack: adminQuickMenuList });
  }

  // ---- Root `+` menu (Section 5, 6) ----
  // Phase 2 UI refinement pass (Section 1): the customer/company section —
  // divider, tenant heading, and its items — is only ever appended
  // once the Quick Menu fetch confirms at least one item exists. With zero
  // configured items, none of that renders (no divider, no heading, no
  // "Nothing here yet." message) — the menu just ends after LiveAsk's own
  // items, rather than flashing a "Loading…" placeholder first.
  function openPlusMenu(){
    adminAuthed = null;
    renderSecondaryPanel(null, function(body){
      const liveAskLabel = document.createElement('div');
      liveAskLabel.className = 'ask-popover-section-label ask-popover-section-label--first';
      liveAskLabel.textContent = 'LiveAsk';
      body.appendChild(liveAskLabel);

      const liveAskItems = [{ label: 'How to use LiveAsk', onClick: showHowToUseLiveAsk }];
      // Start new chat — omitted entirely while a Tour is active (Section
      // 5.1.B, confirmed 27 August 2026), and only offered at all once
      // there's a real conversation to clear.
      if (!tourToken && conversationHistory.length > 0) {
        liveAskItems.push({ label: 'Start new chat', onClick: startNewChatConfirm });
      }
      liveAskItems.push({ label: 'Give feedback', onClick: giveFeedbackFlow });
      // Restart Tour — contextual only (Section 5.1.D): shown only while a
      // Tour is actually active.
      if (tourToken) {
        liveAskItems.push({ label: 'Restart Tour', onClick: restartTourConfirm });
      }
      liveAskItems.push({ label: 'Admin', onClick: adminPinEntry });
      renderChoiceButtons(body, liveAskItems.map(function(it){ return { label: it.label, value: it }; }), function(it){ it.onClick(); });

      fetchQuickMenuItems().then(function(items){
        if (items.length === 0) return;
        const divider = document.createElement('div');
        divider.className = 'ask-popover-divider';
        body.appendChild(divider);

        const customerLabel = document.createElement('div');
        customerLabel.className = 'ask-popover-section-label';
        customerLabel.textContent = DEPLOYMENT_COMPANY_NAME;
        body.appendChild(customerLabel);

        renderChoiceButtons(body, items.map(function(it){ return { label: it.title, value: it }; }), runQuickMenuItem);
        positionPopover();
      });
    }, { rootMenu: true });
  }

  plusBtn.addEventListener('click', function(e){
    e.stopPropagation();
    if (popover.classList.contains('open')) { closePlusMenu(); return; }
    openPlusMenu();
  });
  scrim.addEventListener('click', closePlusMenu);
  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape' && popover.classList.contains('open')) closePlusMenu();
  });
  // Reuse the panel's own existing outside-click-to-collapse exclusion —
  // the popover lives inside #ask-panel, so submitToPanel/the main
  // document click listener above already leaves it alone; this only needs
  // to stop a click INSIDE the popover from bubbling up to that listener
  // and collapsing the whole chat panel underneath it.
  popover.addEventListener('click', function(e){ e.stopPropagation(); });
  window.addEventListener('resize', function(){
    if (popover.classList.contains('open')) positionPopover();
  });

  // ====================================================================
  // Dictation + Realtime Voice client — 10 September 2026.
  //
  // Dictation remains a separate, browser-native speech-to-text aid: it
  // writes into the ordinary textarea and never sends until the visitor
  // presses the primary arrow. Realtime Voice uses the accepted production
  // Worker contract: browser WebRTC media -> voiceSession:start -> SDP
  // answer, plus a Worker WebSocket control channel for trusted lifecycle,
  // governed-answer mediation and final transcript events.
  // ====================================================================
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let dictationActive = false;
  let dictationBase = '';
  let dictationHadSpeech = false;

  let voiceMode = 'idle';
  let voiceGeneration = 0;
  let voicePeer = null;
  let voiceDataChannel = null;
  let voiceControlSocket = null;
  let voiceLocalStream = null;
  let voiceRemoteAudio = null;
  let voiceSessionId = null;
  let voiceMuted = false;
  let voiceEnding = false;
  let voiceStartAbort = null;
  let voiceAttachTimer = null;
  let voiceIdentityEl = null;
  let pendingAssistantVoiceTranscript = '';
  const renderedVoiceFinals = new Set();

  function clearVoiceUiClasses(){
    ['is-typed', 'is-dictating', 'is-awaiting-speech', 'is-connecting', 'is-voice', 'is-speaking', 'is-muted', 'is-ending'].forEach(function(name){
      uip.classList.remove(name);
    });
  }

  function setVoiceUi(mode, statusText){
    voiceMode = mode;
    clearVoiceUiClasses();
    voiceStatus.textContent = statusText || '';
    input.disabled = mode === 'connecting' || mode === 'listening' || mode === 'speaking' || mode === 'muted' || mode === 'ending';
    micBtn.disabled = mode === 'connecting' || mode === 'ending';

    if (mode === 'dictating') {
      uip.classList.add('is-dictating', 'is-awaiting-speech');
      micBtn.setAttribute('aria-label', 'Stop dictation');
      sendBtn.setAttribute('aria-label', 'Send dictated text');
      return;
    }
    if (mode === 'connecting') {
      uip.classList.add('is-connecting');
      sendBtn.setAttribute('aria-label', 'Cancel Voice connection');
      return;
    }
    if (mode === 'ending') {
      uip.classList.add('is-ending');
      sendBtn.setAttribute('aria-label', 'Ending Voice');
      return;
    }
    if (mode === 'listening' || mode === 'speaking' || mode === 'muted') {
      uip.classList.add('is-voice');
      if (mode === 'speaking') uip.classList.add('is-speaking');
      if (mode === 'muted') uip.classList.add('is-muted');
      micLabel.textContent = mode === 'muted' ? 'Unmute' : 'Mute';
      micBtn.setAttribute('aria-label', mode === 'muted' ? 'Unmute microphone' : 'Mute microphone');
      sendBtn.setAttribute('aria-label', 'End Voice');
      return;
    }

    micLabel.textContent = 'Dictate';
    micBtn.setAttribute('aria-label', 'Dictate message');
    updatePrimaryControlState();
  }

  function updatePrimaryControlState(){
    if (voiceMode !== 'idle') return;
    const hasText = input.value.trim().length > 0;
    uip.classList.toggle('is-typed', hasText);
    sendBtn.setAttribute('aria-label', hasText ? 'Send' : 'Start Voice');
  }

  function renderVoiceNotice(message){
    thread.classList.add('active');
    askPanel.querySelector('.ask-box').classList.add('expanded');
    const notice = document.createElement('div');
    notice.className = 'ask-msg ai ask-voice-notice';
    const p = document.createElement('p');
    const face = document.createElement('span');
    face.className = 'ask-voice-notice-face';
    face.setAttribute('aria-hidden', 'true');
    face.textContent = '😯';
    p.appendChild(face);
    p.appendChild(document.createTextNode(message));
    notice.appendChild(p);
    thread.appendChild(notice);
    showFooter();
    maybeScrollToBottom();
  }

  function appendVoiceTranscript(role, text){
    const clean = typeof text === 'string' ? text.trim() : '';
    if (!clean) return;
    const dedupeKey = role + '\u0000' + clean;
    if (renderedVoiceFinals.has(dedupeKey)) return;
    renderedVoiceFinals.add(dedupeKey);
    if (renderedVoiceFinals.size > 40) {
      const first = renderedVoiceFinals.values().next().value;
      renderedVoiceFinals.delete(first);
    }

    thread.classList.add('active');
    askPanel.querySelector('.ask-box').classList.add('expanded');
    if (role === 'user') {
      completeInputInstruction();
      const visitor = document.createElement('div');
      visitor.className = 'ask-msg visitor';
      visitor.innerHTML = '<p></p>';
      visitor.querySelector('p').textContent = clean;
      thread.appendChild(visitor);
      conversationHistory.push({ role: 'user', content: clean });
    } else {
      const assistant = createAiMessageEl(clean, isFirstAiReply());
      thread.appendChild(assistant);
      conversationHistory.push({ role: 'assistant', content: clean });
      activateInputInstruction(clean, assistant);
      if (voiceIdentityEl) {
        completeIdentity(voiceIdentityEl);
        voiceIdentityEl = null;
      }
    }
    saveSession();
    showFooter();
    maybeScrollToBottom();
  }

  function bufferAssistantVoiceTranscript(text){
    const clean = typeof text === 'string' ? text.trim() : '';
    if (clean) pendingAssistantVoiceTranscript = clean;
  }

  function flushAssistantVoiceTranscript(){
    if (!pendingAssistantVoiceTranscript) return;
    const text = pendingAssistantVoiceTranscript;
    pendingAssistantVoiceTranscript = '';
    appendVoiceTranscript('assistant', text);
  }

  function stopLocalVoiceMedia(){
    if (voiceAttachTimer) { clearTimeout(voiceAttachTimer); voiceAttachTimer = null; }
    const socket = voiceControlSocket;
    const channel = voiceDataChannel;
    const peer = voicePeer;
    const stream = voiceLocalStream;
    const audio = voiceRemoteAudio;
    voiceControlSocket = null;
    voiceDataChannel = null;
    voicePeer = null;
    voiceLocalStream = null;
    voiceRemoteAudio = null;
    try { if (socket && socket.readyState < 2) socket.close(1000, 'Visitor ended Voice'); } catch (e) {}
    try { if (channel) channel.close(); } catch (e) {}
    if (stream) stream.getTracks().forEach(function(track){ track.stop(); });
    try { if (peer) peer.close(); } catch (e) {}
    if (audio) {
      try { audio.pause(); } catch (e) {}
      audio.srcObject = null;
      audio.remove();
    }
  }

  async function finishVoice(options){
    options = options || {};
    if (voiceEnding) return;
    voiceEnding = true;
    voiceGeneration += 1;
    if (voiceStartAbort) { voiceStartAbort.abort(); voiceStartAbort = null; }
    const endingSessionId = voiceSessionId;
    voiceSessionId = null;
    if (options.notice) pendingAssistantVoiceTranscript = '';
    else flushAssistantVoiceTranscript();
    if (options.showEnding !== false && voiceMode !== 'idle') setVoiceUi('ending', 'Ending…');
    stopLocalVoiceMedia();

    if (endingSessionId) {
      try {
        await fetch(WORKER_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: sessionId, voiceSession: 'end', voiceSessionId: endingSessionId }),
          keepalive: true
        });
      } catch (e) { /* control-channel close also releases the lease */ }
    }
    voiceMuted = false;
    voicePromptEnabled = false;
    renderVoicePromptControl();
    voiceEnding = false;
    setVoiceUi('idle');
    if (options.notice) renderVoiceNotice(options.notice);
  }

  function voiceFailureMessage(reason){
    if (reason === 'engagement_authority_invalid') return 'Voice permission expired before connection. Please try Voice again.';
    if (reason === 'voice_session_already_active') return 'Voice is already active for this conversation. You can keep typing here while it resets.';
    if (/exhaust|entitlement|quota|denied/i.test(reason || '')) return 'Voice time is unavailable right now. Text is still ready here.';
    return 'Voice could not connect. Text is still ready here.';
  }

  function handleVoiceControlMessage(event){
    let data;
    try { data = JSON.parse(event.data); } catch (e) { return; }
    if (data.type === 'sideband.attached') {
      if (voiceAttachTimer) { clearTimeout(voiceAttachTimer); voiceAttachTimer = null; }
      if (!voiceMuted) setVoiceUi('listening', 'Listening…');
      return;
    }
    if (data.type === 'voice.state.speaking') {
      if (!voiceMuted && voiceMode !== 'speaking') setVoiceUi('listening', 'Listening…');
      return;
    }
    if (data.type === 'voice.state.responding') {
      if (data.responding) {
        setVoiceUi('speaking', 'Speaking…');
        if (!voiceIdentityEl) {
          voiceIdentityEl = beginIdentity();
          setTimeout(function(){ if (voiceIdentityEl) beginAnswering(voiceIdentityEl); }, 350);
        }
      } else if (!voiceMuted) {
        setVoiceUi('listening', 'Listening…');
      }
      return;
    }
    if (data.type === 'voice.transcript.visitor_final') {
      appendVoiceTranscript('user', data.text);
      return;
    }
    if (data.type === 'voice.transcript.assistant_final') {
      // The governed answer reaches the browser before OpenAI begins its
      // audible rendition. Hold it until playback ends so the interface
      // never looks as though Voice is reading a pre-written chat reply.
      bufferAssistantVoiceTranscript(data.text);
      return;
    }
    if (data.type === 'voice.terminated') {
      finishVoice({ force: true, notice: voiceFailureMessage(data.reason) });
      return;
    }
    if (data.type === 'voice.turn.incomplete' || data.type === 'voice.turn.ended') {
      if (voiceIdentityEl) { completeIdentity(voiceIdentityEl); voiceIdentityEl = null; }
      if (!voiceMuted) setVoiceUi('listening', 'Listening…');
      return;
    }
    if (data.type === 'sideband.failed' || data.type === 'sideband.error') {
      finishVoice({ force: true, notice: 'Voice lost its secure control connection. Text is still ready here.' });
    }
  }

  function workerWebSocketUrl(data){
    const url = new URL(WORKER_URL);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/voice/control';
    url.search = new URLSearchParams({
      call_id: data.providerCallId,
      voice_session_id: data.voiceSessionId,
      engagement_id: sessionId
    }).toString();
    return url.toString();
  }

  async function ensureVoiceAuthority(signal){
    if (voiceAuthority && voiceAuthority.token && voiceAuthority.expiresAt > Date.now()) return;
    const response = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionId, voiceAuthority: 'bootstrap' }),
      signal: signal
    });
    const data = await response.json().catch(function(){ return {}; });
    if (!response.ok || !data.ok) throw new Error(data.reason || ('voice_authority_http_' + response.status));
    rememberVoiceAuthority(data);
    if (!voiceAuthority || !voiceAuthority.token || voiceAuthority.expiresAt <= Date.now()) {
      throw new Error('engagement_authority_unavailable');
    }
  }

  async function startVoice(options){
    options = options || {};
    if (voiceMode !== 'idle') return;
    if (!window.RTCPeerConnection || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      voicePromptEnabled = false;
      renderVoicePromptControl();
      renderVoiceNotice('Voice is not available in this browser. Text is still ready here.');
      return;
    }
    pauseRotation();
    clearInterval(rotateTimer); rotateTimer = null;
    clearTimeout(rotateFadeTimeout);
    setVoiceUi('connecting', 'Connecting…');
    const generation = ++voiceGeneration;
    voiceEnding = false;
    voiceStartAbort = new AbortController();

    try {
      await ensureVoiceAuthority(voiceStartAbort.signal);
      if (generation !== voiceGeneration) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (generation !== voiceGeneration) { stream.getTracks().forEach(function(track){ track.stop(); }); return; }
      voiceLocalStream = stream;

      const peer = new RTCPeerConnection();
      voicePeer = peer;
      const audio = document.createElement('audio');
      audio.className = 'ask-voice-audio';
      audio.autoplay = true;
      audio.playsInline = true;
      shadowRoot.appendChild(audio);
      voiceRemoteAudio = audio;
      peer.ontrack = function(event){
        audio.srcObject = event.streams[0];
        const play = audio.play();
        if (play && play.catch) play.catch(function(){});
      };
      stream.getTracks().forEach(function(track){ peer.addTrack(track, stream); });

      const channel = peer.createDataChannel('oai-events');
      voiceDataChannel = channel;
      const promptInstruction = options.instruction && options.instruction.label
        ? { kind: options.instruction.kind, label: options.instruction.label }
        : null;
      channel.addEventListener('open', function(){
        if (!promptInstruction || !voicePromptEnabled || channel !== voiceDataChannel || channel.readyState !== 'open') return;
        const eventId = 'liveask_voice_prompt_' + Date.now().toString(36);
        channel.send(JSON.stringify({
          event_id: eventId,
          type: 'response.create',
          response: {
            conversation: 'none',
            metadata: {
              liveask_purpose: 'structured_instruction',
              liveask_instruction_kind: promptInstruction.kind
            },
            output_modalities: ['audio'],
            input: [],
            instructions: 'Say exactly this instruction, with no embellishment: "' + promptInstruction.label + '"'
          }
        }));
      });
      channel.addEventListener('message', function(event){
        let providerEvent;
        try { providerEvent = JSON.parse(event.data); } catch (e) { return; }
        if (providerEvent.type === 'output_audio_buffer.started') setVoiceUi('speaking', 'Speaking…');
        if (providerEvent.type === 'output_audio_buffer.stopped') {
          flushAssistantVoiceTranscript();
          if (!voiceMuted) setVoiceUi('listening', 'Listening…');
        }
      });

      peer.addEventListener('connectionstatechange', function(){
        if (peer !== voicePeer || voiceEnding) return;
        if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
          finishVoice({ force: true, notice: 'Voice connection ended. Text is still ready here.' });
        }
      });

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const response = await fetch(WORKER_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: sessionId,
          voiceSession: 'start',
          voiceAuthorityToken: voiceAuthority.token,
          sdpOffer: peer.localDescription.sdp,
          textHistory: conversationHistory
        }),
        signal: voiceStartAbort.signal
      });
      const data = await response.json().catch(function(){ return {}; });
      if (!response.ok || !data.ok) throw new Error(data.reason || ('voice_start_http_' + response.status));
      if (generation !== voiceGeneration) {
        voiceSessionId = data.voiceSessionId;
        await finishVoice({ force: true, showEnding: false });
        return;
      }
      voiceSessionId = data.voiceSessionId;
      await peer.setRemoteDescription({ type: 'answer', sdp: data.sdpAnswer });

      const control = new WebSocket(workerWebSocketUrl(data));
      voiceControlSocket = control;
      control.addEventListener('message', handleVoiceControlMessage);
      control.addEventListener('close', function(){
        if (control === voiceControlSocket && !voiceEnding && voiceMode !== 'idle') {
          finishVoice({ force: true, notice: 'Voice connection ended. Text is still ready here.' });
        }
      });
      control.addEventListener('error', function(){
        if (control === voiceControlSocket && !voiceEnding) {
          finishVoice({ force: true, notice: 'Voice could not open its secure control connection. Text is still ready here.' });
        }
      });
      voiceAttachTimer = setTimeout(function(){
        if (voiceMode === 'connecting') finishVoice({ force: true, notice: 'Voice took too long to connect. Text is still ready here.' });
      }, 10000);
    } catch (err) {
      if (generation !== voiceGeneration || err.name === 'AbortError') return;
      const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      const message = denied ? 'Microphone access was denied. Text is still ready here.' : voiceFailureMessage(err.message);
      await finishVoice({ force: true, notice: message });
    } finally {
      voiceStartAbort = null;
    }
  }

  function toggleVoiceMute(){
    if (!voiceLocalStream || (voiceMode !== 'listening' && voiceMode !== 'speaking' && voiceMode !== 'muted')) return;
    voiceMuted = !voiceMuted;
    voiceLocalStream.getAudioTracks().forEach(function(track){ track.enabled = !voiceMuted; });
    setVoiceUi(voiceMuted ? 'muted' : 'listening', voiceMuted ? 'Microphone muted' : 'Listening…');
  }

  function startDictation(){
    if (!recognition || dictationActive || voiceMode !== 'idle') return;
    pauseRotation();
    clearInterval(rotateTimer); rotateTimer = null;
    clearTimeout(rotateFadeTimeout);
    dictationBase = input.value.trimEnd();
    dictationHadSpeech = false;
    dictationActive = true;
    voiceStatus.textContent = 'You are dictating to text here';
    setVoiceUi('dictating', 'You are dictating to text here');
    try { recognition.start(); }
    catch (e) { dictationActive = false; setVoiceUi('idle'); }
  }

  if (SR) {
    recognition = new SR();
    recognition.lang = (navigator.languages && navigator.languages[0]) || navigator.language || document.documentElement.lang || 'en-AU';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = function(event){
      let spoken = '';
      for (let resultIndex = 0; resultIndex < event.results.length; resultIndex += 1) {
        spoken += event.results[resultIndex][0].transcript;
        if (resultIndex < event.results.length - 1) spoken += ' ';
      }
      spoken = spoken.trim();
      if (spoken) {
        dictationHadSpeech = true;
        uip.classList.remove('is-awaiting-speech');
        input.value = (dictationBase ? dictationBase + ' ' : '') + spoken;
        input.closest('.ask-input-row').classList.add('has-text');
        ph.classList.add('fade');
        autoGrow();
      }
    };
    recognition.onspeechstart = function(){
      dictationHadSpeech = true;
      uip.classList.remove('is-awaiting-speech');
    };
    recognition.onerror = function(event){
      uip.dataset.dictationError = event.error || 'unknown';
      if (event.error !== 'aborted' && event.error !== 'no-speech') {
        const reason = event.error === 'not-allowed' || event.error === 'service-not-allowed'
          ? 'Microphone access or the browser speech service was denied.'
          : event.error === 'audio-capture'
            ? 'The browser could not access a microphone.'
            : event.error === 'network'
              ? 'The browser speech service could not connect.'
              : event.error === 'language-not-supported'
                ? 'The browser speech service does not support this language.'
                : 'Dictation stopped unexpectedly.';
        renderVoiceNotice(reason + ' Your existing text has been kept.');
      }
    };
    recognition.onend = function(){
      dictationActive = false;
      setVoiceUi('idle');
      autoGrow();
    };
  } else {
    micBtn.style.display = 'none';
  }

  micBtn.addEventListener('click', function(){
    if (voiceMode === 'listening' || voiceMode === 'speaking' || voiceMode === 'muted') {
      toggleVoiceMute();
      return;
    }
    if (dictationActive) {
      try { recognition.stop(); } catch (e) {}
      return;
    }
    startDictation();
  });

  sendBtn.addEventListener('click', function(){
    if (voiceMode === 'connecting' || voiceMode === 'listening' || voiceMode === 'speaking' || voiceMode === 'muted' || voiceMode === 'ending') {
      finishVoice({ showEnding: true });
      return;
    }
    if (dictationActive) {
      try { recognition.stop(); } catch (e) {}
      if (input.value.trim()) send();
      return;
    }
    if (input.value.trim()) send();
    else startVoice({ instruction: voicePromptEnabled ? activeInputInstruction : null });
  });

  window.addEventListener('pagehide', function(){
    if (!voiceSessionId) return;
    const endingSessionId = voiceSessionId;
    voiceSessionId = null;
    stopLocalVoiceMedia();
    try {
      fetch(WORKER_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId, voiceSession: 'end', voiceSessionId: endingSessionId }),
        keepalive: true
      });
    } catch (e) {}
  });

  updatePrimaryControlState();
})();
