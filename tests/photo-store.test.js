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
  assert.equal(record.aiReview, null);
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

test("automatic AI review waits for eight eligible photos and protects gestures", () => {
  const scheduled = Array.from({ length: 9 }, (_, index) => ({
    id: `scheduled-${index + 1}`,
    blob: fakeBlob(10),
    capturedAtMs: (index + 1) * 1000,
    trigger: "schedule",
    aiReview: null,
  }));
  const gesture = {
    id: "hands-up",
    blob: fakeBlob(10),
    capturedAtMs: 500,
    trigger: "gesture",
    aiReview: null,
  };
  const reviewed = {
    id: "already-reviewed",
    blob: fakeBlob(10),
    capturedAtMs: 250,
    trigger: "schedule",
    aiReview: { action: "keep" },
  };

  assert.deepEqual(
    storage.selectAiReviewBatch([gesture, reviewed, ...scheduled.slice(0, 7)], 8),
    [],
  );
  assert.deepEqual(
    storage
      .selectAiReviewBatch([scheduled[8], gesture, reviewed, ...scheduled.slice(0, 8)], 8)
      .map((record) => record.id),
    scheduled.slice(0, 8).map((record) => record.id),
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

test("a capture records the cumulative anonymous session count", () => {
  const occupied = storage.createCaptureRecord({
    blob: { size: 2048, type: "image/jpeg" },
    uniquePeopleSeen: 4,
    pose: { present: true, confidence: 0.91, pose: "standing", people: 2 },
  });
  assert.equal(occupied.uniquePeopleSeen, 4);

  const emptyLater = storage.createCaptureRecord({
    blob: { size: 2048, type: "image/jpeg" },
    uniquePeopleSeen: 4,
    pose: { present: false },
  });
  assert.equal(emptyLater.pose, null);
  assert.equal(emptyLater.uniquePeopleSeen, 4);

  assert.equal(
    storage.createCaptureRecord({ uniquePeopleSeen: Number.POSITIVE_INFINITY }).uniquePeopleSeen,
    0,
  );
  assert.equal(storage.createCaptureRecord({ uniquePeopleSeen: 20_000 }).uniquePeopleSeen, 10_000);
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

test("AI rejects stay recoverable until the user purges them", async () => {
  const store = createStore();
  const kept = await store.save({ blob: fakeBlob(10), date: new Date(2026, 0, 1) });
  const rejected = await store.save({ blob: fakeBlob(20), date: new Date(2026, 0, 2) });

  await store.applyAiReviews(
    [
      {
        id: kept.id,
        action: "keep",
        recommendation: "keep",
        relevance: 0.9,
        informationGain: 0.8,
        quality: 0.7,
        confidence: 0.95,
        duplicateOf: null,
        reason: "Shows useful work.",
      },
      {
        id: rejected.id,
        action: "discard",
        recommendation: "discard",
        discardBasis: "redundant",
        relevance: 0.1,
        informationGain: 0.1,
        quality: 0.8,
        confidence: 0.96,
        duplicateOf: kept.id,
        reason: "Adds no new information.",
      },
    ],
    { model: "gemini-3.1-flash-lite" },
  );

  assert.deepEqual((await store.listActive()).map((record) => record.id), [kept.id]);
  assert.deepEqual((await store.listDiscarded()).map((record) => record.id), [rejected.id]);
  assert.equal((await store.listDiscarded())[0].aiReview.discardBasis, "redundant");
  assert.equal((await store.usage()).discarded, 1);
  assert.equal((await store.usage()).active, 1);

  const restored = await store.restoreAiDiscard(rejected.id);
  assert.equal(restored.aiReview.action, "keep");
  assert.ok(restored.aiReview.restoredAt);
  assert.equal((await store.listActive()).length, 2);

  await store.applyAiReviews([
    {
      id: rejected.id,
      action: "discard",
      recommendation: "discard",
      discardBasis: "redundant",
      confidence: 0.98,
      reason: "Still redundant.",
    },
  ]);
  assert.equal(await store.purgeAiDiscarded(), 1);
  assert.equal((await store.list()).length, 1);
});

test("gesture captures cannot be put in the AI review bin", async () => {
  const store = createStore();
  const requested = await store.save({
    blob: fakeBlob(10),
    date: new Date(2026, 0, 1),
    trigger: "gesture",
  });

  const [updated] = await store.applyAiReviews([
    {
      id: requested.id,
      action: "discard",
      recommendation: "discard",
      confidence: 1,
      reason: "Attempted discard.",
    },
  ]);

  assert.equal(updated.aiReview.action, "keep");
  assert.equal(updated.aiReview.confidence, 1);
  assert.equal((await store.listDiscarded()).length, 0);
});

test("the store rejects malformed or low-confidence discard actions", async () => {
  const store = createStore();
  const malformed = await store.save({ blob: fakeBlob(10), date: new Date(2026, 0, 1) });
  const uncertain = await store.save({ blob: fakeBlob(10), date: new Date(2026, 0, 2) });

  const updated = await store.applyAiReviews([
    {
      id: malformed.id,
      action: "discard",
      recommendation: "discard",
      discardBasis: "not_applicable",
      confidence: 0.99,
    },
    {
      id: uncertain.id,
      action: "discard",
      recommendation: "discard",
      discardBasis: "irrelevant",
      confidence: 0.79,
    },
  ]);

  assert.deepEqual(
    updated.map((record) => record.aiReview.action),
    ["review", "review"],
  );
  // They do not become high-confidence rejects, but the model did flag both
  // for discard, so both leave the main gallery for the recoverable bin.
  assert.equal((await store.listDiscarded()).length, 2);
  assert.equal((await store.listActive()).length, 0);
  assert.equal((await store.usage()).needsReview, 2);
  assert.equal(storage.AI_DISCARD_CONFIDENCE, 0.8);
});

test("missing output stays visible rather than becoming an AI flag", async () => {
  const store = createStore();
  const record = await store.save({ blob: fakeBlob(10), date: new Date(2026, 0, 1) });

  await store.applyAiReviews([
    {
      id: record.id,
      action: "review",
      recommendation: "keep",
      discardBasis: "not_applicable",
      confidence: 0,
    },
  ]);

  assert.equal((await store.listActive()).length, 1);
  assert.equal((await store.listDiscarded()).length, 0);
});

test("storage pressure prunes AI rejects before kept photos", () => {
  const records = [
    { id: "new", capturedAtMs: 3000, bytes: 100, score: 0.1 },
    { id: "good", capturedAtMs: 2000, bytes: 100, score: 0.9 },
    {
      id: "ai-reject",
      capturedAtMs: 1000,
      bytes: 100,
      score: 1,
      aiReview: { action: "discard" },
    },
  ];

  assert.deepEqual(storage.selectExpired(records, { maxRecords: 2, maxBytes: 1e9 }), [
    "ai-reject",
  ]);
});

function fakeIndexedDb(options = {}) {
  const rows = new Map();
  const calls = { clear: 0, created: 0, deleted: [], open: 0, put: [] };
  const database = {
    objectStoreNames: {
      contains() {
        return calls.created > 0;
      },
    },
    createObjectStore(name, configuration) {
      calls.created += 1;
      calls.createdStore = { name, configuration };
    },
    transaction(name, mode) {
      const transaction = {
        error: options.transactionError || null,
        objectStore(receivedName) {
          assert.equal(receivedName, storage.STORE_NAME);
          return {
            clear() {
              rows.clear();
              calls.clear += 1;
              finish();
            },
            delete(id) {
              rows.delete(id);
              calls.deleted.push(id);
              finish();
            },
            getAll() {
              const request = {};
              queueMicrotask(() => {
                request.result = [...rows.values()];
                request.onsuccess?.();
              });
              return request;
            },
            put(record) {
              rows.set(record.id, record);
              calls.put.push(record.id);
              finish();
            },
          };
        },
      };
      calls.transaction = { name, mode };

      function finish() {
        queueMicrotask(() => {
          if (options.transactionOutcome === "abort") transaction.onabort?.();
          else if (options.transactionOutcome === "error") transaction.onerror?.();
          else transaction.oncomplete?.();
        });
      }

      return transaction;
    },
  };
  const factory = {
    open(name, version) {
      calls.open += 1;
      calls.openedWith = { name, version };
      const request = {};
      queueMicrotask(() => {
        request.result = database;
        if (options.openOutcome === "blocked") {
          request.onblocked?.();
          return;
        }
        if (options.openOutcome === "error") {
          request.error = options.openError || new Error("open failed");
          request.onerror?.();
          return;
        }
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };

  return { calls, factory, rows };
}

test("the IndexedDB backend upgrades once and persists every CRUD operation", async () => {
  const indexedDb = fakeIndexedDb();
  const backend = storage.createIndexedDbBackend(indexedDb.factory);

  assert.equal(backend.persistent, true);
  await backend.ready();
  await backend.ready();
  assert.equal(indexedDb.calls.open, 1);
  assert.deepEqual(indexedDb.calls.openedWith, {
    name: storage.DB_NAME,
    version: storage.DB_VERSION,
  });
  assert.deepEqual(indexedDb.calls.createdStore, {
    name: storage.STORE_NAME,
    configuration: { keyPath: "id" },
  });

  await backend.put({ id: "one", value: 1 });
  await backend.put({ id: "two", value: 2 });
  assert.deepEqual(await backend.getAll(), [
    { id: "one", value: 1 },
    { id: "two", value: 2 },
  ]);
  assert.deepEqual(indexedDb.calls.transaction, {
    name: storage.STORE_NAME,
    mode: "readonly",
  });

  await backend.remove("one");
  assert.deepEqual(await backend.getAll(), [{ id: "two", value: 2 }]);
  await backend.clear();
  assert.deepEqual(await backend.getAll(), []);
  assert.deepEqual(indexedDb.calls.deleted, ["one"]);
  assert.equal(indexedDb.calls.clear, 1);
});

test("IndexedDB blocked, aborted, and failed transactions surface useful errors", async () => {
  const blocked = storage.createIndexedDbBackend(fakeIndexedDb({ openOutcome: "blocked" }).factory);
  await assert.rejects(blocked.ready(), /Another tab/);

  const abortError = new Error("quota aborted transaction");
  const aborted = storage.createIndexedDbBackend(
    fakeIndexedDb({ transactionOutcome: "abort", transactionError: abortError }).factory,
  );
  await assert.rejects(aborted.put({ id: "one" }), abortError);

  const failed = storage.createIndexedDbBackend(
    fakeIndexedDb({ transactionOutcome: "error" }).factory,
  );
  await assert.rejects(failed.clear(), /local photo store failed/);
});
