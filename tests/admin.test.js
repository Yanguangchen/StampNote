process.env.TZ = "UTC";

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
    this.open = false;
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

  prepend(...children) {
    const existing = this.children;
    this.children = [];
    this.append(...children);
    this.children.push(...existing);
  }

  async dispatch(name) {
    return this.listeners.get(name)?.({
      target: this,
      preventDefault() {},
    });
  }

  close() {
    this.open = false;
  }

  focus() {}

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === "src") this.src = "";
    if (name === "open") this.open = false;
  }

  replaceChildren(...children) {
    this.children.forEach((child) => child?.setConnected?.(false));
    this.children = [];
    this.append(...children);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "open") this.open = true;
  }

  select() {}

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

function elementsWithClass(element, className) {
  return descendants(element).filter((entry) =>
    String(entry.className || "").split(/\s+/).includes(className),
  );
}

function scopeOptions(element) {
  return elementsWithClass(element, "scope-option");
}

function optionTitles(element) {
  return scopeOptions(element).map((option) => option.children[0].textContent);
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
    gpsLocation: { latitude: 1.2868, longitude: 103.8545, accuracyMeters: 15 },
    people: 2,
    uniquePeopleSeen: 5,
    poseDetected: false,
    aiReview: { action: "keep", recommendation: "keep", confidence: 0.96, reason: "Useful." },
    ...overrides,
  };
}

function createAdminHarness(options = {}) {
  const ids = [
    "theme-toggle",
    "theme-toggle-icon",
    "theme-toggle-label",
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
    "dialog-gps-reference",
    "dialog-coordinate-status",
    "dialog-people",
    "dialog-review",
    "attendance-refresh",
    "attendance-worker-filter",
    "attendance-status",
    "attendance-list",
    "present-worker-count",
    "attendance-checkin-count",
    "location-options",
    "date-options",
    "session-options",
    "scope-breadcrumb",
    "session-actions",
    "session-rename",
    "session-delete",
    "session-rename-dialog",
    "session-rename-form",
    "session-rename-input",
    "session-rename-error",
    "session-rename-cancel",
    "session-rename-save",
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  elements["photo-filter"].value = "all";
  elements["attendance-worker-filter"].value = "all";
  elements["photo-library"].setConnected(true);
  elements["photo-dialog"].showModal = function showModal() {
    this.open = true;
  };
  elements["session-rename-dialog"].showModal = function showModal() {
    this.open = true;
  };

  const events = [];
  const configured = [];
  const revoked = [];
  const objectUrls = [];
  const windowListeners = new Map();
  const confirmations = [];
  const cloudCalls = {
    attendance: [],
    blobs: [],
    deletedSessions: [],
    dashboardSessions: 0,
    pages: [],
    renamedSessions: [],
    updatedTruckLocations: [],
    signIn: 0,
    signOut: 0,
  };
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
        async getDashboardSessions() {
          cloudCalls.dashboardSessions += 1;
          if (options.dashboardSessionsError) throw options.dashboardSessionsError;
          return options.dashboardSessions || [];
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
        async renameSession(session) {
          cloudCalls.renamedSessions.push(session);
          if (options.renameError) throw options.renameError;
          return {
            ...session,
            key: cloudData.createSessionKey(session),
          };
        },
        async updateSessionTruckLocation(session, truckLocationInput) {
          const truckLocation = cloudData.cleanTruckLocation(truckLocationInput);
          cloudCalls.updatedTruckLocations.push({ session, truckLocation });
          if (options.coordinateError) throw options.coordinateError;
          return {
            ...session,
            key: cloudData.createSessionKey(session),
            truckLocation,
          };
        },
        async deleteSession(session) {
          cloudCalls.deletedSessions.push(session);
          if (options.deleteError) throw options.deleteError;
          return options.deleteResult || {
            attendanceDeleted: 0,
            attendanceEventIds: [],
            photoDeleted: 1,
            photoIds: ["kept"],
          };
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
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
    },
    matchMedia(query) {
      return {
        matches: query.includes("dark") && options.systemDark === true,
        addEventListener(name, callback) {
          mediaListeners.set(name, callback);
        },
      };
    },
    confirm(message) {
      confirmations.push(message);
      return options.confirmResult !== false;
    },
  };
  const storage = new Map(
    options.storedTheme ? [["stampnote-theme", options.storedTheme]] : [],
  );
  const mediaListeners = new Map();
  const document = {
    documentElement: new FakeElement("html"),
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
    confirmations,
    configured,
    elements,
    events,
    mediaListeners,
    root: document.documentElement,
    storage,
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
  assert.match(adminHtml, /id="location-options"/);
  assert.match(adminHtml, /id="date-options"/);
  assert.match(adminHtml, /id="session-options"/);
  assert.match(adminHtml, /id="scope-breadcrumb"/);
  assert.match(adminHtml, /id="session-rename"/);
  assert.match(adminHtml, /id="session-delete"/);
  assert.match(adminHtml, /id="session-rename-dialog"/);
  assert.match(adminCss, /\.dashboard-workspace\s*\{[^}]*grid-template-columns:/);
  assert.match(adminCss, /\.scope-rail\s*\{/);
  assert.match(adminCss, /\.session-option-actions\s*\{/);
  assert.match(adminCss, /\.dashboard-panel\s*\{[^}]*backdrop-filter:\s*var\(--blur\)/);
  assert.match(adminCss, /--blur:\s*blur\(/);
  assert.doesNotMatch(adminHtml, /Authenticated cloud library/);
  assert.doesNotMatch(adminHtml, /Only Gemini-reviewed batches appear here/);
  assert.doesNotMatch(adminHtml, /system-health|System online/);
  assert.match(adminHtml, /<output\b[^>]*id="dialog-location"[^>]*aria-readonly="true"/);
  assert.match(adminHtml, /Set the Truck location X and Y inside each session/);
  assert.match(adminHtml, /id="dialog-coordinate-status"/);
  assert.doesNotMatch(adminHtml, /id="vehicle-coordinate-form"/);
  assert.doesNotMatch(adminHtml, /id="dashboard-vehicle-coordinate-[xy]"/);
  assert.doesNotMatch(adminHtml, /<input\b[^>]*(?:name|id)="(?:location|dialog-location)"/i);
});

test("session cards expose Truck location X and Y plus rename and delete controls", async () => {
  const harness = createAdminHarness();
  await settle();
  harness.auth({ uid: "user-1", email: "owner@example.com" });
  await settle();

  const sessionOptions = harness.elements["session-options"];
  const renameButtons = elementsWithClass(sessionOptions, "session-option-rename");
  const deleteButtons = elementsWithClass(sessionOptions, "session-option-delete");
  const truckLocationForms = elementsWithClass(sessionOptions, "truck-location-form");
  assert.deepEqual(renameButtons.map((button) => button.textContent), ["Rename", "Rename"]);
  assert.deepEqual(deleteButtons.map((button) => button.textContent), ["Delete", "Delete"]);
  assert.equal(truckLocationForms.length, 2);
  assert.deepEqual(
    truckLocationForms.map((form) => form.attributes.get("aria-label")),
    ["Truck location for Morning session", "Truck location for Afternoon session"],
  );
  assert.deepEqual(
    descendants(truckLocationForms[1])
      .filter((entry) => entry.dataset.coordinateAxis)
      .map((entry) => entry.dataset.coordinateAxis),
    ["x", "y"],
  );
  assert.equal(harness.elements["session-actions"].hidden, true);

  const [xInput, yInput] = descendants(truckLocationForms[1]).filter(
    (entry) => entry.dataset.coordinateAxis,
  );
  xInput.value = "103.8555";
  yInput.value = "1.2868";
  await truckLocationForms[1].dispatch("submit");
  await settle();

  assert.equal(harness.cloudCalls.updatedTruckLocations.length, 1);
  assert.equal(harness.cloudCalls.updatedTruckLocations[0].session.sessionId, "afternoon");
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.cloudCalls.updatedTruckLocations[0].truckLocation)),
    { x: 103.8555, y: 1.2868 },
  );
  const savedInputs = descendants(elementsWithClass(sessionOptions, "truck-location-form")[1])
    .filter((entry) => entry.dataset.coordinateAxis);
  assert.deepEqual(savedInputs.map((entry) => entry.value), ["103.8555", "1.2868"]);

  await elementsWithClass(sessionOptions, "session-option-rename")[1].dispatch("click");
  assert.equal(harness.elements["session-rename-dialog"].open, true);
  assert.equal(harness.elements["session-rename-input"].value, "Afternoon");
  harness.elements["session-rename-input"].value = "  PM   site walk ";
  await harness.elements["session-rename-form"].dispatch("submit");
  await settle();

  assert.equal(harness.cloudCalls.renamedSessions.length, 1);
  assert.equal(harness.cloudCalls.renamedSessions[0].label, "PM site walk");
  assert.equal(harness.elements["session-rename-dialog"].open, false);
  assert.match(harness.elements["scope-breadcrumb"].textContent, /Whole day$/);
  assert.equal(optionTitles(sessionOptions)[2], "PM site walk · 12:34 PM");

  await elementsWithClass(sessionOptions, "session-option-delete")[1].dispatch("click");
  await settle();

  assert.equal(harness.confirmations.length, 1);
  assert.match(harness.confirmations[0], /cannot be undone/i);
  assert.equal(harness.cloudCalls.deletedSessions.length, 1);
  assert.equal(harness.cloudCalls.deletedSessions[0].label, "PM site walk");
  assert.deepEqual(optionTitles(sessionOptions), ["Whole day", "Morning · 1:00 AM – 11:00 AM"]);
  assert.equal(harness.elements["session-actions"].hidden, true);
  assert.match(harness.elements["dashboard-status"].textContent, /Deleted PM site walk/);
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
  assert.equal(harness.elements["dashboard-status"].textContent, "2 photos");
  assert.equal(harness.elements["load-more-row"].hidden, false);
  assert.equal(harness.cloudCalls.pages.length, 1);
  assert.equal(harness.cloudCalls.pages[0].pageSize, 48);
  assert.equal(harness.cloudCalls.pages[0].after, null);
  assert.equal(harness.cloudCalls.attendance.length, 1);
  assert.equal(harness.cloudCalls.attendance[0].pageSize, 500);
  assert.equal(harness.cloudCalls.attendance[0].dateKey, undefined);
  assert.deepEqual(harness.cloudCalls.blobs.sort(), ["flagged", "kept"]);

  // The dashboard opens on one location, one date and the whole of that day.
  const attendanceList = harness.elements["attendance-list"];
  const locationOptions = harness.elements["location-options"];
  const dateOptions = harness.elements["date-options"];
  const sessionOptions = harness.elements["session-options"];
  assert.deepEqual(optionTitles(locationOptions), ["Orchard Road", "10 Marina Bay"]);
  assert.equal(locationOptions.children[1].dataset.selected, "true");
  assert.equal(dateOptions.children.length, 2);
  assert.equal(dateOptions.children[1].dataset.selected, "true");
  assert.deepEqual(optionTitles(sessionOptions), [
    "Whole day",
    "Morning · 1:00 AM – 11:00 AM",
    "Afternoon · 12:34 PM",
  ]);
  assert.equal(scopeOptions(sessionOptions)[0].dataset.selected, "true");
  assert.match(harness.elements["scope-breadcrumb"].textContent, /^10 Marina Bay · /);
  assert.match(harness.elements["scope-breadcrumb"].textContent, /Whole day$/);

  assert.equal(harness.elements["present-worker-count"].textContent, "1");
  assert.equal(harness.elements["attendance-checkin-count"].textContent, "1");
  assert.equal(
    descendants(attendanceList).filter((entry) => entry.className === "attendance-row").length,
    1,
  );
  // The two summary tiles carry the counts, so the status line stays silent
  // unless attendance is loading or failed.
  assert.equal(harness.elements["attendance-status"].textContent, "");
  assert.deepEqual(
    harness.elements["attendance-worker-filter"].children.map((entry) => entry.textContent),
    ["All workers", "Ari Tan · WORKER-7"],
  );

  // Choosing another site swaps both the roster and the photographs below it.
  await locationOptions.children[0].dispatch("click");
  assert.match(harness.elements["scope-breadcrumb"].textContent, /^Orchard Road · /);
  assert.equal(harness.elements["present-worker-count"].textContent, "2");
  assert.equal(harness.elements["attendance-checkin-count"].textContent, "2");
  assert.equal(dateOptions.children.length, 1);
  assert.deepEqual(optionTitles(sessionOptions), ["Whole day", "Morning · 2:00 AM – 7:00 AM"]);
  assert.equal(harness.elements["dashboard-status"].textContent, "0 photos");
  assert.deepEqual(
    harness.elements["attendance-worker-filter"].children.map((entry) => entry.textContent),
    ["All workers", "Ari Tan · WORKER-7", "Bo Lim · WORKER-9"],
  );

  harness.elements["attendance-worker-filter"].value = "WORKER-9";
  await harness.elements["attendance-worker-filter"].dispatch("change");
  assert.equal(harness.elements["attendance-checkin-count"].textContent, "1");
  assert.equal(
    descendants(attendanceList).filter((entry) => entry.className === "attendance-row").length,
    1,
  );
  assert.equal(harness.elements["attendance-status"].textContent, "");

  harness.elements["attendance-worker-filter"].value = "all";
  await harness.elements["attendance-worker-filter"].dispatch("change");

  // Back to the site that holds the photographs, then down to one time session.
  await locationOptions.children[1].dispatch("click");
  await dateOptions.children[1].dispatch("click");
  await scopeOptions(sessionOptions)[2].dispatch("click");
  assert.match(harness.elements["scope-breadcrumb"].textContent, /Afternoon session$/);
  assert.equal(harness.elements["attendance-checkin-count"].textContent, "0");
  assert.match(
    attendanceList.children[0].textContent,
    /No worker checked in during this session/,
  );
  assert.equal(harness.elements["dashboard-status"].textContent, "1 photo");

  await scopeOptions(sessionOptions)[0].dispatch("click");

  // Truck coordinates belong to the session and can be entered manually or by RPA.
  const afternoonTruckForm = elementsWithClass(sessionOptions, "truck-location-form")[1];
  const [truckX, truckY] = descendants(afternoonTruckForm).filter(
    (entry) => entry.dataset.coordinateAxis,
  );
  truckX.value = "103.8555";
  truckY.value = "1.2868";
  await afternoonTruckForm.dispatch("submit");
  await settle();
  assert.equal(harness.cloudCalls.updatedTruckLocations.length, 1);
  assert.equal(harness.cloudCalls.updatedTruckLocations[0].session.sessionId, "afternoon");

  const library = harness.elements["photo-library"];
  const cards = descendants(library).filter((entry) => entry.className === "photo-card");
  assert.equal(cards.length, 2);
  const badges = descendants(library).filter((entry) => entry.className === "photo-badge");
  assert.deepEqual(badges.map((entry) => entry.textContent), [
    "GPS discrepancy",
    "Uncertain AI flag",
  ]);

  const firstButton = descendants(cards[0]).find((entry) => entry.className === "photo-open");
  await firstButton.dispatch("click");
  await settle();
  assert.equal(harness.elements["photo-dialog"].open, true);
  assert.equal(harness.elements["dialog-location"].textContent, "10 Marina Bay");
  assert.equal(
    harness.elements["dialog-gps-reference"].textContent,
    "Automatic GPS · X 103.8545 · Y 1.2868 · accuracy ±15 m",
  );
  assert.match(harness.elements["dialog-coordinate-status"].textContent, /Truck location/);
  assert.match(harness.elements["dialog-coordinate-status"].textContent, /X 103\.8555/);
  assert.match(harness.elements["dialog-coordinate-status"].textContent, /Flagged/);
  assert.match(harness.elements["dialog-coordinate-status"].textContent, /accuracy threshold 15 m/);
  assert.equal(
    harness.elements["dialog-people"].textContent,
    "2 people in this photo · 5 unique people seen this session",
  );
  assert.match(harness.elements["dialog-review"].textContent, /confidence/);
  assert.match(harness.elements["dialog-image"].src, /^blob:dashboard-/);

  harness.elements["photo-filter"].value = "location-flagged";
  await harness.elements["photo-filter"].dispatch("change");
  await settle();
  assert.equal(harness.elements["dashboard-status"].textContent, "1 of 2 photos");
  assert.equal(
    descendants(library).filter((entry) => entry.className === "photo-card").length,
    1,
  );

  harness.elements["photo-filter"].value = "flagged";
  await harness.elements["photo-filter"].dispatch("change");
  await settle();
  assert.equal(harness.elements["dashboard-status"].textContent, "1 of 2 photos");
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
  // The tally counts the photos in the chosen scope, not every photo the page
  // happens to hold: the third one belongs to another site.
  assert.equal(harness.elements["dashboard-status"].textContent, "2 photos");
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

test("the dashboard theme follows the system until the header toggle pins one", async () => {
  assert.match(adminHtml, /id="theme-toggle"/);
  assert.match(adminHtml, /stampnote-theme/);
  assert.match(adminCss, /:root\[data-theme="dark"\]/);
  assert.match(adminCss, /prefers-color-scheme: dark/);

  const harness = createAdminHarness();
  await settle();
  assert.equal(harness.root.dataset.theme, undefined);
  assert.equal(harness.elements["theme-toggle-label"].textContent, "Dark");
  assert.equal(harness.elements["theme-toggle"].attributes.get("aria-pressed"), "false");

  await harness.elements["theme-toggle"].dispatch("click");
  assert.equal(harness.root.dataset.theme, "dark");
  assert.equal(harness.storage.get("stampnote-theme"), "dark");
  assert.equal(harness.elements["theme-toggle-label"].textContent, "Light");
  assert.equal(harness.elements["theme-toggle"].attributes.get("aria-pressed"), "true");

  await harness.elements["theme-toggle"].dispatch("click");
  assert.equal(harness.root.dataset.theme, "light");
  assert.equal(harness.storage.get("stampnote-theme"), "light");
});

test("a saved dark theme is restored and a dark system keeps the toggle honest", async () => {
  const pinned = createAdminHarness({ storedTheme: "dark" });
  await settle();
  assert.equal(pinned.root.dataset.theme, "dark");
  assert.equal(pinned.elements["theme-toggle-label"].textContent, "Light");

  const system = createAdminHarness({ systemDark: true });
  await settle();
  assert.equal(system.root.dataset.theme, undefined);
  assert.equal(system.elements["theme-toggle-label"].textContent, "Light");

  await system.elements["theme-toggle"].dispatch("click");
  assert.equal(system.root.dataset.theme, "light");
});
