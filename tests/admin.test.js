process.env.TZ = "UTC";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const cloudData = require("../photo-cloud.js");
const weatherService = require("../weather-service.js");
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

// Two sites a couple of kilometres apart, so a fixture never merges by accident.
const SITE_FIXES = {
  "10 Marina Bay": { latitude: 1.2868, longitude: 103.8545 },
  "Orchard Road": { latitude: 1.3048, longitude: 103.8318 },
};

function photo(id, overrides = {}) {
  const capturedAtMs = Date.parse(overrides.capturedAt || "2026-08-13T12:34:56.000Z");
  const location = overrides.location || "10 Marina Bay";
  const fix = SITE_FIXES[location] || SITE_FIXES["10 Marina Bay"];
  return {
    id,
    capturedAt: new Date(capturedAtMs).toISOString(),
    capturedAtMs,
    location,
    locationKey: cloudData.createLocationKey(location),
    dateKey: cloudData.createDateKey(capturedAtMs),
    imageBytes: 4096,
    gpsLocation: { ...fix, accuracyMeters: 15 },
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
    "date-picker",
    "date-hint",
    "date-search",
    "date-search-toggle",
    "date-search-label",
    "session-options",
    "scope-breadcrumb",
    "scope-guidance",
    "date-step",
    "session-step",
    "detail-column",
    "session-facts",
    "photos-panel",
    "session-actions",
    "session-truck-location",
    "session-weather",
    "session-rename",
    "location-delete",
    "date-delete",
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
    weather: [],
    savedWeather: [],
    signIn: 0,
    signOut: 0,
  };
  let authCallback;
  // Stands in for what Firestore keeps between reloads.
  const storedSessions = new Map();
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
          return [...(options.dashboardSessions || []), ...storedSessions.values()];
        },
        async updateSessionWeather(session, weatherInput) {
          cloudCalls.savedWeather.push({ session, weather: weatherInput });
          if (options.weatherSaveError) throw options.weatherSaveError;
          const key = cloudData.createSessionKey(session);
          const saved = {
            ...session,
            key,
            weather: cloudData.cleanSessionWeather(weatherInput),
          };
          storedSessions.set(key, saved);
          return saved;
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
        async deleteScope(scope) {
          cloudCalls.deletedSessions.push(scope);
          if (options.deleteError) throw options.deleteError;
          return options.deleteResult || {
            attendanceDeleted: 0,
            attendanceEventIds: [],
            photoDeleted: 1,
            photoIds: ["kept"],
            sessionKeys: [],
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
    StampNoteWeather:
      options.weather === null
        ? null
        : {
            ...weatherService,
            fetchDayWeather(input) {
              cloudCalls.weather.push(input);
              if (options.weatherError) return Promise.reject(options.weatherError);
              return Promise.resolve(options.weatherRows || []);
            },
          },
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

// The rail answers nothing on its own, so a test that wants the detail side
// walks its three steps. Session 0 is "Whole day".
async function chooseScope(harness, { location = 1, date = 0, session = 0 } = {}) {
  await scopeOptions(harness.elements["location-options"])[location].dispatch("click");
  await settle();
  await scopeOptions(harness.elements["date-options"])[date].dispatch("click");
  await settle();
  await scopeOptions(harness.elements["session-options"])[session].dispatch("click");
  await settle();
}

test("photos and daily attendance share one dashboard without status or access-copy clutter", () => {
  assert.match(adminHtml, /Photos &amp; attendance/);
  assert.match(adminHtml, /id="photo-library"/);
  assert.match(adminHtml, /id="attendance-list"/);
  assert.match(adminHtml, /id="attendance-worker-filter"/);
  assert.match(adminHtml, /id="location-options"/);
  assert.match(adminHtml, /id="date-options"/);
  assert.match(adminHtml, /<input\b[^>]*type="date"[^>]*id="date-picker"/);
  assert.match(adminHtml, /id="session-options"/);
  assert.match(adminHtml, /id="scope-breadcrumb"/);
  assert.match(adminHtml, /id="session-rename"/);
  assert.match(adminHtml, /id="session-delete"/);
  // A glyph apiece rather than the word three times: each column is narrow, and
  // what would be spelled out is the thing the column already names. The name is
  // still in the markup, so the button is called something to a reader that
  // cannot see the bin.
  ["location", "date", "session"].forEach((level) => {
    assert.match(
      adminHtml,
      new RegExp(`id="${level}-delete"[\\s\\S]*?<svg class="scope-delete-icon"`),
    );
    assert.match(
      adminHtml,
      new RegExp(`id="${level}-delete"[\\s\\S]*?<span class="scope-delete-label">Delete `),
    );
  });
  // Geometry shared with the date step's search button, so a step's controls are
  // the same size whatever they do.
  assert.match(adminCss, /\.scope-delete,\s*\.scope-search\s*\{[^}]*width:\s*26px/);
  assert.match(adminCss, /\.scope-delete-icon,\s*\.scope-search-icon\s*\{[^}]*stroke:\s*currentColor/);
  assert.match(adminHtml, /id="session-truck-location"/);
  assert.match(adminHtml, /id="session-rename-dialog"/);
  assert.match(adminCss, /\.dashboard-workspace\s*\{[^}]*grid-template-columns:/);
  // Location, then date, then session, running left to right across the page.
  assert.match(adminCss, /\.scope-rail\s*\{[^}]*grid-template-columns:\s*repeat\(3,/);
  assert.match(adminCss, /\.scope-rail-heading\s*\{[^}]*grid-column:\s*1 \/ -1/);
  // On a desktop the roster sits beside the photographs. Stacked, it spent the
  // full 1313px to show a number and a word, and pushed the photographs to
  // y=1161 — below the fold of a 900px screen.
  assert.match(adminHtml, /class="detail-column"/);
  assert.match(
    adminCss,
    /@media \(min-width: 1100px\)\s*\{[\s\S]*?\.dashboard-detail\s*\{[^}]*grid-template-columns:/,
  );

  // In that narrow column the heading stacks above its filter, which only holds
  // if these rules are read after the ones they revise. A media query carries no
  // extra specificity, so declared earlier the column direction applied while the
  // stretch did not — and stretching cancelled leaves `align-items: end`, which
  // down a column is the right-hand edge.
  const desktopBlock = adminCss.indexOf("@media (min-width: 1100px)");
  assert.ok(desktopBlock > 0, "the desktop layout block exists");
  assert.ok(
    desktopBlock > adminCss.indexOf(".attendance-heading {"),
    "the desktop overrides are declared after the attendance heading they revise",
  );
  assert.ok(
    desktopBlock > adminCss.indexOf(".attendance-filter {"),
    "the desktop overrides are declared after the attendance filter they revise",
  );

  assert.match(adminCss, /\.session-truck-location\s*\{/);

  // The sky and the truck's coordinates read across one row as matched tiles.
  // Flex rather than two grid columns, so a session with only one of them gives
  // that one the full width instead of leaving a reserved column empty beside it;
  // equal basis and equal grow on both is what makes the pair match.
  assert.match(
    adminHtml,
    /<div class="session-facts" id="session-facts" hidden>[\s\S]*?id="session-weather"[\s\S]*?id="session-truck-location"[\s\S]*?<\/div>/,
  );
  assert.match(adminCss, /\.session-facts\s*\{[^}]*display: flex/);
  assert.match(adminCss, /\.session-facts\s*\{[^}]*flex-wrap: wrap/);
  assert.match(adminCss, /\.session-facts\s*\{[^}]*align-items: stretch/);
  assert.match(
    adminCss,
    /\.session-facts > \.session-weather,\s*\n\.session-facts > \.session-truck-location\s*\{[^}]*flex: 1 1 260px/,
  );
  // Half of the 380px column will not seat a longitude beside a latitude, so the
  // band takes the whole pane instead and the coordinates stay side by side.
  assert.match(
    adminCss,
    /@media \(min-width: 1100px\)\s*\{[\s\S]*?\.scope-summary,\s*\n\s*\.session-facts\s*\{[^}]*grid-column: 1 \/ -1/,
  );
  assert.match(adminCss, /\.truck-location-form fieldset\s*\{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  // Matched tiles means matched insets and a shared bottom edge, with the shorter
  // of the two spreading its lines rather than bunching them at the top.
  assert.match(adminCss, /\.session-weather\s*\{[^}]*align-content: space-between/);
  assert.match(adminCss, /\.truck-location-form\s*\{[^}]*align-content: space-between/);
  assert.match(adminCss, /\.session-weather\s*\{[^}]*padding: 12px 14px/);
  assert.match(adminCss, /\.truck-location-form\s*\{[^}]*padding: 12px 14px/);
  assert.match(adminCss, /\.session-truck-location\s*\{[^}]*display: grid/);
  assert.match(adminCss, /\.scope-date-field\s*\{/);
  assert.match(adminCss, /\.dashboard-panel\s*\{[^}]*backdrop-filter:\s*var\(--blur\)/);
  assert.match(adminCss, /--blur:\s*blur\(/);
  assert.doesNotMatch(adminHtml, /Authenticated cloud library/);
  assert.doesNotMatch(adminHtml, /Only Gemini-reviewed batches appear here/);
  assert.doesNotMatch(adminHtml, /system-health|System online/);
  assert.match(adminHtml, /<output\b[^>]*id="dialog-location"[^>]*aria-readonly="true"/);
  // The rail already names the location, date and session, so the page title
  // and the scope line are kept for the outline and the live region only, and
  // the session step no longer explains what its own fields are for.
  assert.doesNotMatch(adminHtml, /Pick a session to set its Truck location X and Y/);
  assert.match(
    adminCss,
    /\.intro,\s*\n\.scope-breadcrumb,[^{]*\{[^}]*clip:\s*rect\(0, 0, 0, 0\)/,
  );
  // Side by side, a cap per column bounds the whole band rather than stacking
  // three scrollers into more height than the viewport has.
  assert.match(adminCss, /\.scope-options\s*\{[^}]*max-height:\s*clamp\(/);
  assert.match(adminCss, /\.scope-options\s*\{[^}]*overflow-y:\s*auto/);
  assert.doesNotMatch(adminCss, /\.scope-rail\s*\{[^}]*position:\s*sticky/);
  assert.match(adminHtml, /id="dialog-coordinate-status"/);
  assert.doesNotMatch(adminHtml, /id="vehicle-coordinate-form"/);
  assert.doesNotMatch(adminHtml, /id="dashboard-vehicle-coordinate-[xy]"/);
  assert.doesNotMatch(adminHtml, /<input\b[^>]*(?:name|id)="(?:location|dialog-location)"/i);
});

test("the selected session carries its Truck location, rename and delete in the detail pane", async () => {
  const harness = createAdminHarness();
  await settle();
  harness.auth({ uid: "user-1", email: "owner@example.com" });
  await settle();

  const truckHost = harness.elements["session-truck-location"];

  // Nothing below the rail exists until the rail has been answered, and step one
  // is left to speak for itself rather than being narrated underneath.
  assert.equal(harness.elements["detail-column"].hidden, true);
  assert.equal(harness.elements["photos-panel"].hidden, true);
  assert.equal(harness.elements["scope-guidance"].hidden, true);
  assert.equal(harness.elements["scope-guidance"].textContent, "");

  await chooseScope(harness, { location: 1, date: 1 });
  const sessionOptions = harness.elements["session-options"];

  // The rail is rows only. A step holding three fixed periods used to carry three
  // coordinate forms and six buttons, which is what made it taller than the page.
  assert.equal(elementsWithClass(sessionOptions, "truck-location-form").length, 0);
  assert.equal(elementsWithClass(sessionOptions, "session-option-rename").length, 0);
  assert.equal(elementsWithClass(sessionOptions, "session-option-delete").length, 0);

  // Nothing to rename or place while the whole day is in view.
  assert.equal(harness.elements["session-actions"].hidden, true);
  assert.equal(truckHost.hidden, true);
  assert.equal(truckHost.children.length, 0);

  await scopeOptions(sessionOptions)[2].dispatch("click");
  await settle();

  assert.equal(harness.elements["session-actions"].hidden, false);
  assert.equal(truckHost.hidden, false);
  const truckLocationForms = elementsWithClass(truckHost, "truck-location-form");
  assert.equal(truckLocationForms.length, 1, "one form, for the session being looked at");
  assert.equal(
    truckLocationForms[0].attributes.get("aria-label"),
    "Truck location for Afternoon session",
  );
  assert.deepEqual(
    descendants(truckLocationForms[0])
      .filter((entry) => entry.dataset.coordinateAxis)
      .map((entry) => entry.dataset.coordinateAxis),
    ["x", "y"],
  );

  const [xInput, yInput] = descendants(truckLocationForms[0]).filter(
    (entry) => entry.dataset.coordinateAxis,
  );
  xInput.value = "103.8555";
  yInput.value = "1.2868";
  await truckLocationForms[0].dispatch("submit");
  await settle();

  assert.equal(harness.cloudCalls.updatedTruckLocations.length, 1);
  assert.equal(harness.cloudCalls.updatedTruckLocations[0].session.sessionId, "afternoon");
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.cloudCalls.updatedTruckLocations[0].truckLocation)),
    { x: 103.8555, y: 1.2868 },
  );
  const savedInputs = descendants(elementsWithClass(truckHost, "truck-location-form")[0]).filter(
    (entry) => entry.dataset.coordinateAxis,
  );
  assert.deepEqual(savedInputs.map((entry) => entry.value), ["103.8555", "1.2868"]);

  await harness.elements["session-rename"].dispatch("click");
  assert.equal(harness.elements["session-rename-dialog"].open, true);
  assert.equal(harness.elements["session-rename-input"].value, "Afternoon");
  harness.elements["session-rename-input"].value = "  PM   site walk ";
  await harness.elements["session-rename-form"].dispatch("submit");
  await settle();

  assert.equal(harness.cloudCalls.renamedSessions.length, 1);
  assert.equal(harness.cloudCalls.renamedSessions[0].label, "PM site walk");
  assert.equal(harness.elements["session-rename-dialog"].open, false);
  assert.match(harness.elements["scope-breadcrumb"].textContent, /PM site walk session$/);
  assert.equal(optionTitles(sessionOptions)[2], "PM site walk · 12:34 PM");

  await harness.elements["session-delete"].dispatch("click");
  await settle();

  assert.equal(harness.confirmations.length, 1);
  assert.match(harness.confirmations[0], /cannot be undone/i);
  assert.equal(harness.cloudCalls.deletedSessions.length, 1);
  // The narrowest scope: this period, of this day, at this site.
  assert.equal(harness.cloudCalls.deletedSessions[0].sessionId, "afternoon");
  assert.equal(harness.cloudCalls.deletedSessions[0].dateKey, "2026-08-13");
  assert.deepEqual(optionTitles(sessionOptions), ["Whole day", "Morning · 1:00 AM – 11:00 AM"]);
  // Deleting what was selected falls back to the whole day, so the form goes away.
  assert.equal(harness.elements["session-actions"].hidden, true);
  assert.equal(truckHost.hidden, true);
  assert.match(harness.elements["dashboard-status"].textContent, /Deleted PM site walk/);
});

test("each step deletes at its own level, so a site need not be cleared a session at a time", async () => {
  const harness = createAdminHarness();
  await settle();
  harness.auth({ uid: "user-1", email: "owner@example.com" });
  await settle();

  const locationOptions = harness.elements["location-options"];
  const dateOptions = harness.elements["date-options"];
  const locationDelete = harness.elements["location-delete"];
  const dateDelete = harness.elements["date-delete"];
  const sessionDelete = harness.elements["session-delete"];
  const marinaBay = () =>
    scopeOptions(locationOptions).find(
      (option) => option.children[0].textContent === "10 Marina Bay",
    );

  // A level can only be deleted once something is chosen at it.
  assert.equal(locationDelete.disabled, true);
  assert.equal(dateDelete.disabled, true);
  assert.equal(sessionDelete.disabled, true);

  await marinaBay().dispatch("click");
  await settle();
  assert.equal(locationDelete.disabled, false);
  assert.equal(dateDelete.disabled, true, "no day chosen yet");
  assert.equal(sessionDelete.disabled, true);

  await scopeOptions(dateOptions)[0].dispatch("click");
  await settle();
  assert.equal(dateDelete.disabled, false);

  // A day goes with every session in it, named as a day rather than a session.
  await dateDelete.dispatch("click");
  await settle();

  assert.match(harness.confirmations.at(-1), /every time session in it/);
  assert.match(harness.confirmations.at(-1), /cannot be undone/i);
  const dayScope = harness.cloudCalls.deletedSessions.at(-1);
  assert.equal(dayScope.locationKey, cloudData.createLocationKey("10 Marina Bay"));
  assert.match(dayScope.dateKey, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(dayScope.sessionId, undefined, "a whole day names no period");
  // The site it belonged to survives and stays chosen; the day does not.
  assert.ok(marinaBay(), "the site is still listed");
  assert.equal(dateDelete.disabled, true);

  // And the site itself goes in one press, without naming a day at all.
  await dateDelete.dispatch("click");
  assert.equal(
    harness.cloudCalls.deletedSessions.length,
    1,
    "a disabled step deletes nothing",
  );

  await locationDelete.dispatch("click");
  await settle();

  assert.match(harness.confirmations.at(-1), /everything recorded there/);
  const siteScope = harness.cloudCalls.deletedSessions.at(-1);
  assert.equal(siteScope.locationKey, cloudData.createLocationKey("10 Marina Bay"));
  assert.equal(siteScope.dateKey, undefined, "a whole site names no day");
  assert.equal(siteScope.sessionId, undefined);
  assert.equal(marinaBay(), undefined, "the site is gone from the rail");
  // Its neighbour is untouched, and nothing is chosen any more.
  assert.deepEqual(optionTitles(locationOptions), ["Orchard Road"]);
  assert.equal(locationDelete.disabled, true);
  assert.match(harness.elements["dashboard-status"].textContent, /Deleted 10 Marina Bay/);
});

test("one yard split by GPS error is one row in the rail", async () => {
  // The same site, photographed either side of a fifty metre error. Attendance
  // carries no coordinates at all, only the address it was written with.
  const marina = { latitude: 1.2868, longitude: 103.8545 };
  const across = { latitude: marina.latitude + 48 / 111320, longitude: marina.longitude };
  const harness = createAdminHarness({
    pages: [
      {
        photos: [
          photo("a", { location: "34 Parbury Avenue", gpsLocation: { ...marina, accuracyMeters: 20 } }),
          photo("b", { location: "34 Parbury Avenue", gpsLocation: { ...marina, accuracyMeters: 20 } }),
          photo("c", { location: "32 Parbury Avenue", gpsLocation: { ...across, accuracyMeters: 45 } }),
        ],
        after: null,
        hasMore: false,
      },
    ],
    attendance: [
      {
        eventId: "attendance-1",
        workerId: "WORKER-7",
        displayName: "Ari Tan",
        checkedInAtMs: Date.parse("2026-08-13T12:40:00.000Z"),
        dateKey: "2026-08-13",
        location: "32 Parbury Avenue",
      },
      {
        eventId: "attendance-2",
        workerId: "WORKER-9",
        displayName: "Bo Lim",
        checkedInAtMs: Date.parse("2026-08-13T12:50:00.000Z"),
        dateKey: "2026-08-13",
        location: "34 Parbury Avenue",
      },
    ],
  });
  await settle();
  harness.auth({ uid: "user-1", email: "owner@example.com" });
  await settle();

  const locationOptions = harness.elements["location-options"];
  assert.deepEqual(optionTitles(locationOptions), ["34 Parbury Avenue"]);
  // The merge is stated, not silent: a reader expecting two rows can see why
  // there is one.
  assert.match(scopeOptions(locationOptions)[0].children[1].textContent, /also 32 Parbury Avenue/);

  await chooseScope(harness, { location: 0, date: 0, session: 0 });

  // Every photograph and both workers belong to the one site.
  assert.equal(harness.elements["dashboard-status"].textContent, "3 photos");
  assert.equal(harness.elements["present-worker-count"].textContent, "2");
  assert.equal(harness.elements["attendance-checkin-count"].textContent, "2");
});

// One day of hourly weather at the site, in the shape the service reads.
function weatherRows(hours) {
  return hours.map((entry) => ({
    dateKey: entry.dateKey || "2026-08-13",
    hour: entry.hour,
    precipitationMm: entry.precipitation ?? 0,
    weatherCode: entry.code ?? 0,
    gustKph: entry.gust ?? 10,
    temperatureC: entry.temperature ?? 31,
  }));
}

test("every session carries its own weather, and a wet one warns of delays", async () => {
  const harness = createAdminHarness({
    weatherRows: weatherRows([
      // A clear morning, then the storm that stopped the afternoon.
      { hour: 9, code: 1 },
      { hour: 10, code: 0 },
      { hour: 12, precipitation: 7.2, code: 95, gust: 71 },
      { hour: 13, precipitation: 3.1, code: 65, gust: 52 },
    ]),
  });
  await settle();
  harness.auth({ uid: "user-1", email: "owner@example.com" });
  await settle();

  await scopeOptions(harness.elements["location-options"])[1].dispatch("click");
  await settle();
  await scopeOptions(harness.elements["date-options"])[1].dispatch("click");
  await settle();

  // One question for the site and the day, not one per session.
  assert.equal(harness.cloudCalls.weather.length, 1);
  assert.equal(harness.cloudCalls.weather[0].dateKey, "2026-08-13");
  // The site's own coordinate, averaged over what was photographed there.
  assert.equal(Math.round(harness.cloudCalls.weather[0].latitude * 1000) / 1000, 1.287);

  const sessionOptions = scopeOptions(harness.elements["session-options"]);
  const morning = sessionOptions.find((option) =>
    option.children[0].textContent.startsWith("Morning"),
  );
  const afternoon = sessionOptions.find((option) =>
    option.children[0].textContent.startsWith("Afternoon"),
  );

  // The weather rides along with each session's counts in the rail.
  assert.match(morning.children[1].textContent, /Mainly clear, no impact/);
  assert.equal(morning.dataset.severity, undefined, "a clear session is not marked");
  // What it was and what it cost, in the words a reader scans for.
  assert.match(afternoon.children[1].textContent, /Thunderstorm, severe impact/);
  assert.equal(afternoon.dataset.severity, "storm", "a reader scanning the day sees this one");
  assert.equal(afternoon.dataset.weather, "storm");

  // Opening the stormy session states the delay plainly.
  await afternoon.dispatch("click");
  await settle();

  const panel = harness.elements["session-weather"];
  assert.equal(panel.hidden, false);
  const badge = elementsWithClass(panel, "weather-badge")[0];
  assert.equal(badge.dataset.severity, "storm");
  // The thunderstorm hour was lost outright and the heavy-rain hour halved:
  // three quarters of a two-hour window, which reads as severe.
  assert.equal(badge.textContent, "Thunderstorm, severe impact");
  assert.equal(elementsWithClass(panel, "weather-icon")[0].textContent, "⛈");
  assert.equal(elementsWithClass(panel, "weather-delay")[0].textContent, "Delays likely");
  // The figures behind the statement stay available underneath it.
  assert.match(elementsWithClass(panel, "weather-figures")[0].textContent, /1.5 h lost of 2/);

  // The clear session has weather but no alert.
  await morning.dispatch("click");
  await settle();
  assert.equal(elementsWithClass(panel, "weather-delay").length, 0);
  assert.equal(elementsWithClass(panel, "weather-badge")[0].dataset.severity, "dry");
  // Every reading states its cost, including the ones that cost nothing.
  assert.equal(elementsWithClass(panel, "weather-badge")[0].textContent, "Mainly clear, no impact");
  assert.equal(elementsWithClass(panel, "weather-icon")[0].textContent, "⛅");
});

test("a session's weather is written down once and read back from then on", async () => {
  const harness = createAdminHarness({
    weatherRows: weatherRows([
      { hour: 12, precipitation: 7.2, code: 95, gust: 71 },
      { hour: 13, precipitation: 3.1, code: 65, gust: 52 },
    ]),
  });
  await settle();
  harness.auth({ uid: "user-1", email: "owner@example.com" });
  await settle();
  await chooseScope(harness, { location: 1, date: 1, session: 0 });

  // The day it learned about is saved against the sessions it belongs to.
  const afternoon = harness.cloudCalls.savedWeather.find(
    (entry) => entry.session.sessionId === "afternoon",
  );
  assert.ok(afternoon, "the afternoon's weather was written down");
  assert.equal(afternoon.session.dateKey, "2026-08-13");
  assert.equal(afternoon.session.locationKey, cloudData.createLocationKey("10 Marina Bay"));
  assert.equal(afternoon.weather.severity, "storm");
  assert.equal(afternoon.weather.condition, "Thunderstorm");
  assert.equal(afternoon.weather.precipitationMm, 10.3);
  assert.equal(afternoon.weather.maxGustKph, 71);
  // 2026-08-13 is long over, so the reading is the record rather than a forecast.
  assert.equal(afternoon.weather.provisional, false);
  // An hour stopped by thunder and an hour halved by heavy rain.
  assert.equal(afternoon.weather.lostHours, 1.5);
  assert.equal(afternoon.weather.impactPercent, 75);
  assert.equal(typeof afternoon.weather.recordedAtMs, "number");

  // A session the service had no hours for is not written down as fine.
  assert.equal(
    harness.cloudCalls.savedWeather.some((entry) => entry.session.sessionId === "morning"),
    false,
  );

  // Written once: opening the day again asks neither the sky nor Firestore.
  const asked = harness.cloudCalls.weather.length;
  const saved = harness.cloudCalls.savedWeather.length;
  await scopeOptions(harness.elements["location-options"])[0].dispatch("click");
  await settle();
  await chooseScope(harness, { location: 1, date: 1, session: 2 });
  assert.equal(harness.cloudCalls.weather.length, asked, "the day is not asked about twice");
  assert.equal(harness.cloudCalls.savedWeather.length, saved, "nor written twice");

  // And the stored reading is what the panel shows.
  const badge = elementsWithClass(harness.elements["session-weather"], "weather-badge")[0];
  assert.equal(badge.dataset.severity, "storm");
  assert.equal(badge.textContent, "Thunderstorm, severe impact");
});

test("a day already recorded is never asked about again", async () => {
  // What a previous visit wrote down, exactly as Firestore would return it.
  const stored = {
    key: cloudData.createSessionKey({
      locationKey: cloudData.createLocationKey("10 Marina Bay"),
      dateKey: "2026-08-13",
      sessionId: "afternoon",
    }),
    location: "10 Marina Bay",
    locationKey: cloudData.createLocationKey("10 Marina Bay"),
    dateKey: "2026-08-13",
    sessionId: "afternoon",
    label: "Afternoon",
    weather: {
      severity: "wet",
      condition: "Heavy rain",
      precipitationMm: 12.4,
      maxGustKph: 31,
      temperatureC: 27,
      wetHours: 3,
      hours: 5,
      lostHours: 2.4,
      impactPercent: 40,
      provisional: false,
      recordedAtMs: Date.parse("2026-08-14T02:00:00.000Z"),
    },
  };
  const harness = createAdminHarness({
    dashboardSessions: [stored],
    pages: [
      {
        photos: [photo("kept", { capturedAt: "2026-08-13T12:34:56.000Z" })],
        after: null,
        hasMore: false,
      },
    ],
    attendance: [],
  });
  await settle();
  harness.auth({ uid: "user-1", email: "owner@example.com" });
  await settle();
  await chooseScope(harness, { location: 0, date: 0, session: 1 });

  // Every session of the day is on record, so nothing is fetched or rewritten.
  assert.equal(harness.cloudCalls.weather.length, 0, "the sky is not asked again");
  assert.equal(harness.cloudCalls.savedWeather.length, 0);

  const panel = harness.elements["session-weather"];
  const badge = elementsWithClass(panel, "weather-badge")[0];
  assert.equal(badge.dataset.severity, "wet");
  // The wording is put back on a stored reading rather than stored with it.
  // The wording and the icon are put back on a stored reading rather than
  // stored with it; the cost it carries is the one that was written down.
  assert.equal(badge.textContent, "Heavy rain, moderate impact");
  assert.equal(elementsWithClass(panel, "weather-icon")[0].textContent, "🌧");
  assert.equal(elementsWithClass(panel, "weather-delay")[0].textContent, "Delays possible");
  assert.match(elementsWithClass(panel, "weather-figures")[0].textContent, /2.4 h lost of 5/);
});

test("a dashboard without weather still works, and a failed lookup says so", async () => {
  // The service is absent: every session keeps its counts and nothing throws.
  const without = createAdminHarness({ weather: null });
  await settle();
  without.auth({ uid: "user-1", email: "owner@example.com" });
  await settle();
  await chooseScope(without, { location: 1, date: 1, session: 0 });
  assert.equal(without.elements["session-weather"].hidden, true);
  assert.equal(without.elements["photos-panel"].hidden, false);

  const failed = createAdminHarness({ weatherError: new Error("Weather service returned 503.") });
  await settle();
  failed.auth({ uid: "user-1", email: "owner@example.com" });
  await settle();
  await chooseScope(failed, { location: 1, date: 1, session: 2 });

  const panel = failed.elements["session-weather"];
  assert.equal(panel.hidden, false);
  const badge = elementsWithClass(panel, "weather-badge")[0];
  assert.equal(badge.dataset.severity, "unavailable");
  assert.match(badge.textContent, /Weather unavailable/);
  // A lookup that failed is not a session that was fine.
  assert.equal(elementsWithClass(panel, "weather-delay").length, 0);
  // The rest of the session is unaffected.
  assert.equal(failed.elements["detail-column"].hidden, false);
});

test("the rail and the detail side are revealed one answered step at a time", async () => {
  const harness = createAdminHarness();
  await settle();
  harness.auth({ uid: "user-1", email: "owner@example.com" });
  await settle();

  // Signed in, the rail offers a location and nothing else.
  assert.equal(harness.elements["date-step"].hidden, true);
  assert.equal(harness.elements["session-step"].hidden, true);
  assert.equal(harness.elements["detail-column"].hidden, true);
  assert.equal(harness.elements["photos-panel"].hidden, true);
  // The guidance frame stays away entirely rather than telling the reader to use
  // the only list on the page.
  assert.equal(harness.elements["scope-guidance"].hidden, true);
  assert.equal(harness.elements["scope-guidance"].textContent, "");

  await scopeOptions(harness.elements["location-options"])[1].dispatch("click");
  await settle();
  assert.equal(harness.elements["date-step"].hidden, false);
  assert.equal(harness.elements["session-step"].hidden, true);
  assert.equal(harness.elements["detail-column"].hidden, true);
  assert.match(harness.elements["scope-guidance"].textContent, /pick a date/i);

  await scopeOptions(harness.elements["date-options"])[1].dispatch("click");
  await settle();
  assert.equal(harness.elements["session-step"].hidden, false);
  assert.equal(harness.elements["detail-column"].hidden, true);
  assert.equal(harness.elements["session-facts"].hidden, true);
  assert.equal(harness.elements["photos-panel"].hidden, true);
  assert.match(harness.elements["scope-guidance"].textContent, /pick a time session/i);

  // Only the third answer brings the photographs, the roster and the fields.
  await scopeOptions(harness.elements["session-options"])[0].dispatch("click");
  await settle();
  assert.equal(harness.elements["detail-column"].hidden, false);
  // The band of facts sits outside the roster's column now, so it is revealed on
  // its own account rather than carried in with it.
  assert.equal(harness.elements["session-facts"].hidden, false);
  assert.equal(harness.elements["photos-panel"].hidden, false);
  assert.equal(harness.elements["scope-guidance"].hidden, true);
  assert.equal(harness.elements["scope-guidance"].textContent, "");

  // Going back up the rail puts the detail side away again rather than leaving
  // one site's photographs on screen under another site's name.
  await scopeOptions(harness.elements["location-options"])[0].dispatch("click");
  await settle();
  assert.equal(harness.elements["session-step"].hidden, true);
  assert.equal(harness.elements["detail-column"].hidden, true);
  assert.equal(harness.elements["session-facts"].hidden, true);
  assert.equal(harness.elements["photos-panel"].hidden, true);
  assert.equal(harness.elements["photo-library"].children.length, 0);
});

test("a month of history keeps the date step short and still reaches any day", async () => {
  // Thirty working days at one site. Given a button each, this step alone grew
  // taller than the column it has to sit in, and every further day made it worse.
  const attendance = Array.from({ length: 30 }, (unused, index) => {
    const day = String(index + 1).padStart(2, "0");
    return {
      eventId: `attendance-${day}`,
      workerId: "WORKER-7",
      displayName: "Ari Tan",
      checkedInAtMs: Date.parse(`2026-06-${day}T01:00:00.000Z`),
      dateKey: `2026-06-${day}`,
      location: "10 Marina Bay",
    };
  });
  const harness = createAdminHarness({
    attendance,
    pages: [{ photos: [], after: null, hasMore: false }],
  });
  await settle();
  harness.auth({ uid: "user-1", email: "owner@example.com" });
  await settle();

  const dateOptions = harness.elements["date-options"];
  const datePicker = harness.elements["date-picker"];

  await scopeOptions(harness.elements["location-options"])[0].dispatch("click");
  await settle();

  assert.equal(scopeOptions(dateOptions).length, 6, "only the newest few earn a button");
  assert.match(harness.elements["date-hint"].textContent, /30 days recorded/);

  // The calendar spans exactly what was recorded, and opens on the day in view.
  assert.equal(datePicker.min, "2026-06-01");
  assert.equal(datePicker.max, "2026-06-30");
  // The calendar spans what was recorded but opens empty: the day is the
  // reader's to choose, not the rail's to assume.
  assert.equal(datePicker.value, "");
  assert.equal(datePicker.disabled, false);

  // A day too old to be listed is still one press away.
  datePicker.value = "2026-06-03";
  await datePicker.dispatch("change");
  await settle();

  // A day on its own is still not a scope; the third step has to be answered.
  assert.equal(harness.elements["detail-column"].hidden, true);
  assert.match(harness.elements["scope-guidance"].textContent, /pick a time session/i);
  await scopeOptions(harness.elements["session-options"])[0].dispatch("click");
  await settle();

  assert.equal(harness.elements["detail-column"].hidden, false);
  assert.match(harness.elements["scope-breadcrumb"].textContent, /June 3, 2026/);
  assert.equal(harness.elements["attendance-checkin-count"].textContent, "1");
  // It keeps a button of its own while selected, so the rail never shows the
  // reader a list in which nothing is chosen.
  const afterJump = scopeOptions(dateOptions);
  assert.equal(afterJump.length, 7);
  assert.deepEqual(
    afterJump.filter((option) => option.dataset.selected === "true").map((option) =>
      option.children[0].textContent,
    ),
    ["Wednesday, June 3, 2026"],
  );

  // A day nothing was recorded on says so instead of silently selecting nothing.
  datePicker.value = "2026-07-04";
  await datePicker.dispatch("change");
  await settle();

  assert.match(harness.elements["date-hint"].textContent, /No check-ins or photos on/);
  assert.equal(harness.elements["date-hint"].dataset.state, "error");
  assert.match(harness.elements["scope-breadcrumb"].textContent, /June 3, 2026/);
});

test("the calendar waits behind a search button rather than standing over the day list", async () => {
  const harness = createAdminHarness();
  await settle();
  harness.auth({ uid: "user-1", email: "owner@example.com" });
  await settle();

  const search = harness.elements["date-search"];
  const toggle = harness.elements["date-search-toggle"];

  // Most visits take one of the recent buttons, so the field that reaches the
  // rest is not drawn until it is asked for.
  assert.equal(search.hidden, true);
  assert.equal(toggle.attributes.get("aria-expanded"), "false");
  assert.equal(harness.elements["date-search-label"].textContent, "Jump to a date");

  await toggle.dispatch("click");
  await settle();
  assert.equal(search.hidden, false);
  assert.equal(toggle.attributes.get("aria-expanded"), "true");
  assert.equal(harness.elements["date-search-label"].textContent, "Hide the date jump");

  await toggle.dispatch("click");
  await settle();
  assert.equal(search.hidden, true);
  assert.equal(toggle.attributes.get("aria-expanded"), "false");
  assert.equal(harness.elements["date-search-label"].textContent, "Jump to a date");

  // The button is named and the calendar it opens is the thing it points at.
  assert.match(adminHtml, /id="date-search-toggle"[\s\S]*?aria-controls="date-search"/);
  assert.match(adminHtml, /<div class="scope-date-search" id="date-search" hidden>/);
  assert.match(adminCss, /\.scope-search\[aria-expanded="true"\]/);
  assert.match(adminCss, /\.scope-search-label\s*\{[\s\S]*?clip: rect\(0, 0, 0, 0\)/);
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
  // Signing in fills the rail. The photographs wait for a scope to belong to.
  assert.equal(harness.elements["gallery-toolbar"].hidden, true);
  assert.equal(harness.elements["photo-library"].hidden, true);
  assert.equal(harness.elements["photos-panel"].hidden, true);
  assert.equal(harness.elements["detail-column"].hidden, true);
  assert.equal(harness.elements["sign-out"].hidden, false);
  assert.equal(harness.elements["account-name"].textContent, "owner@example.com");
  // The tally belongs to a scope, so the status line waits with everything else.
  assert.equal(harness.elements["dashboard-status"].textContent, "");
  assert.equal(harness.cloudCalls.pages.length, 1);
  assert.equal(harness.cloudCalls.pages[0].pageSize, 48);
  assert.equal(harness.cloudCalls.pages[0].after, null);
  assert.equal(harness.cloudCalls.attendance.length, 1);
  assert.equal(harness.cloudCalls.attendance[0].pageSize, 500);
  assert.equal(harness.cloudCalls.attendance[0].dateKey, undefined);
  // No card is drawn yet, so no photograph has been fetched from storage.
  assert.deepEqual(harness.cloudCalls.blobs, []);

  // The rail lists the sites; choosing one, then a day, then the whole of that
  // day is what brings the detail side into being.
  const attendanceList = harness.elements["attendance-list"];
  const locationOptions = harness.elements["location-options"];
  const dateOptions = harness.elements["date-options"];
  const sessionOptions = harness.elements["session-options"];
  assert.deepEqual(optionTitles(locationOptions), ["Orchard Road", "10 Marina Bay"]);
  assert.equal(scopeOptions(sessionOptions).length, 0, "no day, no sessions to offer");

  await chooseScope(harness, { location: 1, date: 1 });

  assert.equal(harness.elements["photos-panel"].hidden, false);
  assert.equal(harness.elements["detail-column"].hidden, false);
  assert.equal(harness.elements["gallery-toolbar"].hidden, false);
  assert.equal(harness.elements["photo-library"].hidden, false);
  assert.equal(harness.elements["load-more-row"].hidden, false);
  assert.equal(harness.elements["dashboard-status"].textContent, "2 photos");
  assert.deepEqual(harness.cloudCalls.blobs.sort(), ["flagged", "kept"]);
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

  // Choosing another site puts the reader back at step two: the day and the
  // session below it belonged to the site they just left.
  await locationOptions.children[0].dispatch("click");
  await settle();
  assert.equal(harness.elements["detail-column"].hidden, true);
  assert.match(harness.elements["scope-guidance"].textContent, /pick a date/i);

  await scopeOptions(dateOptions)[0].dispatch("click");
  await settle();
  await scopeOptions(sessionOptions)[0].dispatch("click");
  await settle();
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
  await settle();
  await dateOptions.children[1].dispatch("click");
  await settle();
  await scopeOptions(sessionOptions)[2].dispatch("click");
  await settle();
  assert.match(harness.elements["scope-breadcrumb"].textContent, /Afternoon session$/);
  assert.equal(harness.elements["attendance-checkin-count"].textContent, "0");
  assert.match(
    attendanceList.children[0].textContent,
    /No worker checked in during this session/,
  );
  assert.equal(harness.elements["dashboard-status"].textContent, "1 photo");

  // Truck coordinates belong to the session and can be entered manually or by RPA.
  // The form follows the selection, so the afternoon is still the one in view.
  const afternoonTruckForm = elementsWithClass(
    harness.elements["session-truck-location"],
    "truck-location-form",
  )[0];
  const [truckX, truckY] = descendants(afternoonTruckForm).filter(
    (entry) => entry.dataset.coordinateAxis,
  );
  truckX.value = "103.8555";
  truckY.value = "1.2868";
  await afternoonTruckForm.dispatch("submit");
  await settle();
  assert.equal(harness.cloudCalls.updatedTruckLocations.length, 1);
  assert.equal(harness.cloudCalls.updatedTruckLocations[0].session.sessionId, "afternoon");

  await scopeOptions(sessionOptions)[0].dispatch("click");

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
