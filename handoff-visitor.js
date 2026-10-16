/* LiveAsk visitor handoff module (Exec / Human Voice PoC). Lazy-loaded by runtime.js
 * only when the Worker returns a governed `handoffOffer`. Built from
 * worker/exec-pwa/handoff-visitor.src.js by tools/build-handoff-clients.mjs
 * (shared call core inlined).
 *
 * Consent is a deterministic UI event: nothing here is ever triggered by model
 * text. The visitor must (1) accept the offer, (2) tap TALK NOW once the owner
 * app is media-ready. The server enforces both; this file only presents them.
 */
(function () {
  'use strict';
/* LiveAsk human-to-human call core (audio only, 1:1). Shared VERBATIM by the
 * Exec PWA and the visitor widget (inlined at build time by
 * tools/build-handoff-clients.mjs). No AI provider is involved: signalling is
 * the LiveAsk HandoffRoom, media is WebRTC P2P with Cloudflare TURN fallback.
 *
 * Authority: every network call carries the server-minted tuple (tenant is
 * implicit; engagementId, participantId, handoffId, mediaSessionId, attempt)
 * plus the role-bound token. IDs alone confer nothing; the server validates the
 * full tuple before it returns ICE servers or a signalling ticket.
 */
(function (root) {
  'use strict';
  var HEARTBEAT_MS = 5000;
  var RESTART_AFTER_MS = 3000;
  var GIVE_UP_AFTER_MS = 15000;

  function create(opts) {
    var role = opts.role;                       // 'visitor' | 'owner'
    var tuple = opts.tuple;                     // { handoffId, engagementId, participantId, mediaSessionId, attempt, token }
    var callApi = opts.callApi;                 // async (route, body) => JSON   (route: ice|ticket|report|ping|end)
    var wsBase = opts.wsBase;                   // ws(s)://host/handoff/signal
    var onStatus = opts.onStatus || function () {};
    var audioEl = opts.audioEl;
    var stream = opts.localStream;
    var diag = opts.diag || function () {};

    var pc = null, ws = null, closed = false, connectedReported = false;
    var pendingCandidates = [], remoteSet = false, wsRetries = 0, restartTimer = null, giveUpTimer = null, hbTimer = null, iceRefreshTimer = null;
    var startedAt = Date.now(), everConnected = false, makingOffer = false;

    function status(s, detail) { diag('call.' + s, detail); try { onStatus(s, detail || null); } catch (e) {} }
    function body(extra) { return Object.assign({}, tuple, extra || {}); }

    async function detectPath() {
      try {
        var stats = await pc.getStats();
        var pairId = null, byId = {};
        stats.forEach(function (r) { byId[r.id] = r; if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId; });
        if (!pairId) stats.forEach(function (r) { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pairId = r.id; });
        var pair = pairId && byId[pairId];
        if (!pair) return 'unknown';
        var l = byId[pair.localCandidateId], r2 = byId[pair.remoteCandidateId];
        return (l && l.candidateType === 'relay') || (r2 && r2.candidateType === 'relay') ? 'relay' : 'p2p';
      } catch (e) { return 'unknown'; }
    }

    function send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

    async function makeOffer(iceRestart) {
      if (!pc || makingOffer) return;
      try {
        makingOffer = true;
        var offer = await pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
        await pc.setLocalDescription(offer);
        send({ type: 'description', description: pc.localDescription });
      } finally { makingOffer = false; }
    }

    async function onSignal(msg) {
      if (closed || !pc) return;
      if (msg.type === 'peer') {
        // Visitor is the offerer. It (re)offers whenever the owner is present and media is not up.
        if (msg.present && role === 'visitor' && pc.connectionState !== 'connected') makeOffer(everConnected);
        return;
      }
      if (msg.type === 'description' && msg.description) {
        if (msg.description.type === 'offer' && role === 'owner') {
          await pc.setRemoteDescription(msg.description); remoteSet = true; await flushCandidates();
          var answer = await pc.createAnswer(); await pc.setLocalDescription(answer);
          send({ type: 'description', description: pc.localDescription });
        } else if (msg.description.type === 'answer' && role === 'visitor') {
          await pc.setRemoteDescription(msg.description); remoteSet = true; await flushCandidates();
        }
        return;
      }
      if (msg.type === 'candidate') {
        if (!remoteSet) { pendingCandidates.push(msg.candidate); return; }
        try { if (msg.candidate) await pc.addIceCandidate(msg.candidate); } catch (e) { diag('call.candidate_error', String(e && e.message)); }
        return;
      }
      if (msg.type === 'bye') { status('peer_left'); }
    }
    async function flushCandidates() {
      var list = pendingCandidates; pendingCandidates = [];
      for (var i = 0; i < list.length; i++) { try { if (list[i]) await pc.addIceCandidate(list[i]); } catch (e) {} }
    }

    async function openSocket() {
      if (closed) return;
      var t = await callApi('ticket', body());
      if (!t || !t.ok) { fail('ticket_refused'); return; }
      var qs = new URLSearchParams({ role: role, handoffId: tuple.handoffId, engagementId: tuple.engagementId, participantId: tuple.participantId, mediaSessionId: tuple.mediaSessionId, attempt: String(tuple.attempt), ticket: t.ticket });
      ws = new WebSocket(wsBase + '?' + qs.toString());
      ws.onopen = function () { wsRetries = 0; diag('call.ws_open'); send({ type: 'hello' }); };
      ws.onmessage = function (ev) { try { onSignal(JSON.parse(ev.data)); } catch (e) {} };
      ws.onclose = function () {
        diag('call.ws_close');
        if (closed || wsRetries >= 5) return;
        wsRetries++;
        setTimeout(function () { if (!closed) openSocket().catch(function () {}); }, Math.min(4000, 500 * wsRetries));
      };
    }

    function fail(reason) {
      if (closed) return;
      status('failed', reason);
      callApi('report', body({ state: 'failed', reason: reason })).catch(function () {});
    }

    function scheduleIceRefresh(ttlSeconds, retry) {
      clearTimeout(iceRefreshTimer);
      var delay = retry ? 60000 : Math.max(60000, Math.floor((ttlSeconds || 600) * 500));
      iceRefreshTimer = setTimeout(async function () {
        if (closed || !pc) return;
        try {
          var fresh = await callApi('ice', body({ refresh: true }));
          if (fresh && fresh.ok && fresh.relay) {
            var config = pc.getConfiguration();
            pc.setConfiguration(Object.assign({}, config, { iceServers: fresh.iceServers }));
            diag('call.ice_renewed');
            scheduleIceRefresh(fresh.ttlSeconds);
          } else {
            diag('call.ice_renewal_failed', fresh && fresh.reason);
            scheduleIceRefresh(0, true);
          }
        } catch (e) {
          diag('call.ice_renewal_failed', String(e && e.name));
          scheduleIceRefresh(0, true);
        }
      }, delay);
    }

    async function start() {
      status('preparing');
      var ice = await callApi('ice', body());
      if (!ice || !ice.ok) { fail('ice_refused'); return; }
      diag('call.ice', { relay: !!ice.relay, reason: ice.reason || null });
      pc = new RTCPeerConnection({ iceServers: ice.iceServers, bundlePolicy: 'max-bundle', iceTransportPolicy: (typeof window !== 'undefined' && window.__LIVEASK_FORCE_RELAY === true) ? 'relay' : 'all' });   // relay-only is a test hook (forced-relay test); never set in production
      if (ice.relay) scheduleIceRefresh(ice.ttlSeconds);
      if (stream) stream.getTracks().forEach(function (tr) { pc.addTrack(tr, stream); });
      pc.onicecandidate = function (ev) { send({ type: 'candidate', candidate: ev.candidate ? ev.candidate.toJSON() : null }); };
      pc.ontrack = function (ev) {
        if (audioEl) { audioEl.srcObject = ev.streams[0] || new MediaStream([ev.track]); var p = audioEl.play(); if (p && p.catch) p.catch(function (e) { diag('call.autoplay_blocked', String(e && e.name)); status('audio_blocked'); }); }
      };
      pc.onconnectionstatechange = async function () {
        var s = pc.connectionState; diag('call.pc_' + s);
        if (s === 'connected') {
          clearTimeout(restartTimer); clearTimeout(giveUpTimer);
          everConnected = true;
          if (!connectedReported) {
            connectedReported = true;
            var path = await detectPath();
            diag('call.path', path);
            status('connected', { path: path, ms: Date.now() - startedAt });
            callApi('report', body({ state: 'connected', path: path })).catch(function () {});
          } else status('connected', { resumed: true });
        } else if (s === 'disconnected' || s === 'failed') {
          if (closed) return;
          status('reconnecting');
          callApi('report', body({ state: 'reconnecting' })).catch(function () {});
          clearTimeout(restartTimer);
          restartTimer = setTimeout(function () { if (role === 'visitor' && pc && pc.connectionState !== 'connected') makeOffer(true).catch(function () {}); }, s === 'failed' ? 200 : RESTART_AFTER_MS);
          clearTimeout(giveUpTimer);
          giveUpTimer = setTimeout(function () {
            if (closed || (pc && pc.connectionState === 'connected')) return;
            if (everConnected) { status('lost'); } else fail('ice_failed');
          }, GIVE_UP_AFTER_MS);
        }
      };
      await openSocket();
      hbTimer = setInterval(function () { callApi('ping', body()).catch(function () {}); }, HEARTBEAT_MS);
      status('signalling');
    }

    function setMuted(m) { if (stream) stream.getAudioTracks().forEach(function (t) { t.enabled = !m; }); }
    function close(opts2) {
      if (closed) return; closed = true;
      clearInterval(hbTimer); clearTimeout(restartTimer); clearTimeout(giveUpTimer); clearTimeout(iceRefreshTimer);
      try { send({ type: 'bye' }); } catch (e) {}
      try { if (ws) ws.close(1000, 'bye'); } catch (e) {}
      try { if (pc) pc.close(); } catch (e) {}
      if (audioEl) { try { audioEl.srcObject = null; } catch (e) {} }
      if (stream && !(opts2 && opts2.keepStream)) { stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} }); }
    }
    return { start: start, close: close, setMuted: setMuted, get attempt() { return tuple.attempt; }, getPc: function () { return pc; } };
  }

  root.LiveAskHumanCall = { create: create };
})(typeof window !== 'undefined' ? window : globalThis);


  var hooks = null, cur = null;

  function css(el, o) { Object.keys(o).forEach(function (k) { el.style[k] = o[k]; }); return el; }
  function mk(tag, text, style, attrs) {
    var el = document.createElement(tag); if (text) el.textContent = text; if (style) css(el, style);
    if (attrs) Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    return el;
  }
  var BTN = { font: 'inherit', fontWeight: '700', letterSpacing: '.04em', padding: '12px 14px', borderRadius: '10px', border: '2px solid #0E1B2C', background: '#FAFAF7', color: '#1D2A3A', cursor: 'pointer', minHeight: '44px', flex: '1' };
  var BTN_PRIMARY = Object.assign({}, BTN, { background: '#005FAE', borderColor: '#005FAE', color: '#fff' });
  var BTN_DANGER = Object.assign({}, BTN, { background: '#B3261E', borderColor: '#B3261E', color: '#fff' });
  function fmt(ms) { var s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }
  function nowServer(st) { return Date.now() + (st.clockSkew || 0); }

  function api(route, body) {
    var url = new URL('/handoff/' + route, hooks.workerUrl);
    return fetch(url.toString(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, reason: 'bad_response' }; }); })
      .catch(function () { return { ok: false, reason: 'network' }; });
  }

  function present(offer) {
    if (!offer || !offer.handoffId || !offer.offerToken) return;
    if (cur && !cur.done) return;                       // one live offer at a time
    var st = cur = { offer: offer, done: false, view: null, ctl: null, stream: null, muted: false, poll: null, tick: null, audio: new Audio(), startedAt: 0, left: false };
    st.audio.autoplay = true; st.audio.setAttribute('playsinline', '');
    var card = mk('div', null, { margin: '8px 0', padding: '14px', border: '1px solid #DCDFE3', borderRadius: '12px', background: '#fff', color: '#1D2A3A', display: 'flex', flexDirection: 'column', gap: '10px' }, { 'data-liveask-handoff': offer.handoffId, role: 'group', 'aria-live': 'polite' });
    st.card = card;
    hooks.thread.appendChild(card);
    draw(st);
    try { hooks.scroll && hooks.scroll(); } catch (e) {}
    window.addEventListener('pagehide', function () { if (!st.done && !st.left) { st.left = true; try { navigator.sendBeacon(new URL('/handoff/visitor/left', hooks.workerUrl).toString(), new Blob([JSON.stringify({ handoffId: offer.handoffId, offerToken: offer.offerToken })], { type: 'text/plain' })); } catch (e) {} } });
  }

  function body(st) { return { handoffId: st.offer.handoffId, offerToken: st.offer.offerToken }; }
  function ownerName(st) { return (st.view && st.view.owner && st.view.owner.name) || st.offer.owner.name; }
  function pronoun(st) { var p = (st.view && st.view.owner && st.view.owner.pronoun) || st.offer.owner.pronoun; return p === 'he' || p === 'she' ? p : 'they'; }

  function set(st, nodes) {
    st.card.textContent = ''; nodes.forEach(function (n) { if (n) st.card.appendChild(n); });
    if (st.card.querySelector('[data-le-handoff=accept], [data-le-contact-choices], [data-le-fallback-choices]')) st.card.setAttribute('data-le-choice-active', 'true');
    else st.card.removeAttribute('data-le-choice-active');
    try { hooks.onChoiceState && hooks.onChoiceState(); hooks.scroll && hooks.scroll(); } catch (e) {}
  }
  function row() { var r = mk('div', null, { display: 'flex', gap: '10px' }); for (var i = 0; i < arguments.length; i++) if (arguments[i]) r.appendChild(arguments[i]); return r; }
  function btn(label, style, fn, id) { var b = mk('button', label, style, { type: 'button', 'data-le-handoff': id || label.toLowerCase().replace(/\W+/g, '-') }); b.addEventListener('click', fn); return b; }

  function draw(st) {
    var v = st.view, phase = v ? v.phase : 'offered';
    if (v && v.terminal) return drawEnd(st);
    if (phase === 'offered') {
      return set(st, [mk('p', st.offer.text, { margin: 0 }), row(btn(st.offer.accept, BTN_PRIMARY, function () { accept(st); }, 'accept'), btn(st.offer.decline, BTN, function () { decline(st); }, 'decline'))]);
    }
    if (phase === 'asking') {
      var remaining = mk('p', v && v.expiresAt ? fmt(v.expiresAt - nowServer(st)) + ' remaining' : 'Waiting for a response', { margin: 0, fontSize: '13px', color: '#5B6878' }, { 'data-le-handoff': 'remaining' });
      return set(st, [mk('p', 'Checking whether ' + ownerName(st) + ' can take your call. You can keep waiting or leave details.', { margin: 0 }), remaining, btn('CANCEL', BTN, function () { decline(st); }, 'cancel')]);
    }
    if (phase === 'ready') {
      return set(st, [mk('p', ownerName(st) + ' is ready to speak.', { margin: 0, fontWeight: '600' }),
        mk('p', 'Tap Talk Now to start the call. Your microphone will be used for this call only; it is not recorded.', { margin: 0, fontSize: '13px', color: '#5B6878' }),
        btn('TALK NOW', BTN_PRIMARY, function () { talkNow(st); }, 'talk-now'), mk('p', null, { margin: 0, color: '#B3261E', fontSize: '13px' }, { 'data-le-handoff': 'msg' })]);
    }
    if (phase === 'connecting' || phase === 'connected') {
      var connected = phase === 'connected';
      var mute = btn(st.muted ? 'UNMUTE' : 'MUTE', BTN, function () { st.muted = !st.muted; if (st.ctl) st.ctl.setMuted(st.muted); mute.textContent = st.muted ? 'UNMUTE' : 'MUTE'; }, 'mute');
      var contact = connected && v.contactRequest && st.contactAnswered !== v.contactRequest.id ?
        mk('div', null, { padding: '12px', border: '1px solid #DCDFE3', borderRadius: '10px' }, { 'data-le-contact-choices': 'true' }) : null;
      if (contact) {
        contact.appendChild(mk('p', ownerName(st) + ' has requested a contact method in case you need to reconnect. This is optional; your call continues.', { margin: '0 0 8px' }));
        contact.appendChild(row(btn('PHONE', BTN_PRIMARY, function () { contactChoice(st, 'phone'); }, 'contact-phone'),
          btn('EMAIL', BTN, function () { contactChoice(st, 'email'); }, 'contact-email')));
      }
      return set(st, [mk('p', connected ? 'Live with ' + ownerName(st) : 'Connecting you to ' + ownerName(st) + '…', { margin: 0, fontWeight: '700' }),
        mk('p', connected && v.media ? '' : '', { margin: 0, fontSize: '13px', color: '#5B6878' }, { 'data-le-handoff': 'note' }),
        connected && v.callbackIntent ? mk('p', ownerName(st) + ' intends to call you back ' + (v.callbackIntent.label || ('within ' + v.callbackIntent.minutes + ' minutes')) + '. This is an intention, not a guaranteed appointment.', { margin: 0, padding: '10px', border: '1px solid #DCDFE3', borderRadius: '10px' }) : null,
        contact,
        row(mute, btn('END', BTN_DANGER, function () { end(st); }, 'end'))]);
    }
    drawEnd(st);
  }
  function contactChoice(st, choice) {
    if (!st.view || !st.view.contactRequest || !hooks.onContactChoice) return;
    st.contactAnswered = st.view.contactRequest.id;
    draw(st);
    hooks.onContactChoice(choice);
  }

  function drawEnd(st) {
    stopAll(st, true);
    // The live card is inserted when the offer begins. Move the terminal
    // event after messages exchanged during the call, exactly once.
    if (!st.terminalPlaced && st.card.parentNode === hooks.thread) {
      hooks.thread.appendChild(st.card);
      st.terminalPlaced = true;
    }
    var v = st.view || {};
    var line;
    if (v.state === 'ended') line = 'Call ended' + (v.durationMs ? ' · ' + fmt(v.durationMs) : '') + '. I’m still here if you need anything else.';
    else if (v.state === 'owner_declined' && v.callbackIntent)
      line = ownerName(st) + ' can’t talk right now, but intends to get back to you ' + (v.callbackIntent.label || ('within ' + v.callbackIntent.minutes + ' minutes')) + '. Would you prefer contact by phone or email?';
    else if (v.fallback || v.state === 'owner_declined' || v.state === 'owner_timeout' || v.state === 'owner_unavailable' || v.state === 'expired' || v.state === 'media_failed' || v.state === 'connection_lost' || v.state === 'notification_failed')
      line = ownerName(st) + ' can\u2019t jump on right now, but I can pass on your details so ' + pronoun(st) + ' can follow up. Would you prefer contact by phone or email?';
    else line = 'No problem. I’m still here to help.';
    var fallback = v.fallback || ['owner_declined', 'owner_timeout', 'owner_unavailable', 'media_failed', 'connection_lost', 'notification_failed', 'expired'].indexOf(v.state) >= 0;
    var choices = fallback && hooks.onContactChoice ? mk('div', null, { display: 'flex', gap: '8px' }, { 'data-le-fallback-choices': 'true' }) : null;
    if (choices) {
      choices.appendChild(btn('PHONE', BTN_PRIMARY, function () { fallbackChoice(st, 'phone'); }, 'fallback-phone'));
      choices.appendChild(btn('EMAIL', BTN, function () { fallbackChoice(st, 'email'); }, 'fallback-email'));
    }
    set(st, [mk('p', line, { margin: 0 }, { 'data-le-handoff': 'ended' }), choices]);
    if (v.fallback || ['owner_declined', 'owner_timeout', 'owner_unavailable', 'media_failed', 'connection_lost', 'notification_failed', 'expired'].indexOf(v.state) >= 0) { try { hooks.onFallback && hooks.onFallback(v.state); } catch (e) {} }
  }
  function fallbackChoice(st, choice) {
    if (!hooks.onContactChoice || st.fallbackAnswered) return;
    st.fallbackAnswered = true;
    var choices = st.card.querySelector('[data-le-fallback-choices]'); if (choices) choices.remove();
    st.card.removeAttribute('data-le-choice-active');
    try { hooks.onChoiceState && hooks.onChoiceState(); } catch (e) {}
    hooks.onContactChoice(choice);
  }

  function stopAll(st, keepDone) {
    clearInterval(st.poll); clearInterval(st.tick); st.poll = st.tick = null;
    if (st.ctl) { try { st.ctl.close(); } catch (e) {} st.ctl = null; }
    if (st.stream) { st.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} }); st.stream = null; }
    st.done = true;
    try { hooks.onEnd && hooks.onEnd(); } catch (e) {}
  }

  function startPolling(st) {
    clearInterval(st.poll);
    st.poll = setInterval(function () { refresh(st); }, 3000);   // doubles as the visitor liveness heartbeat
    clearInterval(st.tick);
    st.tick = setInterval(function () {
      var remaining = st.card.querySelector('[data-le-handoff=remaining]');
      if (remaining && st.view && st.view.expiresAt) remaining.textContent = fmt(st.view.expiresAt - nowServer(st)) + ' remaining';
    }, 500);
  }
  async function refresh(st) {
    if (st.done) return;
    var r = await api('visitor/status', body(st));
    if (st.done) return;
    if (!r.ok) {
      // not_authorised = the handoff no longer exists for us; repeated failures (network down, feature switched off) => honest fallback
      st.fails = (st.fails || 0) + 1;
      if (r.reason === 'not_authorised' || st.fails >= 5) { st.view = { state: 'expired', terminal: true, fallback: true, owner: st.view && st.view.owner }; draw(st); }
      return;
    }
    st.fails = 0;
    if (typeof r.serverNow === 'number') st.clockSkew = r.serverNow - Date.now();
    var prev = st.view; st.view = r.view; if (st.view.phase === 'connected' && !st.connectedAt) st.connectedAt = Date.now();
    if (st.view.media && (st.view.phase === 'connecting' || st.view.phase === 'connected') && st.stream) syncCall(st);
    if (!prev || prev.phase !== st.view.phase || prev.terminal !== st.view.terminal ||
      (prev.contactRequest && prev.contactRequest.id) !== (st.view.contactRequest && st.view.contactRequest.id) ||
      (prev.callbackIntent && prev.callbackIntent.advisedAt) !== (st.view.callbackIntent && st.view.callbackIntent.advisedAt)) draw(st);
  }
  function syncCall(st) {
    var m = st.view.media; if (!m) return;
    if (st.ctl && st.ctl.attempt !== m.attempt) { try { st.ctl.close({ keepStream: true }); } catch (e) {} st.ctl = null; }
    if (st.ctl) return;
    var wsUrl = new URL('/handoff/signal', hooks.workerUrl); wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    var tuple = Object.assign({ handoffId: st.offer.handoffId }, m); delete tuple.turnEnabled;
    st.ctl = LiveAskHumanCall.create({
      role: 'visitor', tuple: tuple, audioEl: st.audio, localStream: st.stream, wsBase: wsUrl.toString(),
      callApi: function (route, b) { return api('media/' + route, b); },
      onStatus: function (s) { var n = st.card.querySelector('[data-le-handoff=note]'); if (n) n.textContent = s === 'reconnecting' ? 'Reconnecting…' : s === 'audio_blocked' ? 'Tap the page once to hear audio.' : ''; }
    });
    if (st.muted) st.ctl.setMuted(true);
    st.ctl.start().catch(function () {});
  }

  async function accept(st) {
    var r = await api('visitor/accept', body(st));
    if (typeof r.serverNow === 'number') st.clockSkew = r.serverNow - Date.now();
    if (!r.ok) { st.view = { state: 'expired', terminal: true, fallback: true, owner: st.offer.owner }; return draw(st); }
    st.view = r.view || { phase: 'asking', owner: st.offer.owner, state: r.state };
    if (r.state === 'notification_failed' || (r.view && r.view.terminal)) { st.view = r.view || { state: r.state, terminal: true, fallback: true, owner: st.offer.owner }; return draw(st); }
    draw(st); startPolling(st);
  }
  async function decline(st) {
    var r = await api('visitor/decline', body(st));
    st.view = { state: 'visitor_declined', terminal: true, fallback: false, owner: st.offer.owner }; stopAll(st); draw(st);
  }
  async function talkNow(st) {
    var msg = st.card.querySelector('[data-le-handoff=msg]');
    try { st.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }); }
    catch (e) { if (msg) msg.textContent = 'Microphone access is needed to talk. Allow it and tap Talk Now again.'; return; }
    var aiBinding = hooks.getAiVoiceBinding ? hooks.getAiVoiceBinding() : {};
    var r = await api('visitor/talk-now', Object.assign(body(st), aiBinding));
    if (!r.ok) {
      if (st.stream) { st.stream.getTracks().forEach(function (t) { t.stop(); }); st.stream = null; }
      if (r.reason === 'ai_voice_not_finalised' || r.reason === 'ai_voice_finalising' || r.reason === 'network') { var m2 = st.card.querySelector('[data-le-handoff=msg]'); if (m2) m2.textContent = 'That did not go through. Please tap Talk Now again.'; return; }
      st.view = { state: 'expired', terminal: true, fallback: true, owner: st.view && st.view.owner }; return draw(st);
    }
    st.view = r.view;
    try { if (hooks.onTalkNow) await hooks.onTalkNow(); } catch (e) { await end(st); return; } // await client AI cleanup before starting human audio
    draw(st); syncCall(st); startPolling(st);
  }
  async function end(st) {
    var m = st.view && st.view.media;
    if (m) { var t = Object.assign({ handoffId: st.offer.handoffId }, m); delete t.turnEnabled; await api('media/end', t); }
    st.view = { state: 'ended', terminal: true, durationMs: st.connectedAt ? Date.now() - st.connectedAt : null, owner: st.view && st.view.owner };
    stopAll(st); draw(st);
  }

  window.LiveAskHandoffVisitor = { init: function (h) { hooks = h; return { present: present }; } };
})();

