process.env.TZ = "UTC";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");

const data = require("../photo-cloud.js");
globalThis.StampNoteCloudData = data;
const metrics = require("../metrics.js");

const root = resolve(__dirname, "..");
const html = readFileSync(resolve(root, "metrics.html"), "utf8");
const css = readFileSync(resolve(root, "metrics.css"), "utf8");
const source = readFileSync(resolve(root, "metrics.js"), "utf8");
const server = readFileSync(resolve(root, "server.js"), "utf8");

const NOW = Date.parse("2026-08-17T09:00:00.000Z");
const DAY = 86_400_000;

function at(daysAgo, hour = 9) {
  const date = new Date(NOW - daysAgo * DAY);
  date.setHours(hour, 0, 0, 0);
  return date.getTime();
}

function checkIn(daysAgo, location = "10 Marina Bay", hour = 9) {
  return { workerId: "WORKER-7", location, checkedInAtMs: at(daysAgo, hour) };
}

function photo(daysAgo, overrides = {}, hour = 13) {
  const capturedAtMs = at(daysAgo, hour);
  return {
    id: `photo-${daysAgo}-${hour}-${overrides.location || "bay"}`,
    capturedAtMs,
    capturedAt: new Date(capturedAtMs).toISOString(),
    location: "10 Marina Bay",
    aiReview: { action: "keep", recommendation: "keep", confidence: 0.96 },
    ...overrides,
  };
}

test("the range is every day in it, oldest first, zeros included", () => {
  const keys = metrics.rangeDayKeys(7, NOW);
  assert.equal(keys.length, 7);
  assert.equal(keys[6], data.createDateKey(new Date(NOW)));
  // A day nothing happened on is a zero the reader can see, not a gap they
  // have to infer.
  const [attendance] = metrics.buildDailyMetrics({
    attendance: [checkIn(0)],
    photos: [],
    days: 7,
    now: NOW,
  });
  assert.deepEqual(attendance.values, [0, 0, 0, 0, 0, 0, 1]);
  assert.equal(attendance.total, 1);
});

test("each measure is counted on its own day and its own terms", () => {
  const [attendance, flags, sessions] = metrics.buildDailyMetrics({
    attendance: [checkIn(2), checkIn(2), checkIn(0)],
    photos: [
      photo(2),
      photo(2, { id: "flagged-1", aiReview: { action: "review", recommendation: "discard", confidence: 0.7 } }),
      photo(1, { id: "flagged-2", aiReview: { action: "review", recommendation: "discard", confidence: 0.6 } }),
    ],
    days: 3,
    now: NOW,
  });

  assert.equal(attendance.title, "Attendance taken");
  assert.deepEqual(attendance.values, [2, 0, 1]);

  // Only what the review sent back counts as a flag; a kept photo does not.
  assert.equal(flags.title, "Flags raised");
  assert.deepEqual(flags.values, [1, 1, 0]);
  assert.equal(flags.total, 2);

  // A session is a location and one of the day's periods, counted once however
  // much happened inside it: two check-ins and two photos at one site on one
  // morning and afternoon are two sessions, not four.
  assert.equal(sessions.title, "Sessions created");
  assert.deepEqual(sessions.values, [2, 1, 1]);
});

test("sessions separate by place as well as by period", () => {
  const [, , sessions] = metrics.buildDailyMetrics({
    attendance: [
      checkIn(1, "10 Marina Bay", 9),
      checkIn(1, "Orchard Road", 9),
      // The same site and the same morning: already counted.
      checkIn(1, "10 Marina Bay", 10),
      // The same site, a different period.
      checkIn(1, "10 Marina Bay", 14),
    ],
    photos: [],
    days: 2,
    now: NOW,
  });
  assert.deepEqual(sessions.values, [3, 0]);
});

test("the three measures keep their own colour, and the palette is a validated set", () => {
  // Colour follows the measure, not its rank, so a range change never repaints.
  assert.deepEqual(
    metrics.SERIES.map((entry) => [entry.id, entry.slot]),
    [
      ["attendance", 1],
      ["flags", 2],
      ["sessions", 3],
    ],
  );

  // Categorical slots 1-3, validated all-pairs against this page's own two
  // surfaces. The dark column is the same three hues stepped for the dark
  // surface rather than an automatic flip.
  assert.match(css, /--series-1:\s*#2a78d6/);
  assert.match(css, /--series-2:\s*#eb6834/);
  assert.match(css, /--series-3:\s*#1baf7a/);
  assert.match(css, /:root\[data-theme="dark"\][\s\S]*?--series-1:\s*#3987e5/);
  assert.match(css, /@media \(prefers-color-scheme: dark\)[\s\S]*?--series-3:\s*#199e70/);

  // The mark wears the colour; every label on the page wears ink.
  assert.match(css, /\.metric-panel\[data-slot="1"\] \.chart-bar\s*\{\s*fill:\s*var\(--series-1\)/);
  assert.doesNotMatch(css, /\.chart-tick\s*\{[^}]*var\(--series/);
});

test("the marks follow the fixed specs and the chrome stays recessive", () => {
  // Columns are capped rather than filling their band, separated by surface
  // rather than by a stroke around them, and capped with a 4px round end.
  assert.match(source, /const MAX_BAR = 24;/);
  assert.match(source, /const SURFACE_GAP = 2;/);
  assert.match(source, /Math\.min\(MAX_BAR, band - SURFACE_GAP\)/);
  assert.match(source, /barPath\(x, baseline - height, barWidth, height, 4\)/);
  assert.doesNotMatch(css, /\.chart-bar\s*\{[^}]*stroke:/);

  // Hairline, solid, one step off the surface — never dashed.
  assert.match(css, /\.chart-grid\s*\{[^}]*stroke-width:\s*1/);
  assert.doesNotMatch(css, /stroke-dasharray/);

  // A date under every column is a wall of text; three is a scale.
  assert.match(source, /\[0, Math\.floor\(entry\.values\.length \/ 2\), entry\.values\.length - 1\]/);
});

test("every value is reachable without a pointer", () => {
  // The hit area is the whole band rather than the painted column, and carries
  // the same readout on focus as on hover.
  assert.match(source, /class: "chart-hit"[\s\S]*?width: band/);
  assert.match(source, /target\.addEventListener\("focus", show\)/);
  assert.match(source, /tabindex: "0"/);

  // The tooltip enhances; the table twin is what keeps it from gating. Three
  // light-mode slots sit under 3:1, so the table is required relief, not a nicety.
  assert.match(html, /id="metrics-table"/);
  assert.match(html, /<th scope="col">Attendance taken<\/th>/);
  assert.match(html, /<th scope="col">Flags raised<\/th>/);
  assert.match(html, /<th scope="col">Sessions created<\/th>/);

  // One filter row above everything it scopes, never one per chart.
  assert.ok(html.indexOf('class="metrics-filters"') < html.indexOf('id="metrics-panels"'));
  assert.equal((html.match(/class="metrics-filters"/g) || []).length, 1);

  // A single series per panel needs no legend: the panel title names it.
  assert.doesNotMatch(html, /class="legend"/);
  assert.doesNotMatch(css, /\.legend\b/);

  // Reloading holds the previous render rather than flashing a skeleton.
  assert.match(css, /\.metrics-panels\[data-stale="true"\]\s*\{\s*opacity:/);
});

test("hidden means hidden, for everything this sheet lays out", () => {
  // The gate and the tooltip are both laid out by this sheet, and an author
  // `display` beats the attribute — so without this rule they stay on screen
  // after being told to go, and the sign-in card survives signing in.
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(css, /\.auth-gate\s*\{[^}]*display:\s*grid/);
  assert.match(css, /\.chart-tooltip\s*\{[^}]*display:\s*grid/);

  // Signing in swaps the two: the gate goes, the workspace arrives.
  assert.match(source, /authGate\.hidden = Boolean\(user\);/);
  assert.match(source, /workspace\.hidden = !user;/);
});

test("the page is served and reachable from the drawer", () => {
  assert.match(server, /"metrics\.html",\s*\n\s*"metrics\.css",\s*\n\s*"metrics\.js",/);
  assert.match(html, /<header[^>]*data-sidebar-mount/);
  assert.match(html, /<script src="sidebar\.js" defer><\/script>/);
});
