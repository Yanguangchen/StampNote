const assert = require("node:assert/strict");
const { readFileSync, existsSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");

const projectRoot = resolve(__dirname, "..");
const html = readFileSync(resolve(projectRoot, "index.html"), "utf8");
const css = readFileSync(resolve(projectRoot, "styles.css"), "utf8");
const manifest = JSON.parse(readFileSync(resolve(projectRoot, "manifest.json"), "utf8"));
const addressService = require(resolve(projectRoot, "address-service.js"));
const stamp = require(resolve(projectRoot, "stamp.js"));

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tagWithId(tagName, id) {
  const pattern = new RegExp(
    `<${tagName}\\b(?=[^>]*\\bid=["']${escapeRegExp(id)}["'])[^>]*>`,
    "i",
  );
  const match = html.match(pattern);
  assert.ok(match, `Expected a <${tagName}> with id="${id}"`);
  return match[0];
}

function hasAttribute(tag, name, expectedValue) {
  if (expectedValue === undefined) {
    return new RegExp(`\\s${name}(?:\\s|=|/?>)`, "i").test(tag);
  }

  return new RegExp(
    `\\s${name}=["']${escapeRegExp(expectedValue)}["']`,
    "i",
  ).test(tag);
}

test("page has the required HTML foundation", () => {
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html\s+lang=["']en["']/i);
  assert.match(
    html,
    // viewport-fit=cover so the picture reaches under a phone's rounded corners.
    /<meta\s+name=["']viewport["']\s+content=["']width=device-width, initial-scale=1\.0, viewport-fit=cover["']/i,
  );
  assert.match(html, /<link\s+rel=["']stylesheet["']\s+href=["']styles\.css["']/i);
  assert.ok(existsSync(resolve(projectRoot, "styles.css")));
});

test("the installable app launches in fullscreen with complete PWA icons", () => {
  const app = readFileSync(resolve(projectRoot, "app.js"), "utf8");

  assert.match(html, /<link\s+rel=["']manifest["']\s+href=["']manifest\.json["']/i);
  assert.match(html, /<meta\s+name=["']apple-mobile-web-app-capable["']\s+content=["']yes["']/i);
  assert.match(
    html,
    /<meta\s+name=["']apple-mobile-web-app-status-bar-style["']\s+content=["']black-translucent["']/i,
  );
  assert.equal(manifest.id, "/");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "fullscreen");
  assert.deepEqual(manifest.display_override, ["fullscreen", "standalone"]);
  assert.equal(manifest.prefer_related_applications, false);
  assert.match(app, /matchMedia\?\.\("\(display-mode: fullscreen\)"\)/);
  assert.deepEqual(
    manifest.icons.map(({ sizes, type, purpose }) => ({ sizes, type, purpose })),
    [
      { sizes: "192x192", type: "image/png", purpose: "any maskable" },
      { sizes: "512x512", type: "image/png", purpose: "any maskable" },
    ],
  );
  for (const icon of [
    "icons/stampnote.svg",
    "icons/stampnote-180.png",
    ...manifest.icons.map((entry) => entry.src.replace(/^\//, "")),
  ]) {
    assert.ok(existsSync(resolve(projectRoot, icon)), `Expected ${icon}`);
  }
});

test("face enrollment visibly pauses the activity and explains how to complete it", () => {
  assert.ok(hasAttribute(tagWithId("section", "face-enrollment"), "hidden"));
  assert.match(html, /Attendance taking/);
  assert.match(tagWithId("div", "face-enrollment-progress"), /role=["']progressbar["']/);
  assert.match(tagWithId("div", "face-enrollment-progress"), /aria-label=["']Attendance taking progress["']/);
  assert.match(html, /Move closer until your face fills the oval/);
  assert.match(html, /Face matching stays on this device and clears when recording stops/);
  assert.doesNotMatch(html, /\d+ clear views/i);
  assert.doesNotMatch(html, /face-enrollment-count/);
  assert.doesNotMatch(tagWithId("div", "face-enrollment-progress"), /aria-valuenow|max=["']/);
  assert.match(css, /\.face-enrollment-progress span\s*\{[^}]*animation:\s*face-enrollment-progress/);
  assert.match(tagWithId("button", "face-enrollment-skip"), /type=["']button["']/);
  assert.match(html, /id="face-enrollment-match"[^>]*aria-live="assertive"/);
  assert.match(html, /id="face-enrollment-worker-id"/);
  assert.match(css, /\.face-enrollment\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0/);
  assert.match(css, /\.face-enrollment\[data-status="complete"\][^{]*\{[^}]*background:/);
  assert.match(css, /\.face-enrollment-match strong\s*\{[^}]*font-size:\s*clamp/);
  assert.match(css, /\.face-scan-frame\s*\{[^}]*border-radius:/);

  const app = readFileSync(resolve(projectRoot, "app.js"), "utf8");
  const controller = readFileSync(resolve(projectRoot, "auto-capture.js"), "utf8");
  assert.match(app, /faceEnrollmentSkip\?\.addEventListener\("click"/);
  assert.match(app, /model\s*\?\s*facialRecognition\?\.createFaceIdentity/);
  assert.match(controller, /if \(!state\.activityStarted\)/);
  assert.match(controller, /skipFaceEnrollment\(\)/);
});

test("Firebase initializes the supplied project and Analytics", () => {
  const firebasePath = resolve(projectRoot, "firebase.js");
  const firebase = readFileSync(firebasePath, "utf8");

  assert.match(html, /<script\s+src=["']photo-cloud\.js["']\s+defer><\/script>/i);
  assert.match(html, /<script\s+src=["']firebase\.js["']\s+defer><\/script>/i);
  assert.ok(existsSync(firebasePath));
  assert.match(firebase, /firebasejs\/12\.17\.1/);
  assert.match(firebase, /firebase-app\.js/);
  assert.match(firebase, /firebase-auth\.js/);
  assert.match(firebase, /firebase-firestore\.js/);
  assert.match(firebase, /firebase-analytics\.js/);
  assert.match(firebase, /projectId:\s*["']stampnote-eedcd["']/);
  assert.match(firebase, /measurementId:\s*["']G-XG9MCLSZ6G["']/);
  assert.match(firebase, /appSdk\.initializeApp\(firebaseConfig\)/);
  assert.match(firebase, /analyticsSdk\.getAnalytics\(app\)/);
  assert.match(firebase, /signInWithPopup/);
  assert.match(firebase, /setDoc/);
  assert.match(firebase, /Bytes\.fromUint8Array/);
});

test("the live camera is the camera, so there is no second one", () => {
  // A file input that opens the phone's camera app sat beside a page already
  // holding the camera open. Choosing a photograph that already exists is a
  // different job and keeps its button.
  assert.equal(/id=["']camera-input["']/.test(html), false);
  assert.equal(/capture=["']environment["']/.test(html), false);
  assert.equal(/Open camera/.test(html), false);
  assert.match(html, /id=["']gallery-input["']/);
});

test("gallery control accepts multiple images", () => {
  const galleryInput = tagWithId("input", "gallery-input");

  assert.ok(hasAttribute(galleryInput, "type", "file"));
  assert.ok(hasAttribute(galleryInput, "accept", "image/*"));
  assert.ok(hasAttribute(galleryInput, "multiple"));
  assert.equal(hasAttribute(galleryInput, "capture"), false);
});

// Every control on screen is a glyph. Its name is in the markup — so it names
// the button to a screen reader — but it is only shown when a pointer asks.
const NAMED_CONTROLS = [
  ["label", "for", "gallery-input", "Choose"],
  ["button", "id", "place-toggle", "Place"],
  ["button", "id", "monitor-toggle", "Start auto capture"],
  ["button", "id", "captures-save", "Save to this device"],
  ["button", "id", "cloud-auth", "Sign in with Google"],
  ["a", "id", "admin-dashboard", "Open photo dashboard"],
  ["button", "id", "share-button", "Share"],
  ["button", "id", "ai-review", "Review photos with Gemini"],
  ["button", "id", "ai-review-bin", "Show AI review bin"],
  ["button", "id", "ai-review-purge", "Delete AI flags permanently"],
  ["button", "id", "captures-clear", "Delete every photo"],
  ["button", "id", "viewer-restore", "Restore this photo"],
  ["button", "id", "viewer-share", "Share this photo"],
  ["button", "id", "viewer-delete", "Delete this photo"],
  ["button", "id", "viewer-close", "Close"],
];

function controlMarkup(tagName, attribute, id) {
  const pattern = new RegExp(
    `<${tagName}\\b[^>]*${attribute}=["']${escapeRegExp(id)}["'][^>]*>([\\s\\S]*?)</${tagName}>`,
    "i",
  );
  const match = html.match(pattern);

  assert.ok(match, `Expected a <${tagName}> for ${id}`);
  return match;
}

test("controls carry their name in the markup and nothing beside the glyph", () => {
  NAMED_CONTROLS.forEach(([tagName, attribute, id, name]) => {
    const match = controlMarkup(tagName, attribute, id);

    assert.match(match[1], new RegExp(`class=["'][^"']*hint[^"']*["'][^>]*>${escapeRegExp(name)}<`, "i"));
    assert.match(match[1], /<svg\b[^>]*aria-hidden=["']true["']/i);

    // The glyph and the name are the whole of it, so no wording is laid out
    // next to the icon.
    const visible = match[1]
      .replace(/<svg\b[\s\S]*?<\/svg>/gi, "")
      .replace(/<span\b[^>]*class=["'][^"']*hint[^"']*["'][^>]*>[\s\S]*?<\/span>/gi, "")
      .trim();

    assert.equal(visible, "", `Expected no visible text in the ${id} control`);
  });
});

test("a control's name is shown above it, only while a pointer is on it", () => {
  // One tooltip, not two: a title attribute would have the browser drawing its
  // own next to the styled one.
  NAMED_CONTROLS.forEach(([tagName, attribute, id]) => {
    assert.equal(/\btitle=/.test(controlMarkup(tagName, attribute, id)[0]), false);
  });
  assert.equal(/monitorToggle\.title/.test(readFileSync(resolve(projectRoot, "app.js"), "utf8")), false);

  // Above the control, out of the way of the finger or cursor on it.
  assert.match(css, /\.hint\s*\{[^}]*position:\s*absolute/);
  assert.match(css, /\.hint\s*\{[^}]*bottom:\s*calc\(100% \+ 6px\)/);

  // Transparent rather than removed, so it still names the button when it is
  // not being shown, and never eats the click meant for the control.
  assert.match(css, /\.hint\s*\{[^}]*opacity:\s*0/);
  assert.match(css, /\.hint\s*\{[^}]*pointer-events:\s*none/);
  assert.equal(/\.hint\s*\{[^}]*display:\s*none/.test(css), false);

  // Hover is what reveals it, and only where hovering is a thing that happens.
  assert.match(css, /@media \(hover: hover\)\s*\{\s*:is\([^)]*\):hover > \.hint/);
  // A finger has no hover, so a press shows it, and a keyboard gets it on focus.
  assert.match(css, /:is\([^)]*\):active > \.hint/);
  assert.match(css, /:is\([^)]*\):focus-visible > \.hint/);
});

test("the address is typed into a single field, with no location button", () => {
  const addressField = tagWithId("textarea", "address-field");

  assert.ok(hasAttribute(addressField, "autocomplete", "street-address"));
  assert.match(html, /<label\b[^>]*for=["']address-field["'][^>]*>Street address<\/label>/i);
  assert.match(html, /id=["']location-status["'][^>]*role=["']status["'][^>]*aria-live=["']polite["']/i);

  // Removed controls leave nothing behind for the script to bind to.
  assert.equal(/id=["']locate-button["']/.test(html), false);
  assert.equal(/id=["']save-button["']/.test(html), false);
  assert.equal(/getElementById|#locate-button|#save-button/.test(readFileSync(resolve(projectRoot, "app.js"), "utf8")), false);
});

test("geolocation helper resolves coordinates and accuracy", async () => {
  const fakeGeolocation = {
    getCurrentPosition(success, _error, options) {
      assert.equal(options.enableHighAccuracy, true);
      success({ coords: { latitude: 1.2834, longitude: 103.8607, accuracy: 12.5 } });
    },
  };

  const result = await addressService.getCurrentCoordinates(fakeGeolocation);
  assert.deepEqual(result, { latitude: 1.2834, longitude: 103.8607, accuracy: 12.5 });
});

test("geolocation and reverse lookup reject unavailable or invalid inputs", async () => {
  await assert.rejects(addressService.getCurrentCoordinates(null), /not supported/);
  assert.throws(() => addressService.buildReverseGeocodeUrl(-91, 103), /Latitude/);
  assert.throws(() => addressService.buildReverseGeocodeUrl(1, 181), /Longitude/);
  assert.throws(() => addressService.buildReverseGeocodeUrl(Number.NaN, 103), /Latitude/);
  const originalFetch = global.fetch;
  try {
    global.fetch = undefined;
    await assert.rejects(addressService.reverseGeocode(1, 103), /not available/);
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(addressService.createCacheKey(1.234567, 103.876543), "stampnote:address:1.23457,103.87654");
});

test("denied location explains how to re-enable it, per platform", () => {
  const iphone = {
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
      "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  };
  const ipad = {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
      "(KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    maxTouchPoints: 5,
  };
  const desktop = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", maxTouchPoints: 0 };

  assert.match(addressService.describeGeolocationError({ code: 1 }, iphone), /Website Settings/);
  assert.match(addressService.describeGeolocationError({ code: 1 }, ipad), /Website Settings/);
  assert.match(addressService.describeGeolocationError({ code: 1 }, desktop), /site settings/);
  assert.equal(addressService.isIosBrowser(desktop), false);

  // An insecure page can never get a position, whatever the error says.
  assert.match(
    addressService.describeGeolocationError({ code: 1 }, { ...iphone, isSecureContext: false }),
    /https:\/\//,
  );
  assert.match(addressService.describeGeolocationError(null, { isSecureContext: false }), /https:\/\//);

  assert.match(addressService.describeGeolocationError({ code: 2 }, iphone), /unavailable/i);
  assert.match(addressService.describeGeolocationError({ code: 3 }, iphone), /timed out/i);
  assert.equal(addressService.describeGeolocationError({ message: "Boom" }, iphone), "Boom");
});

test("in-app browsers are told to reopen the page in Safari", () => {
  const safari =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
    "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
  // Telegram and friends use a WKWebView, which omits the Version/ token.
  const webView =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
    "(KHTML, like Gecko) Mobile/15E148";

  assert.equal(addressService.isInAppBrowser({ userAgent: safari }), false);
  assert.equal(addressService.isInAppBrowser({ userAgent: webView }), true);
  // A Home Screen web app drops the token too, but can hold permission itself.
  assert.equal(addressService.isInAppBrowser({ userAgent: webView, standalone: true }), false);
  assert.equal(
    addressService.isInAppBrowser({ userAgent: `${safari} [FBAN/FBIOS;FBAV/450.0]` }),
    true,
  );

  assert.match(addressService.describeGeolocationError({ code: 1 }, { userAgent: webView }), /Open in Safari/);
  assert.match(
    addressService.describeGeolocationError({ code: 1 }, { userAgent: safari }),
    /Location Services/,
  );
  assert.match(
    addressService.describeGeolocationError({ code: 1 }, { userAgent: safari, embedded: true }),
    /embedded/i,
  );
});

test("diagnostics report the values needed to identify the block", () => {
  const report = addressService.describeEnvironment(
    { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Version/17.5 Safari/604.1" },
    { permissionState: "denied", errorCode: 1, errorMessage: "User denied Geolocation" },
  );

  assert.match(report, /secure context: true/);
  assert.match(report, /permission: denied/);
  assert.match(report, /error: code 1 \(User denied Geolocation\)/);
  assert.match(report, /in-app browser: false/);
  assert.match(report, /ios: true/);

  const empty = addressService.describeEnvironment({}, {});
  assert.match(empty, /permission: unknown/);
  assert.match(empty, /error: none/);
});

test("permission state is only trusted when the browser reports one", async () => {
  assert.equal(await addressService.getPermissionState(undefined), "unknown");
  assert.equal(await addressService.getPermissionState({}), "unknown");

  // Safari rejects permission names it does not support.
  assert.equal(
    await addressService.getPermissionState({
      query: async () => {
        throw new TypeError("unsupported");
      },
    }),
    "unknown",
  );

  assert.equal(
    await addressService.getPermissionState({ query: async () => ({ state: "granted" }) }),
    "granted",
  );
  assert.equal(
    await addressService.getPermissionState({ query: async () => ({ state: "denied" }) }),
    "denied",
  );
});

test("the stamped file saves itself, once per upload", () => {
  const app = readFileSync(resolve(projectRoot, "app.js"), "utf8");

  // Debounced so typing an address does not save a file per keystroke.
  assert.match(app, /autoSaveTimer = window\.setTimeout\(autoSave, AUTO_SAVE_DELAY\)/);
  assert.match(app, /if \(autoSaved \|\| !addressField\.value\.trim\(\)\)/);
  assert.match(app, /autoSaved = true/);
  // A fresh upload is a fresh set to save.
  assert.match(app, /autoSaved = false;\s*\n\s*photos\.length = 0/);
  assert.match(app, /link\.download = file\.name/);
  assert.match(app, /URL\.revokeObjectURL/);
});

test("location is attempted once per upload and never when already refused", () => {
  const app = readFileSync(resolve(projectRoot, "app.js"), "utf8");

  assert.match(app, /if \(firstRun\) \{\s*autoLocate\(\);/);
  assert.match(app, /getPermissionState\(navigator\.permissions\)\) === "denied"/);
  assert.match(app, /isInAppBrowser\(context\)/);
  // A refusal falls back to typing rather than an error the user cannot act on.
  assert.match(app, /if \(blocked\) \{\s*setStatus\("Type the street address above\."\);/);
});

test("reverse geocoder requests one detailed address and formats the response", async () => {
  let requestedUrl;
  const fakeFetch = async (url, options) => {
    requestedUrl = new URL(url);
    assert.equal(options.headers.Accept, "application/json");
    return {
      ok: true,
      async json() {
        return {
          display_name: "10 Bayfront Avenue, Downtown Core, Singapore 018956",
          address: {
            house_number: "10",
            road: "Bayfront Avenue",
            suburb: "Downtown Core",
            postcode: "018956",
            country: "Singapore",
          },
        };
      },
    };
  };

  const result = await addressService.reverseGeocode(1.2834, 103.8607, {
    fetchImplementation: fakeFetch,
    language: "en-SG",
  });

  assert.equal(requestedUrl.hostname, "nominatim.openstreetmap.org");
  assert.equal(requestedUrl.pathname, "/reverse");
  assert.equal(requestedUrl.searchParams.get("format"), "jsonv2");
  assert.equal(requestedUrl.searchParams.get("zoom"), "18");
  assert.equal(requestedUrl.searchParams.get("layer"), "address");
  assert.equal(requestedUrl.searchParams.get("accept-language"), "en-SG");
  assert.equal(result.address, "10 Bayfront Avenue");
});

test("formatter keeps only the street number and name", () => {
  assert.equal(
    addressService.formatAddress({
      display_name: "10, Bayfront Avenue, Downtown Core, Singapore 018956, Singapore",
      address: {
        house_number: "10",
        road: "Bayfront Avenue",
        suburb: "Downtown Core",
        state: "Central Region",
        postcode: "018956",
        country: "Singapore",
      },
    }),
    "10 Bayfront Avenue",
  );

  assert.equal(
    addressService.formatAddress({ address: { road: "Orchard Road", city: "Singapore" } }),
    "Orchard Road",
  );

  // Falls back to display_name, still trimmed to the street.
  assert.equal(
    addressService.formatAddress({
      display_name: "10, Bayfront Avenue, Downtown Core, Singapore 018956",
    }),
    "10 Bayfront Avenue",
  );

  assert.equal(addressService.formatAddress({}), "");
});

test("reverse geocoder reports service and empty-address failures", async () => {
  await assert.rejects(
    addressService.reverseGeocode(1.28, 103.86, {
      fetchImplementation: async () => ({ ok: false, status: 503 }),
    }),
    /returned 503/,
  );

  await assert.rejects(
    addressService.reverseGeocode(1.28, 103.86, {
      fetchImplementation: async () => ({ ok: true, json: async () => ({}) }),
    }),
    /No street address/,
  );
});

test("CSS includes keyboard focus, mobile layout, and reduced motion support", () => {
  assert.match(css, /\.visually-hidden:focus\s*\+\s*\.button/);
  assert.match(css, /@media\s*\(max-width:\s*560px\)/);
  assert.match(css, /@media \(min-width: 900px\) and \(orientation: landscape\)/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
});

test("a saved hands-up photo produces an apparent shutter confirmation", () => {
  const flash = tagWithId("div", "capture-flash");
  const app = readFileSync(resolve(projectRoot, "app.js"), "utf8");

  assert.ok(hasAttribute(flash, "aria-hidden", "true"));
  assert.match(html, /class=["']capture-flash-confirmation["'][\s\S]*Photo taken/);
  assert.match(css, /@keyframes\s+shutter-flash/);
  assert.match(css, /\.capture-flash\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0/);
  assert.match(css, /\.capture-flash\.is-visible\s*\{[^}]*animation:\s*shutter-flash/);
  assert.match(app, /state\.lastRecord\?\.trigger === "gesture"/);
  assert.match(app, /showGestureCaptureFlash\(\)/);

  // Reduced-motion users get the confirmation pill without the bright flash.
  assert.match(
    css,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.capture-flash\.is-visible\s*\{[^}]*background:\s*transparent/,
  );
});

test("stamp bar is one text line tall plus its padding", () => {
  const layout = stamp.computeStampLayout(1200);

  assert.equal(layout.barHeight, layout.fontSize + layout.paddingY * 2);
  assert.ok(layout.paddingY > 0 && layout.paddingX > 0);
  // Scales with the photo but stays legible at either extreme.
  assert.equal(stamp.computeStampLayout(200).fontSize, 16);
  assert.equal(stamp.computeStampLayout(6000).fontSize, 76);
  assert.ok(stamp.computeStampLayout(1200).fontSize > stamp.computeStampLayout(600).fontSize);
});

test("stamp renders the date and time in the sample format", () => {
  assert.equal(stamp.formatStampTime(new Date(2026, 7, 5, 14, 32)), "05 AUG 2026 · 14:32");
  assert.match(stamp.formatStampTime(undefined), /^\d{2} [A-Z]{3} \d{4} · \d{2}:\d{2}$/);
});

test("stamped canvas adds a bar above and below the photo", () => {
  const drawn = [];
  const fakeContext = {
    measureText: (text) => ({ width: text.length * 6 }),
    drawImage: (...args) => drawn.push(["drawImage", ...args]),
    fillRect: (...args) => drawn.push(["fillRect", ...args]),
    fillText: (...args) => drawn.push(["fillText", ...args]),
  };
  const fakeDocument = {
    createElement: () => ({ getContext: () => fakeContext }),
  };

  const canvas = stamp.drawStampedImage(
    { naturalWidth: 1000, naturalHeight: 750 },
    { address: "10 Bayfront Avenue", date: new Date(2026, 7, 5, 14, 32), document: fakeDocument },
  );
  const { barHeight } = stamp.computeStampLayout(1000);

  assert.equal(canvas.width, 1000);
  assert.equal(canvas.height, 750 + barHeight * 2);

  // Photo is offset by the top bar; both bars span the full width.
  assert.deepEqual(
    drawn.find((entry) => entry[0] === "drawImage"),
    ["drawImage", { naturalWidth: 1000, naturalHeight: 750 }, 0, barHeight, 1000, 750],
  );
  assert.deepEqual(
    drawn.filter((entry) => entry[0] === "fillRect"),
    [
      ["fillRect", 0, 0, 1000, barHeight],
      ["fillRect", 0, barHeight + 750, 1000, barHeight],
    ],
  );

  // Location in the top bar, timestamp in the bottom one.
  assert.deepEqual(
    drawn.filter((entry) => entry[0] === "fillText").map((entry) => [entry[1], entry[3]]),
    [
      ["10 BAYFRONT AVENUE", barHeight / 2],
      ["05 AUG 2026 · 14:32", barHeight + 750 + barHeight / 2],
    ],
  );
});

test("an overlong stamp address is shortened to the available line", () => {
  const written = [];
  const fakeContext = {
    measureText: (text) => ({ width: text.length * 12 }),
    drawImage() {},
    fillRect() {},
    fillText: (text) => written.push(text),
  };
  const fakeDocument = {
    createElement: () => ({ getContext: () => fakeContext }),
  };

  stamp.drawStampedImage(
    { width: 240, height: 120 },
    {
      address: "123 This is a deliberately very long street address",
      date: new Date(2026, 7, 5, 14, 32),
      document: fakeDocument,
    },
  );

  assert.match(written[0], /…$/);
  assert.ok(fakeContext.measureText(written[0]).width <= 240);
  assert.equal(written[1], "05 AUG 2026 · 14:32");
});

test("the live camera is wired for autoplay on a phone", () => {
  const video = tagWithId("video", "monitor-video");

  // iOS refuses to play a video that is not muted and inline, which would take
  // the whole watch down with it.
  assert.ok(hasAttribute(video, "playsinline"));
  assert.ok(hasAttribute(video, "muted"));
  assert.ok(hasAttribute(video, "autoplay"));

  // The frame stays hidden until a stream is actually attached.
  assert.ok(hasAttribute(tagWithId("div", "monitor-frame"), "hidden"));

  // The overlay is decoration over the video; the badge carries the words.
  assert.ok(hasAttribute(tagWithId("canvas", "pose-overlay"), "aria-hidden", "true"));
  assert.match(html, /id=["']pose-badge["'][^>]*role=["']status["'][^>]*aria-live=["']polite["']/i);
});

test("auto capture loads its own scripts, ahead of the app that wires them", () => {
  const order = [...html.matchAll(/<script\s+src=["']([^"']+)["']/gi)].map((match) => match[1]);

  ["pose-detector.js", "capture-scheduler.js", "photo-store.js", "auto-capture.js"].forEach(
    (file) => {
      assert.ok(order.includes(file), `Expected ${file} to be loaded`);
      assert.ok(order.indexOf(file) < order.indexOf("app.js"), `${file} must precede app.js`);
      assert.ok(existsSync(resolve(projectRoot, file)));
    },
  );
});

test("with nothing captured, the strip is away and saving is off", () => {
  // The strip only exists once there is something in it.
  assert.ok(hasAttribute(tagWithId("section", "filmstrip"), "hidden"));
  assert.match(html, /id=["']captures["']/);

  // Save keeps its place in the bar and greys out, rather than appearing from
  // nowhere and moving the buttons either side of it.
  const save = tagWithId("button", "captures-save");
  assert.ok(hasAttribute(save, "disabled"));
  assert.equal(hasAttribute(save, "hidden"), false);
  assert.match(readFileSync(resolve(projectRoot, "app.js"), "utf8"), /capturesSave\.disabled = !hasCaptures/);

  assert.ok(hasAttribute(tagWithId("button", "captures-clear"), "hidden"));
});

test("capture stays local and consented AI review uploads reduced batches", () => {
  const app = readFileSync(resolve(projectRoot, "app.js"), "utf8");
  const store = readFileSync(resolve(projectRoot, "photo-store.js"), "utf8");

  // Every capture goes to the device's own store, and stays queued there.
  assert.match(app, /storage\.createPhotoStore\(\)/);
  assert.match(store, /status: "local"/);

  // Nothing in the capture or storage path posts a photo anywhere.
  assert.equal(/fetch\(|XMLHttpRequest|sendBeacon|WebSocket/.test(store), false);
  assert.equal(/sendBeacon|XMLHttpRequest|WebSocket/.test(app), false);

  // The upload is behind named consent and downsizing, and it reaches only the
  // server function rather than exposing a model credential. Complete groups
  // of eight review themselves; the sparkle button remains for leftovers.
  assert.match(app, /hasAiReviewConsent\(\)/);
  assert.match(app, /AI_REVIEW_MAX_EDGE = 512/);
  assert.match(app, /AI_REVIEW_BATCH_SIZE = 8/);
  assert.match(app, /storage\.selectAiReviewBatch\(active, AI_REVIEW_BATCH_SIZE\)/);
  assert.match(app, /reviewCapturesWithAi\(\{ automatic: true \}\)/);
  assert.match(app, /aiReviewButton\?\.addEventListener\("click"/);
  assert.match(app, /fetch\(AI_REVIEW_ENDPOINT/);
  assert.match(app, /window\.location\.port === "5500"/);
  assert.match(app, /https:\/\/stampnote-omega\.vercel\.app\/api\/triage/);
  assert.equal(/GEMINI_API_KEY|AI_GATEWAY_API_KEY/.test(app), false);
  assert.match(app, /cloud\.uploadReviewedPhoto\(record\)/);
  assert.match(app, /await store\.markSynced\(record\.id\)/);
  assert.match(app, /record\.blob && record\.aiReview/);
  assert.match(app, /response\.status === 404/);
  assert.match(app, /No photos were moved or deleted/);
  assert.equal(/completed photo\(s\) were saved/.test(app), false);
});

test("cloud photos require sign-in and the admin dashboard groups them by place and date", () => {
  const firebase = readFileSync(resolve(projectRoot, "firebase.js"), "utf8");
  const firestoreRules = readFileSync(resolve(projectRoot, "firestore.rules"), "utf8");
  const admin = readFileSync(resolve(projectRoot, "admin.html"), "utf8");
  const adminApp = readFileSync(resolve(projectRoot, "admin.js"), "utf8");

  assert.ok(existsSync(resolve(projectRoot, "admin.css")));
  assert.match(admin, /id=["']photo-library["']/);
  assert.match(admin, /Continue with Google/);
  assert.match(adminApp, /function buildScope\(\)/);
  assert.match(adminApp, /function scopedPhotos\(view\)/);
  assert.match(adminApp, /cloud\.getPhotosPage/);
  assert.match(adminApp, /cloud\.getPhotoBlob/);
  assert.equal(/getDownloadURL/.test(firebase), false);
  assert.equal(existsSync(resolve(projectRoot, "storage.rules")), false);
  assert.match(firebase, /maxEdge = 512/);
  assert.match(firebase, /imageData:/);
  assert.match(firestoreRules, /match \/\{document=\*\*\}/);
  assert.match(firestoreRules, /allow read, write: if request\.auth != null/);
  assert.equal(/allow read, write: if true/.test(firestoreRules), false);
});

test("Realtime Database rules deny anonymous access and are registered for deployment", () => {
  const firebaseConfig = JSON.parse(
    readFileSync(resolve(projectRoot, "firebase.json"), "utf8"),
  );
  const databaseRules = JSON.parse(
    readFileSync(resolve(projectRoot, "database.rules.json"), "utf8"),
  );

  assert.equal(firebaseConfig.database.rules, "database.rules.json");
  assert.equal(databaseRules.rules[".read"], "auth != null");
  assert.equal(databaseRules.rules[".write"], "auth != null");
  assert.deepEqual(databaseRules.rules.attendanceDays.$date.entries[".indexOn"], [
    "checkedInAtMs",
    "workerId",
    "location",
  ]);
  assert.equal(JSON.stringify(databaseRules).includes('".read":true'), false);
  assert.equal(JSON.stringify(databaseRules).includes('".write":true'), false);
});

test("Firestore attendance collection-group index is registered for deployment", () => {
  const firebaseConfig = JSON.parse(
    readFileSync(resolve(projectRoot, "firebase.json"), "utf8"),
  );
  const firestoreIndexes = JSON.parse(
    readFileSync(resolve(projectRoot, "firestore.indexes.json"), "utf8"),
  );

  assert.equal(firebaseConfig.firestore.indexes, "firestore.indexes.json");
  assert.deepEqual(firestoreIndexes.fieldOverrides, [
    {
      collectionGroup: "entries",
      fieldPath: "checkedInAtMs",
      indexes: [{ order: "DESCENDING", queryScope: "COLLECTION_GROUP" }],
    },
  ]);
});

test("AI review starts hidden and rejected photos can be recovered", () => {
  assert.ok(hasAttribute(tagWithId("button", "ai-review"), "hidden"));
  assert.ok(hasAttribute(tagWithId("button", "ai-review-bin"), "hidden"));
  assert.ok(hasAttribute(tagWithId("button", "viewer-restore"), "hidden"));
  const loader = tagWithId("section", "ai-review-loader");
  assert.ok(hasAttribute(loader, "hidden"));
  assert.ok(hasAttribute(loader, "role", "status"));
  assert.ok(hasAttribute(loader, "aria-live", "polite"));
  assert.match(html, /id="ai-review-loader-title">Reviewing photos/);
  assert.match(html, /Gemini vision/);

  const app = readFileSync(resolve(projectRoot, "app.js"), "utf8");
  assert.match(app, /store\.applyAiReviews\(/);
  assert.match(app, /store\.restoreAiDiscard\(/);
  assert.match(app, /store\.purgeAiDiscarded\(/);
  assert.match(app, /allRecords\.filter\(storage\.isAiFlagged\)/);
  assert.match(css, /\.capture\[data-ai-review="discard"\]/);
  assert.match(css, /\.capture\[data-ai-review="review"\]/);
  assert.match(css, /\.ai-review-loader\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0/);
  assert.match(css, /@keyframes ai-core-throb/);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)/);
});

test("the schedule is driven by the pose tracker, at the two required intervals", () => {
  const app = readFileSync(resolve(projectRoot, "app.js"), "utf8");
  const scheduler = readFileSync(resolve(projectRoot, "capture-scheduler.js"), "utf8");

  assert.match(scheduler, /const POSE_INTERVAL = 30000;/);
  assert.match(scheduler, /const IDLE_INTERVAL = 120000;/);

  // The app takes the defaults rather than inventing its own cadence.
  assert.match(app, /schedule\.createCaptureScheduler\(\)/);
  assert.match(app, /pose\.createPoseDetector\(\)/);
  assert.match(app, /pose\.createPoseTracker\(\)/);
});

test("the start and stop glyphs swap through the attribute, not the property", () => {
  const app = readFileSync(resolve(projectRoot, "app.js"), "utf8");

  // `hidden` is an HTMLElement property. Assigning it on an <svg> sets a stray
  // JavaScript property, the [hidden] rule never matches, and the button keeps
  // offering to start a watch that is already running.
  assert.match(app, /monitorIconStart\.toggleAttribute\("hidden", running\)/);
  assert.match(app, /monitorIconStop\.toggleAttribute\("hidden", !running\)/);
  assert.equal(/monitorIcon(Start|Stop)\.hidden\s*=/.test(app), false);

  // The stop glyph starts out hidden in the markup, where the attribute works.
  assert.ok(hasAttribute(tagWithId("svg", "monitor-icon-stop"), "hidden"));
  assert.equal(hasAttribute(tagWithId("svg", "monitor-icon-start"), "hidden"), false);
});

test("the overlay draws a whole rig, limb by limb", () => {
  const app = readFileSync(resolve(projectRoot, "app.js"), "utf8");

  // Arms and legs are drawn as their own chains rather than a torso outline.
  ["shoulderLeft", "elbowLeft", "wristLeft", "hipRight", "kneeRight", "ankleRight"].forEach(
    (joint) => {
      assert.match(app, new RegExp(`points\\.${joint}`), `expected ${joint} in the overlay`);
    },
  );

  // A limb that was not found leaves a gap instead of a bone drawn to nowhere.
  assert.match(app, /if \(index === 0 \|\| !start \|\| !end\) \{\s*return;/);

  // Trunk and limbs are told apart by colour.
  assert.match(app, /const SPINE_COLOR = /);
  assert.match(app, /const LIMB_COLOR = /);
});

test("vehicles are highlighted without reaching the schedule", () => {
  const app = readFileSync(resolve(projectRoot, "app.js"), "utf8");
  const controller = readFileSync(resolve(projectRoot, "auto-capture.js"), "utf8");

  // Drawn in their own colour, labelled, and drawn before the rig so a person
  // in front of a car stays in the foreground.
  assert.match(app, /const VEHICLE_COLOR = /);
  assert.match(app, /drawVehicle\(context, state\.vehicle\.box, frame, width\)/);
  assert.match(app, /const label = "VEHICLE"/);

  // The schedule is handed `present` — whether a person is there — and nothing
  // about vehicles. This is the line that keeps a passing car from pulling the
  // watch onto the 30-second cadence.
  assert.match(controller, /scheduler\.evaluate\(\{ present: state\.present, now: timestamp \}\)/);
  assert.equal(/scheduler\.evaluate\([^)]*vehicle/.test(controller), false);
});

test("the overlay follows the crop the video is displayed with", () => {
  const app = readFileSync(resolve(projectRoot, "app.js"), "utf8");

  // The video fills its box with object-fit: cover, which scales it up and
  // crops the overflow. Keypoints arrive in the camera frame's coordinates, so
  // without the same transform the rig drifts off the body by however much was
  // cropped — and a phone camera's shape almost never matches the box it is
  // given, so this is the ordinary case, not the corner one.
  assert.match(css, /\.monitor video\s*\{[^}]*object-fit:\s*cover/);
  assert.match(app, /function coveredFrame\(width, height\)/);
  assert.match(app, /Math\.max\(width \/ sourceWidth, height \/ sourceHeight\)/);
  assert.match(app, /frame\.left \+ point\.x \* frame\.width/);

  // Nothing may map a keypoint straight onto the element's own size again.
  assert.equal(/point\.x \* width/.test(app), false);
});

test("the watch is given the whole screen, whichever way the phone is held", () => {
  // The camera fills the stage in whatever shape the screen is, so turning the
  // phone needs no layout of its own — and the overlay maps its keypoints
  // through the same crop.
  assert.match(css, /\.stage\s*\{[^}]*position:\s*relative/);
  assert.match(css, /\.monitor\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0/);
  assert.match(css, /height:\s*100dvh/);

  // Landscape on a phone is all width and no height, and it is how this gets
  // held while recording.
  assert.match(css, /@media \(orientation: landscape\) and \(max-height: 560px\)/);

  // Bones and labels are sized from the width they are drawn at, so the rig
  // does not thin to a scratch on a larger display.
  const app = readFileSync(resolve(projectRoot, "app.js"), "utf8");
  assert.match(app, /function boneWidth\(width\)/);
  assert.match(app, /context\.lineWidth = stroke/);
});

test("the live camera is released when the watch stops", () => {
  const app = readFileSync(resolve(projectRoot, "app.js"), "utf8");

  // A stream left running keeps the camera light on after the user stops.
  assert.match(app, /stream\?\.getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/);
  assert.match(app, /monitorVideo\.srcObject = null/);
  assert.match(app, /addEventListener\("pagehide"/);

  // A hidden tab has no camera to look through, so tracking pauses.
  assert.match(app, /addEventListener\("visibilitychange"/);
  assert.match(app, /controller\.setPaused\(true\)/);
});

test("one tracking error cannot permanently stop the sampling loop", () => {
  const app = readFileSync(resolve(projectRoot, "app.js"), "utf8");
  const controller = readFileSync(resolve(projectRoot, "auto-capture.js"), "utf8");

  assert.match(controller, /Tracking restarted after a camera hiccup/);
  assert.match(controller, /catch\s*\{[\s\S]*detector\.reset\?\.\(\);[\s\S]*tracker\.reset\(\)/);
  assert.match(app, /finally\s*\{[\s\S]*sampleTimer = window\.setTimeout\(look/);
});

test("CSS covers the live frame, the pose overlay and the capture grid", () => {
  assert.match(css, /\.monitor\s*\{/);
  assert.match(css, /\.monitor-overlay\s*\{/);
  assert.match(css, /\.monitor video\s*\{[^}]*object-fit:\s*cover/);
  assert.match(css, /\.reel\s*\{[^}]*overflow-x:\s*auto/);
  assert.match(css, /\.capture\[data-pose="true"\]/);
});

test("deleting photos says nothing, and nothing points at a button that is gone", () => {
  const app = readFileSync(resolve(projectRoot, "app.js"), "utf8");

  // The grid emptying is the confirmation.
  assert.equal(/Stored photos deleted/.test(app), false);
  // There is no Add photo button any more, so no wording may send anyone to it.
  assert.equal(/Add photo/i.test(app), false);
  assert.equal(/Add photo/i.test(html), false);
});

test("the photographs are a strip under the camera, not a panel over it", () => {
  // Order on the page: the picture, then the strip of what it has taken, then
  // the tools. Nothing covers the camera and nothing has to be opened.
  const stage = html.indexOf('<main class="stage"');
  const strip = html.indexOf('id="filmstrip"');
  const toolbar = html.indexOf('<nav class="toolbar"');

  assert.ok(stage > -1 && strip > stage && toolbar > strip);
  assert.equal(/id=["']photo-sheet["']/.test(html), false);

  // One row, swiped sideways, with both kinds of photograph in it.
  assert.match(css, /\.reel\s*\{[^}]*display:\s*flex/);
  assert.match(css, /\.reel\s*\{[^}]*overflow-x:\s*auto/);
  assert.match(css, /\.previews,\s*\n\.captures\s*\{[^}]*display:\s*contents/);

  // A tile is a button, so it opens the photo whole and a keyboard can reach it.
  const app = readFileSync(resolve(projectRoot, "app.js"), "utf8");
  assert.match(app, /tile\.className = "capture"/);
  assert.match(app, /tile\.addEventListener\("click", \(\) =>\s*\n?\s*openViewer/);
  assert.match(html, /id=["']viewer["'][^>]*role=["']dialog["']/);
});

test("the shutter is centred and saving sits in the bottom right corner", () => {
  // Three columns rather than a spread row: whatever is placed either side, the
  // record button stays in the middle of the screen.
  assert.match(css, /\.toolbar\s*\{[^}]*grid-template-columns:\s*1fr auto 1fr/);
  assert.match(css, /\.toolbar-group-end\s*\{[^}]*justify-content:\s*flex-end/);

  // Save is the last thing in the bar, in the trailing group.
  const trailing = html.match(/<div class="toolbar-group toolbar-group-end">([\s\S]*?)<\/div>/i);
  assert.ok(trailing, "Expected a trailing toolbar group");
  assert.match(trailing[1], /id=["']captures-save["']/);

  // And the record button is between the two groups.
  assert.ok(html.indexOf('id="monitor-toggle"') > html.indexOf('<div class="toolbar-group">'));
  assert.ok(html.indexOf('id="monitor-toggle"') < html.indexOf('toolbar-group-end'));

  // The stopped glyph is the familiar solid red recording circle.
  assert.match(css, /--record:\s*#ff3b30/);
  assert.match(css, /\.record\s*\{[^}]*color:\s*var\(--record\)/);
  assert.match(css, /\.record\s*\{[^}]*linear-gradient/);
  assert.match(css, /\.record\s*\{[^}]*box-shadow:/);
  assert.match(css, /\.record::before\s*\{[^}]*inset:\s*5px/);
  assert.match(css, /\.record:active\s*\{[^}]*translateY\(3px\)/);
  assert.match(css, /\.record \.record-icon\s*\{[^}]*fill:\s*currentColor/);
  assert.match(tagWithId("button", "monitor-toggle"), /aria-pressed=["']false["']/);
});

test("a capture is kept without anyone touching the device", () => {
  const app = readFileSync(resolve(projectRoot, "app.js"), "utf8");
  const controller = readFileSync(resolve(projectRoot, "auto-capture.js"), "utf8");

  // The store write is inside the capture itself — no button, no prompt, no
  // gesture between taking a photograph and keeping it.
  assert.match(controller, /async function capture\([\s\S]*?await store\.save\(/);
  assert.equal(/confirm\(|showSaveFilePicker|click\(\)/.test(controller), false);

  // Copying them out to a folder is the part a browser will not do silently, so
  // it is armed once and then writes every later capture on its own.
  assert.match(app, /const canKeepFolder = typeof window\.showDirectoryPicker === "function"/);
  assert.match(app, /if \(folder\) \{\s*\n\s*writeToFolder\(state\.lastRecord\)/);
  assert.match(app, /createWritable\(\)/);
});

test("nothing animates behind the picture", () => {
  // The old card interface panned a grid across the background forever. The
  // camera is the background now, and a loop under it is both a distraction
  // and a phone's battery burning on a decoration. Continuous animation is
  // limited to temporary, explicitly visible task indicators.
  const infiniteAnimationSelectors = [...css.matchAll(
    /([^{}]+)\{[^{}]*animation:[^;]*infinite/g,
  )].map((match) => match[1].trim());

  assert.equal(/grid-pan/.test(css), false);
  assert.ok(infiniteAnimationSelectors.length > 0);
  assert.ok(
    infiniteAnimationSelectors.every(
      (selector) =>
        selector.startsWith(".ai-review-") ||
        selector.startsWith(".face-enrollment-progress"),
    ),
  );
  assert.equal(/body::before|body::after/.test(css), false);
});

test("share control is present and starts hidden", () => {
  const shareButton = tagWithId("button", "share-button");

  assert.ok(hasAttribute(shareButton, "type", "button"));
  // Revealed by script only when the browser can share files.
  assert.ok(hasAttribute(shareButton, "hidden"));
});

test("the watch tracks a room, not just one person", () => {
  const model = readFileSync(resolve(projectRoot, "pose-model.js"), "utf8");
  const app = readFileSync(resolve(projectRoot, "app.js"), "utf8");
  const controller = readFileSync(resolve(projectRoot, "auto-capture.js"), "utf8");

  // The models are asked for several people rather than one. Cost follows how
  // many are actually there, so a raised cap is free in an empty room.
  assert.match(model, /const MAX_PEOPLE = \d+;/);
  assert.match(model, /numPoses: MAX_PEOPLE/);
  assert.match(model, /numFaces: MAX_PEOPLE/);
  assert.equal(/numPoses: 1/.test(model), false);

  // Every pose is mapped, not just the first one the model listed.
  assert.match(model, /mapping\.buildCrowd\(poses,/);
  assert.equal(/pose\?\.landmarks\?\.\[0\]/.test(model), false);

  // The overlay draws everyone, and eases each person towards their own next
  // position rather than smearing one across the frame into another.
  assert.match(app, /bodies\.forEach\(\(body\) => drawBody\(/);
  assert.match(app, /mapping\.blendBodies\(drawn\?\.bodies, target\.bodies, EASE\)/);

  // The count is state, so it can be shown and stored.
  assert.match(controller, /state\.people = identified\?\.visibleCount \?\? tracked\.people/);
  assert.match(controller, /\$\{state\.people\} tracked workers in frame/);

  // Enrolled worker IDs are painted onto both live and saved pixels while the
  // numeric tracking ID stays internal.
  assert.match(html, /<script\s+src=["']person-tracker\.js["']\s+defer><\/script>/i);
  assert.match(html, /<script\s+src=["']face-identity\.js["']\s+defer><\/script>/i);
  assert.match(app, /facialRecognition\?\.createFaceIdentity\?\.\(\{ knownIdentities/);
  assert.match(app, /personIdentity\?\.createPersonTracker\(\{ identities/);
  assert.match(
    readFileSync(resolve(projectRoot, "person-tracker.js"), "utf8"),
    /personLabel: track\.workerId \|\| "TRACKING WORKER"/,
  );
  assert.doesNotMatch(
    readFileSync(resolve(projectRoot, "person-tracker.js"), "utf8"),
    /workerAlias/,
  );
  assert.match(app, /const text = label\.toUpperCase\(\)/);
  assert.match(app, /drawPersonMarker\(captureContext, body,/);
  assert.match(controller, /bodies: \(state\.bodies \|\| \[\]\)/);
  assert.equal(/personIds:\s*state\.personIds/.test(controller), false);
});
