const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const appPath = resolve(__dirname, "..", "app.js");

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.className = "";
    this.dataset = {};
    this.disabled = false;
    this.files = null;
    this.hidden = false;
    this.listeners = new Map();
    this.textContent = "";
    this.value = "";
    this.classList = {
      values: new Set(),
      add: (...names) => names.forEach((name) => this.classList.values.add(name)),
      remove: (...names) => names.forEach((name) => this.classList.values.delete(name)),
      contains: (name) => this.classList.values.has(name),
    };
  }

  get childElementCount() {
    return this.children.length;
  }

  addEventListener(name, callback) {
    const callbacks = this.listeners.get(name) || [];
    callbacks.push(callback);
    this.listeners.set(name, callbacks);
  }

  append(...children) {
    children.forEach((child) => {
      this.children.push(child);
      if (child && typeof child === "object") child.parentElement = this;
    });
  }

  async dispatch(name, event = {}) {
    const callbacks = this.listeners.get(name) || [];
    for (const callback of callbacks) {
      await callback({ target: this, ...event });
    }
  }

  click() {
    this.clicks = (this.clicks || 0) + 1;
  }

  focus() {
    this.focused = true;
  }

  querySelector(selector) {
    return selector === ".hint" ? this.hint || null : null;
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === "src") this.src = "";
  }

  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  toggleAttribute(name, force) {
    if (force) this.attributes.set(name, "");
    else this.attributes.delete(name);
  }
}

class FakeCanvas extends FakeElement {
  constructor() {
    super("canvas");
    this.height = 0;
    this.width = 0;
    this.calls = [];
    const calls = this.calls;
    this.context = new Proxy(
      {
        getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
        measureText: (text) => ({ width: String(text).length * 6 }),
      },
      {
        get(target, property) {
          if (!(property in target)) {
            target[property] = (...args) => {
              calls.push({ method: property, args });
            };
          }
          return target[property];
        },
      },
    );
  }

  getContext() {
    return this.context;
  }

  toBlob(callback, type = "image/jpeg") {
    callback(new Blob(["encoded photo"], { type }));
  }

  toDataURL() {
    return "data:image/jpeg;base64,c3RhbXBlZA==";
  }
}

class FakeFile extends Blob {
  constructor(parts, name, options = {}) {
    super(parts, options);
    this.name = name;
    this.lastModified = options.lastModified || Date.now();
  }
}

function usageFor(records, isAiFlagged) {
  const active = records.filter((record) => !isAiFlagged(record));
  const discarded = records.filter(isAiFlagged);
  return {
    active: active.length,
    bytes: records.reduce((total, record) => total + (record.blob?.size || 0), 0),
    count: records.length,
    discarded: discarded.length,
    needsReview: discarded.filter((record) => record.aiReview?.action === "review").length,
  };
}

function createAppHarness(options = {}) {
  const ids = [
    "address-field",
    "location-status",
    "address-panel",
    "previews",
    "share-button",
    "location-diagnostics",
    "location-diagnostics-body",
    "gallery-input",
    "monitor-frame",
    "monitor-video",
    "monitor-toggle",
    "monitor-toggle-name",
    "monitor-icon-start",
    "monitor-icon-stop",
    "monitor-status",
    "capture-flash",
    "pose-overlay",
    "pose-badge",
    "face-enrollment",
    "face-enrollment-kicker",
    "face-enrollment-title",
    "face-enrollment-message",
    "face-enrollment-match",
    "face-enrollment-worker-id",
    "face-enrollment-progress",
    "face-enrollment-count",
    "face-enrollment-skip",
    "captures",
    "captures-summary",
    "captures-save",
    "captures-clear",
    "ai-review",
    "ai-review-bin",
    "ai-review-purge",
    "ai-review-loader",
    "ai-review-loader-title",
    "ai-review-loader-detail",
    "cloud-auth",
    "admin-dashboard",
    "stage-empty",
    "filmstrip",
    "place-toggle",
    "viewer",
    "viewer-image",
    "viewer-ai-review",
    "viewer-restore",
    "viewer-share",
    "viewer-delete",
    "viewer-close",
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  elements["address-panel"].hidden = true;
  elements["monitor-frame"].hidden = true;
  elements["face-enrollment"].hidden = true;
  elements["face-enrollment-match"].hidden = true;
  elements["ai-review-loader"].hidden = true;
  elements.viewer.hidden = true;
  elements["monitor-video"].readyState = 4;
  elements["monitor-video"].videoHeight = 720;
  elements["monitor-video"].videoWidth = 1280;
  elements["monitor-video"].play = async () => {};
  elements["pose-overlay"] = new FakeCanvas();
  elements["captures-save"].hint = new FakeElement("span");
  elements["ai-review-bin"].hint = new FakeElement("span");
  elements["cloud-auth"].hint = new FakeElement("span");

  const body = new FakeElement("body");
  const documentListeners = new Map();
  const document = {
    body,
    hidden: false,
    addEventListener(name, callback) {
      documentListeners.set(name, callback);
    },
    createElement(name) {
      return name === "canvas" ? new FakeCanvas() : new FakeElement(name);
    },
    querySelector(selector) {
      return elements[selector.slice(1)] || null;
    },
  };

  const events = [];
  const telemetry = {
    configure(configuration) {
      this.configuration = configuration;
    },
    createTraceId() {
      return "capture-trace-123";
    },
    event(name, fields, eventOptions) {
      events.push({ name, fields, options: eventOptions });
    },
    safeErrorCode(error, fallback = "unknown_error") {
      return String(error?.code || error?.name || fallback)
        .toLowerCase()
        .replace(/[^a-z0-9_./:-]/g, "_");
    },
  };

  const cache = new Map();
  const serviceCalls = { coordinates: 0, reverse: 0 };
  const service = {
    createCacheKey(latitude, longitude) {
      return `address:${latitude}:${longitude}`;
    },
    describeEnvironment() {
      return "secure=true; permission=granted";
    },
    describeGeolocationError(error) {
      return error ? "Location unavailable." : "A secure page is required.";
    },
    async getCurrentCoordinates() {
      serviceCalls.coordinates += 1;
      return { latitude: 1.2868, longitude: 103.8545 };
    },
    async getPermissionState() {
      return options.permission || "granted";
    },
    isInAppBrowser() {
      return false;
    },
    async reverseGeocode() {
      serviceCalls.reverse += 1;
      return { address: "10 Marina Boulevard" };
    },
  };

  const stampedCanvases = [];
  const stampedInputs = [];
  const stamp = {
    drawStampedImage(input) {
      const canvas = new FakeCanvas();
      stampedInputs.push(input);
      stampedCanvases.push(canvas);
      return canvas;
    },
  };

  const records = [...(options.records || [])];
  const storeCalls = { marked: [], removed: [], reviews: [] };
  const isAiFlagged = (record) =>
    record?.aiReview?.recommendation === "discard" || record?.aiReview?.action === "discard";
  const store = {
    async applyAiReviews(decisions, reviewOptions) {
      storeCalls.reviews.push({ decisions, options: reviewOptions });
      decisions.forEach((decision) => {
        const record = records.find((entry) => entry.id === decision.id);
        if (record) {
          record.aiReview = decision;
          record.status = "local";
        }
      });
    },
    async clear() {
      records.length = 0;
    },
    isPersistent() {
      return true;
    },
    async list() {
      return [...records];
    },
    async listActive() {
      return records.filter((record) => !isAiFlagged(record));
    },
    async listDiscarded() {
      return records.filter(isAiFlagged);
    },
    async listPending() {
      return records.filter((record) => record.status === "local");
    },
    async markSynced(id) {
      storeCalls.marked.push(id);
      const record = records.find((entry) => entry.id === id);
      if (record) record.status = "synced";
    },
    async purgeAiDiscarded() {
      for (let index = records.length - 1; index >= 0; index -= 1) {
        if (isAiFlagged(records[index])) records.splice(index, 1);
      }
    },
    async ready() {
      if (options.storeError) throw options.storeError;
    },
    async remove(id) {
      storeCalls.removed.push(id);
      const index = records.findIndex((entry) => entry.id === id);
      if (index >= 0) records.splice(index, 1);
    },
    async restoreAiDiscard(id) {
      const record = records.find((entry) => entry.id === id);
      if (record) record.aiReview = { ...record.aiReview, action: "keep", recommendation: "keep" };
    },
    async usage(current) {
      return usageFor(current, isAiFlagged);
    },
  };
  const storage = {
    createPhotoStore() {
      return store;
    },
    formatBytes(bytes) {
      return `${bytes} B`;
    },
    isAiFlagged,
    selectAiReviewBatch() {
      return [];
    },
  };

  let authCallback;
  const cloudCalls = { deleted: [], signIn: 0, signOut: 0, uploaded: [] };
  const cloud = options.cloud
    ? {
        async deleteReviewedPhoto(record) {
          cloudCalls.deleted.push(record.id);
        },
        async signIn() {
          cloudCalls.signIn += 1;
        },
        async signOut() {
          cloudCalls.signOut += 1;
        },
        subscribeAuth(callback) {
          authCallback = callback;
          return () => {};
        },
        async uploadReviewedPhoto(record) {
          cloudCalls.uploaded.push(record.id);
          if (options.uploadError) throw options.uploadError;
        },
        ...(Array.isArray(options.workerFaces)
          ? {
              async getWorkerFaces() {
                return options.workerFaces;
              },
            }
          : {}),
      }
    : null;

  const controllerState = {
    activityStarted: !options.faceEnrollment,
    captures: 0,
    faceEnrollment: options.faceEnrollment
      ? { required: true, status: "move_closer", samples: 0, total: 5, progress: 0 }
      : null,
    lastRecord: null,
    running: false,
  };
  let captureConfiguration;
  let faceIdentityOptions;
  let personTrackerOptions;
  let cameraConstraints;
  let detectorClosed = false;
  let trackStopped = false;
  const controller = {
    getState() {
      return controllerState;
    },
    setPaused(paused) {
      controllerState.paused = paused;
    },
    start() {
      controllerState.running = true;
      captureConfiguration?.onUpdate?.({ ...controllerState });
    },
    stop() {
      controllerState.running = false;
    },
    skipFaceEnrollment() {
      controllerState.activityStarted = true;
      controllerState.faceEnrollment = {
        ...controllerState.faceEnrollment,
        required: false,
        status: "skipped",
      };
      captureConfiguration?.onUpdate?.({ ...controllerState });
      return controllerState;
    },
    async tick() {
      if (options.tickCapture && controllerState.captures === 0) {
        controllerState.captures = 1;
        controllerState.lastRecord = { id: "gesture-1", trigger: "gesture" };
      }
      return controllerState;
    },
  };
  const detector = {
    kind: "model",
    wantsVideo: true,
    close() {
      detectorClosed = true;
    },
  };
  const pose = {
    createPoseDetector() {
      return { kind: "builtin", wantsVideo: false };
    },
    createPoseTracker() {
      return {};
    },
  };
  const schedule = { createCaptureScheduler: () => ({}) };
  const autoCapture = {
    SAMPLE_INTERVAL: 250,
    createAutoCapture(configuration) {
      captureConfiguration = configuration;
      return controller;
    },
    describeCadence() {
      return "Person in frame · next photo in 30s";
    },
  };

  const timers = [];
  const animationFrames = [];
  const fetchRequests = [];
  const objectUrls = [];
  const revoked = [];
  const shared = [];
  const windowListeners = new Map();
  let confirmCalls = 0;
  let timerId = 0;
  const scope = {
    StampNoteAddress: service,
    StampNoteAutoCapture: options.full === false ? null : autoCapture,
    StampNoteFirebase: cloud,
    StampNoteFaceIdentity: options.faceEnrollment
      ? {
          createFaceIdentity(configuration) {
            faceIdentityOptions = configuration;
            return {
              async load() {},
              enrollmentState() {
                return controllerState.faceEnrollment;
              },
            };
          },
        }
      : null,
    StampNotePersonTracker: options.faceEnrollment
      ? {
          createPersonTracker(configuration) {
            personTrackerOptions = configuration;
            return {};
          },
        }
      : null,
    StampNoteModel:
      options.full === false
        ? null
        : {
            async load() {
              if (options.modelError) throw options.modelError;
              return detector;
            },
          },
    StampNoteObservability: telemetry,
    StampNotePose: options.full === false ? null : pose,
    StampNoteSchedule: options.full === false ? null : schedule,
    StampNoteStamp: stamp,
    StampNoteStore: options.full === false ? null : storage,
    StampNoteTriage: {},
    addEventListener(name, callback) {
      windowListeners.set(name, callback);
    },
    cancelAnimationFrame(id) {
      const frame = animationFrames.find((entry) => entry.id === id);
      if (frame) frame.cancelled = true;
    },
    clearTimeout(id) {
      const timer = timers.find((entry) => entry.id === id);
      if (timer) timer.cancelled = true;
    },
    confirm() {
      confirmCalls += 1;
      return options.confirm !== false;
    },
    isSecureContext: options.secure !== false,
    location: { hostname: "stampnote.example", port: "" },
    matchMedia() {
      return { matches: false };
    },
    requestAnimationFrame(callback) {
      const id = animationFrames.length + 1;
      animationFrames.push({ callback, id });
      return id;
    },
    sessionStorage: {
      getItem(key) {
        return cache.get(key) || null;
      },
      setItem(key, value) {
        cache.set(key, value);
      },
    },
    setTimeout(callback, delay) {
      timerId += 1;
      timers.push({ callback, delay, id: timerId });
      return timerId;
    },
  };
  scope.self = scope;
  scope.top = scope;

  class FakeImage extends FakeElement {
    constructor() {
      super("img");
      this.naturalHeight = 600;
      this.naturalWidth = 800;
    }

    set src(value) {
      this._src = value;
      queueMicrotask(() => this.dispatch(options.imageError ? "error" : "load"));
    }

    get src() {
      return this._src || "";
    }
  }

  class FakeFileReader {
    constructor() {
      this.listeners = new Map();
      this.result = null;
    }

    addEventListener(name, callback) {
      this.listeners.set(name, callback);
    }

    readAsDataURL(blob) {
      this.result = `data:${blob.type || "application/octet-stream"};base64,cmV2aWV3`;
      queueMicrotask(() => this.listeners.get("load")?.());
    }
  }

  const navigator = {
    canShare: options.canShare === false ? () => false : () => true,
    geolocation: {},
    language: "en-SG",
    maxTouchPoints: 0,
    onLine: true,
    permissions: {},
    share: async (payload) => {
      shared.push(payload);
      if (options.shareError) throw options.shareError;
    },
    userAgent: "StampNote test browser",
  };
  if (options.camera) {
    navigator.mediaDevices = {
      async getUserMedia(constraints) {
        cameraConstraints = constraints;
        if (options.cameraError) throw options.cameraError;
        return {
          getTracks() {
            return [{ stop: () => { trackStopped = true; } }];
          },
        };
      },
    };
  }

  let clock = 100;
  const performance = {
    now() {
      clock += 5;
      return clock;
    },
  };
  const urlApi = {
    createObjectURL(blob) {
      const url = `blob:stampnote-${objectUrls.length + 1}`;
      objectUrls.push({ blob, url });
      return url;
    },
    revokeObjectURL(url) {
      revoked.push(url);
    },
  };
  const context = vm.createContext({
    Blob,
    Date,
    File: FakeFile,
    FileReader: FakeFileReader,
    Image: FakeImage,
    URL: urlApi,
    Uint8ClampedArray,
    console,
    document,
    fetch: async (url, requestOptions) => {
      fetchRequests.push({ url, options: requestOptions });
      return options.fetchResponse || { ok: true, json: async () => ({ decisions: [] }) };
    },
    navigator,
    performance,
    window: scope,
  });
  scope.document = document;
  scope.navigator = navigator;
  scope.performance = performance;

  vm.runInContext(readFileSync(appPath, "utf8"), context, { filename: appPath });

  return {
    auth(user, error = null) {
      authCallback?.(user, error);
    },
    cloudCalls,
    get confirmCalls() {
      return confirmCalls;
    },
    controllerState,
    documentListeners,
    elements,
    events,
    fetchRequests,
    get captureConfiguration() {
      return captureConfiguration;
    },
    get cameraConstraints() {
      return cameraConstraints;
    },
    get detectorClosed() {
      return detectorClosed;
    },
    get faceIdentityOptions() {
      return faceIdentityOptions;
    },
    objectUrls,
    get personTrackerOptions() {
      return personTrackerOptions;
    },
    records,
    revoked,
    serviceCalls,
    shared,
    stampedCanvases,
    stampedInputs,
    storeCalls,
    timers,
    get trackStopped() {
      return trackStopped;
    },
    windowListeners,
  };
}

async function settle(turns = 4) {
  for (let index = 0; index < turns; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("manual uploads are located, stamped, saved, and shared by the browser entrypoint", async () => {
  const harness = createAppHarness({ full: false });
  const upload = new FakeFile(["photo"], "garden.png", {
    lastModified: Date.parse("2026-08-13T12:00:00Z"),
    type: "image/png",
  });
  harness.elements["gallery-input"].files = [upload];

  await harness.elements["gallery-input"].dispatch("change");
  await settle();

  assert.equal(harness.elements["address-panel"].hidden, false);
  assert.equal(harness.elements["address-field"].value, "10 Marina Boulevard");
  assert.equal(harness.elements.previews.childElementCount, 1);
  assert.equal(harness.elements.filmstrip.hidden, false);
  assert.equal(harness.serviceCalls.coordinates, 1);
  assert.equal(harness.serviceCalls.reverse, 1);
  assert.ok(harness.stampedCanvases.length >= 2);

  const saveTimer = harness.timers.findLast((timer) => timer.delay === 1500 && !timer.cancelled);
  assert.ok(saveTimer);
  await saveTimer.callback();
  await settle();
  assert.equal(harness.elements["location-status"].textContent, "Saved.");
  assert.equal(harness.elements["location-status"].dataset.state, "success");
  assert.equal(harness.objectUrls.at(-1).blob.name, "stamped-1-garden.jpg");

  await harness.elements["share-button"].dispatch("click");
  assert.equal(harness.shared.length, 1);
  assert.equal(harness.shared[0].files[0].name, "stamped-1-garden.jpg");
});

test("capture-library initialization syncs reviewed photos and supports viewer deletion", async () => {
  const record = {
    aiReview: { action: "keep", confidence: 0.97, reason: "Clear scene.", recommendation: "keep" },
    blob: new Blob(["capture"], { type: "image/jpeg" }),
    capturedAt: "2026-08-13T12:00:00.000Z",
    id: "capture-1",
    name: "capture-1.jpg",
    poseDetected: true,
    status: "local",
    trigger: "schedule",
    type: "image/jpeg",
  };
  const harness = createAppHarness({ cloud: true, records: [record] });
  await settle();

  assert.equal(harness.elements["monitor-toggle"].dataset.running, "false");
  assert.equal(harness.elements.captures.childElementCount, 1);
  assert.match(harness.elements["captures-summary"].textContent, /1 photo kept on this device/);
  assert.ok(harness.events.some((event) => event.name === "capture.store.ready"));

  harness.auth({ email: "owner@example.com", uid: "owner-1" });
  await settle(8);
  assert.deepEqual(harness.cloudCalls.uploaded, ["capture-1"]);
  assert.deepEqual(harness.storeCalls.marked, ["capture-1"]);
  assert.equal(record.status, "synced");
  assert.equal(harness.elements["cloud-auth"].dataset.signedIn, "true");
  assert.equal(harness.elements["admin-dashboard"].hidden, false);

  await harness.elements.captures.children[0].dispatch("click");
  assert.equal(harness.elements.viewer.hidden, false);
  assert.match(harness.elements["viewer-ai-review"].textContent, /97% confidence/);
  await harness.elements["viewer-share"].dispatch("click");
  assert.equal(harness.shared.at(-1).files[0].name, "capture-1.jpg");

  await harness.elements["viewer-delete"].dispatch("click");
  await settle();
  assert.deepEqual(harness.cloudCalls.deleted, ["capture-1"]);
  assert.deepEqual(harness.storeCalls.removed, ["capture-1"]);
  assert.equal(harness.elements.captures.childElementCount, 0);

  await harness.elements["cloud-auth"].dispatch("click");
  assert.equal(harness.cloudCalls.signOut, 1);
  assert.ok(harness.events.some((event) => event.name === "cloud.sync.completed"));
});

test("manual AI review prepares compact copies, persists decisions, and keeps flags recoverable", async () => {
  const records = [
    {
      blob: new Blob(["first capture"], { type: "image/jpeg" }),
      capturedAt: "2026-08-13T12:00:00.000Z",
      capturedAtMs: Date.parse("2026-08-13T12:00:00.000Z"),
      id: "review-1",
      name: "review-1.jpg",
      poseDetected: true,
      status: "local",
      trigger: "schedule",
      type: "image/jpeg",
    },
    {
      blob: new Blob(["second capture"], { type: "image/jpeg" }),
      capturedAt: "2026-08-13T12:00:30.000Z",
      capturedAtMs: Date.parse("2026-08-13T12:00:30.000Z"),
      id: "review-2",
      name: "review-2.jpg",
      poseDetected: false,
      status: "local",
      trigger: "schedule",
      type: "image/jpeg",
    },
  ];
  const decisions = [
    {
      action: "keep",
      confidence: 0.98,
      id: "review-1",
      reason: "Useful context.",
      recommendation: "keep",
    },
    {
      action: "review",
      confidence: 0.72,
      id: "review-2",
      reason: "Possibly redundant.",
      recommendation: "discard",
    },
  ];
  let finishReview;
  const pendingReview = new Promise((resolve) => {
    finishReview = resolve;
  });
  const harness = createAppHarness({
    fetchResponse: pendingReview,
    records,
  });
  await settle();
  assert.equal(harness.elements["ai-review"].hidden, false);

  const reviewPromise = harness.elements["ai-review"].dispatch("click");
  await settle(6);

  assert.equal(harness.elements["ai-review-loader"].hidden, false);
  assert.equal(harness.elements["ai-review-loader"].attributes.get("aria-busy"), "true");
  assert.equal(harness.elements["ai-review-loader-title"].textContent, "Gemini is reviewing");
  assert.match(harness.elements["ai-review-loader-detail"].textContent, /photos 1–2 of 2/i);

  finishReview({
      ok: true,
      async json() {
        return { decisions, model: "gemini-test" };
      },
  });
  await reviewPromise;
  await settle(6);

  assert.equal(harness.elements["ai-review-loader"].hidden, true);
  assert.equal(harness.elements["ai-review-loader"].attributes.get("aria-busy"), "false");
  assert.equal(harness.fetchRequests.length, 1);
  assert.equal(harness.fetchRequests[0].url, "/api/triage");
  const request = JSON.parse(harness.fetchRequests[0].options.body);
  assert.deepEqual(request.images.map((image) => image.id), ["review-1", "review-2"]);
  assert.ok(request.images.every((image) => image.dataUrl.startsWith("data:image/jpeg;base64,")));
  assert.deepEqual(JSON.parse(JSON.stringify(harness.storeCalls.reviews)), [
    { decisions, options: { model: "gemini-test" } },
  ]);
  assert.equal(records[0].aiReview.action, "keep");
  assert.equal(records[1].aiReview.action, "review");
  assert.match(harness.elements["monitor-status"].textContent, /1 flagged photo/);
  assert.match(harness.elements["monitor-status"].textContent, /queued/);
  assert.equal(harness.elements["ai-review-bin"].hidden, false);
  assert.ok(harness.events.some((event) => event.name === "ai.review.started"));
  assert.ok(harness.events.some((event) => event.name === "ai.review.completed"));
});

test("the live monitor starts and stops cleanly, and unsupported cameras fail observably", async () => {
  const harness = createAppHarness({ camera: true, tickCapture: true });
  await settle();
  await harness.elements["monitor-toggle"].dispatch("click");
  await settle(8);

  assert.equal(harness.controllerState.running, true);
  assert.equal(harness.confirmCalls, 0, "recording should start without a blocking dialog");
  assert.equal(harness.elements["monitor-toggle"].dataset.running, "true");
  assert.equal(harness.elements["monitor-toggle"].attributes.get("aria-pressed"), "true");
  assert.equal(harness.elements["monitor-frame"].hidden, false);
  assert.equal(harness.elements["stage-empty"].hidden, true);
  assert.equal(harness.captureConfiguration.detector.kind, "model");
  assert.ok(harness.events.some((event) => event.name === "capture.monitor.started"));
  assert.ok(harness.events.some((event) => event.name === "capture.saved"));

  const capture = await harness.captureConfiguration.captureImage({
    bodies: [
      {
        box: { x: 0.1, y: 0.2, width: 0.3, height: 0.5 },
        personId: 7,
        workerId: "WORKER-007",
        personLabel: "Ari Tan",
      },
    ],
  });
  assert.equal(capture.blob.type, "image/jpeg");
  const savedInput = harness.stampedInputs.at(-1);
  assert.ok(savedInput.calls.some((call) => call.method === "strokeRect"));
  assert.ok(
    savedInput.calls.some(
      (call) => call.method === "fillText" && call.args[0] === "WORKER-007",
    ),
  );

  await harness.elements["monitor-toggle"].dispatch("click");
  assert.equal(harness.controllerState.running, false);
  assert.equal(harness.elements["monitor-toggle"].dataset.running, "false");
  assert.equal(harness.trackStopped, true);
  assert.equal(harness.detectorClosed, true);
  assert.match(harness.elements["monitor-status"].textContent, /Auto capture stopped/);

  const unsupported = createAppHarness();
  await settle();
  await unsupported.elements["monitor-toggle"].dispatch("click");
  await settle();
  assert.match(unsupported.elements["monitor-status"].textContent, /cannot open a live camera/);
  assert.ok(
    unsupported.events.some(
      (event) =>
        event.name === "capture.monitor.failed" && event.fields.errorCode === "camera_unsupported",
    ),
  );
});

test("the live camera prompts for attendance taking before the activity starts", async () => {
  const harness = createAppHarness({ camera: true, faceEnrollment: true });
  await settle();
  await harness.elements["monitor-toggle"].dispatch("click");
  await settle(8);

  assert.equal(harness.elements["face-enrollment"].hidden, false);
  assert.equal(
    harness.elements["face-enrollment-title"].textContent,
    "Attendance taking",
  );
  assert.match(harness.elements["face-enrollment-message"].textContent, /Move closer/i);
  assert.equal(harness.elements["face-enrollment-progress"].value, 0);
  assert.equal(harness.elements["face-enrollment-count"].textContent, "0 of 5");
  assert.equal(harness.cameraConstraints.video.width.ideal, 1920);
  assert.equal(harness.cameraConstraints.video.height.ideal, 1080);
  assert.match(harness.elements["monitor-status"].textContent, /before auto capture begins/i);

  harness.controllerState.faceEnrollment = {
    required: true,
    status: "not_recognized",
    samples: 5,
    total: 5,
    matchDistance: 0.71,
    matchVotes: 3,
    requiredVotes: 4,
    matchReason: "insufficient_consensus",
  };
  harness.captureConfiguration.onUpdate({ ...harness.controllerState });
  const failedMatch = harness.events.find((event) => event.name === "face.match.failed");
  assert.deepEqual(JSON.parse(JSON.stringify(failedMatch.fields)), {
    errorCode: "insufficient_consensus",
    matchDistance: 0.71,
    matchVotes: 3,
    requiredVotes: 4,
    sampleCount: 5,
    status: "failed",
  });

  await harness.elements["face-enrollment-skip"].dispatch("click");
  assert.equal(harness.controllerState.activityStarted, true);
  assert.equal(harness.elements["face-enrollment"].hidden, true);
  assert.match(harness.elements["monitor-status"].textContent, /match skipped/i);
  assert.ok(harness.events.some((event) => event.name === "face.match.skipped"));
});

test("recording loads enrolled face templates into both matching layers", async () => {
  const embedding = Array.from({ length: 128 }, (unused, index) => index / 1000);
  const workers = [{ workerId: "WORKER-7", displayName: "Ari Tan", embedding }];
  const harness = createAppHarness({
    camera: true,
    cloud: true,
    faceEnrollment: true,
    workerFaces: workers,
  });
  await settle();
  await harness.elements["monitor-toggle"].dispatch("click");
  await settle(8);

  assert.deepEqual(harness.faceIdentityOptions.knownIdentities, workers);
  assert.deepEqual(harness.personTrackerOptions.identities, workers);
  assert.match(harness.elements["monitor-status"].textContent, /attendance taking/i);

  harness.controllerState.activityStarted = true;
  harness.controllerState.faceEnrollment = {
    required: true,
    status: "complete",
    samples: 5,
    total: 5,
    workerId: "WORKER-7",
    personLabel: "Ari Tan",
    matchDistance: 0.38,
    matchVotes: 5,
    requiredVotes: 4,
  };
  harness.captureConfiguration.onUpdate({ ...harness.controllerState });
  const completed = harness.events.find((event) => event.name === "face.match.completed");
  assert.equal(completed.fields.matchVotes, 5);
  assert.equal(completed.fields.matchDistance, 0.38);
  assert.equal(Object.hasOwn(completed.fields, "workerId"), false);
  assert.equal(harness.elements["face-enrollment"].hidden, false);
  assert.equal(harness.elements["face-enrollment"].dataset.status, "complete");
  assert.equal(harness.elements["face-enrollment-kicker"].textContent, "Attendance confirmed");
  assert.equal(harness.elements["face-enrollment-title"].textContent, "Attendance recorded");
  assert.equal(harness.elements["face-enrollment-match"].hidden, false);
  assert.equal(harness.elements["face-enrollment-worker-id"].textContent, "WORKER-7");
  assert.match(harness.elements["face-enrollment-message"].textContent, /Ari Tan is ready/i);

  const confirmationTimer = harness.timers.find((timer) => timer.delay === 1_800);
  assert.ok(confirmationTimer, "the matched identity remains prominent before fading");
  confirmationTimer.callback();
  assert.equal(harness.elements["face-enrollment"].hidden, true);
});
