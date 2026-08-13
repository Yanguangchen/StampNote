const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const observabilityPath = resolve(__dirname, "..", "observability.js");
const pure = require(observabilityPath);

function createBrowserHarness(options = {}) {
  const windowListeners = new Map();
  const documentListeners = new Map();
  const timers = [];
  const requests = [];
  const observers = [];
  let uuid = 0;
  let now = 100;

  class FakePerformanceObserver {
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }

    observe(configuration) {
      this.configuration = configuration;
    }

    disconnect() {
      this.disconnected = true;
    }

    emit(entries) {
      this.callback({ getEntries: () => entries });
    }
  }

  const scope = {
    PerformanceObserver: options.performanceObservers === false ? undefined : FakePerformanceObserver,
    crypto: {
      randomUUID() {
        uuid += 1;
        return `00000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`;
      },
    },
    document: {
      hidden: false,
      documentElement: { dataset: { surface: options.surface || "capture" } },
      addEventListener(name, callback) {
        documentListeners.set(name, callback);
      },
    },
    async fetch(url, requestOptions) {
      requests.push({ url, options: requestOptions });
      return options.fetch ? options.fetch(url, requestOptions, requests.length) : { ok: true, status: 202 };
    },
    location: {
      hostname: options.hostname || "stampnote.example",
      port: options.port || "",
    },
    navigator: { onLine: options.online !== false },
    performance: {
      getEntriesByType(name) {
        return name === "navigation" ? [{ requestStart: 10, responseStart: 45 }] : [];
      },
      now() {
        return now;
      },
    },
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
    addEventListener(name, callback) {
      windowListeners.set(name, callback);
    },
  };
  const context = vm.createContext({ window: scope });
  vm.runInContext(readFileSync(observabilityPath, "utf8"), context, {
    filename: observabilityPath,
  });

  return {
    api: scope.StampNoteObservability,
    documentListeners,
    observers,
    requests,
    scope,
    timers,
    windowListeners,
    setNow(value) {
      now = value;
    },
  };
}

test("client telemetry sanitizes its fixed field allowlist and error codes", () => {
  const fields = pure.sanitizeFields({
    durationMs: 9_000_000,
    failedCount: 2,
    matchDistance: 0.47,
    matchVotes: 3,
    requiredVotes: 4,
    sampleCount: 5,
    online: true,
    status: "signed_in",
    trigger: "gesture",
    metricName: "LCP",
    metricRating: "poor",
    errorCode: "Auth Popup Blocked!",
    email: "must-not-leave@example.com",
    negative: -1,
  });

  assert.deepEqual(fields, {
    durationMs: 3_600_000,
    failedCount: 2,
    matchDistance: 0.47,
    matchVotes: 3,
    requiredVotes: 4,
    sampleCount: 5,
    online: true,
    status: "signed_in",
    trigger: "gesture",
    metricName: "LCP",
    metricRating: "poor",
    errorCode: "auth_popup_blocked",
  });
  assert.equal(pure.safeErrorCode({ name: "Network Error!" }), "network_error");
  assert.equal(pure.safeErrorCode(null, "fallback"), "fallback");
  assert.deepEqual(pure.sanitizeFields(null), {});
});

test("browser telemetry batches safe events, deduplicates failures, and records web vitals", async () => {
  const harness = createBrowserHarness({ hostname: "stampnote.example" });
  const { api } = harness;
  assert.ok(api);
  api.configure({ surface: "dashboard" });
  api.configure({ surface: "unsupported" });

  const observer = (type) =>
    harness.observers.find((entry) => entry.configuration?.type === type);
  observer("paint").emit([
    { name: "first-paint", startTime: 10 },
    { name: "first-contentful-paint", startTime: 1200 },
  ]);
  assert.equal(observer("paint").disconnected, true);
  observer("largest-contentful-paint").emit([{ startTime: 2800 }]);
  observer("layout-shift").emit([
    { value: 0.08, hadRecentInput: false },
    { value: 0.5, hadRecentInput: true },
  ]);
  observer("longtask").emit([{ duration: 75 }, { duration: 25 }]);

  harness.setNow(1500);
  harness.windowListeners.get("load")();
  assert.equal(
    api.event("capture.saved", { trigger: "schedule", photoCount: 2, email: "private" }),
    true,
  );
  assert.equal(api.event("unknown.event"), false);
  assert.equal(
    api.event("tracking.failed", { errorCode: "camera stalled" }, { dedupeMs: 60_000 }),
    true,
  );
  assert.equal(
    api.event("tracking.failed", { errorCode: "camera stalled" }, { dedupeMs: 60_000 }),
    false,
  );

  assert.equal(await api.flush(), true);
  assert.equal(harness.requests[0].url, "/api/telemetry");
  const first = JSON.parse(harness.requests[0].options.body);
  assert.equal(first.surface, "dashboard");
  assert.match(first.sessionId, /^[A-Za-z0-9_-]{8,80}$/);
  assert.deepEqual(first.events.map((event) => event.name), [
    "web.vital",
    "web.vital",
    "client.ready",
    "capture.saved",
    "tracking.failed",
  ]);
  assert.equal(first.events[0].fields.metricName, "FCP");
  assert.equal(first.events[1].fields.metricName, "TTFB");
  assert.equal(Object.hasOwn(first.events[3].fields, "email"), false);
  assert.equal(first.events[4].fields.errorCode, "camera_stalled");
  assert.match(harness.requests[0].options.headers["X-StampNote-Trace-Id"], /^[A-Za-z0-9_-]{8,80}$/);
  assert.equal(harness.requests[0].options.keepalive, true);

  harness.windowListeners.get("pagehide")();
  await new Promise((resolve) => setImmediate(resolve));
  const final = JSON.parse(harness.requests.at(-1).options.body);
  assert.deepEqual(final.events.map((event) => event.fields.metricName), ["LCP", "CLS", "long_tasks"]);
  assert.deepEqual(final.events.map((event) => event.fields.metricRating), [
    "needs_improvement",
    "good",
    "unknown",
  ]);
});

test("browser telemetry retries a rejected batch and selects the Live Server endpoint", async () => {
  const harness = createBrowserHarness({
    hostname: "127.0.0.1",
    port: "5500",
    fetch(_url, _options, attempt) {
      return attempt === 1 ? { ok: false, status: 503 } : { ok: true, status: 202 };
    },
  });
  const { api } = harness;
  api.event("cloud.sync.failed", { errorCode: "offline" });

  assert.equal(await api.flush(), false);
  assert.equal(await api.flush(), true);
  assert.equal(harness.requests[0].url, "https://stampnote-omega.vercel.app/api/telemetry");
  assert.deepEqual(
    JSON.parse(harness.requests[0].options.body),
    JSON.parse(harness.requests[1].options.body),
  );
  assert.ok(harness.timers.some((timer) => timer.delay === 1_800));
});

test("browser errors are reported immediately without leaking their messages", async () => {
  const harness = createBrowserHarness();
  const secret = new Error("customer name and private image path");
  secret.name = "PrivateFailure";
  harness.windowListeners.get("error")({ error: secret });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.requests.length, 1);
  const body = JSON.parse(harness.requests[0].options.body);
  assert.equal(body.events[0].name, "client.error");
  assert.equal(body.events[0].fields.errorCode, "privatefailure");
  assert.equal(harness.requests[0].options.body.includes(secret.message), false);

  harness.windowListeners.get("unhandledrejection")({ reason: { code: "promise failed" } });
  harness.scope.document.hidden = true;
  harness.documentListeners.get("visibilitychange")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(harness.requests.length >= 2);
});
