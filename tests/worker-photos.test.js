const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const storage = require("../photo-store.js");
const workerPhotos = require("../worker-photos.js");
const root = resolve(__dirname, "..");
const workerPhotosPath = resolve(root, "worker-photos.js");
const html = readFileSync(resolve(root, "worker-photos.html"), "utf8");
const css = readFileSync(resolve(root, "worker-photos.css"), "utf8");
const source = readFileSync(workerPhotosPath, "utf8");

test("the worker page offers separate camera and multi-photo library inputs", () => {
  assert.match(html, /id="take-photo"[\s\S]*capture="environment"/);
  assert.match(html, /id="choose-photos"[\s\S]*multiple/);
  assert.match(html, /id="worker-photo-send"[^>]*disabled>Send<\/button>/);
  assert.doesNotMatch(html, /Recent worker photos|Latest photo details|worker-photo-grid/);
  assert.doesNotMatch(html, /Ready\. Location access is requested/);
});

test("the page opens on the two buttons rather than on a paragraph about them", () => {
  // The eyebrow and the standfirst went entirely; the stamp's contents are
  // learned from the first photo rather than promised above the button.
  assert.doesNotMatch(html, /No recording needed/);
  assert.doesNotMatch(html, /Take one now or choose existing/);
  assert.doesNotMatch(html, /current GPS,[\s\S]*weather/);
  assert.doesNotMatch(html, /class="eyebrow"|class="intro-copy"/);
  assert.doesNotMatch(css, /\.eyebrow|\.intro-copy/);

  // The title is not drawn, but the page still has one, and the buttons below
  // are still named by it.
  assert.match(html, /<h1 class="visually-hidden" id="worker-photo-title">Add a site photo<\/h1>/);
  assert.match(html, /class="action-card" aria-labelledby="worker-photo-title"/);
  assert.match(css, /\.visually-hidden\s*\{[\s\S]*?clip: rect\(0, 0, 0, 0\)/);

  // Two buttons, each an icon and its name. Nothing explains them further.
  assert.match(html, />Take photo</);
  assert.match(html, />Choose from gallery</);
  assert.doesNotMatch(html, /Choose how to add it/);
  assert.doesNotMatch(html, /Open the rear camera|Select one or several/);
  assert.equal((html.match(/class="photo-action["\s]/g) || []).length, 2);
  // Send is not one of them: it appears once a photo has been chosen.
  assert.match(source, /sendButton\.hidden = staged\.length === 0;/);
});

test("every selected batch gets a fresh GPS fix and weather before it becomes sendable", () => {
  assert.match(source, /maximumAge:\s*0/);
  assert.match(source, /fetchDayWeather/);
  assert.match(source, /reverseGeocode/);
  assert.match(source, /await readCaptureContext\(date\)/);
  assert.match(source, /createCaptureRecord\(\{[\s\S]*gpsLocation:[\s\S]*weather:/);
  assert.match(source, /trigger:\s*"worker"/);
  assert.match(source, /source,/);
});

test("Send runs Gemini sanitization before local persistence or cloud upload", () => {
  const sendStart = source.indexOf("async function sendStagedPhotos");
  const sendEnd = source.indexOf('takeInput.addEventListener("change"', sendStart);
  const sendFlow = source.slice(sendStart, sendEnd);
  assert.ok(sendStart > 0);
  assert.ok(sendFlow.indexOf("requestGeminiSanitization(staged)") < sendFlow.indexOf("store.save({"));
  assert.ok(sendFlow.indexOf("store.applyAiReviews") < sendFlow.indexOf("uploadRecord(record)"));
  assert.match(source, /!storage\.isAiFlagged\(record\)/);
  assert.match(source, /sendButton\.addEventListener\("click", sendStagedPhotos\)/);
});

test("a weather outage is recorded rather than blocking field photos", () => {
  const weather = workerPhotos.unavailableWeather(1234);
  assert.equal(weather.severity, "unknown");
  assert.equal(weather.condition, "Weather unavailable");
  assert.equal(weather.recordedAtMs, 1234);
  assert.equal(workerPhotos.describeWeather(weather), "Weather unavailable");
  assert.equal(
    workerPhotos.describeWeather({
      severity: "wet",
      condition: "Rain",
      temperatureC: 27,
      precipitationMm: 4.2,
    }),
    "Rain · 27 °C · 4.2 mm rain",
  );
});

test("coordinates provide a stable address fallback and the page supports dark mode", () => {
  assert.equal(
    workerPhotos.fallbackAddress({ latitude: 1.2868, longitude: 103.8545 }),
    "1.28680, 103.85450",
  );
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  assert.match(html, /theme-color[^>]*prefers-color-scheme: dark/);
});

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.dataset = {};
    this.disabled = false;
    this.files = null;
    this.hidden = false;
    this.listeners = new Map();
    this.textContent = "";
    this.value = "";
  }

  addEventListener(name, callback) {
    this.listeners.set(name, callback);
  }

  append(...children) {
    this.children.push(...children);
  }

  async dispatch(name, event = {}) {
    return this.listeners.get(name)?.({ target: this, ...event });
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
}

class FakeCanvas extends FakeElement {
  constructor() {
    super("canvas");
    this.height = 0;
    this.width = 0;
  }

  getContext() {
    return {
      drawImage() {},
    };
  }

  toBlob(callback, type = "image/jpeg") {
    callback(new Blob(["stamped"], { type }));
  }
}

class FakeFile extends Blob {
  constructor(parts, name, options = {}) {
    super(parts, options);
    this.name = name;
    this.lastModified = options.lastModified || Date.now();
  }
}

function createWorkerPhotosHarness(options = {}) {
  const ids = [
    "photo-actions",
    "take-photo",
    "choose-photos",
    "worker-photo-status",
    "worker-photo-status-text",
    "worker-photo-send",
    "worker-photo-auth",
    "worker-photo-account",
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  elements["worker-photo-send"].hidden = true;
  elements["worker-photo-send"].disabled = true;
  elements["worker-photo-status"].hidden = true;

  const records = [...(options.records || [])];
  const storeCalls = { saved: [], marked: [], reviews: [] };
  const store = {
    async applyAiReviews(decisions, reviewOptions) {
      storeCalls.reviews.push({ decisions, options: reviewOptions });
      return decisions.map((decision) => {
        const record = records.find((entry) => entry.id === decision.id) || { id: decision.id };
        const updated = { ...record, aiReview: decision };
        const index = records.findIndex((entry) => entry.id === decision.id);
        if (index >= 0) records[index] = updated;
        return updated;
      });
    },
    async listPending() {
      return records.filter((record) => record.status === "local");
    },
    async markSynced(id) {
      storeCalls.marked.push(id);
      const record = records.find((entry) => entry.id === id);
      if (record) record.status = "synced";
    },
    async ready() {
      if (options.storeError) throw options.storeError;
    },
    async save(input) {
      const record = storage.createCaptureRecord(input);
      records.push(record);
      storeCalls.saved.push(record);
      return record;
    },
  };

  let authCallback;
  const cloudCalls = { uploaded: [], signIn: 0, signOut: 0 };
  const cloud = options.cloud
    ? {
        async signIn() {
          cloudCalls.signIn += 1;
          if (options.signInError) throw options.signInError;
        },
        async signOut() {
          cloudCalls.signOut += 1;
        },
        subscribeAuth(callback) {
          authCallback = callback;
          return () => {};
        },
        async uploadWorkerPhoto(record) {
          cloudCalls.uploaded.push(record.id);
          if (options.uploadError) throw options.uploadError;
        },
      }
    : null;

  const addressCalls = { coordinates: 0, reverse: 0 };
  const address = {
    describeGeolocationError(error) {
      return error?.message || "Location unavailable.";
    },
    async getCurrentCoordinates() {
      addressCalls.coordinates += 1;
      if (options.gpsError) throw options.gpsError;
      return { latitude: 1.2868, longitude: 103.8545, accuracyMeters: 12 };
    },
    async reverseGeocode() {
      addressCalls.reverse += 1;
      if (options.addressError) throw options.addressError;
      return { address: "10 Marina Boulevard" };
    },
  };

  const weather = {
    async fetchDayWeather() {
      if (options.weatherError) throw options.weatherError;
      return [{ hour: 12, precipitationMm: 0, temperatureC: 31, condition: "Fair" }];
    },
    summarizeSessionWeather() {
      return {
        severity: "fine",
        condition: "Fair",
        precipitationMm: 0,
        temperatureC: 31,
        wetHours: 0,
        hours: 1,
      };
    },
  };

  const stamped = [];
  const stamp = {
    drawStampedImage(image, stampOptions) {
      stamped.push({ image, options: stampOptions });
      return new FakeCanvas();
    },
  };

  const fetchRequests = [];
  class FakeImage {
    constructor() {
      this.naturalHeight = 600;
      this.naturalWidth = 800;
    }

    set src(value) {
      this._src = value;
      queueMicrotask(() => {
        if (options.imageError) this.onerror?.();
        else this.onload?.();
      });
    }

    get src() {
      return this._src || "";
    }
  }

  class FakeFileReader {
    constructor() {
      this.listeners = new Map();
      this.result = null;
      this.error = null;
    }

    addEventListener(name, callback) {
      this.listeners.set(name, callback);
    }

    readAsDataURL() {
      if (options.readerError) {
        this.error = options.readerError;
        queueMicrotask(() => this.listeners.get("error")?.());
        return;
      }
      this.result = "data:image/jpeg;base64,cmV2aWV3";
      queueMicrotask(() => this.listeners.get("load")?.());
    }
  }

  const scope = {
    StampNoteAddress: address,
    StampNoteFirebase: cloud,
    StampNoteStamp: stamp,
    StampNoteStore: {
      createCaptureRecord: storage.createCaptureRecord,
      createPhotoStore() {
        return store;
      },
      isAiFlagged: storage.isAiFlagged,
    },
    StampNoteWeather: weather,
    console,
    document: {
      createElement(name) {
        return name === "canvas" ? new FakeCanvas() : new FakeElement(name);
      },
      querySelector(selector) {
        return elements[selector.replace(/^#/, "")] || null;
      },
    },
    fetch: async (url, request) => {
      fetchRequests.push({ url, options: request });
      if (options.fetchResponse) return options.fetchResponse(request);
      const body = JSON.parse(request.body);
      return {
        ok: true,
        json: async () => ({
          model: "gemini-test",
          decisions: (body.images || []).map((image) => ({
            id: image.id,
            action: "keep",
            recommendation: "keep",
            confidence: 0.94,
            reason: "Useful site photo.",
          })),
        }),
      };
    },
    isSecureContext: true,
    location: { hostname: options.hostname || "stampnote.example", port: options.port || "" },
    navigator: {
      geolocation: {},
      maxTouchPoints: 0,
      standalone: false,
      userAgent: "StampNote test browser",
    },
    URL: {
      createObjectURL() {
        return "blob:worker-photo";
      },
      revokeObjectURL() {},
    },
  };
  scope.window = scope;
  scope.self = scope;
  scope.top = scope;

  const context = vm.createContext({
    Blob,
    FileReader: FakeFileReader,
    Image: FakeImage,
    URL: scope.URL,
    console,
    document: scope.document,
    fetch: scope.fetch,
    navigator: scope.navigator,
    window: scope,
    globalThis: scope,
  });
  Object.assign(context, {
    StampNoteAddress: address,
    StampNoteFirebase: cloud,
    StampNoteStamp: stamp,
    StampNoteStore: scope.StampNoteStore,
    StampNoteWeather: weather,
  });

  vm.runInContext(source, context, { filename: workerPhotosPath });

  return {
    addressCalls,
    auth(user, error = null) {
      authCallback?.(user, error);
    },
    cloudCalls,
    elements,
    fetchRequests,
    records,
    stamped,
    storeCalls,
  };
}

async function settle(turns = 6) {
  for (let index = 0; index < turns; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("a chosen photo is stamped with a fresh GPS fix before Send appears", async () => {
  const harness = createWorkerPhotosHarness();
  const file = new FakeFile(["site"], "site.jpg", { type: "image/jpeg" });
  harness.elements["take-photo"].files = [file];

  await harness.elements["take-photo"].dispatch("change");
  await settle();

  assert.equal(harness.addressCalls.coordinates, 1);
  assert.equal(harness.addressCalls.reverse, 1);
  assert.equal(harness.stamped.length, 1);
  assert.equal(harness.stamped[0].options.address, "10 Marina Boulevard");
  assert.equal(harness.elements["worker-photo-send"].hidden, false);
  assert.equal(harness.elements["worker-photo-send"].disabled, false);
  assert.match(harness.elements["worker-photo-status-text"].textContent, /GPS and weather are attached/);
  assert.equal(harness.elements["worker-photo-status"].dataset.state, "success");

  await harness.elements["worker-photo-send"].dispatch("click");
  await settle();
  assert.equal(harness.storeCalls.saved.length, 1);
  assert.match(
    harness.elements["worker-photo-status-text"].textContent,
    /sanitized and saved on this device/,
  );
});

test("a weather or address outage still stages the photo, and a GPS refusal does not", async () => {
  const weatherDown = createWorkerPhotosHarness({
    weatherError: new Error("forecast unavailable"),
    addressError: new Error("geocoder unavailable"),
  });
  weatherDown.elements["choose-photos"].files = [
    new FakeFile(["site"], "site.jpg", { type: "image/jpeg" }),
  ];
  await weatherDown.elements["choose-photos"].dispatch("change");
  await settle();
  assert.match(
    weatherDown.elements["worker-photo-status-text"].textContent,
    /weather unavailability is recorded/,
  );
  assert.equal(weatherDown.stamped[0].options.address, "1.28680, 103.85450");
  assert.equal(weatherDown.elements["worker-photo-send"].hidden, false);

  const gpsDenied = createWorkerPhotosHarness({
    gpsError: Object.assign(new Error("User denied Geolocation"), { code: 1 }),
  });
  gpsDenied.elements["take-photo"].files = [
    new FakeFile(["site"], "site.jpg", { type: "image/jpeg" }),
  ];
  await gpsDenied.elements["take-photo"].dispatch("change");
  await settle();
  assert.match(gpsDenied.elements["worker-photo-status-text"].textContent, /User denied Geolocation/);
  assert.equal(gpsDenied.elements["worker-photo-send"].hidden, true);
  assert.equal(gpsDenied.stamped.length, 0);

  const unreadable = createWorkerPhotosHarness({ imageError: true });
  unreadable.elements["take-photo"].files = [
    new FakeFile(["broken"], "broken.jpg", { type: "image/jpeg" }),
  ];
  await unreadable.elements["take-photo"].dispatch("change");
  await settle();
  assert.match(unreadable.elements["worker-photo-status-text"].textContent, /could not be opened/);
});

test("Send sanitizes, saves locally, and uploads only accepted photos", async () => {
  const harness = createWorkerPhotosHarness({ cloud: true });
  harness.elements["take-photo"].files = [
    new FakeFile(["keep"], "keep.jpg", { type: "image/jpeg" }),
    new FakeFile(["hold"], "hold.jpg", { type: "image/jpeg" }),
    new FakeFile(["notes.txt"], "notes.txt", { type: "text/plain" }),
  ];

  await harness.elements["take-photo"].dispatch("change");
  await settle();
  assert.match(harness.elements["worker-photo-status-text"].textContent, /2 photos are ready/);

  const stagedHarness = createWorkerPhotosHarness({
    cloud: true,
    fetchResponse(request) {
      const body = JSON.parse(request.body);
      return {
        ok: true,
        json: async () => ({
          model: "gemini-test",
          decisions: body.images.map((image, index) => ({
            id: image.id,
            action: index === 0 ? "keep" : "discard",
            recommendation: index === 0 ? "keep" : "discard",
            confidence: 0.91,
            reason: index === 0 ? "Useful." : "Not a site photo.",
          })),
        }),
      };
    },
  });
  stagedHarness.elements["choose-photos"].files = [
    new FakeFile(["keep"], "keep.jpg", { type: "image/jpeg" }),
    new FakeFile(["hold"], "hold.jpg", { type: "image/jpeg" }),
  ];
  await stagedHarness.elements["choose-photos"].dispatch("change");
  await settle();
  stagedHarness.auth({ email: "owner@example.com", uid: "owner-1" });
  await settle();
  await stagedHarness.elements["worker-photo-send"].dispatch("click");
  await settle();

  assert.equal(stagedHarness.storeCalls.saved.length, 2);
  assert.equal(stagedHarness.cloudCalls.uploaded.length, 1);
  assert.match(stagedHarness.elements["worker-photo-status-text"].textContent, /1 sent/);
  assert.match(stagedHarness.elements["worker-photo-status-text"].textContent, /1 held back/);
  assert.equal(stagedHarness.elements["worker-photo-send"].hidden, true);

  const uploadFailed = createWorkerPhotosHarness({
    cloud: true,
    uploadError: new Error("Quota exceeded."),
  });
  uploadFailed.elements["take-photo"].files = [
    new FakeFile(["site"], "site.jpg", { type: "image/jpeg" }),
  ];
  await uploadFailed.elements["take-photo"].dispatch("change");
  await settle();
  uploadFailed.auth({ email: "owner@example.com", uid: "owner-1" });
  await settle();
  await uploadFailed.elements["worker-photo-send"].dispatch("click");
  await settle();
  assert.match(uploadFailed.elements["worker-photo-status-text"].textContent, /kept on device to retry/);
});

test("Gemini failures and a missing store leave the batch unsent", async () => {
  const failed = createWorkerPhotosHarness({
    fetchResponse: async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: "Gemini is busy." }),
    }),
  });
  failed.elements["take-photo"].files = [new FakeFile(["site"], "site.jpg", { type: "image/jpeg" })];
  await failed.elements["take-photo"].dispatch("change");
  await settle();
  await failed.elements["worker-photo-send"].dispatch("click");
  await settle();
  assert.match(failed.elements["worker-photo-status-text"].textContent, /Gemini is busy/);
  assert.match(failed.elements["worker-photo-status-text"].textContent, /Nothing was sent/);
  assert.equal(failed.storeCalls.saved.length, 0);

  const incomplete = createWorkerPhotosHarness({
    fetchResponse: async () => ({
      ok: true,
      json: async () => ({ decisions: null }),
    }),
  });
  incomplete.elements["take-photo"].files = [
    new FakeFile(["site"], "site.jpg", { type: "image/jpeg" }),
  ];
  await incomplete.elements["take-photo"].dispatch("change");
  await settle();
  await incomplete.elements["worker-photo-send"].dispatch("click");
  await settle();
  assert.match(incomplete.elements["worker-photo-status-text"].textContent, /incomplete result/);

  const storeDown = createWorkerPhotosHarness({
    storeError: new Error("IndexedDB refused the open."),
  });
  await settle();
  assert.match(
    storeDown.elements["worker-photo-status-text"].textContent,
    /IndexedDB refused the open/,
  );
});

test("sign-in syncs pending worker photos and a refused login stays on the page", async () => {
  const pending = storage.createCaptureRecord({
    blob: new Blob(["pending"], { type: "image/jpeg" }),
    date: new Date("2026-08-14T13:00:00.000Z"),
    address: "10 Marina Boulevard",
    trigger: "worker",
    source: "camera",
  });
  pending.status = "local";
  pending.aiReview = { action: "keep", recommendation: "keep", confidence: 0.9, reason: "Useful." };

  const harness = createWorkerPhotosHarness({ cloud: true, records: [pending] });
  harness.auth({ email: "owner@example.com", uid: "owner-1" });
  await settle();
  assert.deepEqual(harness.cloudCalls.uploaded, [pending.id]);
  assert.deepEqual(harness.storeCalls.marked, [pending.id]);
  assert.match(harness.elements["worker-photo-status-text"].textContent, /1 sanitized photo synced/);
  assert.equal(harness.elements["worker-photo-account"].textContent, "owner@example.com");
  assert.equal(harness.elements["worker-photo-auth"].textContent, "Sign out");

  await harness.elements["worker-photo-auth"].dispatch("click");
  await settle();
  assert.equal(harness.cloudCalls.signOut, 1);

  const leftover = { ...pending, id: "pending-retry", status: "local" };
  const retry = createWorkerPhotosHarness({
    cloud: true,
    records: [leftover],
    uploadError: new Error("Quota exceeded."),
  });
  retry.auth({ email: "owner@example.com", uid: "owner-1" });
  await settle();
  assert.deepEqual(retry.cloudCalls.uploaded, ["pending-retry"]);
  assert.deepEqual(retry.storeCalls.marked, []);
  assert.equal(leftover.status, "local");

  const refused = createWorkerPhotosHarness({
    cloud: true,
    signInError: new Error("Popup closed."),
  });
  await refused.elements["worker-photo-auth"].dispatch("click");
  await settle();
  assert.match(refused.elements["worker-photo-status-text"].textContent, /Popup closed/);

  const offline = createWorkerPhotosHarness();
  assert.equal(offline.elements["worker-photo-auth"].hidden, true);

  const authError = createWorkerPhotosHarness({ cloud: true });
  authError.auth(null, new Error("Google sign-in is unavailable."));
  assert.match(
    authError.elements["worker-photo-status-text"].textContent,
    /Google sign-in is unavailable/,
  );
  assert.equal(authError.elements["worker-photo-account"].textContent, "Photos save on this device");
});
