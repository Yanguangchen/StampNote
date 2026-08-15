process.env.TZ = "UTC";

const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const coordinates = require("../coordinates.js");
const data = require("../photo-cloud.js");

const root = resolve(__dirname, "..");
const html = readFileSync(resolve(root, "coordinates.html"), "utf8");
const css = readFileSync(resolve(root, "coordinates.css"), "utf8");
const source = readFileSync(resolve(root, "coordinates.js"), "utf8");
const server = readFileSync(resolve(root, "server.js"), "utf8");

function photo(id, capturedAt, gpsLocation, location = "10 Marina Bay") {
  const capturedAtMs = Date.parse(capturedAt);
  return {
    id,
    capturedAt,
    capturedAtMs,
    dateKey: data.createDateKey(capturedAtMs),
    location,
    locationKey: data.createLocationKey(location),
    gpsLocation,
  };
}

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.className = "";
    this.dataset = {};
    this.disabled = false;
    this.hidden = false;
    this.listeners = new Map();
    this.open = false;
    this.scope = "";
    this.textContent = "";
    this.type = "";
    this.value = "";
  }

  addEventListener(name, callback) {
    this.listeners.set(name, callback);
  }

  append(...children) {
    this.children.push(...children);
  }

  async dispatch(name) {
    return this.listeners.get(name)?.({ target: this, preventDefault() {} });
  }

  replaceChildren(...children) {
    this.children = [...children];
  }

  showModal() {
    this.open = true;
    this.hidden = false;
  }

  close() {
    this.open = false;
    this.listeners.get("close")?.({ target: this });
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
}

function descendants(element) {
  return [element, ...element.children.flatMap(descendants)];
}

function createPageHarness(pagePhotos, savedSessions = []) {
  const ids = [
    "coordinate-sign-in",
    "coordinate-sign-out",
    "coordinate-auth-gate",
    "coordinate-account-name",
    "coordinate-workspace",
    "coordinate-status",
    "coordinate-refresh",
    "coordinate-date-filter",
    "coordinate-location-filter",
    "coordinate-sort-order",
    "coordinate-clear-filters",
    "coordinate-search-toggle",
    "coordinate-search-label",
    "coordinate-toolbar",
    "coordinate-result-count",
    "coordinate-session-list",
    "coordinate-empty",
    "coordinate-data",
    "coordinate-map-dialog",
    "coordinate-map-close",
    "coordinate-map-title",
    "coordinate-map-summary",
    "coordinate-map-canvas",
    "coordinate-map-error",
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  elements["coordinate-location-filter"].value = "all";
  elements["coordinate-sort-order"].value = "newest";
  elements["coordinate-data"].textContent = "[]";
  const calls = {
    circles: [],
    maps: [],
    markers: [],
    polylines: [],
    tileLayers: [],
    updates: [],
  };
  let authCallback;
  const cloud = {
    async getPhotosPage() {
      return { photos: pagePhotos, after: null, hasMore: false };
    },
    async getAttendance() {
      return [];
    },
    async getDashboardSessions() {
      return savedSessions;
    },
    async updateSessionTruckLocation(session, truckLocation) {
      calls.updates.push({ session, truckLocation });
      return { ...session, truckLocation };
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
      return new FakeElement(tagName);
    },
    querySelector(selector) {
      return elements[selector.replace(/^#/, "")] || null;
    },
  };
  function mapLayer(kind, value, options) {
    const layer = {
      addTo(map) {
        calls[kind].push({ map, options, value });
        return layer;
      },
      bindTooltip(label, tooltipOptions) {
        layer.tooltip = { label, options: tooltipOptions };
        return layer;
      },
      getBounds() {
        return { points: value };
      },
    };
    return layer;
  }
  const leaflet = {
    circle(point, options) {
      return mapLayer("circles", point, options);
    },
    circleMarker(point, options) {
      return mapLayer("markers", point, options);
    },
    map(canvas, options) {
      const map = {
        canvas,
        options,
        fitBounds(bounds, fitOptions) {
          map.fitted = { bounds, options: fitOptions };
        },
        invalidateSize() {
          map.invalidated = true;
        },
        remove() {
          map.removed = true;
        },
      };
      calls.maps.push(map);
      return map;
    },
    polyline(points, options) {
      return mapLayer("polylines", points, options);
    },
    tileLayer(url, options) {
      return mapLayer("tileLayers", url, options);
    },
  };
  const context = {
    console,
    document,
    L: leaflet,
    setTimeout(callback) {
      callback();
    },
    StampNoteCloudData: data,
    StampNoteFirebase: cloud,
    StampNoteObservability: { configure() {} },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "coordinates.js" });
  return {
    auth(user, error = null) {
      authCallback(user, error);
    },
    calls,
    elements,
  };
}

async function settle() {
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
}

test("the dedicated page exposes all-session filters, GPS records and truck inputs", () => {
  assert.match(html, /<title>Geographic Surveillence · StampNote<\/title>/);
  assert.doesNotMatch(html, /Every recorded GPS reading is grouped/);
  assert.match(html, /id="coordinate-date-filter"[^>]*type="date"/);
  assert.match(html, /id="coordinate-location-filter"/);
  assert.match(html, /id="coordinate-sort-order"/);
  assert.match(html, /id="coordinate-session-list"/);
  assert.match(html, /id="coordinate-data"[^>]*type="application\/json"/);
  assert.match(html, /id="coordinate-map-dialog"/);
  assert.match(html, /leaflet@1\.9\.4\/dist\/leaflet\.js/);
  assert.doesNotMatch(html, /proximity threshold|maximum GPS uncertainty|GPS proximity is not proof/);
  assert.doesNotMatch(html, /GPS comparison workspace|Dates are ordered first|same Google account/);
  assert.match(source, /row\.dataset\.rpaGpsReading = "true"/);
  assert.match(source, /input\.dataset\.rpaField = field/);
  assert.match(source, /toggle\.dataset\.rpaAction = "toggleSessionCoordinates"/);
  assert.match(source, /mapButton\.dataset\.rpaAction = "comparePositionsOnMap"/);
  assert.match(source, /cloud\.updateSessionTruckLocation\(/);
  assert.match(css, /\.coordinate-session-body\s*\{[^}]*grid-template-columns:/);
  assert.match(
    server,
    /"coordinates\.html",\s*\n\s*"coordinates\.css",\s*\n\s*"coordinates\.js",/,
  );
});

test("the console is set in a vendored monospace face and dressed as an instrument", () => {
  // Self-hosted like Outfit, because this page's body text depends on the face
  // and not only its numbers: a site with no connection should still get the
  // console rather than whatever the operating system calls monospace.
  assert.match(html, /rel="preload"[\s\S]{0,120}jetbrains-mono-latin-wght-normal\.woff2/);
  assert.match(html, /href="vendor\/fonts\/jetbrains-mono\.css"/);
  [
    "jetbrains-mono-latin-wght-normal.woff2",
    "jetbrains-mono-latin-ext-wght-normal.woff2",
    "jetbrains-mono-LICENSE.txt",
  ].forEach((file) => {
    assert.ok(existsSync(resolve(root, "vendor", "fonts", file)), `${file} is vendored`);
  });
  const fontCss = readFileSync(resolve(root, "vendor", "fonts", "jetbrains-mono.css"), "utf8");
  assert.match(fontCss, /font-family: "JetBrains Mono"/);
  assert.match(fontCss, /font-display: swap/);
  assert.match(fontCss, /url\("jetbrains-mono-latin-wght-normal\.woff2"\) format\("woff2"\)/);

  // The mono face is load-bearing rather than decorative: this page is columns of
  // coordinates, and digits of unequal width do not line up down a column however
  // carefully the table is built. So it reaches the readings too, and no rule is
  // left asking for a different stack behind it.
  assert.match(css, /--console-font: "JetBrains Mono"/);
  assert.match(css, /body\s*\{\s*font-family: var\(--console-font\);/);
  assert.match(css, /\.coordinate-readings td\s*\{\s*font-family: var\(--console-font\);/);
  assert.doesNotMatch(css, /font-family: ui-monospace/);
  assert.doesNotMatch(css, /font-family: "Outfit"/);

  // Tracked capitals, squared corners and a measuring grid behind the readings.
  assert.match(css, /\.coordinates-intro h1\s*\{[\s\S]*?text-transform: uppercase/);
  assert.match(css, /--console-radius: 4px/);
  assert.match(css, /\.coordinate-session::before/);

  // The grid is the viewport's rather than the reading column's, so it is fixed
  // across the whole screen and ordered explicitly beneath the column instead of
  // relying on body's background reaching the canvas.
  assert.match(css, /body::before\s*\{[\s\S]*?position: fixed;[\s\S]*?var\(--console-grid\) 1px/);
  assert.match(css, /body::before\s*\{[\s\S]*?inset: 0;/);
  assert.match(css, /body::before\s*\{[\s\S]*?pointer-events: none;/);
  assert.match(css, /\.coordinates-main\s*\{\s*position: relative;\s*z-index: 1;\s*\}/);
  assert.doesNotMatch(css, /z-index: -1/);

  // The console tones are mixed out of the theme's own accent, so light and dark
  // follow without a second palette to keep in step with the first.
  assert.match(css, /--console-grid: color-mix\(in srgb, var\(--accent\)/);
  assert.doesNotMatch(css, /\[data-theme="dark"\]/);

  // A cursor blinking beside the title for as long as the page is open would
  // flicker at the edge of the vision of somebody comparing digits below it.
  assert.match(css, /animation: console-cursor 1\.1s steps\(1\) 4;/);
  assert.match(
    css,
    /prefers-reduced-motion: reduce\)\s*\{\s*\.coordinates-intro h1::after\s*\{\s*animation: none;/,
  );

  // Drawn, not typed, so the heading is still called exactly what it says.
  assert.match(css, /\.coordinates-intro h1::before,\s*\.coordinates-intro h1::after\s*\{\s*content: "";/);
});

test("the page renders every reading beside one session form and saves that session", async () => {
  const harness = createPageHarness([
    photo(
      "first",
      "2026-08-14T13:10:00.000Z",
      { latitude: 1.2868, longitude: 103.8545, accuracyMeters: 12 },
    ),
    photo(
      "second",
      "2026-08-14T13:20:00.000Z",
      { latitude: 1.2869, longitude: 103.8546, accuracyMeters: 8 },
    ),
  ]);
  harness.auth({ uid: "user-1", email: "owner@example.com" });
  await settle();

  const list = harness.elements["coordinate-session-list"];
  assert.equal(list.children.length, 1);
  const card = list.children[0];
  assert.equal(card.dataset.dateKey, "2026-08-14");
  assert.equal(card.dataset.sessionId, "afternoon");
  const body = descendants(card).find((entry) => entry.className === "coordinate-session-body");
  const toggle = descendants(card).find(
    (entry) => entry.dataset.rpaAction === "toggleSessionCoordinates",
  );
  assert.equal(body.hidden, true, "session coordinates are concealed initially");
  assert.equal(toggle.textContent, "Show coordinates");
  await toggle.dispatch("click");
  assert.equal(body.hidden, false);
  assert.equal(toggle.textContent, "Hide coordinates");
  assert.equal(toggle.attributes.get("aria-expanded"), "true");
  await toggle.dispatch("click");
  assert.equal(body.hidden, true);
  assert.equal(
    descendants(card).filter((entry) => entry.dataset.rpaGpsReading === "true").length,
    2,
    "all readings remain present inside the concealed session area",
  );

  const [xInput, yInput] = descendants(card).filter((entry) => entry.dataset.coordinateAxis);
  const form = descendants(card).find((entry) => entry.className === "coordinate-truck-form");
  const comparison = descendants(card).find((entry) => entry.className === "coordinate-comparison");
  const mapButton = descendants(card).find(
    (entry) => entry.dataset.rpaAction === "comparePositionsOnMap",
  );
  xInput.value = "103.8545";
  yInput.value = "1.2868";
  await xInput.dispatch("input");
  await yInput.dispatch("input");
  assert.match(comparison.textContent, /Within threshold/);
  assert.equal(mapButton.disabled, false);

  await mapButton.dispatch("click");
  assert.equal(harness.elements["coordinate-map-dialog"].open, true);
  assert.equal(harness.calls.maps.length, 1);
  assert.equal(harness.calls.markers.length, 2);
  assert.equal(harness.calls.polylines.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.calls.polylines[0].value)), [
    [1.2869, 103.8546],
    [1.2868, 103.8545],
  ]);
  assert.match(harness.elements["coordinate-map-summary"].textContent, /Within threshold/);
  assert.notEqual(harness.elements["coordinate-map-canvas"].dataset.distanceMeters, "0");
  await harness.elements["coordinate-map-close"].dispatch("click");
  assert.equal(harness.elements["coordinate-map-dialog"].open, false);

  await form.dispatch("submit");
  await settle();
  assert.equal(harness.calls.updates.length, 1);
  assert.equal(harness.calls.updates[0].session.dateKey, "2026-08-14");
  assert.equal(harness.calls.updates[0].session.sessionId, "afternoon");
  assert.deepEqual(JSON.parse(JSON.stringify(harness.calls.updates[0].truckLocation)), {
    x: 103.8545,
    y: 1.2868,
  });
  const machineIndex = JSON.parse(harness.elements["coordinate-data"].textContent);
  assert.equal(machineIndex.length, 1);
  assert.equal(machineIndex[0].gpsReadings.length, 2);
  assert.equal(machineIndex[0].comparison.status, "within_threshold");

  xInput.value = "103.8646";
  await xInput.dispatch("input");
  assert.match(comparison.textContent, /Flag for review/);
  assert.equal(card.dataset.reviewRequired, "true");
  assert.equal(card.dataset.reviewReason, "distance_exceeds_threshold");
  await form.dispatch("submit");
  await settle();
  const flaggedIndex = JSON.parse(harness.elements["coordinate-data"].textContent);
  assert.equal(flaggedIndex[0].comparison.flaggedForReview, true);
  assert.equal(flaggedIndex[0].comparison.reviewReason, "distance_exceeds_threshold");
});

test("a fresh session displays its start GPS before any photo is uploaded", async () => {
  const savedSession = {
    key: data.createSessionKey({
      location: "10 Marina Bay",
      dateKey: "2026-08-14",
      sessionId: "afternoon",
    }),
    location: "10 Marina Bay",
    dateKey: "2026-08-14",
    sessionId: "afternoon",
    gpsLocation: { latitude: 1.2868, longitude: 103.8545, accuracyMeters: 12.5 },
    gpsCapturedAtMs: Date.parse("2026-08-14T13:00:00.000Z"),
  };
  const harness = createPageHarness([], [savedSession]);
  harness.auth({ uid: "user-1", email: "owner@example.com" });
  await settle();

  const card = harness.elements["coordinate-session-list"].children[0];
  const rows = descendants(card).filter((entry) => entry.dataset.rpaGpsReading === "true");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dataset.sourceType, "session_start");
  assert.equal(JSON.parse(rows[0].dataset.gpsRecord).longitude, 103.8545);
  assert.ok(descendants(card).some((entry) => entry.textContent === "Session start"));
  assert.ok(
    !descendants(card).some(
      (entry) => entry.textContent === "No automatic GPS coordinates were recorded in this session.",
    ),
  );
});

test("sessions retain every GPS reading and choose the best reference deterministically", () => {
  const photos = [
    photo(
      "afternoon-poor",
      "2026-08-14T13:30:00.000Z",
      { latitude: 1.28, longitude: 103.85, accuracyMeters: 35 },
    ),
    photo(
      "afternoon-accurate-earlier",
      "2026-08-14T13:10:00.000Z",
      { latitude: 1.281, longitude: 103.851, accuracyMeters: 8 },
    ),
    photo(
      "afternoon-accurate-later",
      "2026-08-14T13:20:00.000Z",
      { latitude: 1.282, longitude: 103.852, accuracyMeters: 8 },
    ),
    photo(
      "morning",
      "2026-08-14T09:00:00.000Z",
      { latitude: 1.283, longitude: 103.853, accuracyMeters: 10 },
    ),
    photo(
      "older-evening",
      "2026-08-13T18:00:00.000Z",
      { latitude: 1.284, longitude: 103.854, accuracyMeters: 12 },
    ),
  ];
  const afternoonKey = data.createSessionKey({
    location: "10 Marina Bay",
    dateKey: "2026-08-14",
    sessionId: "afternoon",
  });
  const sessions = coordinates.buildCoordinateSessions(
    {
      photos,
      attendance: [],
      savedSessions: [
        {
          key: afternoonKey,
          location: "10 Marina Bay",
          dateKey: "2026-08-14",
          sessionId: "afternoon",
          label: "Delivery window",
          truckLocation: { x: 103.852, y: 1.282 },
        },
      ],
    },
    data,
  );
  const sorted = coordinates.sortCoordinateSessions(sessions, "newest");

  assert.deepEqual(
    sorted.map((session) => [session.dateKey, session.sessionId]),
    [
      ["2026-08-14", "morning"],
      ["2026-08-14", "afternoon"],
      ["2026-08-13", "evening"],
    ],
  );
  const afternoon = sorted[1];
  assert.equal(afternoon.sessionLabel, "Delivery window");
  assert.equal(afternoon.readings.length, 3, "no GPS reading is hidden by the session summary");
  assert.deepEqual(
    afternoon.readings.map((reading) => reading.sourcePhotoId),
    ["afternoon-accurate-earlier", "afternoon-accurate-later", "afternoon-poor"],
  );
  assert.equal(afternoon.reference.sourcePhotoId, "afternoon-accurate-later");
  assert.deepEqual(afternoon.truckLocation, { x: 103.852, y: 1.282 });
});

test("date sorting reverses dates without reversing time sessions within each day", () => {
  const sessions = [
    { dateKey: "2026-08-14", sessionFromHour: 12, firstAtMs: 2, location: "A" },
    { dateKey: "2026-08-13", sessionFromHour: 17, firstAtMs: 3, location: "A" },
    { dateKey: "2026-08-14", sessionFromHour: 0, firstAtMs: 1, location: "A" },
  ];
  assert.deepEqual(
    coordinates.sortCoordinateSessions(sessions, "newest").map((entry) => [
      entry.dateKey,
      entry.sessionFromHour,
    ]),
    [
      ["2026-08-14", 0],
      ["2026-08-14", 12],
      ["2026-08-13", 17],
    ],
  );
  assert.deepEqual(
    coordinates.sortCoordinateSessions(sessions, "oldest").map((entry) => [
      entry.dateKey,
      entry.sessionFromHour,
    ]),
    [
      ["2026-08-13", 17],
      ["2026-08-14", 0],
      ["2026-08-14", 12],
    ],
  );
});

test("comparison keeps the 25 metre threshold separate from GPS uncertainty", () => {
  const base = {
    key: "session",
    location: "10 Marina Bay",
    locationKey: data.createLocationKey("10 Marina Bay"),
    aliases: [],
    dateKey: "2026-08-14",
    sessionId: "morning",
    sessionLabel: "Morning",
    firstAtMs: 1,
    lastAtMs: 1,
    readings: [],
    reference: { latitude: 1.2868, longitude: 103.8545, accuracyMeters: 10 },
    truckLocation: { x: null, y: null },
  };

  assert.equal(
    coordinates.compareSessionToTruck(base, { x: 103.8545, y: 1.2868 }, data).status,
    "within_threshold",
  );
  const outside = coordinates.compareSessionToTruck(
    base,
    { x: 103.8555, y: 1.2868 },
    data,
  );
  assert.equal(outside.status, "outside_threshold");
  assert.equal(outside.flaggedForReview, true);
  assert.equal(outside.reviewReason, "distance_exceeds_threshold");
  const inaccurate = coordinates.compareSessionToTruck(
    { ...base, reference: { ...base.reference, accuracyMeters: 42 } },
    { x: 103.8545, y: 1.2868 },
    data,
  );
  assert.equal(inaccurate.status, "insufficient_accuracy");
  assert.equal(inaccurate.flaggedForReview, true);
  assert.equal(
    coordinates.compareSessionToTruck({ ...base, reference: null }, { x: 1, y: 1 }, data).status,
    "gps_unavailable",
  );

  const record = coordinates.sessionRecord(base, data, { x: 103.8545, y: 1.2868 });
  assert.equal(record.comparison.distanceThresholdMeters, 25);
  assert.equal(record.comparison.maximumGpsAccuracyMeters, 20);
  assert.equal(record.comparison.flaggedForReview, false);
});
