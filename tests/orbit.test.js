const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const root = resolve(__dirname, "..");
const source = readFileSync(resolve(root, "orbit.js"), "utf8");

class FakeElement {
  constructor() {
    this.attributes = new Map();
    this.dataset = {};
    this.hidden = true;
    this.textContent = "";
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  addEventListener(name, callback) {
    this.listener = { name, callback };
  }
}

function createOrbitHarness(options = {}) {
  const record = new FakeElement();
  record.dataset.running = "false";
  record.dataset.loading = "false";
  const loader = new FakeElement();
  loader.hidden = true;
  const themeColour = new FakeElement();
  const themeToggle = new FakeElement();
  const themeIcon = new FakeElement();
  const themeLabel = new FakeElement();
  const body = new FakeElement();
  const documentElement = new FakeElement();
  const storage = new Map(options.theme ? [["stampnote-theme", options.theme]] : []);
  const media = {
    matches: options.systemDark === true,
    addEventListener() {},
  };

  const document = {
    body,
    documentElement,
    querySelector(selector) {
      if (selector === "#monitor-toggle") return record;
      if (selector === "#ai-review-loader") return loader;
      if (selector === 'meta[name="theme-color"]:not([media])') return themeColour;
      if (selector === "#theme-toggle") return themeToggle;
      if (selector === "#theme-toggle-icon") return themeIcon;
      if (selector === "#theme-toggle-label") return themeLabel;
      return null;
    },
  };

  const context = {
    MutationObserver: class {
      observe() {}
    },
    document,
    window: {
      localStorage: {
        getItem(key) {
          return storage.has(key) ? storage.get(key) : null;
        },
        setItem(key, value) {
          storage.set(key, String(value));
        },
      },
      matchMedia() {
        return media;
      },
    },
  };
  context.window.document = document;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: resolve(root, "orbit.js") });

  return { body, record, themeColour, themeIcon, themeLabel, themeToggle };
}

test("the idle stage follows the pinned theme and goes live when recording starts", () => {
  const harness = createOrbitHarness({ theme: "light" });
  assert.equal(harness.body.dataset.stage, "idle");
  assert.equal(harness.body.dataset.recorded, "false");
  assert.equal(harness.themeColour.attributes.get("content"), "#f6f7f6");
  assert.equal(harness.themeLabel.textContent, "Dark");

  harness.record.dataset.running = "true";
  harness.themeToggle.listener.callback();
  assert.equal(harness.themeIcon.textContent, "☀");
  assert.equal(harness.body.dataset.stage, "live");
  assert.equal(harness.themeColour.attributes.get("content"), "#0d1512");
});
