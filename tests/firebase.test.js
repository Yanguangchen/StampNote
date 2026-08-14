const assert = require("node:assert/strict");
const { test } = require("node:test");

const cloudData = require("../photo-cloud.js");
const { SDK_BASE, createFirebaseClient, firebaseConfig } = require("../firebase.js");

function createHarness(options = {}) {
  const calls = {
    analytics: [],
    batches: [],
    canvas: [],
    deleted: [],
    documents: [],
    imports: [],
    persistence: [],
    queries: [],
    redirects: [],
    revoked: [],
    signOut: [],
    writes: [],
  };
  const auth = {
    currentUser:
      options.user === undefined ? { uid: "user-1", email: "owner@example.com" } : options.user,
  };
  const app = { name: "stampnote" };
  const db = { name: "firestore" };
  const authObserver = {};
  let popupError = null;
  let imageFailure = false;
  let encodeFailure = false;
  const queryResults = options.queryResults ? [...options.queryResults] : null;

  class FakeProvider {
    setCustomParameters(parameters) {
      calls.providerParameters = parameters;
    }
  }

  class FakeImage {
    constructor() {
      this.naturalWidth = options.imageWidth || 1024;
      this.naturalHeight = options.imageHeight || 512;
      this.listeners = new Map();
    }

    addEventListener(name, callback) {
      this.listeners.set(name, callback);
    }

    set src(value) {
      this.source = value;
      queueMicrotask(() => this.listeners.get(imageFailure ? "error" : "load")?.());
    }
  }

  const scope = {
    Blob,
    Image: FakeImage,
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    StampNoteCloudData: options.cloudData === undefined ? cloudData : options.cloudData,
    URL: {
      createObjectURL(blob) {
        calls.objectUrlBlob = blob;
        return "blob:firebase-test";
      },
      revokeObjectURL(url) {
        calls.revoked.push(url);
      },
    },
    document: {
      createElement(name) {
        assert.equal(name, "canvas");
        const canvas = {
          width: 0,
          height: 0,
          getContext(kind) {
            assert.equal(kind, "2d");
            return {
              drawImage(...arguments_) {
                calls.canvas.push(arguments_);
              },
            };
          },
          toBlob(callback, type, quality) {
            calls.encoding = { type, quality };
            callback(encodeFailure ? null : new Blob([Uint8Array.of(1, 2, 3, 4)]));
          },
        };
        calls.createdCanvas = canvas;
        return canvas;
      },
    },
  };

  const appSdk = {
    initializeApp(config) {
      calls.config = config;
      return app;
    },
  };
  const authSdk = {
    browserLocalPersistence: { kind: "local" },
    GoogleAuthProvider: FakeProvider,
    getAuth(receivedApp) {
      assert.equal(receivedApp, app);
      return auth;
    },
    onAuthStateChanged(receivedAuth, onUser, onError) {
      assert.equal(receivedAuth, auth);
      authObserver.onUser = onUser;
      authObserver.onError = onError;
      return () => {
        calls.unsubscribed = true;
      };
    },
    async setPersistence(receivedAuth, persistence) {
      calls.persistence.push([receivedAuth, persistence]);
    },
    async signInWithPopup(receivedAuth, provider) {
      calls.popup = [receivedAuth, provider];
      if (popupError) {
        throw popupError;
      }
      return { user: auth.currentUser };
    },
    async signInWithRedirect(receivedAuth, provider) {
      calls.redirects.push([receivedAuth, provider]);
    },
    async signOut(receivedAuth) {
      calls.signOut.push(receivedAuth);
    },
  };
  const firestoreSdk = {
    Bytes: {
      fromUint8Array(bytes) {
        return { bytes: [...bytes], toUint8Array: () => bytes };
      },
    },
    collection(...segments) {
      return { kind: "collection", segments };
    },
    collectionGroup(receivedDb, name) {
      assert.equal(receivedDb, db);
      return { kind: "collectionGroup", name };
    },
    async deleteDoc(reference) {
      calls.deleted.push(reference);
    },
    doc(...segments) {
      const reference = { kind: "document", segments };
      calls.documents.push(reference);
      return reference;
    },
    getFirestore(receivedApp) {
      assert.equal(receivedApp, app);
      return db;
    },
    async getDocs(query) {
      calls.queries.push(query);
      const docs = queryResults?.length ? queryResults.shift() : options.documents || [
        { id: "firestore-1", data: () => ({ id: "photo-1", capturedAtMs: 2 }) },
        { id: "firestore-2", data: () => ({ id: "photo-2", capturedAtMs: 1 }) },
      ];
      return { docs, size: options.snapshotSize ?? docs.length };
    },
    limit(value) {
      return { kind: "limit", value };
    },
    orderBy(field, direction) {
      return { kind: "orderBy", field, direction };
    },
    query(collection, ...clauses) {
      return { collection, clauses };
    },
    serverTimestamp() {
      return { kind: "serverTimestamp" };
    },
    async setDoc(reference, value, writeOptions) {
      calls.writes.push({ reference, value, writeOptions });
    },
    startAfter(value) {
      return { kind: "startAfter", value };
    },
    where(field, operator, value) {
      return { kind: "where", field, operator, value };
    },
    writeBatch(receivedDb) {
      assert.equal(receivedDb, db);
      const batch = { committed: false, deletes: [] };
      calls.batches.push(batch);
      return {
        delete(reference) {
          batch.deletes.push(reference);
        },
        async commit() {
          batch.committed = true;
        },
      };
    },
  };
  const analyticsSdk = {
    async isSupported() {
      if (options.analyticsError) {
        throw options.analyticsError;
      }
      return options.analyticsSupported !== false;
    },
    getAnalytics(receivedApp) {
      calls.analytics.push(receivedApp);
    },
  };
  const modules = [appSdk, authSdk, firestoreSdk, analyticsSdk];
  let moduleIndex = 0;
  const client = createFirebaseClient({
    globalScope: scope,
    async loadSdk(url) {
      calls.imports.push(url);
      return modules[moduleIndex++];
    },
  });

  return {
    auth,
    authObserver,
    calls,
    client,
    scope,
    setEncodeFailure(value) {
      encodeFailure = value;
    },
    setImageFailure(value) {
      imageFailure = value;
    },
    setPopupError(error) {
      popupError = error;
    },
  };
}

function reviewedPhoto(overrides = {}) {
  return {
    id: "photo-1",
    address: "10 Marina Bay",
    capturedAt: "2026-08-13T12:00:00.000Z",
    capturedAtMs: Date.parse("2026-08-13T12:00:00.000Z"),
    blob: new Blob(["full-size-image"], { type: "image/jpeg" }),
    gpsLocation: { latitude: 1.2868, longitude: 103.8545, accuracyMeters: 12.5 },
    uniquePeopleSeen: 5,
    aiReview: { action: "keep", recommendation: "keep", confidence: 0.95 },
    ...overrides,
  };
}

test("Firebase initializes every required SDK and keeps Analytics optional", async () => {
  const harness = createHarness();
  const services = await harness.client.ready;
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(firebaseConfig, {
    apiKey: "AIzaSyArs5PDu31KE6wdV-o3Y16UpTdRkaj2JYw",
    authDomain: "stampnote-eedcd.firebaseapp.com",
    projectId: "stampnote-eedcd",
    storageBucket: "stampnote-eedcd.firebasestorage.app",
    messagingSenderId: "436163750873",
    appId: "1:436163750873:web:7a73d375be41975e2207c8",
    measurementId: "G-XG9MCLSZ6G",
  });
  assert.deepEqual(harness.calls.imports, [
    `${SDK_BASE}/firebase-app.js`,
    `${SDK_BASE}/firebase-auth.js`,
    `${SDK_BASE}/firebase-firestore.js`,
    `${SDK_BASE}/firebase-analytics.js`,
  ]);
  assert.equal(harness.calls.config, firebaseConfig);
  assert.equal(services.auth, harness.auth);
  assert.deepEqual(harness.calls.providerParameters, { prompt: "select_account" });
  assert.equal(harness.calls.persistence.length, 1);
  assert.deepEqual(harness.calls.analytics, [services.app]);

  const blocked = createHarness({ analyticsError: new Error("blocked") });
  await blocked.client.ready;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(blocked.calls.analytics, []);
});

test("Firebase auth handles popup, redirect fallback, observers, and sign-out", async () => {
  const harness = createHarness();
  await harness.client.ready;

  const signedIn = await harness.client.signIn();
  assert.equal(signedIn.user.uid, "user-1");

  harness.setPopupError(Object.assign(new Error("blocked"), { code: "auth/popup-blocked" }));
  assert.equal(await harness.client.signIn(), null);
  assert.equal(harness.calls.redirects.length, 1);

  const denied = Object.assign(new Error("denied"), { code: "auth/operation-not-allowed" });
  harness.setPopupError(denied);
  await assert.rejects(harness.client.signIn(), denied);

  const observed = [];
  const unsubscribe = harness.client.subscribeAuth((user, error) => observed.push({ user, error }));
  await new Promise((resolve) => setImmediate(resolve));
  harness.authObserver.onUser({ uid: "next-user" });
  harness.authObserver.onError(denied);
  assert.deepEqual(observed, [
    { user: { uid: "next-user" }, error: null },
    { user: null, error: denied },
  ]);
  unsubscribe();
  assert.equal(harness.calls.unsubscribed, true);

  await harness.client.signOut();
  assert.deepEqual(harness.calls.signOut, [harness.auth]);
});

test("Firebase auth subscriptions report SDK startup failures and can be cancelled early", async () => {
  let release;
  const firstModule = new Promise((resolve) => {
    release = resolve;
  });
  const startupError = new Error("SDK unavailable");
  const client = createFirebaseClient({
    globalScope: {},
    loadSdk: (() => {
      let call = 0;
      return () => (call++ === 0 ? firstModule : Promise.reject(startupError));
    })(),
  });
  const observed = [];
  const cancel = client.subscribeAuth((user, error) => observed.push({ user, error }));
  cancel();
  release({});
  await assert.rejects(client.ready, startupError);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(observed, []);

  const failedClient = createFirebaseClient({
    globalScope: {},
    loadSdk: () => Promise.reject(startupError),
  });
  const failures = [];
  failedClient.subscribeAuth((user, error) => failures.push({ user, error }));
  await assert.rejects(failedClient.ready, startupError);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(failures, [{ user: null, error: startupError }]);
});

test("worker face templates are validated, team-scoped, listed, replaced, and deleted", async () => {
  const embedding = Array.from({ length: 128 }, (unused, index) => index / 1000);
  const enrollmentViews = [
    embedding,
    embedding.map((value, index) => value + (index === 0 ? 0.05 : 0)),
    embedding.map((value, index) => value + (index === 1 ? 0.05 : 0)),
  ];
  const harness = createHarness({
    documents: [
      {
        id: "WORKER-7",
        data: () => ({ workerId: "WORKER-7", displayName: "Ari Tan", embedding }),
      },
      { id: "broken", data: () => ({ workerId: "../bad", embedding: [] }) },
    ],
  });
  await harness.client.ready;

  const saved = await harness.client.saveWorkerFace({
    workerId: "worker-7",
    displayName: "  Ari   Tan ",
    embedding,
    embeddings: enrollmentViews,
    sampleCount: 3,
  });
  const magnitude = Math.sqrt(embedding.reduce((total, value) => total + value ** 2, 0));
  const normalizedEmbedding = embedding.map((value) => value / magnitude);
  assert.deepEqual(saved, {
    workerId: "WORKER-7",
    displayName: "Ari Tan",
    embedding: normalizedEmbedding,
    embeddings: enrollmentViews.map((view) => {
      const viewMagnitude = Math.sqrt(view.reduce((total, value) => total + value ** 2, 0));
      return view.map((value) => value / viewMagnitude);
    }),
    // No portrait was supplied with this enrollment.
    profilePhoto: null,
  });
  const write = harness.calls.writes[0];
  assert.deepEqual(write.reference.segments.slice(1), ["workers", "WORKER-7"]);
  assert.equal(write.value.ownerId, "user-1");
  assert.equal(write.value.templateType, "face-api-128-flat-gallery");
  assert.equal(write.value.schemaVersion, 3);
  assert.equal(write.value.consentVersion, "worker-face-v1");
  assert.equal(write.value.embedding.length, 128);
  assert.equal(write.value.embeddings, undefined, "the Firestore payload has no nested arrays");
  assert.equal(write.value.embeddingGallery.length, 128 * 3);
  assert.equal(write.value.embeddingCount, 3);
  assert.equal(write.value.embeddingDimensions, 128);
  assert.ok(write.value.embeddingGallery.every(Number.isFinite));
  assert.equal(write.value.sampleCount, 3, "stored metadata preserves the actual sample count");
  assert.deepEqual(write.writeOptions, { merge: true });

  const workers = await harness.client.getWorkerFaces();
  assert.equal(workers.length, 1, "malformed stored templates are ignored");
  assert.equal(workers[0].workerId, "WORKER-7");
  assert.equal(workers[0].embeddings.length, 1, "legacy centroids remain usable as a gallery");
  assert.deepEqual(harness.calls.queries.at(-1).segments.slice(1), ["workers"]);

  await harness.client.deleteWorkerFace("worker-7");
  assert.deepEqual(harness.calls.deleted.at(-1).segments.slice(1), ["workers", "WORKER-7"]);

  await assert.rejects(
    harness.client.saveWorkerFace({ workerId: "bad/id", displayName: "Ari", embedding }),
    /Worker ID/,
  );
  await assert.rejects(
    harness.client.saveWorkerFace({ workerId: "OK", displayName: "Ari", embedding: [1] }),
    /incomplete/,
  );

  harness.auth.currentUser = null;
  await assert.rejects(
    harness.client.getWorkerFaces(),
    (error) => error.code === "auth-required",
  );
});

test("an enrollment portrait is stored as bounded bytes and read back as an image", async () => {
  const harness = createHarness();
  const embedding = Array.from({ length: 128 }, (unused, index) => (index % 7) + 1);
  // A one-pixel JPEG is enough to prove the round trip.
  const portrait =
    "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";

  const saved = await harness.client.saveWorkerFace({
    workerId: "worker-9",
    displayName: "Bo Lim",
    embedding,
    profilePhoto: portrait,
  });
  assert.equal(saved.profilePhoto, portrait);

  const write = harness.calls.writes[0];
  assert.equal(write.value.profilePhotoContentType, "image/jpeg");
  assert.ok(write.value.profilePhotoBytes > 0);
  assert.ok(Array.isArray(write.value.profilePhotoData.bytes));

  // Reading a worker turns those bytes back into something an <img> can show,
  // and a worker enrolled before portraits existed simply has none.
  const reader = createHarness({
    documents: [
      {
        id: "WORKER-9",
        data: () => ({
          workerId: "WORKER-9",
          displayName: "Bo Lim",
          embedding,
          profilePhotoData: write.value.profilePhotoData,
          profilePhotoContentType: "image/jpeg",
        }),
      },
      { id: "WORKER-8", data: () => ({ workerId: "WORKER-8", displayName: "Ari Tan", embedding }) },
    ],
  });
  const [older, worker] = await reader.client.getWorkerFaces();
  assert.equal(worker.profilePhoto, portrait);
  assert.equal(older.profilePhoto, null);

  // Anything that is not a small image is refused rather than stored.
  await assert.rejects(
    harness.client.saveWorkerFace({
      workerId: "WORKER-9",
      displayName: "Bo Lim",
      embedding,
      profilePhoto: "https://example.com/photo.jpg",
    }),
    /JPEG or PNG data URL/,
  );
  await assert.rejects(
    harness.client.saveWorkerFace({
      workerId: "WORKER-9",
      displayName: "Bo Lim",
      embedding,
      profilePhoto: `data:image/jpeg;base64,${"A".repeat(200000)}`,
    }),
    /too large/,
  );
});

test("a flattened Firestore face gallery is rebuilt into matching templates", async () => {
  const first = Array.from({ length: 128 }, (unused, index) => index / 1000);
  const second = first.map((value, index) => value + (index === 0 ? 0.05 : 0));
  const harness = createHarness({
    documents: [
      {
        id: "WORKER-8",
        data: () => ({
          workerId: "WORKER-8",
          displayName: "Bo Lim",
          embedding: first,
          embeddingGallery: [...first, ...second],
          embeddingCount: 2,
          embeddingDimensions: 128,
        }),
      },
    ],
  });
  await harness.client.ready;

  const [worker] = await harness.client.getWorkerFaces();
  assert.equal(worker.workerId, "WORKER-8");
  assert.equal(worker.embeddings.length, 2);
  assert.ok(worker.embeddings.every((template) => template.length === 128));
});

test("matched workers create idempotent daily attendance records that the dashboard can list", async () => {
  const checkedInAtMs = Date.parse("2026-08-14T08:30:00.000Z");
  const harness = createHarness({
    documents: [
      {
        id: "attendance_event_123",
        data: () => ({
          workerId: "WORKER-7",
          displayName: "Ari Tan",
          checkedInAtMs,
          dateKey: "2026-08-14",
          timeZone: "Asia/Singapore",
          location: "10 Marina Bay",
        }),
      },
    ],
  });
  await harness.client.ready;

  const saved = await harness.client.saveAttendance({
    eventId: "attendance_event_123",
    workerId: "worker-7",
    displayName: "  Ari   Tan ",
    checkedInAtMs,
    dateKey: "2026-08-14",
    timeZone: "Asia/Singapore",
    location: "  10   Marina Bay ",
  });
  assert.equal(saved.workerId, "WORKER-7");
  assert.equal(saved.displayName, "Ari Tan");
  assert.equal(saved.location, "10 Marina Bay");
  assert.deepEqual(harness.calls.writes.at(-1).reference.segments.slice(1), [
    "attendanceDays",
    "2026-08-14",
    "entries",
    "attendance_event_123",
  ]);
  assert.equal(harness.calls.writes.at(-1).value.recordedBy, "user-1");
  assert.equal(harness.calls.writes.at(-1).value.status, "present");
  assert.deepEqual(harness.calls.writes.at(-1).writeOptions, { merge: true });

  const entries = await harness.client.getAttendance({
    dateKey: "2026-08-14",
    pageSize: 900,
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].eventId, "attendance_event_123");
  assert.deepEqual(harness.calls.queries.at(-1).collection.segments.slice(1), [
    "attendanceDays",
    "2026-08-14",
    "entries",
  ]);
  assert.deepEqual(harness.calls.queries.at(-1).clauses, [
    { kind: "orderBy", field: "checkedInAtMs", direction: "desc" },
    { kind: "limit", value: 500 },
  ]);

  await harness.client.getAttendance({ pageSize: 25 });
  assert.deepEqual(harness.calls.queries.at(-1).collection, {
    kind: "collectionGroup",
    name: "entries",
  });
  assert.deepEqual(harness.calls.queries.at(-1).clauses, [
    { kind: "orderBy", field: "checkedInAtMs", direction: "desc" },
    { kind: "limit", value: 25 },
  ]);

  await assert.rejects(
    harness.client.saveAttendance({
      eventId: "short",
      workerId: "WORKER-7",
      displayName: "Ari Tan",
      checkedInAtMs,
      dateKey: "2026-08-14",
    }),
    /event ID/,
  );
  await assert.rejects(
    harness.client.getAttendance({ dateKey: "14-08-2026" }),
    /valid date/,
  );

  harness.auth.currentUser = null;
  await assert.rejects(
    harness.client.getAttendance({ dateKey: "2026-08-14" }),
    (error) => error.code === "auth-required",
  );
});

test("dashboard sessions load names and Truck locations and rename in Firestore", async () => {
  const location = "10 Marina Bay";
  const locationKey = cloudData.createLocationKey(location);
  const key = cloudData.createSessionKey({
    locationKey,
    dateKey: "2026-08-14",
    sessionId: "afternoon",
  });
  const morningKey = cloudData.createSessionKey({
    locationKey,
    dateKey: "2026-08-14",
    sessionId: "morning",
  });
  const harness = createHarness({
    queryResults: [
      [
        {
          id: key,
          data: () => ({
            location,
            locationKey,
            dateKey: "2026-08-14",
            sessionId: "afternoon",
            label: "PM site walk",
            truckLocation: { x: 103.8555, y: 1.2868 },
          }),
        },
        {
          id: morningKey,
          data: () => ({
            location,
            locationKey,
            dateKey: "2026-08-14",
            sessionId: "morning",
            truckLocation: { x: 103.8545, y: 1.2867 },
          }),
        },
        { id: "invalid", data: () => ({ label: "Broken" }) },
      ],
    ],
  });
  await harness.client.ready;

  const sessions = await harness.client.getDashboardSessions();
  assert.deepEqual(sessions, [
    {
      key,
      location,
      locationKey,
      dateKey: "2026-08-14",
      sessionId: "afternoon",
      label: "PM site walk",
      truckLocation: { x: 103.8555, y: 1.2868 },
    },
    {
      key: morningKey,
      location,
      locationKey,
      dateKey: "2026-08-14",
      sessionId: "morning",
      label: "",
      truckLocation: { x: 103.8545, y: 1.2867 },
    },
  ]);

  const renamed = await harness.client.renameSession({
    location,
    dateKey: "2026-08-14",
    sessionId: "afternoon",
    label: "  Delivery   window ",
  });
  assert.equal(renamed.label, "Delivery window");
  assert.deepEqual(harness.calls.writes.at(-1).reference.segments.slice(1), [
    "dashboardSessions",
    key,
  ]);
  assert.equal(harness.calls.writes.at(-1).value.renamedBy, "user-1");
  assert.deepEqual(harness.calls.writes.at(-1).writeOptions, { merge: true });
  await assert.rejects(
    harness.client.renameSession({
      location,
      dateKey: "2026-08-14",
      sessionId: "afternoon",
      label: "   ",
    }),
    /between 1 and 60/,
  );
});

test("deleting a dashboard session removes every matching check-in, photo, and custom name", async () => {
  const location = "10 Marina Bay";
  const locationKey = cloudData.createLocationKey(location);
  const afternoon = new Date(2026, 7, 14, 13, 0).getTime();
  const morning = new Date(2026, 7, 14, 9, 0).getTime();
  const harness = createHarness({
    queryResults: [
      [
        { id: "attendance-afternoon", data: () => ({ location, checkedInAtMs: afternoon }) },
        { id: "attendance-morning", data: () => ({ location, checkedInAtMs: morning }) },
        {
          id: "attendance-other-site",
          data: () => ({ location: "Orchard Road", checkedInAtMs: afternoon }),
        },
      ],
      [
        {
          id: "photo-afternoon-doc",
          data: () => ({ id: "photo-afternoon", location, capturedAtMs: afternoon }),
        },
        {
          id: "photo-morning-doc",
          data: () => ({ id: "photo-morning", location, capturedAtMs: morning }),
        },
      ],
    ],
  });
  await harness.client.ready;

  const deleted = await harness.client.deleteSession({
    location,
    locationKey,
    dateKey: "2026-08-14",
    sessionId: "afternoon",
  });
  assert.deepEqual(deleted, {
    attendanceDeleted: 1,
    attendanceEventIds: ["attendance-afternoon"],
    photoDeleted: 1,
    photoIds: ["photo-afternoon"],
  });
  assert.deepEqual(harness.calls.queries[1].clauses, [
    { kind: "where", field: "dateKey", operator: "==", value: "2026-08-14" },
  ]);
  assert.equal(harness.calls.batches.length, 1);
  assert.equal(harness.calls.batches[0].committed, true);
  assert.deepEqual(
    harness.calls.batches[0].deletes.map((reference) => reference.segments.slice(1)),
    [
      ["attendanceDays", "2026-08-14", "entries", "attendance-afternoon"],
      ["users", "user-1", "photos", "photo-afternoon-doc"],
      [
        "dashboardSessions",
        cloudData.createSessionKey({ locationKey, dateKey: "2026-08-14", sessionId: "afternoon" }),
      ],
    ],
  );
});

test("reviewed photos are resized, encoded, and written idempotently to Firestore", async () => {
  const harness = createHarness();
  await harness.client.ready;
  const metadata = await harness.client.uploadReviewedPhoto(reviewedPhoto());

  assert.equal(metadata.ownerId, "user-1");
  assert.equal(harness.calls.createdCanvas.width, 512);
  assert.equal(harness.calls.createdCanvas.height, 256);
  assert.deepEqual(harness.calls.encoding, { type: "image/jpeg", quality: 0.72 });
  assert.deepEqual(harness.calls.revoked, ["blob:firebase-test"]);
  assert.equal(harness.calls.writes.length, 1);
  assert.deepEqual(harness.calls.writes[0].reference.segments, [
    harness.calls.writes[0].reference.segments[0],
    "users",
    "user-1",
    "photos",
    "photo-1",
  ]);
  assert.deepEqual(harness.calls.writes[0].value.imageData.bytes, [1, 2, 3, 4]);
  assert.equal(harness.calls.writes[0].value.imageWidth, 512);
  assert.equal(harness.calls.writes[0].value.imageHeight, 256);
  assert.equal(harness.calls.writes[0].value.uniquePeopleSeen, 5);
  assert.deepEqual(harness.calls.writes[0].value.gpsLocation, {
    latitude: 1.2868,
    longitude: 103.8545,
    accuracyMeters: 12.5,
  });
  assert.equal(Object.hasOwn(harness.calls.writes[0].value, "vehicleCoordinates"), false);
  assert.equal(Object.hasOwn(harness.calls.writes[0].value, "truckLocation"), false);
  assert.deepEqual(harness.calls.writes[0].writeOptions, { merge: true });
});

test("Truck location coordinates are stored once on the dashboard session", async () => {
  const harness = createHarness();
  await harness.client.ready;
  const location = "10 Marina Bay";
  const locationKey = cloudData.createLocationKey(location);
  const session = {
    location,
    locationKey,
    dateKey: "2026-08-14",
    sessionId: "afternoon",
  };
  const key = cloudData.createSessionKey(session);

  const saved = await harness.client.updateSessionTruckLocation(
    session,
    { x: "103.8555", y: 1.2868 },
  );

  assert.equal(saved.key, key);
  assert.deepEqual(saved.truckLocation, { x: 103.8555, y: 1.2868 });
  const write = harness.calls.writes.at(-1);
  assert.deepEqual(write.reference.segments.slice(1), ["dashboardSessions", key]);
  assert.deepEqual(write.value.truckLocation, { x: 103.8555, y: 1.2868 });
  assert.equal(write.value.truckLocationUpdatedBy, "user-1");
  assert.equal(write.value.location, location);
  assert.equal(write.value.locationKey, locationKey);
  assert.equal(write.value.dateKey, "2026-08-14");
  assert.equal(write.value.sessionId, "afternoon");
  assert.deepEqual(write.writeOptions, { merge: true });

  await assert.rejects(
    harness.client.updateSessionTruckLocation(session, { x: "invalid", y: 2 }),
    /longitude/,
  );
  await assert.rejects(
    harness.client.updateSessionTruckLocation(session, { x: 103.8555, y: null }),
    /both truck location coordinates/i,
  );

  const cleared = await harness.client.updateSessionTruckLocation(session, {
    x: null,
    y: null,
  });
  assert.deepEqual(cleared.truckLocation, { x: null, y: null });
  assert.deepEqual(harness.calls.writes.at(-1).value.truckLocation, { x: null, y: null });
});

test("photo upload fails safely before writing incomplete or unencodable records", async () => {
  const signedOut = createHarness({ user: null });
  await signedOut.client.ready;
  await assert.rejects(
    signedOut.client.uploadReviewedPhoto(reviewedPhoto()),
    (error) => error.code === "auth-required",
  );

  const harness = createHarness();
  await harness.client.ready;
  await assert.rejects(harness.client.uploadReviewedPhoto({ blob: new Blob(["image"]) }), /reviewed/);

  harness.scope.StampNoteCloudData = null;
  await assert.rejects(harness.client.uploadReviewedPhoto(reviewedPhoto()), /metadata helpers/);
  harness.scope.StampNoteCloudData = cloudData;

  harness.setImageFailure(true);
  await assert.rejects(harness.client.uploadReviewedPhoto(reviewedPhoto()), /prepared for Firestore/);
  assert.deepEqual(harness.calls.revoked, ["blob:firebase-test"]);

  harness.setImageFailure(false);
  harness.setEncodeFailure(true);
  await assert.rejects(harness.client.uploadReviewedPhoto(reviewedPhoto()), /could not be encoded/);
  assert.equal(harness.calls.writes.length, 0);
});

test("cloud photo pagination clamps page size and preserves the Firestore cursor", async () => {
  const harness = createHarness({ snapshotSize: 100 });
  await harness.client.ready;
  const cursor = { id: "cursor" };
  const page = await harness.client.getPhotosPage({ pageSize: 1000, after: cursor });

  assert.equal(page.photos[0].documentId, "firestore-1");
  assert.equal(page.photos[0].id, "photo-1");
  assert.equal(page.after.id, "firestore-2");
  assert.equal(page.hasMore, true);
  assert.deepEqual(harness.calls.queries[0].collection.segments, [
    harness.calls.queries[0].collection.segments[0],
    "users",
    "user-1",
    "photos",
  ]);
  assert.deepEqual(harness.calls.queries[0].clauses, [
    { kind: "orderBy", field: "capturedAtMs", direction: "desc" },
    { kind: "startAfter", value: cursor },
    { kind: "limit", value: 100 },
  ]);

  await harness.client.getPhotosPage({ pageSize: -10 });
  assert.deepEqual(harness.calls.queries[1].clauses.at(-1), { kind: "limit", value: 1 });

  harness.auth.currentUser = null;
  await assert.rejects(
    harness.client.getPhotosPage(),
    (error) => error.code === "auth-required",
  );
});

test("cloud photos can be opened and deleted only while authenticated", async () => {
  const harness = createHarness();
  await harness.client.ready;

  const blob = await harness.client.getPhotoBlob({
    imageData: { toUint8Array: () => Uint8Array.of(7, 8, 9) },
    imageContentType: "image/webp",
  });
  assert.equal(blob.type, "image/webp");
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [7, 8, 9]);

  await harness.client.deleteReviewedPhoto({ id: "photo-9" });
  assert.deepEqual(harness.calls.deleted[0].segments, [
    harness.calls.deleted[0].segments[0],
    "users",
    "user-1",
    "photos",
    "photo-9",
  ]);
  await assert.rejects(harness.client.deleteReviewedPhoto({}), /no ID/);
  await assert.rejects(harness.client.getPhotoBlob({}), /no image data/);

  harness.auth.currentUser = null;
  await assert.rejects(
    harness.client.deleteReviewedPhoto({ id: "photo-9" }),
    (error) => error.code === "auth-required",
  );
  await assert.rejects(
    harness.client.getPhotoBlob({}),
    (error) => error.code === "auth-required",
  );
});
