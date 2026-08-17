const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const root = resolve(__dirname, "..");
const sidebar = readFileSync(resolve(root, "sidebar.js"), "utf8");
const sidebarCss = readFileSync(resolve(root, "sidebar.css"), "utf8");
const captureHtml = readFileSync(resolve(root, "index.html"), "utf8");
const adminHtml = readFileSync(resolve(root, "admin.html"), "utf8");
const coordinatesHtml = readFileSync(resolve(root, "coordinates.html"), "utf8");
const agentCoordinatesHtml = readFileSync(resolve(root, "agent-coordinates.html"), "utf8");
const aiDashboardHtml = readFileSync(resolve(root, "ai-dashboard.html"), "utf8");
const onboardingHtml = readFileSync(resolve(root, "onboarding.html"), "utf8");
const workerPhotosHtml = readFileSync(resolve(root, "worker-photos.html"), "utf8");
const metricsHtml = readFileSync(resolve(root, "metrics.html"), "utf8");
const server = readFileSync(resolve(root, "server.js"), "utf8");

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.className = "";
    this.dataset = {};
    this.href = "";
    this.id = "";
    this.inert = false;
    this.listeners = new Map();
    this._textContent = "";
    this.type = "";
    this.focused = 0;
  }

  get textContent() {
    if (this.children.length > 0) {
      return this.children.map((child) => child.textContent).join("");
    }
    return this._textContent;
  }

  set textContent(value) {
    this._textContent = String(value);
  }

  addEventListener(name, callback) {
    this.listeners.set(name, callback);
  }

  append(...children) {
    children.forEach((child) => {
      this.children.push(child);
      child.parentElement = this;
    });
  }

  prepend(...children) {
    const existing = this.children;
    this.children = [];
    this.append(...children);
    this.children.push(...existing);
  }

  contains(node) {
    if (node === this) return true;
    return this.children.some((child) => child.contains?.(node));
  }

  dispatch(name, event = {}) {
    return this.listeners.get(name)?.({ preventDefault() {}, target: this, ...event });
  }

  focus() {
    this.focused += 1;
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
}

function descendants(element) {
  return [element, ...element.children.flatMap(descendants)];
}

function createSidebarHarness(pathname, options = {}) {
  const mount = new FakeElement("header");
  const body = new FakeElement("body");
  const documentListeners = new Map();
  const document = {
    activeElement: null,
    body,
    addEventListener(name, callback) {
      documentListeners.set(name, callback);
    },
    createElement(tagName) {
      return new FakeElement(tagName);
    },
    querySelector(selector) {
      if (selector === "#theme-toggle") return options.themeToggle || null;
      return selector === "[data-sidebar-mount]" ? mount : null;
    },
  };
  const context = {
    document,
    window: { location: { pathname } },
    console,
  };
  context.window.document = document;
  vm.createContext(context);
  vm.runInContext(sidebar, context);

  const toggle = mount.children[0];
  const drawer = body.children.find((child) => child.id === "app-sidebar");
  const scrim = body.children.find((child) => child.className === "sidebar-scrim");
  const links = descendants(drawer).filter((node) => node.className === "sidebar-link");
  return { toggle, drawer, scrim, links, documentListeners };
}

test("every switchable page loads the drawer and marks where its toggle goes", () => {
  [captureHtml, adminHtml, coordinatesHtml, agentCoordinatesHtml, aiDashboardHtml, onboardingHtml, workerPhotosHtml].forEach((html) => {
    assert.match(html, /<link rel="stylesheet" href="sidebar\.css" \/>/);
    assert.match(html, /<script src="sidebar\.js" defer><\/script>/);
    assert.match(html, /<header[^>]*data-sidebar-mount/);
  });
  // The drawer carries Recording now, so the onboarding header dropped its own.
  assert.doesNotMatch(onboardingHtml, /class="back-link"/);
  assert.doesNotMatch(captureHtml, /id="worker-onboarding"|id="admin-dashboard"/);
  assert.match(server, /"coordinates\.html",\s*\n\s*"coordinates\.css",\s*\n\s*"coordinates\.js",/);
  assert.match(server, /"sidebar\.css",\s*\n\s*"sidebar\.js",/);
  assert.match(server, /"worker-photos\.html",\s*\n\s*"worker-photos\.css",\s*\n\s*"worker-photos\.js",/);
});

test("sign-out is a door icon on every account control", () => {
  assert.match(
    sidebarCss,
    /:is\(\.button, \.ai-button, \.ai-icon-button, \.auth-button\)\.sign-out/,
  );
  [
    ["admin.html", adminHtml],
    ["coordinates.html", coordinatesHtml],
    ["agent-coordinates.html", agentCoordinatesHtml],
    ["onboarding.html", onboardingHtml],
    ["worker-photos.html", workerPhotosHtml],
    ["ai-dashboard.html", aiDashboardHtml],
    ["metrics.html", metricsHtml],
  ].forEach(([name, html]) => {
    assert.match(html, /class="sign-out-icon"/, `${name} should use the door sign-out icon`);
  });
  assert.match(captureHtml, /class="icon sign-out-icon"/, "index.html should swap in the door icon");
});

test("the drawer starts hidden and out of the tab order", () => {
  const { toggle, drawer, scrim } = createSidebarHarness("/onboarding.html");
  assert.equal(drawer.dataset.open, "false");
  assert.equal(scrim.dataset.open, "false");
  assert.equal(drawer.inert, true);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(toggle.getAttribute("aria-controls"), "app-sidebar");
  assert.equal(toggle.getAttribute("aria-label"), "Open page menu");
  // Closed is a slide rather than a display swap, so the panel keeps its box.
  assert.match(sidebarCss, /\.app-sidebar\s*\{[^}]*transform:\s*translateX\(-100%\)/);
  assert.match(sidebarCss, /\.app-sidebar\[data-open="true"\]\s*\{\s*transform:\s*translateX\(0\)/);
});

test("the toggle opens and closes the drawer, and so do Escape and the scrim", () => {
  const { toggle, drawer, scrim, documentListeners } = createSidebarHarness("/admin.html");

  toggle.dispatch("click");
  assert.equal(drawer.dataset.open, "true");
  assert.equal(scrim.dataset.open, "true");
  assert.equal(drawer.inert, false);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(toggle.getAttribute("aria-label"), "Close page menu");

  toggle.dispatch("click");
  assert.equal(drawer.dataset.open, "false");
  assert.equal(drawer.inert, true);

  toggle.dispatch("click");
  scrim.dispatch("click");
  assert.equal(drawer.dataset.open, "false");

  toggle.dispatch("click");
  documentListeners.get("keydown")({ key: "Escape" });
  assert.equal(drawer.dataset.open, "false");
  // A key that is not Escape leaves an open drawer alone.
  toggle.dispatch("click");
  documentListeners.get("keydown")({ key: "a" });
  assert.equal(drawer.dataset.open, "true");
});

test("the drawer lists every page and marks the one being viewed", () => {
  const { links } = createSidebarHarness("/onboarding.html");
  assert.deepEqual(
    links.map((link) => link.href),
    [
      "index.html",
      "worker-photos.html",
      "onboarding.html",
      "coordinates.html",
      "agent-coordinates.html",
      "ai-dashboard.html",
      "admin.html",
      "metrics.html",
    ],
  );
  assert.equal(
    links.find((link) => link.href === "coordinates.html")?.textContent,
    "Geographic Surveillence",
  );
  assert.equal(
    links.find((link) => link.href === "agent-coordinates.html")?.textContent,
    "Coordinate entry",
  );
  assert.deepEqual(
    links.map((link) => link.getAttribute("aria-current")),
    [null, null, "page", null, null, null, null, null],
  );

  // Each link carries an icon and its label, with no extra hint descriptions.
  links.forEach((link) => {
    const icon = link.children.find((child) => child.className === "sidebar-link-icon");
    const label = link.children.find((child) => child.className === "sidebar-link-label");
    assert.ok(icon, "link should have an icon");
    assert.ok(label, "link should have a label");
    assert.ok(icon.innerHTML.includes("<svg"), "icon should contain an SVG");
  });
  assert.doesNotMatch(sidebar, /hint:/);
  assert.match(sidebar, /heading:\s*"Worker workspace"/);
  assert.match(sidebar, /heading:\s*"Admin workspace"/);
  assert.match(sidebarCss, /\.sidebar-link-icon/);
  assert.match(sidebarCss, /\.sidebar-link-label/);
  assert.match(sidebarCss, /\.sidebar-heading:not\(:first-child\)/);

  // cleanUrls serves /admin without an extension, and a bare path is capture.
  assert.equal(createSidebarHarness("/admin").links[6].getAttribute("aria-current"), "page");
  assert.equal(createSidebarHarness("/coordinates").links[3].getAttribute("aria-current"), "page");
  assert.equal(createSidebarHarness("/agent-coordinates").links[4].getAttribute("aria-current"), "page");
  assert.equal(createSidebarHarness("/ai-dashboard").links[5].getAttribute("aria-current"), "page");
  assert.equal(createSidebarHarness("/worker-photos").links[1].getAttribute("aria-current"), "page");
  assert.equal(createSidebarHarness("/metrics").links[7].getAttribute("aria-current"), "page");
  assert.equal(createSidebarHarness("/").links[0].getAttribute("aria-current"), "page");
});

test("the dashboard theme toggle is placed in the left drawer", () => {
  const themeToggle = new FakeElement("button");
  themeToggle.id = "theme-toggle";
  themeToggle.className = "button button-quiet theme-toggle";
  const { drawer } = createSidebarHarness("/admin.html", { themeToggle });
  const tools = descendants(drawer).find((node) => node.className === "sidebar-tools");

  assert.ok(tools);
  assert.equal(tools.children.at(-1), themeToggle);
  assert.equal(tools.children[0].textContent, "Appearance");
  assert.match(sidebarCss, /\.sidebar-tools\s*\{[^}]*margin-top: auto;/);
  assert.match(sidebarCss, /\.sidebar-tools \.theme-toggle\s*\{[^}]*width: 100%;/);
});

test("opening the drawer moves focus into it and closing brings focus back", () => {
  const { toggle, links, documentListeners } = createSidebarHarness("/admin.html");

  toggle.dispatch("click");
  // Focus lands on a page you can actually go to, not the one already open.
  assert.equal(links[0].focused, 1);
  assert.equal(links[5].focused, 0);

  documentListeners.get("keydown")({ key: "Escape" });
  assert.equal(toggle.focused, 1);
});
