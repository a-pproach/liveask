// LiveAsk Realtime Voice WP1 — transport/control spike ONLY.
// Frozen scope: no Sonnet, tenant knowledge, real actions, Tours, Metering,
// continuity, production Voice UX, or WP2 behaviour.

const MODEL = 'gpt-realtime-2.1-mini';
const OPENAI_BASE = 'https://api.openai.com/v1';

const SESSION_CONFIG = {
  type: 'realtime',
  model: MODEL,
  output_modalities: ['audio'],
  instructions: [
    'You are running a bounded LiveAsk WP1 transport test.',
    'Keep spoken replies very short.',
    'When the user asks to run, execute, or test PING, call the PING function.',
    'After PING returns {"ok":true}, say exactly: Ping test passed.'
  ].join(' '),
  tools: [{
    type: 'function',
    name: 'PING',
    description: 'Harmless WP1 transport test. Call when the user asks to run the ping test.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    strict: true
  }],
  tool_choice: 'auto',
  audio: {
    input: {
      turn_detection: {
        type: 'server_vad',
        create_response: true,
        interrupt_response: true
      }
    },
    output: { voice: 'marin' }
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

function requireKey(env) {
  if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured on the WP1 Worker');
  return env.OPENAI_API_KEY;
}

function extractCallId(location) {
  if (!location) throw new Error('OpenAI create-call response did not include Location');
  const path = location.split('?')[0];
  const callId = path.split('/').filter(Boolean).at(-1);
  if (!callId) throw new Error('Could not extract provider call id from Location');
  return callId;
}

function safeEvent(type, extra = {}) {
  return JSON.stringify({ type, at: new Date().toISOString(), ...extra });
}

async function createCall(request, env) {
  const key = requireKey(env);
  const body = await request.json();
  if (typeof body.sdp !== 'string' || !body.sdp.startsWith('v=0')) {
    return json({ error: 'A browser-generated SDP offer is required' }, 400);
  }

  const form = new FormData();
  form.set('sdp', new Blob([body.sdp], { type: 'application/sdp' }), 'offer.sdp');
  form.set('session', new Blob([JSON.stringify(SESSION_CONFIG)], { type: 'application/json' }), 'session.json');

  const started = Date.now();
  const upstream = await fetch(`${OPENAI_BASE}/realtime/calls`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, accept: 'application/sdp' },
    body: form
  });
  const answer = await upstream.text();
  const location = upstream.headers.get('location');

  if (!upstream.ok) {
    return json({
      error: 'OpenAI create-call failed',
      status: upstream.status,
      providerBody: answer.slice(0, 1200),
      elapsedMs: Date.now() - started,
      model: MODEL
    }, 502);
  }

  const callId = extractCallId(location);
  return json({
    sdp: answer,
    callId,
    model: MODEL,
    providerStatus: upstream.status,
    locationShape: location ? location.replace(callId, '<call_id>') : null,
    elapsedMs: Date.now() - started
  });
}

async function hangupCall(request, env) {
  const key = requireKey(env);
  const body = await request.json();
  if (typeof body.callId !== 'string' || !body.callId) return json({ error: 'callId required' }, 400);

  const started = Date.now();
  const upstream = await fetch(`${OPENAI_BASE}/realtime/calls/${encodeURIComponent(body.callId)}/hangup`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}` }
  });
  const text = await upstream.text();
  return json({
    ok: upstream.ok,
    providerStatus: upstream.status,
    elapsedMs: Date.now() - started,
    providerBody: upstream.ok ? undefined : text.slice(0, 1200)
  }, upstream.ok ? 200 : 502);
}

function pingOutput(callId) {
  return {
    type: 'conversation.item.create',
    item: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ ok: true }) }
  };
}

function isPingCall(event) {
  if (event?.type === 'response.function_call_arguments.done' && event?.name === 'PING' && event?.call_id) {
    return { callId: event.call_id, sourceEvent: event.type };
  }
  if (event?.type === 'conversation.item.done' && event?.item?.type === 'function_call' && event?.item?.name === 'PING' && event?.item?.call_id) {
    return { callId: event.item.call_id, sourceEvent: event.type };
  }
  return null;
}

async function controlSocket(request, env) {
  const key = requireKey(env);
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Expected WebSocket upgrade', { status: 426 });
  }
  const callId = new URL(request.url).searchParams.get('call_id');
  if (!callId) return new Response('call_id required', { status: 400 });

  const pair = new WebSocketPair();
  const [client, browserDiagnostics] = Object.values(pair);
  browserDiagnostics.accept();

  const sidebandResponse = await fetch(`https://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`, {
    headers: { Upgrade: 'websocket', authorization: `Bearer ${key}` }
  });
  const sideband = sidebandResponse.webSocket;
  if (!sideband) {
    browserDiagnostics.send(safeEvent('sideband.failed', { providerStatus: sidebandResponse.status }));
    browserDiagnostics.close(1011, 'OpenAI sideband attach failed');
    return new Response(null, { status: 101, webSocket: client });
  }

  sideband.accept();
  browserDiagnostics.send(safeEvent('sideband.attached', { callId }));

  sideband.addEventListener('message', event => {
    if (typeof event.data !== 'string') return;
    let parsed;
    try { parsed = JSON.parse(event.data); } catch { return; }

    // Metadata-only diagnostics: do not forward transcripts/audio/content.
    browserDiagnostics.send(safeEvent('provider.event', { providerEventType: parsed.type }));

    const ping = isPingCall(parsed);
    if (!ping) return;

    browserDiagnostics.send(safeEvent('ping.received', { sourceEvent: ping.sourceEvent, toolCallId: ping.callId }));
    sideband.send(JSON.stringify(pingOutput(ping.callId)));
    sideband.send(JSON.stringify({ type: 'response.create' }));
    browserDiagnostics.send(safeEvent('ping.result_sent', { toolCallId: ping.callId, result: { ok: true } }));
  });

  sideband.addEventListener('close', event => {
    browserDiagnostics.send(safeEvent('sideband.closed', { code: event.code, reason: event.reason || '' }));
    try { browserDiagnostics.close(1000, 'Provider sideband closed'); } catch {}
  });

  sideband.addEventListener('error', () => {
    browserDiagnostics.send(safeEvent('sideband.error'));
    try { browserDiagnostics.close(1011, 'Provider sideband error'); } catch {}
  });

  browserDiagnostics.addEventListener('close', () => {
    // Closing the diagnostic/control socket deliberately does NOT hang up the provider call.
    try { sideband.close(1000, 'WP1 diagnostics closed'); } catch {}
  });

  return new Response(null, { status: 101, webSocket: client });
}

const TEST_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LiveAsk WP1 Realtime Spike</title>
<style>body{font:16px system-ui;max-width:820px;margin:40px auto;padding:0 18px}button{margin:4px;padding:10px 14px}pre{background:#111;color:#eee;padding:14px;min-height:260px;white-space:pre-wrap}.state{font-weight:700}</style></head>
<body><h1>LiveAsk WP1 Realtime Transport Spike</h1>
<p>Temporary test harness only. No Sonnet, tenant knowledge, real actions, Tours, Metering or production Voice UX.</p>
<p class="state">State: <span id="state">idle</span></p>
<button id="start">1. Start Voice</button><button id="ping" disabled>2. Ask PING</button><button id="hangup" disabled>3. Backend forced hangup</button><button id="close" disabled>Local cleanup</button>
<audio id="remote" autoplay></audio><pre id="log"></pre>
<script type="module">
const state=document.querySelector('#state'), log=document.querySelector('#log'), remote=document.querySelector('#remote');
const start=document.querySelector('#start'), ping=document.querySelector('#ping'), hangup=document.querySelector('#hangup'), closeBtn=document.querySelector('#close');
let pc, stream, dc, callId, control;
function note(type,data={}){const row={at:new Date().toISOString(),type,...data};log.textContent+=JSON.stringify(row)+'\\n';log.scrollTop=log.scrollHeight;}
function setState(v){state.textContent=v;note('browser.state',{state:v});}
async function cleanup(){try{control?.close()}catch{};try{dc?.close()}catch{};try{pc?.close()}catch{};stream?.getTracks().forEach(t=>t.stop());pc=stream=dc=control=null;ping.disabled=hangup.disabled=closeBtn.disabled=true;start.disabled=false;setState('closed');}
start.onclick=async()=>{try{start.disabled=true;setState('requesting-microphone');stream=await navigator.mediaDevices.getUserMedia({audio:true});pc=new RTCPeerConnection();stream.getTracks().forEach(t=>pc.addTrack(t,stream));pc.ontrack=e=>{remote.srcObject=e.streams[0];remote.play().catch(err=>note('audio.play.error',{message:err.message}));note('browser.remote-track')};pc.onconnectionstatechange=()=>note('browser.peer-state',{connectionState:pc.connectionState});
dc=pc.createDataChannel('oai-events');dc.onopen=()=>note('browser.datachannel.open');dc.onmessage=e=>{try{const x=JSON.parse(e.data);note('browser.provider-event',{providerEventType:x.type})}catch{}};
const offer=await pc.createOffer();await pc.setLocalDescription(offer);setState('creating-provider-call');const r=await fetch('/wp1/realtime/calls',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sdp:offer.sdp})});const created=await r.json();if(!r.ok)throw new Error(JSON.stringify(created));callId=created.callId;note('provider.call.created',{providerStatus:created.providerStatus,model:created.model,locationShape:created.locationShape,elapsedMs:created.elapsedMs});await pc.setRemoteDescription({type:'answer',sdp:created.sdp});
const proto=location.protocol==='https:'?'wss:':'ws:';control=new WebSocket(proto+'//'+location.host+'/wp1/realtime/control?call_id='+encodeURIComponent(callId));control.onmessage=e=>{const x=JSON.parse(e.data);note('backend.'+x.type,x);if(x.type==='sideband.attached'){setState('connected');ping.disabled=false;hangup.disabled=false;closeBtn.disabled=false;}};control.onclose=e=>note('backend.control.closed',{code:e.code,reason:e.reason});control.onerror=()=>note('backend.control.error');}catch(err){note('start.error',{message:err.message});setState('failed');start.disabled=false;}};
ping.onclick=()=>{if(dc?.readyState!=='open')return note('ping.request.failed',{reason:'data channel not open'});dc.send(JSON.stringify({type:'conversation.item.create',item:{type:'message',role:'user',content:[{type:'input_text',text:'Run the PING test now.'}]}}));dc.send(JSON.stringify({type:'response.create'}));note('ping.requested.by-test-harness');};
hangup.onclick=async()=>{note('backend.hangup.requested',{browserPeerStateBefore:pc?.connectionState});const r=await fetch('/wp1/realtime/hangup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({callId})});const x=await r.json();note('backend.hangup.result',x);setState('hangup-sent-observe-peer');};
closeBtn.onclick=cleanup;window.addEventListener('beforeunload',()=>{stream?.getTracks().forEach(t=>t.stop());try{pc?.close()}catch{}});
</script></body></html>`;

export { MODEL, SESSION_CONFIG, extractCallId, isPingCall, pingOutput };

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/wp1/')) {
        return new Response(TEST_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
      }
      if (request.method === 'POST' && url.pathname === '/wp1/realtime/calls') return createCall(request, env);
      if (request.method === 'GET' && url.pathname === '/wp1/realtime/control') return controlSocket(request, env);
      if (request.method === 'POST' && url.pathname === '/wp1/realtime/hangup') return hangupCall(request, env);
      return new Response('Not found', { status: 404 });
    } catch (error) {
      return json({ error: error.message || String(error) }, 500);
    }
  }
};
