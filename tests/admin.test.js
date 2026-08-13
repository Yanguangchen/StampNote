const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const cloudData = require("../photo-cloud.js");
const adminPath = resolve(__dirname, "..", "admin.js");

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.dataset = {};
    this.disabled = false;
    this.hidden = false;
    this.isConnected = false;
    this.listeners = new Map();
    this.textContent = "";
    this.value = "";
  }

  addEventListener(name, callback) {
    this.listeners.set(name, callback);
  }

  append(...children) {
    children.forEach((child) => {
      this.children.push(child);
      if (child && typeof child === "object") {
        child.parentElement = this;
        child.setConnected?.(this.isConnected);
      }
    });
  }

  async dispatch(name) {
    return this.listeners.get(name)?.({ target: this });
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === "src") this.src = "";
  }

  replaceChildren(...children) {
    this.children.forEach((child) => child?.setConnected?.(false));
    this.children = [];
    this.append(...children);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  setConnected(value) {
    this.isConnected = value;
    this.children.forEach((child) => child?.setConnected?.(value));
  }
}

class FakeImage extends FakeElement {
  constructor() {
    super("img");
    this.alt = "";
    this.loading = "";
    this.src = "";
  }
}

function descendants(element) {
  return [element, ...element.children.flatMap(descendants)];
}

function photo(id, overrides = {}) {
  const capturedAtMs = Date.parse(overrides.capturedAt || "2026-08-13T12:34:56.000Z");
  const location = overrides.location || "10 Marina Bay";
  return {
    id,
    capturedAt: new Date(capturedAtMs).toISOString(),
    capturedAtMs,
    location,
    locationKey: cloudData.createLocationKey(location),
    dateKey: cloudData.createDateKey(capturedAtMs),
    imageBytes: 4096,
    people: 2,
    uniquePeopleSeen: 5,
    poseDetected: false,
    aiReview: { action: "keep", recommendation: "keep", confidence: 0.96, reason: "Useful." },
    ...overrides,
  };
}

function createAdminHarness(options = {}) {
  const ids = [
    "sign-in",
    "sign-out",
    "auth-gate",
    "account-name",
    "gallery-toolbar",
    "photo-filter",
    "photo-library",
    "dashboard-status",
    "load-more-row",
    "load-more",
    "photo-dialog",
    "dialog-image",
    "dialog-location",
    "dialog-time",
    "dialog-people",
    "dialog-review",
    "system-health",
    "system-health-label",
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  elements["photo-filter"].value = "all";
  elements["photo-library"].setConnected(true);
  elements["photo-dialog"].showModal = function showModal() {
    this.open = true;
  };

  const events = [];
  const configured = [];
  const revoked = [];
  const objectUrls = [];
  const windowListeners = new Map();
  const cloudCalls = { blobs: [], pages: [], signIn: 0, signOut: 0 };
  let authCallback;
  let pages = options.pages || [
    {
      photos: [
        photo("kept"),
        photo("flagged", {
          capturedAt: "2026-08-13T11:00:00.000Z",
          aiReview: {
            action: "review",
            recommendation: "discard",
            confidence: 0.75,
            reason: "Uncertain duplicate.",
          },
        }),
      ],
      after: { id: "cursor-1" },
      hasMore: true,
    },
  ];

  const telemetry = {
    configure(configuration) {
      configured.push(configuration);
    },
    createTraceId() {
      return "dashboard-trace-123";
    },
    event(name, fields, eventOptions) {
      events.push({ name, fields, options: eventOptions });
    },
    safeErrorCode(error, fallback = "unknown_error") {
      return String(error?.code || error?.name || fallback).replace(/[^A-Za-z0-9_./:-]/g, "_");
    },
  };
  const cloud = options.cloud === null
    ? null
    : {
        async getPhotoBlob(entry) {
          cloudCalls.blobs.push(entry.id);
          if (options.imageError) throw options.imageError;
          return new Blob([entry.id]);
        },
        async getPhotosPage(pageOptions) {
          cloudCalls.pages.push(pageOptions);
          if (options.pageError) throw options.pageError;
          return pages.shift() || { photos: [], after: null, hasMore: false };
        },
        async signIn() {
          cloudCalls.signIn += 1;
          if (options.signInError) throw options.signInError;
        },
        async signOut() {
          cloudCalls.signOut += 1;
          if (options.signOutError) throw options.signOutError;
        },
        subscribeAuth(callback) {
          authCallback = callback;
          return () => {};
        },
      };
  let clock = 100;
  const scope = {
    StampNoteCloudData: options.data === null ? null : cloudData,
    StampNoteFirebase: cloud,
    StampNoteObservability: options.telemetry === null ? null : telemetry,
    location: { hostname: options.hostname || "stampnote.example", port: options.port || "" },
    addEventListener(name, callback) {
      windowListeners.set(name, callback);
    },
  };
  const document = {
    createElement(name) {
      return new FakeElement(name);
    },
    querySelector(selector) {
      return elements[selector.slice(1)] || null;
    },
  };
  const context = vm.createContext({
    Blob,
    Image: FakeImage,
    URL: {
      createObjectURL(blob) {
        const url = `blob:dashboard-${objectUrls.length + 1}`;
        objectUrls.push({ blob, url });
        return url;
      },
      revokeObjectURL(url) {
        revoked.push(url);
      },
    },
    document,
    fetch: async () => {
      if (options.healthError) throw options.healthError;
      return {
        status: options.healthStatus || 200,
        async json() {
          if (options.healthJsonError) throw options.healthJsonError;
          return { status: options.healthState || "ok" };
        },
      };
    },
    navigator: { onLine: options.online !== false },
    performance: {
      now() {
        clock += 5;
        return clock;
      },
    },
    window: scope,
  });
  scope.document = document;

  vm.runInContext(readFileSync(adminPath, "utf8"), context, { filename: adminPath });

  return {
    auth(user, error = null) {
      authCallback?.(user, error);
    },
    cloudCalls,
    configured,
    elements,
    events,
    objectUrls,
    revoked,
    setPages(nextPages) {
      pages = nextPages;
    },
    windowListeners,
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("the dashboard signs in, renders and filters photos, paginates, and opens the viewer", async () => {
  const harness = createAdminHarness();
  await settle();

  assert.equal(harness.configured.length, 1);
  assert.equal(harness.configured[0].surface, "dashboard");
  assert.equal(harness.elements["system-health"].dataset.state, "ok");
  assert.equal(harness.elements["system-health-label"].textContent, "System online");

  harness.auth({ uid: "user-1", email: "owner@example.com" });
  await settle();
  assert.equal(harness.elements["auth-gate"].hidden, true);
  assert.equal(harness.elements["gallery-toolbar"].hidden, false);
  assert.equal(harness.elements["photo-library"].hidden, false);
  assert.equal(harness.elements["sign-out"].hidden, false);
  assert.equal(harness.elements["account-name"].textContent, "owner@example.com");
  assert.equal(harness.elements["dashboard-status"].textContent, "2 of 2 loaded photos");
  assert.equal(harness.elements["load-more-row"].hidden, false);
  assert.equal(harness.cloudCalls.pages.length, 1);
  assert.equal(harness.cloudCalls.pages[0].pageSize, 48);
  assert.equal(harness.cloudCalls.pages[0].after, null);
  assert.deepEqual(harness.cloudCalls.blobs.sort(), ["flagged", "kept"]);

  const library = harness.elements["photo-library"];
  const cards = descendants(library).filter((entry) => entry.className === "photo-card");
  assert.equal(cards.length, 2);
  const badges = descendants(library).filter((entry) => entry.className === "photo-badge");
  assert.deepEqual(badges.map((entry) => entry.textContent).sort(), ["Kept", "Uncertain AI flag"]);
  const peopleCounts = descendants(library).filter(
    (entry) => entry.className === "photo-people",
  );
  assert.deepEqual(peopleCounts.map((entry) => entry.textContent), [
    "5 unique people",
    "5 unique people",
  ]);

  const firstButton = descendants(cards[0]).find((entry) => entry.className === "photo-open");
  await firstButton.dispatch("click");
  await settle();
  assert.equal(harness.elements["photo-dialog"].open, true);
  assert.equal(harness.elements["dialog-location"].textContent, "10 Marina Bay");
  assert.equal(
    harness.elements["dialog-people"].textContent,
    "2 people in this photo · 5 unique people seen this session",
  );
  assert.match(harness.elements["dialog-review"].textContent, /confidence/);
  assert.match(harness.elements["dialog-image"].src, /^blob:dashboard-/);

  harness.elements["photo-filter"].value = "flagged";
  await harness.elements["photo-filter"].dispatch("change");
  await settle();
  assert.equal(harness.elements["dashboard-status"].textContent, "1 of 2 loaded photos");
  assert.equal(
    descendants(library).filter((entry) => entry.className === "photo-card").length,
    1,
  );

  harness.elements["photo-filter"].value = "all";
  harness.setPages([
    {
      photos: [photo("kept"), photo("next", { location: "Orchard Road" })],
      after: null,
      hasMore: false,
    },
  ]);
  await harness.elements["load-more"].dispatch("click");
  await settle();
  assert.equal(harness.elements["dashboard-status"].textContent, "3 of 3 loaded photos");
  assert.equal(harness.elements["load-more-row"].hidden, true);
  assert.equal(harness.cloudCalls.pages[1].pageSize, 48);
  assert.equal(harness.cloudCalls.pages[1].after.id, "cursor-1");

  harness.auth(null);
  await settle();
  assert.equal(harness.elements["auth-gate"].hidden, false);
  assert.equal(library.children.length, 0);
  assert.ok(harness.revoked.length >= 2);
  assert.ok(harness.events.some((entry) => entry.name === "dashboard.load.completed"));
  assert.ok(harness.events.some((entry) => entry.name === "cloud.auth.state"));
});

test("dashboard controls and loading failures remain recoverable and observable", async () => {
  const permissionError = Object.assign(new Error("denied"), { code: "permission-denied" });
  const harness = createAdminHarness({
    healthError: Object.assign(new Error("offline"), { code: "network" }),
    pageError: permissionError,
    imageError: permissionError,
    signInError: Object.assign(new Error("provider disabled"), {
      code: "auth/operation-not-allowed",
    }),
    signOutError: permissionError,
  });
  await settle();
  assert.equal(harness.elements["system-health"].dataset.state, "failed");
  assert.equal(harness.elements["system-health-label"].textContent, "System unavailable");

  await harness.elements["sign-in"].dispatch("click");
  assert.equal(harness.elements["sign-in"].disabled, false);
  assert.match(harness.elements["dashboard-status"].textContent, /Enable the Google provider/);

  harness.auth({ uid: "user-1", email: "owner@example.com" });
  await settle();
  assert.match(harness.elements["dashboard-status"].textContent, /Firebase denied access/);
  assert.equal(harness.elements["load-more"].disabled, false);
  assert.equal(harness.elements["load-more-row"].hidden, true);

  await harness.elements["sign-out"].dispatch("click");
  await settle();
  assert.match(harness.elements["dashboard-status"].textContent, /Firebase denied access/);
  assert.ok(harness.events.some((entry) => entry.name === "dashboard.load.failed"));
  assert.ok(harness.events.some((entry) => entry.name === "cloud.auth.failed"));

  harness.auth(null, Object.assign(new Error("database missing"), { code: "failed-precondition" }));
  assert.match(harness.elements["dashboard-status"].textContent, /Create the Firestore database/);
});

test("the dashboard disables sign-in when its Firebase client is missing", async () => {
  const harness = createAdminHarness({ cloud: null });
  await settle();

  assert.equal(harness.elements["sign-in"].disabled, true);
  assert.equal(
    harness.elements["dashboard-status"].textContent,
    "The Firebase photo client could not be loaded.",
  );
  assert.equal(harness.elements["dashboard-status"].dataset.state, "error");
  assert.ok(harness.events.some((entry) => entry.name === "client.error"));
});
