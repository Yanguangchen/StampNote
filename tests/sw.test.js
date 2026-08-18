const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const root = resolve(__dirname, "..");
const source = readFileSync(resolve(root, "sw.js"), "utf8");

function createServiceWorkerHarness(options = {}) {
  const listeners = new Map();
  const cacheStore = new Map();
  const fetches = [];
  const claimed = [];
  const skipped = [];

  const caches = {
    async open(name) {
      if (!cacheStore.has(name)) cacheStore.set(name, new Map());
      const bucket = cacheStore.get(name);
      return {
        async put(request, response) {
          const key = typeof request === "string" ? request : request.url;
          bucket.set(key, response);
        },
        async match(request) {
          const key = typeof request === "string" ? request : request.url;
          return bucket.get(key) || null;
        },
      };
    },
    async keys() {
      return [...cacheStore.keys()];
    },
    async delete(name) {
      return cacheStore.delete(name);
    },
    async match(request) {
      for (const bucket of cacheStore.values()) {
        const key = typeof request === "string" ? request : request.url;
        if (bucket.has(key)) return bucket.get(key);
      }
      return null;
    },
  };

  const context = {
    URL,
    caches,
    clients: {
      async claim() {
        claimed.push(true);
      },
    },
    fetch: async (request) => {
      fetches.push(request);
      if (options.offline) throw new Error("offline");
      const url = typeof request === "string" ? request : request.url;
      return {
        ok: true,
        status: 200,
        url,
        clone() {
          return this;
        },
      };
    },
    location: { origin: "https://stampnote-omega.vercel.app" },
    addEventListener(name, callback) {
      listeners.set(name, callback);
    },
    skipWaiting() {
      skipped.push(true);
    },
  };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: resolve(root, "sw.js") });

  return {
    cacheStore,
    claimed,
    fetches,
    skipped,
    async emit(name, event) {
      await listeners.get(name)?.(event);
    },
  };
}

function waitUntilEvent(extra = {}) {
  const waited = [];
  return {
    ...extra,
    waitUntil(promise) {
      waited.push(promise);
      return promise;
    },
    async flush() {
      await Promise.all(waited);
    },
  };
}

test("install caches onboarding assets and activate drops older caches", async () => {
  const harness = createServiceWorkerHarness();
  cacheStoreSeed(harness, "stampnote-onboarding-v1", "stale.html");

  const install = waitUntilEvent();
  await harness.emit("install", install);
  await install.flush();
  assert.equal(harness.skipped.length, 1);
  assert.ok(harness.cacheStore.has("stampnote-onboarding-v2"));
  assert.ok(harness.fetches.includes("onboarding.js"));

  const activate = waitUntilEvent();
  await harness.emit("activate", activate);
  await activate.flush();
  assert.equal(harness.cacheStore.has("stampnote-onboarding-v1"), false);
  assert.equal(harness.claimed.length, 1);
});

test("fetch prefers the network for code and the cache for immutable fonts", async () => {
  const harness = createServiceWorkerHarness();
  const install = waitUntilEvent();
  await harness.emit("install", install);
  await install.flush();

  let codeResponse;
  const codeEvent = {
    request: {
      method: "GET",
      mode: "same-origin",
      url: "https://stampnote-omega.vercel.app/onboarding.js",
    },
    respondWith(promise) {
      codeResponse = promise;
    },
  };
  await harness.emit("fetch", codeEvent);
  const fresh = await codeResponse;
  assert.equal(fresh.status, 200);

  const fontRequest = {
    method: "GET",
    mode: "same-origin",
    url: "https://stampnote-omega.vercel.app/vendor/fonts/outfit-latin.woff2",
  };
  const fontCache = harness.cacheStore.get("stampnote-onboarding-v2");
  fontCache.set(fontRequest.url, { status: 200, fromCache: true });
  let fontResponse;
  await harness.emit("fetch", {
    request: fontRequest,
    respondWith(promise) {
      fontResponse = promise;
    },
  });
  assert.equal((await fontResponse).fromCache, true);
});

function cacheStoreSeed(harness, name, key) {
  harness.cacheStore.set(name, new Map([[key, { status: 200 }]]));
}
