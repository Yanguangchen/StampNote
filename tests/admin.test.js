const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const cloudData = require("../photo-cloud.js");
const adminPath = resolve(__dirname, "..", "admin.js");
const adminHtml = readFileSync(resolve(__dirname, "..", "admin.html"), "utf8");
const adminCss = readFileSync(resolve(__dirname, "..", "admin.css"), "utf8");

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
    "dashboard-workspace",
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
    "attendance-refresh",
    "attendance-worker-filter",
    "attendance-status",
    "attendance-list",
    "present-worker-count",
    "attendance-checkin-count",
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  elements["photo-filter"].value = "all";
  elements["attendance-worker-filter"].value = "all";
  elements["photo-library"].setConnected(true);
  elements["photo-dialog"].showModal = function showModal() {
    this.open = true;
  };

  const events = [];
  const configured = [];
  const revoked = [];
  const objectUrls = [];
  const windowListeners = new Map();
  const cloudCalls = { attendance: [], blobs: [], pages: [], signIn: 0, signOut: 0 };
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
        async getAttendance(attendanceOptions) {
          cloudCalls.attendance.push(attendanceOptions);
          if (options.attendanceError) throw options.attendanceError;
          return options.attendance || [
            {
              eventId: "attendance-1",
              workerId: "WORKER-7",
              displayName: "Ari Tan",
              checkedInAtMs: Date.parse("2026-08-14T01:00:00.000Z"),
              dateKey: "2026-08-14",
              location: "10 Marina Bay",
            },
            {
              eventId: "attendance-2",
              workerId: "WORKER-7",
              displayName: "Ari Tan",
              checkedInAtMs: Date.parse("2026-08-14T06:00:00.000Z"),
              dateKey: "2026-08-14",
              location: "10 Marina Bay",
            },
            {
              eventId: "attendance-3",
              workerId: "WORKER-9",
              displayName: "Bo Lim",
              checkedInAtMs: Date.parse("2026-08-14T02:00:00.000Z"),
              dateKey: "2026-08-14",
              location: "Orchard Road",
            },
            {
              eventId: "attendance-4",
              workerId: "WORKER-7",
              displayName: "Ari Tan",
              checkedInAtMs: Date.parse("2026-08-14T07:00:00.000Z"),
              dateKey: "2026-08-14",
              location: "Orchard Road",
            },
            {
              eventId: "attendance-5",
              workerId: "WORKER-7",
              displayName: "Ari Tan",
              checkedInAtMs: Date.parse("2026-08-13T01:00:00.000Z"),
              dateKey: "2026-08-13",
              location: "10 Marina Bay",
            },
          ];
        },
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

test("photos and daily attendance share one dashboard without status or access-copy clutter", () => {
  assert.match(adminHtml, /Photos &amp; attendance/);
  assert.match(adminHtml, /id="photo-library"/);
  assert.match(adminHtml, /id="attendance-list"/);
  assert.match(adminHtml, /id="attendance-worker-filter"/);
  assert.match(adminCss, /\.dashboard-workspace\s*\{[^}]*grid-template-columns:/);
  assert.doesNotMatch(adminHtml, /Authenticated cloud library/);
  assert.doesNotMatch(adminHtml, /Only Gemini-reviewed batches appear here/);
  assert.doesNotMatch(adminHtml, /system-health|System online/);
});

test("the dashboard signs in, renders and filters photos, paginates, and opens the viewer", async () => {
  const harness = createAdminHarness();
  await settle();

  assert.equal(harness.configured.length, 1);
  assert.equal(harness.configured[0].surface, "dashboard");

  harness.auth({ uid: "user-1", email: "owner@example.com" });
  await settle();
  assert.equal(harness.elements["auth-gate"].hidden, true);
  assert.equal(harness.elements["dashboard-workspace"].hidden, false);
  assert.equal(harness.elements["gallery-toolbar"].hidden, false);
  assert.equal(harness.elements["photo-library"].hidden, false);
  assert.equal(harness.elements["sign-out"].hidden, false);
  assert.equal(harness.elements["account-name"].textContent, "owner@example.com");
  assert.equal(harness.elements["dashboard-status"].textContent, "2 of 2 loaded photos");
  assert.equal(harness.elements["load-more-row"].hidden, false);
  assert.equal(harness.cloudCalls.pages.length, 1);
  assert.equal(harness.cloudCalls.pages[0].pageSize, 48);
  assert.equal(harness.cloudCalls.pages[0].after, null);
  assert.equal(harness.cloudCalls.attendance.length, 1);
  assert.equal(harness.cloudCalls.attendance[0].pageSize, 500);
  assert.equal(harness.cloudCalls.attendance[0].dateKey, undefined);
  assert.deepEqual(harness.cloudCalls.blobs.sort(), ["flagged", "kept"]);

  assert.equal(harness.elements["present-worker-count"].textContent, "2");
  assert.equal(harness.elements["attendance-checkin-count"].textContent, "5");
  const attendanceList = harness.elements["attendance-list"];
  assert.equal(
    descendants(attendanceList).filter(
      (entry) => entry.className === "attendance-row",
    ).length,
    4,
  );
  const attendanceLocations = descendants(attendanceList).filter(
    (entry) => entry.className === "attendance-location-heading",
  );
  assert.deepEqual(
    attendanceLocations.map((entry) => entry.children[0].textContent),
    ["10 Marina Bay", "Orchard Road"],
  );
  assert.equal(
    descendants(attendanceList).filter(
      (entry) => entry.className === "attendance-date-heading",
    ).length,
    3,
  );
  assert.match(harness.elements["attendance-status"].textContent, /2 workers · 5 recent check-ins/);
  assert.equal(harness.elements["attendance-worker-filter"].disabled, false);
  assert.deepEqual(
    harness.elements["attendance-worker-filter"].children.map((entry) => entry.textContent),
    ["All workers", "Ari Tan · WORKER-7", "Bo Lim · WORKER-9"],
  );

  harness.elements["attendance-worker-filter"].value = "WORKER-7";
  await harness.elements["attendance-worker-filter"].dispatch("change");
  assert.equal(harness.elements["present-worker-count"].textContent, "1");
  assert.equal(harness.elements["attendance-checkin-count"].textContent, "4");
  assert.equal(
    descendants(attendanceList).filter((entry) => entry.className === "attendance-row").length,
    3,
  );
  assert.match(harness.elements["attendance-status"].textContent, /Ari Tan · 4 recent check-ins/);

  harness.elements["attendance-worker-filter"].value = "WORKER-9";
  await harness.elements["attendance-worker-filter"].dispatch("change");
  assert.equal(harness.elements["attendance-checkin-count"].textContent, "1");
  assert.equal(
    descendants(attendanceList).filter((entry) => entry.className === "attendance-row").length,
    1,
  );

  harness.elements["attendance-worker-filter"].value = "all";
  await harness.elements["attendance-worker-filter"].dispatch("change");

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
  assert.equal(harness.elements["dashboard-workspace"].hidden, true);
  assert.equal(library.children.length, 0);
  assert.equal(harness.elements["attendance-list"].children.length, 0);
  assert.equal(harness.elements["attendance-worker-filter"].value, "all");
  assert.equal(harness.elements["attendance-worker-filter"].disabled, true);
  assert.ok(harness.revoked.length >= 2);
  assert.ok(harness.events.some((entry) => entry.name === "dashboard.load.completed"));
  assert.ok(harness.events.some((entry) => entry.name === "cloud.auth.state"));
});

test("dashboard controls and loading failures remain recoverable and observable", async () => {
  const permissionError = Object.assign(new Error("denied"), { code: "permission-denied" });
  const harness = createAdminHarness({
    pageError: permissionError,
    attendanceError: permissionError,
    imageError: permissionError,
    signInError: Object.assign(new Error("provider disabled"), {
      code: "auth/operation-not-allowed",
    }),
    signOutError: permissionError,
  });
  await settle();

  await harness.elements["sign-in"].dispatch("click");
  assert.equal(harness.elements["sign-in"].disabled, false);
  assert.match(harness.elements["dashboard-status"].textContent, /Enable the Google provider/);

  harness.auth({ uid: "user-1", email: "owner@example.com" });
  await settle();
  assert.match(harness.elements["dashboard-status"].textContent, /Firebase denied access/);
  assert.equal(harness.elements["load-more"].disabled, false);
  assert.equal(harness.elements["load-more-row"].hidden, true);
  assert.match(harness.elements["attendance-status"].textContent, /Firebase denied access/);

  await harness.elements["sign-out"].dispatch("click");
  await settle();
  assert.match(harness.elements["dashboard-status"].textContent, /Firebase denied access/);
  assert.ok(harness.events.some((entry) => entry.name === "dashboard.load.failed"));
  assert.ok(harness.events.some((entry) => entry.name === "attendance.load.failed"));
  assert.ok(harness.events.some((entry) => entry.name === "cloud.auth.failed"));

  harness.auth(null, Object.assign(new Error("index missing"), { code: "failed-precondition" }));
  assert.match(harness.elements["dashboard-status"].textContent, /needs an index/);
});

test("the dashboard disables sign-in when its Firebase client is missing", async () => {
  const harness = createAdminHarness({ cloud: null });
  await settle();

  assert.equal(harness.elements["sign-in"].disabled, true);
  assert.equal(
    harness.elements["dashboard-status"].textContent,
    "The Firebase client could not be loaded.",
  );
  assert.equal(harness.elements["dashboard-status"].dataset.state, "error");
  assert.ok(harness.events.some((entry) => entry.name === "client.error"));
});
