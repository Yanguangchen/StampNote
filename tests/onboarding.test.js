const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const root = resolve(__dirname, "..");
const html = readFileSync(resolve(root, "onboarding.html"), "utf8");
const css = readFileSync(resolve(root, "onboarding.css"), "utf8");
const app = readFileSync(resolve(root, "onboarding.js"), "utf8");

test("worker onboarding has signed-in identity, scan, and roster controls", () => {
  assert.match(html, /id="onboarding-auth"/);
  assert.match(html, /id="onboarding-auth-icon"/);
  assert.match(html, /id="onboarding-auth-label">Sign in with Google</);
  assert.match(app, /authButton\.classList\.toggle\("sign-out", signedIn\)/);
  assert.match(html, /id="worker-id"/);
  assert.match(html, /id="worker-name"/);
  assert.equal(/id="worker-consent"|type="checkbox"/.test(html), false);
  assert.match(html, /id="onboarding-video"[^>]*playsinline/);
  assert.match(html, /id="onboarding-progress"[^>]*max="7"/);
  assert.match(html, /id="worker-roster"/);
  // The scan now keeps a portrait, so the page says so where the worker can
  // read it before agreeing to be scanned.
  assert.match(html, /one profile photo/i);
  assert.match(html, /face template for worker ID matching/i);
  assert.ok(existsSync(resolve(root, "onboarding.css")));
  assert.match(css, /\.scanner-oval/);
  // Every step shares one card shell, so the column's edges line up.
  assert.match(css, /\.card\s*\{[^}]*border-radius:/);
  assert.match(html, /class="card worker-form"[\s\S]*class="card scanner"[\s\S]*class="card roster"/);
  assert.match(html, /stampnote-theme/);
  assert.match(css, /prefers-color-scheme: dark/);
  assert.match(css, /:root:not\(\[data-theme="light"\]\)/);
  assert.match(css, /:root\[data-theme="dark"\]/);
  assert.match(css, /\.scanner-view video\s*\{[^}]*object-fit:\s*cover/);
});

test("worker onboarding keeps only the enrollment controls and feedback", () => {
  assert.match(html, /<h1[^>]*>Worker onboarding<\/h1>/);
  assert.equal(/class="intro"|class="steps"|class="brand"|local-chip|step-label/.test(html), false);
  // The only drawing is the door that appears once the worker is signed in.
  assert.equal((html.match(/<svg\b/g) || []).length, 1);
  assert.match(html, /<svg\b[^>]*class="sign-out-icon"/);
  // A portrait per worker, with initials still standing in for anyone enrolled
  // before portraits existed.
  assert.match(app, /worker-avatar/);
  assert.equal(/radial-gradient|backdrop-filter/.test(css), false);
});

test("enrollment stores a representative face gallery and can delete it", () => {
  assert.match(app, /workerFace\.averageEmbeddings\(samples\)/);
  assert.match(app, /telemetry\?\.event\("onboarding\.scan\.started"/);
  assert.match(app, /telemetry\?\.event\(\s*"onboarding\.scan\.completed"/);
  assert.match(app, /telemetry\?\.event\(\s*"onboarding\.worker\.saved"/);
  assert.match(app, /onboarding\.worker\.save_failed/);
  assert.match(app, /capture\.camera\.facing/);
  assert.match(app, /scanTraceId/);
  assert.match(app, /embeddings:\s*samples/);
  assert.match(app, /cloud\.saveWorkerFace\(/);
  assert.match(app, /cloud\.deleteWorkerFace\(/);
  // Enrolling is normally somebody scanning their own face, so the front camera
  // is where this page starts — but a supervisor working down a queue points the
  // back one at each worker instead, and can say so before the scan begins.
  assert.match(app, /fallback:\s*cameraFacing\.FRONT/);
  assert.match(app, /cameraFacing\.videoConstraints\(facing,/);
  assert.match(html, /id="camera-facing-toggle"/);
  assert.match(html, /id="camera-facing-state"/);
  assert.match(css, /\.camera-facing-toggle:disabled/);
  // Seven samples belong to one view of one face, so the lens cannot be swapped
  // out from under a scan that is already running.
  assert.match(app, /cameraFacingToggle\.disabled = scanActive \|\| saving/);
  // Nothing keeps a frame at photo resolution here, so the camera is asked only
  // for what the face model and the badge-sized portrait can use.
  assert.match(app, /FACE_CAMERA_WIDTH\s*=\s*1280/);
  assert.match(app, /FACE_CAMERA_HEIGHT\s*=\s*720/);
  assert.match(app, /enrollmentSamples:\s*ONBOARDING_SAMPLES/);
  assert.match(app, /body\?\.enrollmentAccepted\s*===\s*true/);
  assert.match(app, /loadFaceScanner\(\)/);

  // The one frame that is kept is a badge-sized square, taken from an accepted
  // sample and sent with the enrollment; nothing else is rasterized.
  assert.match(app, /PROFILE_PHOTO_EDGE\s*=\s*256/);
  assert.match(app, /profileCanvas\.toDataURL\("image\/jpeg", PROFILE_PHOTO_QUALITY\)/);
  assert.match(app, /captureProfileFrame\(\);/);
  assert.match(app, /profilePhoto: encodeProfilePhoto\(\)/);
  // Encoding it is worth a scan's worth of ticks, so it happens once, when the
  // enrollment is saved, rather than on every accepted sample.
  assert.equal(app.match(/toDataURL/g).length, 1);
  assert.match(app, /async function saveEnrollment\(\)[\s\S]*?encodeProfilePhoto\(\)/);
  // A cancelled scan keeps nothing.
  assert.match(app, /profileReady = false;/);
});

test("the page arrives a step at a time rather than all at once", () => {
  // An idle camera frame, an oval and a seven-sample counter are the largest
  // thing here and the least actionable before there is a worker to scan, so
  // step two is absent rather than dimmed.
  assert.match(html, /class="card scanner"[^>]*\bhidden\b/);
  assert.doesNotMatch(css, /~ \.scanner:has\(/);
  assert.match(app, /function detailsComplete\(\)/);
  assert.match(app, /normalizeWorkerId\?\.\(workerId\.value\)/);
  assert.match(app, /scannerCard\.hidden = !ready && !scanActive/);
  // An untouched form is two fields and nothing else; the button arrives with the
  // first character, disabled, beside whichever field is still wrong.
  assert.match(app, /function detailsStarted\(\)/);
  assert.match(app, /startButton\.hidden = !detailsStarted\(\) && !scanActive/);
  assert.match(css, /\.card-footer:has\(\.primary-button\[hidden\]\)/);
  // Typing is the trigger, so the reveal keeps up with the keystrokes.
  assert.match(
    app,
    /workerName\?\.addEventListener\("input", \(\) => \{\s*refreshFlow\(\);\s*issueWorkerId\(\);/,
  );
  // A scan already running keeps its camera even if the details are edited.
  assert.match(app, /scanActive = true;/);

  // Who is already enrolled is reference material: folded away, behind one
  // button that carries a glyph rather than a word.
  assert.match(html, /id="roster-body"[^>]*\bhidden\b/);
  assert.match(html, /id="roster-toggle"[\s\S]*?aria-expanded="false"/);
  assert.match(html, /aria-controls="roster-body"/);
  assert.match(html, /class="roster-chevron"[^>]*aria-hidden="true"/);
  assert.match(html, /Show enrolled workers/);
  assert.match(css, /\.roster-chevron\s*\{[^}]*transform:\s*rotate\(45deg\)/);
  assert.match(
    css,
    /\.roster-toggle\[aria-expanded="true"\] \.roster-chevron\s*\{[^}]*rotate\(225deg\)/,
  );
  // Nothing is read for a list nobody has opened; enrolling while it is closed
  // marks it stale instead.
  assert.match(app, /if \(!rosterOpen\) \{\s*rosterStale = true;/);
  assert.match(app, /await refreshRoster\(\);/);
});

test("the worker ID is issued from the name rather than typed", () => {
  // Asked for in the order it is derived: the name, then the ID read out of it.
  assert.match(html, /id="worker-name"[\s\S]*id="worker-id"/);
  assert.match(html, /id="worker-id"[^>]*readonly/s);
  // Nothing for the operator to satisfy in a field they cannot type into.
  assert.doesNotMatch(html, /id="worker-id"[^>]*(?:pattern|required)/s);
  assert.match(css, /\.worker-form input\[readonly\]\s*\{/);

  assert.match(app, /async function issueWorkerId\(/);
  assert.match(app, /workerFace\.nextWorkerId\(name, taken\)/);
  assert.match(app, /workerId\.value = issued \|\| ""/);
  // Saving merges into whatever document the ID names, so the number is issued
  // again from a fresh read once the scan is over.
  assert.match(app, /issueWorkerId\(\{ fresh: true \}\)/);
  assert.match(app, /workerId: issued,/);
  // The roster read and the numbering are the same read.
  assert.match(app, /function readWorkers\(/);
  assert.doesNotMatch(app, /await cloud\.getWorkerFaces\(\)/);
});

test("the recording page moves worker onboarding into the shared page drawer", () => {
  const capture = readFileSync(resolve(root, "index.html"), "utf8");
  const sidebar = readFileSync(resolve(root, "sidebar.js"), "utf8");
  assert.match(capture, /data-sidebar-mount/);
  assert.doesNotMatch(capture, /id="worker-onboarding"|Enroll worker faces/);
  assert.match(sidebar, /file: "onboarding\.html", label: "Worker onboarding"/);
});

test("worker onboarding pre-caches static assets and registers the service worker", () => {
  assert.match(app, /ONBOARDING_CACHE_NAME\s*=\s*"stampnote-onboarding-v1"/);
  assert.match(app, /"onboarding\.html"/);
  assert.match(app, /"onboarding\.css"/);
  assert.match(app, /"onboarding\.js"/);
  assert.match(app, /"worker-face\.js"/);
  assert.match(app, /"camera-facing\.js"/);
  assert.match(app, /"face-identity\.js"/);
  assert.match(app, /"pose-model\.js"/);
  assert.match(app, /navigator\.serviceWorker\.register\("sw\.js"\)/);
  assert.match(app, /cacheStaticAssets\(\)/);

  const swContent = readFileSync(resolve(root, "sw.js"), "utf8");
  assert.match(swContent, /stampnote-onboarding-v2/);
  assert.match(swContent, /addEventListener\("install"/);
  assert.match(swContent, /addEventListener\("fetch"/);

  // Code is read from the network first, so a shipped fix reaches a browser
  // that already visited the app; only fonts and vision models stay cache-first.
  assert.match(swContent, /CODE_EXTENSIONS = \[[^\]]*"\.js"/);
  assert.match(swContent, /IMMUTABLE_EXTENSIONS = \[[^\]]*"\.woff2"/);
  assert.doesNotMatch(swContent, /caches\s*\n?\s*\.match\(event\.request\)\.then\(\(cachedResponse\)/);
});

const workerFace = require("../worker-face.js");
const cameraFacing = require("../camera-facing.js");
const frameScaler = require("../frame-scaler.js");

class OnboardElement {
  constructor(tagName = "div") {
    this.tagName = String(tagName).toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.className = "";
    this.dataset = {};
    this.disabled = false;
    this.hidden = false;
    this.id = "";
    this.listeners = new Map();
    this.parentElement = null;
    this._textContent = "";
    this.value = "";
    this.videoWidth = 640;
    this.videoHeight = 480;
    this.classList = {
      toggle: (name, force) => {
        const names = new Set(this.className.split(" ").filter(Boolean));
        const should = force === undefined ? !names.has(name) : Boolean(force);
        if (should) names.add(name);
        else names.delete(name);
        this.className = [...names].join(" ");
      },
    };
  }

  get textContent() {
    if (this.children.length > 0) {
      return this.children.map((child) => child.textContent).join("");
    }
    return this._textContent;
  }

  set textContent(value) {
    this.children = [];
    this._textContent = String(value);
  }

  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(callback);
  }

  append(...children) {
    children.forEach((child) => {
      this.children.push(child);
      child.parentElement = this;
    });
  }

  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  focus() {
    this.focused = true;
  }

  async play() {}

  getContext() {
    return {
      setTransform() {},
      drawImage() {},
    };
  }

  toDataURL() {
    return "data:image/jpeg;base64,cHJvZmlsZQ==";
  }

  async dispatch(name, event = {}) {
    const list = this.listeners.get(name) || [];
    for (const callback of list) {
      await callback({ preventDefault() {}, target: this, ...event });
    }
  }
}

function createOnboardingHarness(options = {}) {
  const ids = [
    "worker-form",
    "worker-id",
    "worker-name",
    "onboarding-auth",
    "onboarding-auth-icon",
    "onboarding-auth-label",
    "signed-in-state",
    "start-face-scan",
    "cancel-face-scan",
    "onboarding-status",
    "scanner-card",
    "scanner-view",
    "onboarding-video",
    "scanner-instruction",
    "onboarding-progress",
    "onboarding-progress-count",
    "worker-roster",
    "roster-empty",
    "roster-body",
    "roster-toggle",
    "roster-toggle-label",
    "camera-facing-toggle",
    "camera-facing-state",
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new OnboardElement()]));
  elements["scanner-card"].hidden = true;
  elements["cancel-face-scan"].hidden = true;
  elements["onboarding-auth-icon"].hidden = true;
  elements["onboarding-progress"].max = 7;
  elements["onboarding-progress"].value = 0;

  const timers = [];
  const cloudCalls = { saved: [], deleted: [], faces: 0 };
  let authCallback;
  const workers = [...(options.workers || [])];
  const cloud = {
    async getWorkerFaces() {
      cloudCalls.faces += 1;
      if (options.facesError) throw options.facesError;
      return [...workers];
    },
    async saveWorkerFace(record) {
      cloudCalls.saved.push(record);
      const saved = {
        workerId: record.workerId,
        displayName: record.displayName,
        profilePhoto: record.profilePhoto,
      };
      workers.push(saved);
      return saved;
    },
    async deleteWorkerFace(workerId) {
      cloudCalls.deleted.push(workerId);
    },
    async signIn() {},
    async signOut() {},
    subscribeAuth(callback) {
      authCallback = callback;
      return () => {};
    },
  };

  const document = {
    createElement(tagName) {
      return new OnboardElement(tagName);
    },
    querySelector(selector) {
      return elements[selector.replace(/^#/, "")] || null;
    },
  };

  const embedding = Array.from({ length: 128 }, (unused, index) => (index + 1) / 200);
  let sampleCount = 0;
  const pending = [];
  const cachesStore = new Map();
  const context = {
    Blob,
    confirm: () => true,
    console,
    document,
    fetch: async (url) => ({
      ok: true,
      clone() {
        return this;
      },
      url,
    }),
    performance: {
      now() {
        return Date.now();
      },
    },
    navigator: {
      mediaDevices: {
        async getUserMedia() {
          return {
            getTracks() {
              return [{ stop() {} }];
            },
          };
        },
      },
      serviceWorker: {
        async register(script) {
          pending.push(script);
          return { scriptURL: script };
        },
      },
    },
    caches: {
      async open(name) {
        if (!cachesStore.has(name)) cachesStore.set(name, new Map());
        const bucket = cachesStore.get(name);
        return {
          async put(key, value) {
            bucket.set(key, value);
          },
        };
      },
    },
    StampNoteCameraFacing: cameraFacing,
    StampNoteFaceIdentity: {
      createFaceIdentity() {
        return {
          async load() {},
          describe() {
            sampleCount += 1;
            return [
              {
                faceEmbedding: embedding,
                enrollmentAccepted: true,
              },
            ];
          },
          enrollmentState() {
            return { status: "scanning", samples: sampleCount, total: 7 };
          },
          reset() {},
        };
      },
    },
    StampNoteFirebase: cloud,
    StampNoteFrameScaler: frameScaler,
    StampNoteModel: {
      async loadFaceScanner() {
        return {
          detect() {
            return { bodies: [{}] };
          },
          close() {},
        };
      },
    },
    StampNoteObservability: {
      configure() {},
      createTraceId() {
        return "onboard-trace";
      },
      safeErrorCode(error, fallback) {
        return String(error?.code || fallback || "unknown_error");
      },
      event() {
        return true;
      },
    },
    StampNoteWorkerFace: workerFace,
    localStorage: {
      getItem() {
        return null;
      },
      setItem() {},
    },
    addEventListener() {},
    setTimeout(callback, delay) {
      const handle = { callback, delay, cancelled: false };
      timers.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      if (handle) handle.cancelled = true;
    },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(app, context, { filename: resolve(root, "onboarding.js") });

  return {
    async auth(user, error = null) {
      return authCallback?.(user, error);
    },
    cloudCalls,
    elements,
    async flushScan() {
      for (let index = 0; index < 16; index += 1) {
        const next = timers.find((timer) => !timer.cancelled);
        if (!next) break;
        next.cancelled = true;
        await next.callback();
      }
    },
    pending,
  };
}

async function settleOnboarding(turns = 6) {
  for (let index = 0; index < turns; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("signed-in enrollment issues an ID, takes seven samples, and saves the template", async () => {
  const harness = createOnboardingHarness();
  await harness.auth({ email: "yanguangchensp@gmail.com", uid: "owner-1" });
  await settleOnboarding();

  assert.match(harness.elements["signed-in-state"].textContent, /yanguangchensp@gmail.com/);
  harness.elements["worker-name"].value = "Ari Tan";
  await harness.elements["worker-name"].dispatch("input");
  await settleOnboarding();
  assert.equal(harness.elements["worker-id"].value, "AT-0001");

  await harness.elements["worker-form"].dispatch("submit");
  await settleOnboarding();
  await harness.flushScan();
  await settleOnboarding();

  assert.equal(harness.cloudCalls.saved.length, 1);
  assert.equal(harness.cloudCalls.saved[0].workerId, "AT-0001");
  assert.equal(harness.cloudCalls.saved[0].embeddings.length, 7);
  assert.match(harness.elements["onboarding-status"].textContent, /Ari Tan \(AT-0001\) enrolled/);
  assert.equal(harness.pending[0], "sw.js");
});

