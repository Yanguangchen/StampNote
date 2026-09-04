const test = require('node:test');
const assert = require('node:assert/strict');
const { createBridge, parsePairing, createVideoSampler } = require('../src/services/rover-bridge.js');

const token = 'a'.repeat(64);
const pairing = { url: 'http://127.0.0.1:8740', token };
const jpeg = 'data:image/jpeg;base64,/9j/2Q==';
const fragment = input => '#' + new URLSearchParams({ rover: JSON.stringify(input) });

test('pairing links accept loopback only, never arbitrary remote destinations', () => {
  assert.deepEqual(parsePairing(fragment(pairing)), pairing);
  assert.equal(parsePairing(''), null);
  for (const url of ['https://example.com', 'http://192.168.1.3', 'http://127.0.0.1:8740/path', 'http://user:pw@127.0.0.1:8740', 'http://127.0.0.1:8740?token=x']) assert.throws(() => parsePairing(fragment({ url, token })));
  assert.throws(() => parsePairing(fragment({ ...pairing, token: 'short' })));
});

test('sender drops stale/duplicate pictures and never queues behind a slow frame request', async () => {
  const calls = []; let finish;
  const bridge = createBridge({ pairing, imageSize: async () => ({ width: 400, height: 300 }), fetch: async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (url.endsWith('/frame')) await new Promise(resolve => { finish = resolve; });
    return new Response(JSON.stringify({ fresh: true }));
  } });
  await bridge.connect('camera-001');
  assert.equal(await bridge.forward({ capturedAtMs: Date.now() - 6000 }, jpeg), false);
  const capturedAtMs = Date.now(); const sending = bridge.forward({ capturedAtMs }, jpeg);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await bridge.forward({ capturedAtMs: capturedAtMs + 1 }, jpeg), false);
  assert.equal(calls.length, 2); finish(); assert.equal(await sending, true);
  assert.equal(await bridge.forward({ capturedAtMs }, jpeg), false);
  assert.equal(calls[1].body.capturedAt, capturedAtMs);
  assert.equal(calls.length, 2);
});

test('disconnect during image decoding prevents a late picture from being sent', async () => {
  const calls = []; let finishDecode;
  const bridge = createBridge({ pairing, imageSize: () => new Promise(resolve => { finishDecode = resolve; }), fetch: async url => { calls.push(url); return new Response('{}'); } });
  await bridge.connect('camera-001');
  const sending = bridge.forward({ capturedAtMs: Date.now() }, jpeg);
  await bridge.disconnect(); finishDecode({ width: 400, height: 300 });
  assert.equal(await sending, false);
  assert.ok(!calls.some(url => url.endsWith('/frame')));
  await assert.rejects(bridge.connect('camera-002'), /new pairing link/);
});

test('connection failures cannot report successful picture delivery', async () => {
  const states = [];
  const bridge = createBridge({ pairing, fetch: async () => { throw new TypeError('Failed to fetch'); }, onStatus: (state, message) => states.push({ state, message }) });
  await assert.rejects(bridge.connect('camera-001'));
  assert.equal(bridge.isConnected(), false);
  assert.equal(await bridge.forward({ capturedAtMs: Date.now() }, jpeg), false);
  assert.ok(states.some(x => x.state === 'error' && x.message.includes('local network access')));
});

function videoHarness(send) {
  const origin = Date.now(); let tick = 0, sequence = 0;
  const callbacks = new Map();
  const track = { readyState: 'live', muted: false };
  const video = { srcObject: { getVideoTracks: () => [track] }, videoWidth: 1280, videoHeight: 720, readyState: 2, paused: false,
    requestVideoFrameCallback(callback) { callbacks.set(++sequence, callback); return sequence; },
    cancelVideoFrameCallback(id) { callbacks.delete(id); },
  };
  const canvas = { getContext: () => ({ drawImage() {} }), toDataURL: () => jpeg };
  const sampler = createVideoSampler({ video, send, now: () => origin + tick, performance: { timeOrigin: origin }, makeCanvas: () => canvas });
  return { sampler, video, track, origin, callbacks,
    advance(time) { tick = time; },
    frame(time, metadata = {}) {
      tick = time;
      const [id, callback] = callbacks.entries().next().value || [];
      if (!callback) throw new Error('No frame callback registered');
      callbacks.delete(id); callback(time, { mediaTime: time / 1000, captureTime: time - 30, ...metadata });
    },
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('WebRTC sampler reads new video frames, preserves capture age, and stops refreshing a frozen frame', async () => {
  const frames = []; const h = videoHarness(input => frames.push(input));
  h.sampler.start(); h.frame(1000, { rtpTimestamp: 123 }); await flush();
  assert.equal(frames.length, 1);
  assert.equal(frames[0].width, 640); assert.equal(frames[0].height, 360);
  assert.equal(frames[0].capturedAt, h.origin + 970);
  assert.equal(frames[0].timestampKind, 'webrtc-capture');
  assert.equal(frames[0].transport, 'webrtc');
  h.frame(1400, { rtpTimestamp: 123 }); await flush();
  assert.equal(frames.length, 1);
  h.advance(1900); assert.equal(h.sampler.hasFreshFrames(), false);
  assert.equal(frames.length, 1);
  const lateCallback = [...h.callbacks.values()][0]; h.sampler.stop();
  lateCallback(2000, { rtpTimestamp: 125, captureTime: 1980 });
  assert.equal(frames.length, 1); assert.equal(h.callbacks.size, 0);
});

test('WebRTC sampling caps frame rate and drops work during slow delivery without a queue', async () => {
  const frames = []; let finish;
  const h = videoHarness(input => { frames.push(input); return new Promise(resolve => { finish = resolve; }); });
  h.sampler.start(); h.frame(1000); h.frame(1300); h.frame(1600);
  assert.equal(frames.length, 1);
  finish(); await flush(); assert.equal(frames.length, 1);
  h.frame(1700); assert.equal(frames.length, 2); finish(); await flush();
  h.frame(1800); assert.equal(frames.length, 2);
  h.frame(1950); assert.equal(frames.length, 3); finish(); await flush(); h.sampler.stop();
});

test('WebRTC metadata distinguishes receive/decode timing and refuses stale or muted video', async () => {
  const frames = []; const h = videoHarness(input => frames.push(input));
  h.sampler.start(); h.frame(3000, { captureTime: 100 }); await flush();
  assert.equal(frames.length, 0); assert.equal(h.sampler.hasFreshFrames(), false);
  h.frame(3300, { captureTime: undefined, receiveTime: 3200 }); await flush();
  assert.equal(frames[0].timestampKind, 'webrtc-receive'); assert.equal(frames[0].capturedAt, h.origin + 3200);
  h.frame(3600, { captureTime: undefined, presentationTime: 3550 }); await flush();
  assert.equal(frames[1].timestampKind, 'webrtc-presentation');
  h.track.muted = true; h.frame(3900); await flush(); assert.equal(frames.length, 2);
  h.sampler.stop();
});
