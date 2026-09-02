# LiveAsk Realtime Voice — WP1 Transport + Same-Call Control Spike

This branch implements **WP1 only** from the frozen Voice architecture.

## Scope

Implemented:

1. browser-generated WebRTC SDP offer;
2. server call creation through `POST /v1/realtime/calls` using `OPENAI_API_KEY` only on the Worker;
3. SDP answer returned to browser;
4. direct browser ↔ OpenAI WebRTC audio;
5. server sideband attach to the same call through `wss://api.openai.com/v1/realtime?call_id=...`;
6. harmless `PING()` function call handled on that trusted server sideband;
7. fixed `{"ok":true}` function result returned to Realtime;
8. explicit backend `POST /v1/realtime/calls/{call_id}/hangup` while browser peer remains active;
9. metadata-only diagnostic log in the temporary test page.

Not implemented: Sonnet, `ASK_LIVEASK`, tenant knowledge, real actions, Tours, Metering, continuity, production Voice UX, WP2.

## Files

- `wp1-realtime-worker.js` — isolated Cloudflare Worker + temporary browser harness.
- `wrangler.wp1.toml` — isolated deployment config.
- `test_wp1_realtime.mjs` — deterministic contract tests.
- `WP1_REALTIME_SPIKE_README.md` — this file.

No existing production LiveAsk file is modified by WP1.

## Deterministic test

```bash
node test_wp1_realtime.mjs
```

## Provider test setup

Set the server-side secret on the isolated Worker:

```bash
npx wrangler secret put OPENAI_API_KEY --config wrangler.wp1.toml
```

Deploy the isolated spike:

```bash
npx wrangler deploy --config wrangler.wp1.toml
```

Open the deployed Worker URL in a real browser.

## Required provider/browser sequence

1. Click **Start Voice** and grant microphone permission.
2. Confirm create-call log reports model `gpt-realtime-2.1-mini`, provider status 201/2xx, and browser peer reaches connected.
3. Speak and hear a Realtime reply.
4. Interrupt the model once while it is speaking and confirm conversation continues.
5. Confirm log contains `backend.sideband.attached` for the same provider call.
6. Click **Ask PING** or say “run the ping test”.
7. Confirm log contains `backend.ping.received` followed by `backend.ping.result_sent` and hear **“Ping test passed.”**
8. While the peer remains active, click **Backend forced hangup**. Do not locally close the peer first.
9. Confirm provider hangup succeeds and browser peer/audio transitions away from active/connected because of provider termination.
10. Click **Local cleanup** and confirm microphone/peer resources close.

## Falsification / STOP rule

STOP and return evidence to Command Central if any of these fail:

- raw browser SDP cannot be completed through `/v1/realtime/calls`;
- `gpt-realtime-2.1-mini` is inaccessible;
- same-call server sideband cannot attach;
- PING cannot be received/responded to over the trusted server sideband;
- backend provider hangup cannot terminate the active browser WebRTC call.

Do not substitute an ephemeral-token flow or browser-relayed privileged tool handling inside WP1.

## Privacy / diagnostics

The test page logs event types, timestamps, provider status/model/call-control metadata and PING status. The Worker deliberately does not forward transcript or raw audio into the diagnostic WebSocket.
