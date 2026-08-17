process.env.TZ = "UTC";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const data = require("../photo-cloud.js");
const coordinates = require("../coordinates.js");
const agentCoordinates = require("../agent-coordinates.js");

const root = resolve(__dirname, "..");
const html = readFileSync(resolve(root, "agent-coordinates.html"), "utf8");
const css = readFileSync(resolve(root, "agent-coordinates.css"), "utf8");
const source = readFileSync(resolve(root, "agent-coordinates.js"), "utf8");

function createSampleSession(sessionKey, location, dateKey, sessionId, sessionLabel, x = null, y = null, refGps = null) {
  const reference = refGps
    ? {
        readingId: `photo:1:123`,
        longitude: refGps.longitude,
        latitude: refGps.latitude,
        accuracyMeters: refGps.accuracyMeters || 10,
        reference: true,
      }
    : null;

  const truckLocation = { x, y };
  const comparison = coordinates.compareSessionToTruck({ reference }, truckLocation, data);

  return {
    sessionKey,
    location,
    locationKey: data.createLocationKey(location),
    dateKey,
    sessionId,
    sessionLabel,
    reference,
    truckLocation,
    comparison: {
      status: comparison.status,
      distanceMeters: comparison.distanceMeters,
      flaggedForReview: comparison.flaggedForReview,
      reviewReason: comparison.reviewReason,
      distanceThresholdMeters: 25,
      maximumGpsAccuracyMeters: 20,
    },
  };
}

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.className = "";
    this.classList = {
      add: (...names) => {
        const set = new Set(this.className.split(" ").filter(Boolean));
        names.forEach((n) => set.add(n));
        this.className = [...set].join(" ");
      },
      remove: (...names) => {
        const set = new Set(this.className.split(" ").filter(Boolean));
        names.forEach((n) => set.delete(n));
        this.className = [...set].join(" ");
      },
      toggle: (name, force) => {
        if (force === undefined) {
          if (this.classList.contains(name)) this.classList.remove(name);
          else this.classList.add(name);
        } else if (force) {
          this.classList.add(name);
        } else {
          this.classList.remove(name);
        }
      },
      contains: (name) => this.className.split(" ").includes(name),
    };
    this.dataset = {};
    this.disabled = false;
    this.hidden = false;
    this.id = "";
    this.listeners = new Map();
    this.textContent = "";
    this.innerHTML = "";
    this.type = "";
    this.value = "";
    this.parentElement = null;
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

  closest(selector) {
    if (selector.startsWith(".") && this.classList.contains(selector.slice(1))) return this;
    return this.parentElement?.closest?.(selector) || null;
  }

  querySelector(selector) {
    const attrMatch = selector.match(/\[([a-zA-Z0-9_-]+)(?:="?([^"\]]*)"?)?\]/);
    if (attrMatch) {
      const [, attrName, attrVal] = attrMatch;
      return (
        descendants(this).find((el) => {
          if (attrName.startsWith("data-")) {
            const camel = attrName.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            return attrVal !== undefined
              ? el.dataset[camel] === attrVal || el.getAttribute(attrName) === attrVal
              : el.dataset[camel] !== undefined || el.getAttribute(attrName) !== null;
          }
          return (
            el.getAttribute(attrName) === attrVal ||
            el[attrName] === attrVal ||
            String(el.name) === attrVal
          );
        }) || null
      );
    }
    if (selector.startsWith("#")) {
      return descendants(this).find((el) => el.id === selector.slice(1)) || null;
    }
    if (selector.startsWith(".")) {
      return (
        descendants(this).find((el) => el.classList.contains(selector.slice(1))) || null
      );
    }
    return (
      descendants(this).find((el) => el.tagName.toLowerCase() === selector.toLowerCase()) || null
    );
  }

  querySelectorAll(selector) {
    return descendants(this).filter((el) => {
      if (selector.startsWith(".") && el.classList.contains(selector.slice(1))) return true;
      return false;
    });
  }

  focus() {
    this.focused = true;
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "name") this.name = String(value);
    if (name === "id") this.id = String(value);
    if (name === "role") this.role = String(value);
  }

  async dispatch(name, event = {}) {
    const list = this.listeners.get(name) || [];
    for (const callback of list) {
      await callback({
        target: this,
        preventDefault() {},
        ...event,
      });
    }
  }
}

function descendants(element) {
  return [element, ...element.children.flatMap(descendants)];
}

function createAgentPageHarness(savedSessions = [], photos = [], options = {}) {
  const ids = [
    "agent-sign-in",
    "agent-sign-out",
    "agent-auth-gate",
    "agent-account-name",
    "agent-workspace",
    "agent-status",
    "agent-search-input",
    "agent-search-clear",
    "agent-filter-chips",
    "agent-result-count",
    "agent-session-list",
    "agent-empty",
    "agent-empty-reset",
    "agent-refresh",
    "agent-copy-json",
    "agent-copy-json-label",
    "agent-batch-toggle",
    "agent-batch-panel",
    "agent-batch-close",
    "agent-batch-input",
    "agent-batch-apply",
    "agent-batch-export",
    "agent-batch-copy",
    "agent-batch-status",
    "agent-data",
    "count-all",
    "count-missing",
    "count-set",
    "count-flagged",
  ];

  const elements = Object.fromEntries(ids.map((id) => {
    const el = new FakeElement();
    el.id = id;
    return [id, el];
  }));

  elements["agent-data"].textContent = "[]";
  elements["agent-workspace"].hidden = true;
  elements["agent-auth-gate"].hidden = false;
  elements["agent-batch-panel"].hidden = true;
  if (elements["agent-copy-json-label"]) {
    elements["agent-copy-json-label"].textContent = "Copy JSON";
  }

  const chipAll = new FakeElement("button");
  chipAll.className = "filter-chip is-active";
  chipAll.dataset.filter = "all";
  const chipMissing = new FakeElement("button");
  chipMissing.className = "filter-chip";
  chipMissing.dataset.filter = "missing";
  const chipSet = new FakeElement("button");
  chipSet.className = "filter-chip";
  chipSet.dataset.filter = "set";
  const chipFlagged = new FakeElement("button");
  chipFlagged.className = "filter-chip";
  chipFlagged.dataset.filter = "flagged";
  elements["agent-filter-chips"].append(chipAll, chipMissing, chipSet, chipFlagged);

  const calls = {
    updates: [],
    signIn: 0,
    signOut: 0,
    copied: [],
  };

  const navigator = {
    clipboard: {
      async writeText(text) {
        calls.copied.push(text);
      },
    },
  };

  let authCallback;
  const cloud = {
    async getPhotosPage() {
      if (options.loadError) throw options.loadError;
      return { photos, after: null, hasMore: false };
    },
    async getAttendance() {
      return options.attendance || [];
    },
    async getDashboardSessions() {
      return savedSessions;
    },
    async updateSessionTruckLocation(session, truckLocation) {
      if (options.saveError) throw options.saveError;
      calls.updates.push({ session, truckLocation });
      return { ...session, truckLocation };
    },
    async signIn() {
      calls.signIn += 1;
    },
    async signOut() {
      calls.signOut += 1;
    },
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
    querySelectorAll(selector) {
      if (selector === ".filter-chip") return [chipAll, chipMissing, chipSet, chipFlagged];
      return [];
    },
  };

  const context = {
    document,
    navigator,
    location: { search: options.search || "" },
    URLSearchParams,
    StampNoteFirebase: cloud,
    StampNoteCloudData: data,
    StampNoteCoordinates: coordinates,
    StampNoteObservability: { configure() {}, record() {} },
    setTimeout(fn) {
      return setTimeout(fn, 0);
    },
    console,
  };

  context.window = context;
  vm.createContext(context);
  vm.runInContext(source, context);

  return {
    elements,
    cloud,
    calls,
    async auth(user) {
      return authCallback?.(user);
    },
    context,
  };
}

test("agent-coordinates.html contains the necessary HTML foundation and metadata", () => {
  assert.match(html, /<html lang="en" data-surface="agent-coordinates">/);
  assert.match(html, /<title>AI Coordinate Entry · StampNote<\/title>/);
  assert.match(html, /<link rel="stylesheet" href="agent-coordinates\.css" \/>/);
  assert.match(html, /<script src="agent-coordinates\.js" defer><\/script>/);
  assert.match(html, /id="agent-search-input"/);
  assert.match(html, /id="agent-filter-chips"/);
  assert.match(html, /id="agent-batch-panel"/);
  assert.match(html, /id="agent-session-list"/);
  assert.match(html, /id="agent-data"/);
});

test("agent-coordinates.css provides styling, responsive layouts, and dark theme support", () => {
  assert.match(css, /\[data-surface="agent-coordinates"\]/);
  assert.match(css, /\.agent-search-section/);
  assert.match(css, /\.session-card/);
  assert.match(css, /\.coordinate-form/);
  assert.match(css, /\.agent-batch-panel/);
  assert.match(css, /@media \(max-width:\s*768px\)/);
  assert.match(css, /prefers-reduced-motion/);
});

test("filterSessions correctly matches multi-token search queries and filter modes", () => {
  const s1 = createSampleSession("loc1:2026-08-14:morning", "10 Marina Bay", "2026-08-14", "morning", "Morning", 103.8545, 1.2868, { longitude: 103.8545, latitude: 1.2868 });
  const s2 = createSampleSession("loc2:2026-08-15:afternoon", "Bedok Reservoir", "2026-08-15", "afternoon", "Afternoon", null, null, { longitude: 103.93, latitude: 1.33 });
  const s3 = createSampleSession("loc3:2026-08-16:evening", "Jurong West", "2026-08-16", "evening", "Evening", 103.70, 1.34, { longitude: 103.80, latitude: 1.34 }); // Flagged distance discrepancy

  const all = [s1, s2, s3];

  // 1. Search by location token
  assert.deepEqual(agentCoordinates.filterSessions(all, "marina"), [s1]);
  assert.deepEqual(agentCoordinates.filterSessions(all, "bedok"), [s2]);

  // 2. Search by date
  assert.deepEqual(agentCoordinates.filterSessions(all, "2026-08-15"), [s2]);

  // 3. Search by session label
  assert.deepEqual(agentCoordinates.filterSessions(all, "evening"), [s3]);

  // 4. Search multi-token
  assert.deepEqual(agentCoordinates.filterSessions(all, "jurong evening"), [s3]);

  // 5. Filter modes
  assert.deepEqual(agentCoordinates.filterSessions(all, "", "missing"), [s2]);
  assert.deepEqual(agentCoordinates.filterSessions(all, "", "set"), [s1, s3]);
  assert.deepEqual(agentCoordinates.filterSessions(all, "", "flagged"), [s3]);
});

test("page initializes with auth gate and transitions to workspace on sign in", async () => {
  const harness = createAgentPageHarness();
  assert.equal(harness.elements["agent-auth-gate"].hidden, false);
  assert.equal(harness.elements["agent-workspace"].hidden, true);

  await harness.auth({ uid: "user-1", displayName: "Agent Bot" });
  assert.equal(harness.elements["agent-auth-gate"].hidden, true);
  assert.equal(harness.elements["agent-workspace"].hidden, false);
  assert.equal(harness.elements["agent-account-name"].textContent, "Agent Bot");
});

test("sessions are rendered with direct coordinate inputs, copy GPS button, and live status", async () => {
  const s1Key = data.createSessionKey({
    locationKey: data.createLocationKey("10 Marina Bay"),
    dateKey: "2026-08-17",
    sessionId: "morning",
  });
  const s1 = {
    key: s1Key,
    location: "10 Marina Bay",
    dateKey: "2026-08-17",
    sessionId: "morning",
    truckLocation: { x: null, y: null },
    gpsLocation: { latitude: 1.2868, longitude: 103.8545, accuracyMeters: 5 },
    gpsCapturedAtMs: Date.parse("2026-08-17T08:00:00Z"),
  };

  const harness = createAgentPageHarness([s1]);
  await harness.auth({ uid: "u1", displayName: "Tester" });

  const list = harness.elements["agent-session-list"];
  assert.equal(list.children.length, 1);

  const card = list.children[0];
  assert.equal(card.dataset.sessionKey, s1Key);
  assert.equal(card.dataset.location, "10 Marina Bay");
  assert.equal(card.dataset.status, "missing");

  const xInput = card.querySelector('[name="truckLocationX"]');
  const yInput = card.querySelector('[name="truckLocationY"]');
  assert.ok(xInput);
  assert.ok(yInput);
  assert.equal(xInput.value, "");
  assert.equal(yInput.value, "");

  // Test Copy GPS
  const copyBtn = card.querySelector('[data-action="copy-gps"]');
  assert.ok(copyBtn);
  await copyBtn.dispatch("click");
  assert.equal(xInput.value, "103.8545");
  assert.equal(yInput.value, "1.2868");

  // Test Save
  const form = card.querySelector(".coordinate-form");
  await form.dispatch("submit");

  assert.equal(harness.calls.updates.length, 1);
  assert.equal(harness.calls.updates[0].truckLocation.x, 103.8545);
  assert.equal(harness.calls.updates[0].truckLocation.y, 1.2868);
});

test("batch JSON mode allows exporting and applying multiple coordinate updates", async () => {
  const s1Key = data.createSessionKey({
    locationKey: data.createLocationKey("10 Marina Bay"),
    dateKey: "2026-08-17",
    sessionId: "morning",
  });
  const s2Key = data.createSessionKey({
    locationKey: data.createLocationKey("Bedok"),
    dateKey: "2026-08-17",
    sessionId: "afternoon",
  });

  const s1 = {
    key: s1Key,
    location: "10 Marina Bay",
    dateKey: "2026-08-17",
    sessionId: "morning",
    truckLocation: { x: null, y: null },
  };
  const s2 = {
    key: s2Key,
    location: "Bedok",
    dateKey: "2026-08-17",
    sessionId: "afternoon",
    truckLocation: { x: null, y: null },
  };

  const harness = createAgentPageHarness([s1, s2]);
  await harness.auth({ uid: "u1" });

  // Toggle batch panel
  const toggle = harness.elements["agent-batch-toggle"];
  const panel = harness.elements["agent-batch-panel"];
  await toggle.dispatch("click");
  assert.equal(panel.hidden, false);

  // Set batch input
  const batchInput = harness.elements["agent-batch-input"];
  batchInput.value = JSON.stringify([
    { sessionKey: s1Key, x: 103.8545, y: 1.2868 },
    { sessionKey: s2Key, x: 103.9300, y: 1.3300 },
  ]);

  const applyBtn = harness.elements["agent-batch-apply"];
  await applyBtn.dispatch("click");

  assert.equal(harness.calls.updates.length, 2);
  assert.equal(harness.elements["agent-batch-status"].textContent, "Batch complete: 2 updated, 0 errors.");
});

test("public programmatic API globalScope.StampNoteAgentCoordinates works as expected", async () => {
  const s1Key = data.createSessionKey({
    locationKey: data.createLocationKey("10 Marina Bay"),
    dateKey: "2026-08-17",
    sessionId: "morning",
  });
  const s1 = {
    key: s1Key,
    location: "10 Marina Bay",
    dateKey: "2026-08-17",
    sessionId: "morning",
    truckLocation: { x: null, y: null },
  };

  const harness = createAgentPageHarness([s1]);
  await harness.auth({ uid: "u1" });

  const agentApi = harness.context.StampNoteAgentCoordinates || harness.context.window.StampNoteAgentCoordinates;
  assert.ok(agentApi);

  const sessions = agentApi.getSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionKey, s1Key);

  // Test programmatic single update
  await agentApi.updateSessionCoordinates(s1Key, { x: 103.85, y: 1.28 });
  assert.equal(harness.calls.updates.length, 1);
  assert.equal(harness.calls.updates[0].truckLocation.x, 103.85);
  assert.equal(harness.calls.updates[0].truckLocation.y, 1.28);

  // Test programmatic batch update
  const batchResults = await agentApi.batchUpdateCoordinates([
    { sessionKey: s1Key, x: 103.86, y: 1.29 },
  ]);
  assert.equal(batchResults[0].success, true);
  assert.equal(harness.calls.updates.length, 2);
  assert.equal(harness.calls.updates[1].truckLocation.x, 103.86);
  assert.equal(harness.calls.updates[1].truckLocation.y, 1.29);

  // Test getSessionsJson, copyJson, and copySessionJson
  const jsonStr = agentApi.getSessionsJson();
  const parsed = JSON.parse(jsonStr);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].sessionKey, s1Key);

  const copiedJson = await agentApi.copyJson();
  assert.equal(copiedJson, jsonStr);
  assert.equal(harness.calls.copied[harness.calls.copied.length - 1], jsonStr);

  const singleSessionJson = await agentApi.copySessionJson(s1Key);
  const singleParsed = JSON.parse(singleSessionJson);
  assert.equal(singleParsed.sessionKey, s1Key);
  assert.equal(harness.calls.copied[harness.calls.copied.length - 1], singleSessionJson);
});

test("Copy JSON button and Batch Copy button copy formatted session JSON to clipboard", async () => {
  const s1Key = data.createSessionKey({
    locationKey: data.createLocationKey("10 Marina Bay"),
    dateKey: "2026-08-17",
    sessionId: "morning",
  });
  const s1 = {
    key: s1Key,
    location: "10 Marina Bay",
    dateKey: "2026-08-17",
    sessionId: "morning",
    truckLocation: { x: 103.8545, y: 1.2868 },
  };

  const harness = createAgentPageHarness([s1]);
  await harness.auth({ uid: "u1" });

  // 1. Test main Copy JSON button
  const copyBtn = harness.elements["agent-copy-json"];
  assert.ok(copyBtn);
  await copyBtn.dispatch("click");

  assert.ok(harness.calls.copied.length >= 1);
  const copiedLatest = harness.calls.copied[harness.calls.copied.length - 1];
  const parsed = JSON.parse(copiedLatest);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].sessionKey, s1Key);
  assert.equal(parsed[0].truckLocation.x, 103.8545);

  // 2. Test Batch Copy button in batch drawer
  const batchCopyBtn = harness.elements["agent-batch-copy"];
  assert.ok(batchCopyBtn);
  harness.elements["agent-batch-input"].value = JSON.stringify([{ sessionKey: s1Key, custom: true }]);
  await batchCopyBtn.dispatch("click");

  const batchCopied = harness.calls.copied[harness.calls.copied.length - 1];
  assert.match(batchCopied, /"custom":\s*true/);

  // 3. Test per-session card Copy JSON button
  const card = harness.elements["agent-session-list"].children[0];
  assert.ok(card);
  const cardCopyBtn = card.querySelector('[data-action="copy-session-json"]');
  assert.ok(cardCopyBtn);
  await cardCopyBtn.dispatch("click");

  const cardCopied = harness.calls.copied[harness.calls.copied.length - 1];
  const singleParsed = JSON.parse(cardCopied);
  assert.equal(singleParsed.sessionKey, s1Key);
  assert.equal(singleParsed.location, "10 Marina Bay");
});
