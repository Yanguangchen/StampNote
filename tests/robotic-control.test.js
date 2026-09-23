const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const cameraFacing = require("../camera-facing.js");
const captureCamera = require("../src/capture/camera-controller.js");
const root = resolve(__dirname, "..");
const html = readFileSync(resolve(root, "robotic-control.html"), "utf8");
const css = readFileSync(resolve(root, "robotic-control.css"), "utf8");
const source = readFileSync(resolve(root, "robotic-control.js"), "utf8");
const server = readFileSync(resolve(root, "server.js"), "utf8");

function settle(times = 4) {
  return [...Array(times)].reduce(
    (promise) => promise.then(() => new Promise((resolve) => setImmediate(resolve))),
    Promise.resolve(),
  );
}

test("robotic control is a dedicated full-page camera without MediaPipe", () => {
  assert.match(html, /<html lang="en" data-surface="robotic-control">/);
  assert.match(html, /<title>Robotic control · StampNote<\/title>/);
  assert.match(html, /<h1 id="robotic-title" class="visually-hidden">Robotic control<\/h1>/);
  assert.match(html, /id="robotic-video"[^>]*playsinline[^>]*muted[^>]*autoplay/);
  assert.match(html, /id="robotic-incoming-audio"[^>]*autoplay[^>]*playsinline/);
  assert.match(html, /id="robotic-speaker-toggle"/);
  assert.match(html, /id="robotic-incoming-audio-notice"/);
  assert.match(source, /function streamIncomingAudio\(/);
  assert.match(source, /StampNoteRoboticControl/);
  assert.match(html, /id="robotic-toggle"/);
  assert.match(html, /id="robotic-auth"/);
  assert.match(html, /id="camera-facing-toggle"/);
  assert.match(html, /id="camera-loader"/);
  assert.match(html, /<link rel="stylesheet" href="sidebar\.css" \/>/);
  assert.match(html, /<script src="sidebar\.js" defer><\/script>/);
  assert.match(html, /<header[^>]*data-sidebar-mount/);
  assert.match(html, /class="sign-out-icon"/);
  assert.match(html, /src\/capture\/camera-controller\.js/);
  assert.match(html, /src\/services\/live-tunnel\.js/);
  assert.doesNotMatch(html, /pose-model|computer-vision|auto-capture|pose-overlay|face-enrollment|mediapipe/i);
  assert.doesNotMatch(html, /id="monitor-toggle"|id="gallery-input"|id="captures-save"/);
  assert.match(css, /\.monitor video\s*\{[^}]*object-fit:\s*cover/);
  assert.match(css, /\.stage\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0/);
  assert.match(server, /"robotic-control\.html",\s*\n\s*"robotic-control\.css",\s*\n\s*"robotic-control\.js",/);
});

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = String(tagName).toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.className = "";
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.textContent = "";
    this.srcObject = null;
    this.muted = false;
    this.listeners = new Map();
    this.hint = null;
    this.signInIcon = null;
    this.signOutIcon = null;
  }

  addEventListener(name, callback) {
    this.listeners.set(name, callback);
  }

  querySelector(selector) {
    if (selector === ".hint") return this.hint;
    if (selector === ".sign-in-icon") return this.signInIcon;
    if (selector === ".sign-out-icon") return this.signOutIcon;
    return null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  toggleAttribute(name, force) {
    if (force) this.attributes.set(name, "");
    else this.attributes.delete(name);
  }

  async dispatch(name, event = {}) {
    return this.listeners.get(name)?.({ preventDefault() {}, target: this, ...event });
  }

  play() {
    return Promise.resolve();
  }

  pause() {}
}

function createHarness(options = {}) {
  const ids = [
    "robotic-video",
    "robotic-frame",
    "robotic-toggle",
    "robotic-icon-start",
    "robotic-icon-stop",
    "robotic-status",
    "camera-facing-toggle",
    "camera-facing-name",
    "camera-loader",
    "camera-loader-detail",
    "robotic-auth",
    "live-voice-notice",
    "robotic-incoming-audio",
    "robotic-incoming-audio-notice",
    "robotic-speaker-toggle",
    "robotic-speaker-name",
    "theme-toggle",
    "theme-toggle-icon",
    "theme-toggle-label",
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  elements["robotic-frame"].hidden = true;
  elements["camera-loader"].hidden = true;
  elements["live-voice-notice"].hidden = true;
  elements["robotic-incoming-audio-notice"].hidden = true;
  elements["robotic-auth"].hint = new FakeElement("span");
  elements["robotic-auth"].signInIcon = new FakeElement("svg");
  elements["robotic-auth"].signOutIcon = new FakeElement("svg");
  elements["robotic-auth"].signOutIcon.hidden = true;
  elements["robotic-video"].play = async () => {};

  const body = new FakeElement("body");
  body.dataset = { stage: "idle" };
  const documentElement = { dataset: {} };
  const documentListeners = new Map();
  const windowListeners = new Map();
  const events = [];
  const cameraStorage = new Map(Object.entries(options.storedFacing || {}));
  const themeStorage = new Map(options.theme ? [["stampnote-theme", options.theme]] : []);
  let authCallback;
  const cloudCalls = { liveTunnels: [], signIn: 0, signOut: 0 };
  const publishers = [];
  const publisherOptions = [];
  let cameraConstraints;
  let nextCameraError = null;
  let trackStopped = false;
  let clock = 100;

  const facingStorage = {
    getItem(key) {
      return cameraStorage.has(key) ? cameraStorage.get(key) : null;
    },
    setItem(key, value) {
      cameraStorage.set(key, value);
    },
  };

  const cloud = options.cloud
    ? {
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
      }
    : null;

  const liveTunnel = {
    createPublisher(options) {
      publisherOptions.push(options);
      const publisher = {
        async publish(session) {
          cloudCalls.liveTunnels.push({ type: "publish", session });
          if (options.liveTunnelError) throw options.liveTunnelError;
          return { id: "live-1", ...session };
        },
        setStream() {
          cloudCalls.liveTunnels.push({ type: "setStream" });
        },
        close() {
          cloudCalls.liveTunnels.push({ type: "end" });
        },
      };
      publishers.push(publisher);
      return publisher;
    },
    voiceMessageToBlob() {
      return options.voiceBlob || null;
    },
  };

  const document = {
    body,
    documentElement,
    hidden: false,
    addEventListener(name, callback) {
      documentListeners.set(name, callback);
    },
    querySelector(selector) {
      return elements[selector.replace(/^#/, "")] || null;
    },
  };

  const navigator = {
    userAgent: "StampNote test browser",
    maxTouchPoints: 0,
  };
  if (options.camera !== false) {
    navigator.mediaDevices = {
      async getUserMedia(constraints) {
        cameraConstraints = constraints;
        const injected = nextCameraError;
        nextCameraError = null;
        if (injected) throw injected;
        if (options.cameraError) throw options.cameraError;
        return {
          getTracks() {
            return [
              {
                stop() {
                  trackStopped = true;
                },
              },
            ];
          },
          getVideoTracks() {
            return [{ readyState: "live", stop() {} }];
          },
        };
      },
    };
  }

  const context = {
    Audio: options.Audio,
    URL: {
      createObjectURL() {
        return "blob:robotic-1";
      },
      revokeObjectURL() {},
    },
    StampNoteCameraFacing: {
      ...cameraFacing,
      createPreference: (preferenceOptions) =>
        cameraFacing.createPreference({ storage: facingStorage, ...preferenceOptions }),
    },
    StampNoteCaptureCamera: captureCamera,
    StampNoteFirebase: cloud,
    StampNoteLiveTunnel: liveTunnel,
    StampNoteCloudData: {
      sessionDefinitionFor() {
        return { id: "morning", label: "Morning" };
      },
      createDateKey() {
        return "2026-09-19";
      },
    },
    StampNoteObservability: {
      configure(configuration) {
        this.configuration = configuration;
      },
      event(name, fields, eventOptions) {
        events.push({ name, fields, options: eventOptions });
      },
      safeErrorCode(error, fallback = "unknown_error") {
        return String(error?.code || error?.name || fallback)
          .toLowerCase()
          .replace(/[^a-z0-9_./:-]/g, "_");
      },
    },
    addEventListener(name, callback) {
      windowListeners.set(name, callback);
    },
    ...(options.globals || {}),
    console,
    document,
    isSecureContext: options.secure !== false,
    localStorage: {
      getItem(key) {
        return themeStorage.has(key) ? themeStorage.get(key) : null;
      },
      setItem(key, value) {
        themeStorage.set(key, value);
      },
    },
    matchMedia() {
      return { matches: options.dark === true };
    },
    navigator,
    performance: {
      now() {
        clock += 5;
        return clock;
      },
    },
  };
  context.window = context;
  context.self = context;
  context.top = context;
  context.globalThis = context;

  vm.createContext(context);
  vm.runInContext(source, context, { filename: resolve(root, "robotic-control.js") });

  return {
    auth(user, error = null) {
      authCallback?.(user, error);
    },
    cameraConstraints: () => cameraConstraints,
    cloudCalls,
    publisherOptions,
    api: context.StampNoteRoboticControl,
    documentListeners,
    elements,
    events,
    failNextCamera(error) {
      nextCameraError = error;
    },
    storedFacing() {
      return cameraStorage.get("stampnote-robotic-control-camera-facing") || null;
    },
    telemetry: context.StampNoteObservability,
    trackStopped: () => trackStopped,
    windowListeners,
  };
}

test("opening robotic control starts the camera without a tap", async () => {
  assert.match(source, /initializeCloud\(\);\s*startStream\(\);/);
  const harness = createHarness({ camera: true });
  await settle();

  assert.equal(harness.elements["robotic-toggle"].dataset.running, "true");
  assert.equal(harness.elements["robotic-toggle"].getAttribute("aria-pressed"), "true");
  assert.equal(harness.elements["robotic-frame"].hidden, false);
  assert.ok(harness.elements["robotic-video"].srcObject);
  assert.match(harness.elements["robotic-status"].textContent, /Streaming video/);
});

test("starting the camera fills the page and does not load computer vision", async () => {
  const harness = createHarness({ camera: true });
  await settle();

  assert.equal(harness.telemetry.configuration.surface, "robotic-control");
  assert.equal(harness.elements["robotic-toggle"].dataset.running, "true");
  assert.equal(harness.elements["robotic-toggle"].getAttribute("aria-pressed"), "true");
  assert.equal(harness.elements["robotic-frame"].hidden, false);
  assert.ok(harness.elements["robotic-video"].srcObject);
  assert.match(harness.elements["robotic-status"].textContent, /Streaming video/);
  assert.ok(harness.events.some((event) => event.name === "capture.monitor.started"));
  assert.equal(
    harness.events.find((event) => event.name === "capture.monitor.started").fields.vision,
    false,
  );
  assert.equal(harness.cloudCalls.liveTunnels.length, 0);

  await harness.elements["robotic-toggle"].dispatch("click");
  await settle();
  assert.equal(harness.elements["robotic-toggle"].dataset.running, "false");
  assert.equal(harness.elements["robotic-frame"].hidden, true);
  assert.equal(harness.elements["robotic-video"].srcObject, null);
  assert.equal(harness.trackStopped(), true);
});

test("an unsupported or denied camera fails observably", async () => {
  const missing = createHarness({ camera: false });
  await settle();
  assert.match(missing.elements["robotic-status"].textContent, /cannot open a live camera/i);
  assert.ok(
    missing.events.some(
      (event) => event.name === "capture.monitor.failed" && event.fields.errorCode === "camera_unsupported",
    ),
  );

  const denied = createHarness({
    camera: true,
    cameraError: Object.assign(new Error("denied"), { name: "NotAllowedError" }),
  });
  await settle();
  assert.match(denied.elements["robotic-status"].textContent, /permission was denied/i);
  assert.equal(denied.elements["robotic-frame"].hidden, true);
});

test("the lens switch remembers the robotic-control camera and swaps a live stream", async () => {
  const harness = createHarness({ camera: true, cloud: true });
  await settle();
  assert.equal(harness.elements["camera-facing-name"].textContent, "Back");
  assert.equal(harness.elements["camera-facing-toggle"].dataset.facing, "environment");

  await harness.elements["camera-facing-toggle"].dispatch("click");
  await settle();
  assert.equal(harness.elements["camera-facing-name"].textContent, "Front");
  assert.equal(harness.storedFacing(), "user");
  assert.ok(harness.events.some((event) => event.name === "capture.camera.facing"));

  harness.auth({ email: "owner@example.com", uid: "owner-1" });
  await settle();

  await harness.elements["camera-facing-toggle"].dispatch("click");
  await settle();
  assert.equal(harness.elements["camera-facing-name"].textContent, "Back");
  assert.match(JSON.stringify(harness.cameraConstraints()), /environment/);
  assert.ok(harness.cloudCalls.liveTunnels.some((entry) => entry.type === "setStream"));
});

test("a signed-in stream publishes Live tunnel as Robotic control", async () => {
  const harness = createHarness({ camera: true, cloud: true });
  harness.auth({ email: "owner@example.com", uid: "owner-1" });
  await settle();

  const published = harness.cloudCalls.liveTunnels.find((entry) => entry.type === "publish");
  assert.ok(published);
  assert.equal(published.session.location, "Robotic control");
  assert.equal(published.session.sessionLabel, "Robotic control");
  assert.match(harness.elements["robotic-status"].textContent, /Live tunnel/);

  await harness.elements["robotic-toggle"].dispatch("click");
  await settle();
  assert.ok(harness.cloudCalls.liveTunnels.some((entry) => entry.type === "end"));
});

test("signing in after the stream is already running starts the live tunnel", async () => {
  const harness = createHarness({ camera: true, cloud: true });
  await settle();
  assert.equal(harness.cloudCalls.liveTunnels.length, 0);

  harness.auth({ email: "owner@example.com", uid: "owner-1" });
  await settle();
  assert.ok(harness.cloudCalls.liveTunnels.some((entry) => entry.type === "publish"));
});

test("streamIncomingAudio plays live talk audio on robotic control", async () => {
  const harness = createHarness({ camera: true, cloud: true });
  harness.auth({ email: "owner@example.com", uid: "owner-1" });
  await settle();

  assert.equal(typeof harness.api.streamIncomingAudio, "function");
  assert.equal(typeof harness.publisherOptions[0].onAudioStream, "function");
  assert.equal(harness.publisherOptions[0].onAudioStream, harness.api.streamIncomingAudio);

  const track = { kind: "audio", id: "talk" };
  const media = { getAudioTracks: () => [track], getTracks: () => [track] };
  assert.equal(harness.api.streamIncomingAudio(media), media);
  assert.equal(harness.elements["robotic-incoming-audio"].srcObject, media);
  assert.equal(harness.elements["robotic-incoming-audio"].muted, false);
  assert.equal(harness.elements["robotic-incoming-audio-notice"].hidden, false);
  assert.match(harness.elements["robotic-incoming-audio-notice"].textContent, /Live audio in/);
  assert.equal(harness.elements["robotic-speaker-toggle"].dataset.live, "true");
  assert.equal(harness.elements["robotic-speaker-toggle"].getAttribute("aria-pressed"), "true");
  assert.ok(harness.events.some((event) => event.name === "live_tunnel.audio.in"));

  await harness.elements["robotic-speaker-toggle"].dispatch("click");
  assert.equal(harness.elements["robotic-incoming-audio"].muted, true);
  assert.equal(harness.elements["robotic-speaker-toggle"].getAttribute("aria-pressed"), "false");

  await harness.elements["robotic-speaker-toggle"].dispatch("click");
  assert.equal(harness.elements["robotic-incoming-audio"].muted, false);

  assert.equal(harness.api.streamIncomingAudio(null), null);
  assert.equal(harness.elements["robotic-incoming-audio"].srcObject, null);
  assert.equal(harness.elements["robotic-incoming-audio-notice"].hidden, true);
  assert.equal(harness.elements["robotic-speaker-toggle"].dataset.live, "false");
});

test("blocked live talk audio starts on the next tap anywhere on the page", async () => {
  const harness = createHarness({ camera: true, cloud: true });
  harness.auth({ email: "owner@example.com", uid: "owner-1" });
  await settle();

  const audio = harness.elements["robotic-incoming-audio"];
  let blocked = true;
  audio.play = () =>
    blocked
      ? Promise.reject(Object.assign(new Error("gesture"), { name: "NotAllowedError" }))
      : Promise.resolve();

  const track = { kind: "audio", id: "talk" };
  harness.api.streamIncomingAudio({ getAudioTracks: () => [track], getTracks: () => [track] });
  await settle();
  assert.equal(audio.muted, true);
  assert.match(harness.elements["robotic-incoming-audio-notice"].textContent, /Tap anywhere/);

  blocked = false;
  // A touchscreen pointerdown is not a user gesture; touchend is.
  assert.equal(harness.documentListeners.has("pointerdown"), false);
  await harness.documentListeners.get("touchend")({ target: harness.elements["robotic-frame"] });
  await settle();
  assert.equal(audio.muted, false);
  assert.equal(harness.elements["robotic-speaker-toggle"].getAttribute("aria-pressed"), "true");
  assert.match(harness.elements["robotic-incoming-audio-notice"].textContent, /Live audio in/);
});

test("a voice message blocked by autoplay waits for a tap instead of being dropped", async () => {
  const players = [];
  let blocked = true;
  class FakeAudio {
    constructor() {
      this.src = "";
      this.plays = 0;
      players.push(this);
    }
    addEventListener() {}
    play() {
      this.plays += 1;
      return blocked
        ? Promise.reject(Object.assign(new Error("gesture"), { name: "NotAllowedError" }))
        : Promise.resolve();
    }
  }
  const harness = createHarness({
    camera: true,
    cloud: true,
    voiceBlob: { size: 3, type: "audio/webm" },
    globals: {
      Audio: FakeAudio,
      URL: { createObjectURL: () => "blob:voice-1", revokeObjectURL() {} },
    },
  });
  harness.auth({ email: "owner@example.com", uid: "owner-1" });
  await settle();

  harness.publisherOptions[0].onVoiceMessage({ type: "voice-message", audio: "AAA" });
  await settle();
  const notice = harness.elements["live-voice-notice"];
  assert.equal(notice.hidden, false);
  assert.match(notice.textContent, /tap anywhere to play/i);
  assert.equal(players.length, 1);
  assert.equal(players[0].src, "blob:voice-1");

  blocked = false;
  await harness.documentListeners.get("click")({ target: harness.elements["robotic-frame"] });
  await settle();
  assert.equal(players.length, 1, "the same player is reused after the tap");
  assert.equal(players[0].plays, 2);
  assert.match(notice.textContent, /Playing a voice message/);
});
