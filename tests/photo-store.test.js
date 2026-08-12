const assert = require("node:assert/strict");
const { resolve } = require("node:path");
const { test } = require("node:test");

const storage = require(resolve(__dirname, "..", "photo-store.js"));

function fakeBlob(bytes, type = "image/jpeg") {
  return { size: bytes, type };
}

function createStore(options = {}) {
  return storage.createPhotoStore({ backend: storage.createMemoryBackend(), ...options });
}

test("a capture record carries what a later upload would need", () => {
  const record = storage.createCaptureRecord({
    blob: fakeBlob(120000),
    date: new Date(2026, 7, 11, 14, 32, 5),
    address: "  10 Bayfront Avenue  ",
    intervalMs: 30000,
    pose: { present: true, confidence: 0.812345, pose: "standing" },
  });

  assert.equal(record.address, "10 Bayfront Avenue");
  assert.equal(record.bytes, 120000);
  assert.equal(record.type, "image/jpeg");
  assert.equal(record.intervalMs, 30000);
  assert.equal(record.poseDetected, true);
  assert.equal(record.pose.label, "standing");
  assert.equal(record.pose.confidence, 0.812);
  assert.equal(record.capturedAtMs, new Date(2026, 7, 11, 14, 32, 5).getTime());

  // Nothing has left the device, so the queue starts full.
  assert.equal(record.status, "local");
  assert.equal(record.name, "stampnote-20260811-143205-pose.jpg");
});

test("a capture with nobody in frame is named without the pose marker", () => {
  const record = storage.createCaptureRecord({
    blob: fakeBlob(1000),
    date: new Date(2026, 0, 2, 3, 4, 5),
    pose: { present: false },
  });

  assert.equal(record.name, "stampnote-20260102-030405.jpg");
  assert.equal(record.poseDetected, false);
  assert.equal(record.pose, null);
});

test("records are listed newest first", async () => {
  const store = createStore();

  await store.save({ blob: fakeBlob(10), date: new Date(2026, 0, 1, 0, 0, 0) });
  await store.save({ blob: fakeBlob(10), date: new Date(2026, 0, 1, 0, 2, 0) });
  await store.save({ blob: fakeBlob(10), date: new Date(2026, 0, 1, 0, 1, 0) });

  const listed = await store.list();
  assert.deepEqual(
    listed.map((record) => new Date(record.capturedAtMs).getMinutes()),
    [2, 1, 0],
  );
});

test("the oldest captures are dropped once the record limit is passed", async () => {
  const store = createStore({ maxRecords: 3 });

  for (let minute = 0; minute < 5; minute += 1) {
    await store.save({ blob: fakeBlob(10), date: new Date(2026, 0, 1, 0, minute, 0) });
  }

  const listed = await store.list();
  assert.equal(listed.length, 3);
  assert.deepEqual(
    listed.map((record) => new Date(record.capturedAtMs).getMinutes()),
    [4, 3, 2],
  );
});

test("the oldest captures are dropped once the byte budget is passed", async () => {
  const store = createStore({ maxBytes: 250 });

  await store.save({ blob: fakeBlob(100), date: new Date(2026, 0, 1, 0, 0, 0) });
  await store.save({ blob: fakeBlob(100), date: new Date(2026, 0, 1, 0, 1, 0) });
  await store.save({ blob: fakeBlob(100), date: new Date(2026, 0, 1, 0, 2, 0) });

  const usage = await store.usage();
  assert.equal(usage.count, 2);
  assert.equal(usage.bytes, 200);
});

test("pruning keeps the newest even when a single capture blows the budget", () => {
  const records = [
    { id: "new", capturedAtMs: 3000, bytes: 900 },
    { id: "mid", capturedAtMs: 2000, bytes: 900 },
    { id: "old", capturedAtMs: 1000, bytes: 900 },
  ];

  assert.deepEqual(storage.selectExpired(records, { maxBytes: 100, maxRecords: 10 }), [
    "mid",
    "old",
  ]);
  assert.deepEqual(storage.selectExpired(records, { maxRecords: 1, maxBytes: 1e9 }), [
    "mid",
    "old",
  ]);
  assert.deepEqual(storage.selectExpired(records, { maxRecords: 10, maxBytes: 1e9 }), []);
});

test("captures stay queued until something says otherwise", async () => {
  const store = createStore();

  const first = await store.save({ blob: fakeBlob(10), date: new Date(2026, 0, 1, 0, 0, 0) });
  await store.save({ blob: fakeBlob(10), date: new Date(2026, 0, 1, 0, 1, 0) });

  assert.equal((await store.listPending()).length, 2);

  const synced = await store.markSynced(first.id);
  assert.equal(synced.status, "synced");
  assert.ok(synced.syncedAt);

  const pending = await store.listPending();
  assert.equal(pending.length, 1);
  assert.equal((await store.usage()).pending, 1);
  assert.equal(await store.markSynced("no-such-id"), null);
});

test("usage can be summarised from records already in hand", async () => {
  const store = createStore();

  await store.save({ blob: fakeBlob(40), date: new Date(2026, 0, 1, 0, 0, 0) });
  await store.save({ blob: fakeBlob(60), date: new Date(2026, 0, 1, 0, 1, 0) });

  const records = await store.list();

  // The interface has the records already; reading them back out of the
  // database a second time would pull every stored photo into memory again.
  assert.deepEqual(await store.usage(records), await store.usage());
  assert.equal(storage.summarize(records).bytes, 100);
  assert.equal(storage.summarize([]).count, 0);
  assert.equal(storage.summarize([]).oldest, null);
});

test("captures can be removed one at a time or all at once", async () => {
  const store = createStore();

  const record = await store.save({ blob: fakeBlob(10), date: new Date(2026, 0, 1) });
  await store.save({ blob: fakeBlob(10), date: new Date(2026, 0, 2) });

  await store.remove(record.id);
  assert.equal((await store.usage()).count, 1);

  await store.clear();
  assert.equal((await store.usage()).count, 0);
  assert.equal((await store.usage()).oldest, null);
});

test("a browser without IndexedDB still captures, for the session at least", async () => {
  // Private browsing and older WebViews land here.
  const store = storage.createPhotoStore({ indexedDb: undefined });

  await store.ready();
  assert.equal(store.isPersistent(), false);

  await store.save({ blob: fakeBlob(10), date: new Date(2026, 0, 1) });
  assert.equal((await store.usage()).count, 1);
});

test("a database that refuses to open falls back instead of failing", async () => {
  const refusing = {
    open() {
      const request = {};
      queueMicrotask(() => request.onerror?.());
      return request;
    },
  };

  const store = storage.createPhotoStore({ indexedDb: refusing });

  await store.ready();
  assert.equal(store.isPersistent(), false);

  const record = await store.save({ blob: fakeBlob(10), date: new Date(2026, 0, 1) });
  assert.equal((await store.list())[0].id, record.id);
});

test("request wrapping reports both success and failure", async () => {
  const succeeding = {};
  const failing = {};

  const success = storage.promisifyRequest(succeeding);
  succeeding.result = "ok";
  succeeding.onsuccess();
  assert.equal(await success, "ok");

  const failure = storage.promisifyRequest(failing);
  failing.error = new Error("quota exceeded");
  failing.onerror();
  await assert.rejects(failure, /quota exceeded/);
});

test("sizes are reported in units a person reads", () => {
  assert.equal(storage.formatBytes(0), "0 B");
  assert.equal(storage.formatBytes(900), "900 B");
  assert.equal(storage.formatBytes(2048), "2 KB");
  assert.equal(storage.formatBytes(5 * 1024 * 1024), "5.0 MB");
});

test("a capture records how many people were in the frame", () => {
  const crowd = storage.createCaptureRecord({
    blob: { size: 2048, type: "image/jpeg" },
    pose: { present: true, confidence: 0.91, pose: "standing", people: 3 },
  });

  assert.equal(crowd.pose.people, 3);

  // A detector that never counted still records the one person it saw, rather
  // than a photograph that claims nobody was in it.
  const single = storage.createCaptureRecord({
    blob: { size: 2048, type: "image/jpeg" },
    pose: { present: true, confidence: 0.91, pose: "standing" },
  });

  assert.equal(single.pose.people, 1);
});

test("the store sheds its worst photographs, not merely its oldest", () => {
  const records = [
    { id: "newest", capturedAtMs: 5000, bytes: 100, score: 0.2 },
    { id: "empty-room", capturedAtMs: 4000, bytes: 100, score: 0.1 },
    { id: "blurred", capturedAtMs: 3000, bytes: 100, score: 0.2 },
    { id: "a-crowd", capturedAtMs: 2000, bytes: 100, score: 0.95 },
    { id: "one-person", capturedAtMs: 1000, bytes: 100, score: 0.8 },
  ];

  // Room for three. The two worst go, even though they are the two newest
  // after the one that was just taken — and the oldest photograph survives
  // because there are people in it.
  const expired = storage.selectExpired(records, { maxRecords: 3, maxBytes: 1e9 });

  assert.equal(expired.length, 2);
  assert.deepEqual([...expired].sort(), ["blurred", "empty-room"]);

  // The newest is never dropped, whatever it scored.
  assert.equal(expired.includes("newest"), false);
});

test("a capture carries what the triage made of it", () => {
  const record = storage.createCaptureRecord({
    blob: { size: 2048, type: "image/jpeg" },
    pose: { present: true, confidence: 0.9, pose: "standing" },
    score: 0.8123,
    sharpness: 412.7,
    fingerprint: "a1b2c3d4e5f60718",
  });

  assert.equal(record.score, 0.812);
  assert.equal(record.sharpness, 413);
  assert.equal(record.fingerprint, "a1b2c3d4e5f60718");

  // A capture from a detector that measured nothing carries nothing, rather
  // than a score somebody might later mistake for a judgement.
  const unmeasured = storage.createCaptureRecord({ blob: { size: 2048, type: "image/jpeg" } });
  assert.equal(unmeasured.score, null);
  assert.equal(unmeasured.fingerprint, null);
});
