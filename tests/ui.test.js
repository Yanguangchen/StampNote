const assert = require("node:assert/strict");
const { readFileSync, existsSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");

const projectRoot = resolve(__dirname, "..");
const html = readFileSync(resolve(projectRoot, "index.html"), "utf8");
const css = readFileSync(resolve(projectRoot, "styles.css"), "utf8");
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

test("the toolbar's controls are labelled, in writing and for a pointer", () => {
  // These sit in the bottom bar with their names beside them, so unlike the
  // icon-only controls the wording is on screen rather than hidden.
  [
    ["label", "for", "gallery-input", "Choose from gallery", "Choose"],
    ["button", "id", "photo-sheet-toggle", "Photos", "Photos"],
    ["button", "id", "place-toggle", "Street address", "Place"],
  ].forEach(([tagName, attribute, id, tooltip, wording]) => {
    const pattern = new RegExp(
      `<${tagName}\\b[^>]*${attribute}=["']${escapeRegExp(id)}["'][^>]*>([\\s\\S]*?)</${tagName}>`,
      "i",
    );
    const match = html.match(pattern);

    assert.ok(match, `Expected a <${tagName}> for ${id}`);
    assert.match(match[0], new RegExp(`title=["']${escapeRegExp(tooltip)}["']`, "i"));
    assert.match(match[1], new RegExp(`class=["']tool-name["']>${escapeRegExp(wording)}<`, "i"));
    assert.match(match[1], /<svg\b[^>]*aria-hidden=["']true["']/i);
  });

  // The sheet says whether it is open, for anyone who cannot see that it is.
  assert.match(html, /id=["']photo-sheet-toggle["'][^>]*aria-expanded=["']false["']/i);
  assert.match(html, /aria-controls=["']photo-sheet["']/i);
});

test("icon-only controls keep a text name and hide the glyph from assistive tech", () => {
  const controls = [
    ["button", "share-button", "Share"],
    ["button", "monitor-toggle", "Start auto capture"],
    ["button", "captures-save", "Save captures"],
    ["button", "captures-clear", "Delete captures"],
  ];

  controls.forEach(([tagName, id, name]) => {
    const attribute = tagName === "label" ? "for" : "id";
    const pattern = new RegExp(
      `<${tagName}\\b[^>]*${attribute}=["']${escapeRegExp(id)}["'][^>]*>([\\s\\S]*?)</${tagName}>`,
      "i",
    );
    const match = html.match(pattern);

    assert.ok(match, `Expected a <${tagName}> for ${id}`);
    // The glyph carries no text, so the name has to come from the hidden span.
    assert.match(match[1], new RegExp(`class=["']?[^"']*visually-hidden[^"']*["']?[^>]*>${escapeRegExp(name)}<`, "i"));
    assert.match(match[1], /<svg\b[^>]*aria-hidden=["']true["']/i);
    // A tooltip for anyone using a pointer.
    assert.match(match[0], new RegExp(`title=["']${escapeRegExp(name)}["']`, "i"));

    // Nothing but the glyph and the hidden name is left, so the control renders
    // as an icon with no wording beside it.
    const visible = match[1]
      .replace(/<svg\b[\s\S]*?<\/svg>/gi, "")
      .replace(/<span\b[^>]*visually-hidden[^>]*>[\s\S]*?<\/span>/gi, "")
      .trim();

    assert.equal(visible, "", `Expected no visible text in the ${id} control`);
  });
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
  assert.match(css, /@media\s*\(max-width:\s*900px\)/);
  assert.match(css, /@media\s*\(max-width:\s*560px\)/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
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

test("capture controls stay hidden until something has been captured", () => {
  assert.ok(hasAttribute(tagWithId("button", "captures-save"), "hidden"));
  assert.ok(hasAttribute(tagWithId("button", "captures-clear"), "hidden"));
  assert.match(html, /id=["']captures["']/);
});

test("the watch stores captures locally and never uploads them", () => {
  const app = readFileSync(resolve(projectRoot, "app.js"), "utf8");
  const store = readFileSync(resolve(projectRoot, "photo-store.js"), "utf8");

  // Every capture goes to the device's own store, and stays queued there.
  assert.match(app, /storage\.createPhotoStore\(\)/);
  assert.match(store, /status: "local"/);

  // Nothing in the capture path posts a photo anywhere.
  assert.equal(/fetch\(|XMLHttpRequest|sendBeacon|WebSocket/.test(store), false);
  assert.equal(/sendBeacon|XMLHttpRequest|WebSocket/.test(app), false);
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

test("CSS covers the live frame, the pose overlay and the capture grid", () => {
  assert.match(css, /\.monitor\s*\{/);
  assert.match(css, /\.monitor-overlay\s*\{/);
  assert.match(css, /\.monitor video\s*\{[^}]*object-fit:\s*cover/);
  assert.match(css, /\.captures\s*\{[^}]*grid-template-columns/);
  assert.match(css, /\.capture\[data-pose="true"\]/);
});

test("share control is present and starts hidden", () => {
  const shareButton = tagWithId("button", "share-button");

  assert.ok(hasAttribute(shareButton, "type", "button"));
  // Revealed by script only when the browser can share files.
  assert.ok(hasAttribute(shareButton, "hidden"));
});
