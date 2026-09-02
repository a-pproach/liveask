import assert from 'node:assert/strict';
import { MODEL, SESSION_CONFIG, extractCallId, isPingCall, pingOutput } from './wp1-realtime-worker.js';

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('frozen model is gpt-realtime-2.1-mini', () => {
  assert.equal(MODEL, 'gpt-realtime-2.1-mini');
  assert.equal(SESSION_CONFIG.model, MODEL);
});

test('WP1 exposes only PING tool', () => {
  assert.deepEqual(SESSION_CONFIG.tools.map(t => t.name), ['PING']);
});

test('extractCallId handles current Location shape', () => {
  assert.equal(extractCallId('/v1/realtime/calls/rtc_test_123'), 'rtc_test_123');
  assert.equal(extractCallId('https://api.openai.com/v1/realtime/calls/rtc_test_456?x=1'), 'rtc_test_456');
});

test('PING recognizes response.function_call_arguments.done', () => {
  assert.deepEqual(isPingCall({ type: 'response.function_call_arguments.done', name: 'PING', call_id: 'call_1' }), {
    callId: 'call_1', sourceEvent: 'response.function_call_arguments.done'
  });
});

test('PING recognizes conversation.item.done function call', () => {
  assert.deepEqual(isPingCall({ type: 'conversation.item.done', item: { type: 'function_call', name: 'PING', call_id: 'call_2' } }), {
    callId: 'call_2', sourceEvent: 'conversation.item.done'
  });
});

test('non-PING calls are ignored', () => {
  assert.equal(isPingCall({ type: 'response.function_call_arguments.done', name: 'OTHER', call_id: 'call_3' }), null);
});

test('PING result is fixed harmless function output', () => {
  assert.deepEqual(pingOutput('call_4'), {
    type: 'conversation.item.create',
    item: { type: 'function_call_output', call_id: 'call_4', output: '{"ok":true}' }
  });
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}`); console.error(error); }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exitCode = failed ? 1 : 0;
