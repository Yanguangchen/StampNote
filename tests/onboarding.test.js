const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");

const root = resolve(__dirname, "..");
const html = readFileSync(resolve(root, "onboarding.html"), "utf8");
const css = readFileSync(resolve(root, "onboarding.css"), "utf8");
const app = readFileSync(resolve(root, "onboarding.js"), "utf8");

test("worker onboarding has signed-in identity, scan, and roster controls", () => {
  assert.match(html, /id="onboarding-auth"/);
  assert.match(html, /id="worker-id"/);
  assert.match(html, /id="worker-name"/);
  assert.equal(/id="worker-consent"|type="checkbox"/.test(html), false);
  assert.match(html, /id="onboarding-video"[^>]*playsinline/);
  assert.match(html, /id="onboarding-progress"[^>]*max="7"/);
  assert.match(html, /id="worker-roster"/);
  // The scan now keeps a portrait, so the page says so where the worker can
  // read it before agreeing to be scanned.
  assert.match(html, /one profile photo/i);
  assert.match(html, /face template for worker ID matching/i);
  assert.ok(existsSync(resolve(root, "onboarding.css")));
  assert.match(css, /\.scanner-oval/);
  // Every step shares one card shell, so the column's edges line up.
  assert.match(css, /\.card\s*\{[^}]*border-radius:/);
  assert.match(html, /class="card worker-form"[\s\S]*class="card scanner"[\s\S]*class="card roster"/);
  assert.match(css, /prefers-color-scheme: dark/);
  assert.match(css, /\.scanner-view video\s*\{[^}]*object-fit:\s*cover/);
});

test("worker onboarding keeps only the enrollment controls and feedback", () => {
  assert.match(html, /<h1[^>]*>Worker onboarding<\/h1>/);
  assert.equal(/class="intro"|class="steps"|class="brand"|local-chip|step-label/.test(html), false);
  assert.equal(/<svg\b/.test(html), false);
  // A portrait per worker, with initials still standing in for anyone enrolled
  // before portraits existed.
  assert.match(app, /worker-avatar/);
  assert.equal(/radial-gradient|backdrop-filter/.test(css), false);
});

test("enrollment stores a representative face gallery and can delete it", () => {
  assert.match(app, /workerFace\.averageEmbeddings\(samples\)/);
  assert.match(app, /embeddings:\s*samples/);
  assert.match(app, /cloud\.saveWorkerFace\(/);
  assert.match(app, /cloud\.deleteWorkerFace\(/);
  assert.match(app, /facingMode:\s*"user"/);
  // Nothing keeps a frame at photo resolution here, so the camera is asked only
  // for what the face model and the badge-sized portrait can use.
  assert.match(app, /FACE_CAMERA_WIDTH\s*=\s*1280/);
  assert.match(app, /FACE_CAMERA_HEIGHT\s*=\s*720/);
  assert.match(app, /enrollmentSamples:\s*ONBOARDING_SAMPLES/);
  assert.match(app, /body\?\.enrollmentAccepted\s*===\s*true/);
  assert.match(app, /loadFaceScanner\(\)/);

  // The one frame that is kept is a badge-sized square, taken from an accepted
  // sample and sent with the enrollment; nothing else is rasterized.
  assert.match(app, /PROFILE_PHOTO_EDGE\s*=\s*256/);
  assert.match(app, /profileCanvas\.toDataURL\("image\/jpeg", PROFILE_PHOTO_QUALITY\)/);
  assert.match(app, /captureProfileFrame\(\);/);
  assert.match(app, /profilePhoto: encodeProfilePhoto\(\)/);
  // Encoding it is worth a scan's worth of ticks, so it happens once, when the
  // enrollment is saved, rather than on every accepted sample.
  assert.equal(app.match(/toDataURL/g).length, 1);
  assert.match(app, /async function saveEnrollment\(\)[\s\S]*?encodeProfilePhoto\(\)/);
  // A cancelled scan keeps nothing.
  assert.match(app, /profileReady = false;/);
});

test("the page arrives a step at a time rather than all at once", () => {
  // An idle camera frame, an oval and a seven-sample counter are the largest
  // thing here and the least actionable before there is a worker to scan, so
  // step two is absent rather than dimmed.
  assert.match(html, /class="card scanner"[^>]*\bhidden\b/);
  assert.doesNotMatch(css, /~ \.scanner:has\(/);
  assert.match(app, /function detailsComplete\(\)/);
  assert.match(app, /normalizeWorkerId\?\.\(workerId\.value\)/);
  assert.match(app, /scannerCard\.hidden = !ready && !scanActive/);
  // An untouched form is two fields and nothing else; the button arrives with the
  // first character, disabled, beside whichever field is still wrong.
  assert.match(app, /function detailsStarted\(\)/);
  assert.match(app, /startButton\.hidden = !detailsStarted\(\) && !scanActive/);
  assert.match(css, /\.card-footer:has\(\.primary-button\[hidden\]\)/);
  // Typing is the trigger, so the reveal keeps up with the keystrokes.
  assert.match(
    app,
    /workerName\?\.addEventListener\("input", \(\) => \{\s*refreshFlow\(\);\s*issueWorkerId\(\);/,
  );
  // A scan already running keeps its camera even if the details are edited.
  assert.match(app, /scanActive = true;/);

  // Who is already enrolled is reference material: folded away, behind one
  // button that carries a glyph rather than a word.
  assert.match(html, /id="roster-body"[^>]*\bhidden\b/);
  assert.match(html, /id="roster-toggle"[\s\S]*?aria-expanded="false"/);
  assert.match(html, /aria-controls="roster-body"/);
  assert.match(html, /class="roster-chevron"[^>]*aria-hidden="true"/);
  assert.match(html, /Show enrolled workers/);
  assert.match(css, /\.roster-chevron\s*\{[^}]*transform:\s*rotate\(45deg\)/);
  assert.match(
    css,
    /\.roster-toggle\[aria-expanded="true"\] \.roster-chevron\s*\{[^}]*rotate\(225deg\)/,
  );
  // Nothing is read for a list nobody has opened; enrolling while it is closed
  // marks it stale instead.
  assert.match(app, /if \(!rosterOpen\) \{\s*rosterStale = true;/);
  assert.match(app, /await refreshRoster\(\);/);
});

test("the worker ID is issued from the name rather than typed", () => {
  // Asked for in the order it is derived: the name, then the ID read out of it.
  assert.match(html, /id="worker-name"[\s\S]*id="worker-id"/);
  assert.match(html, /id="worker-id"[^>]*readonly/s);
  // Nothing for the operator to satisfy in a field they cannot type into.
  assert.doesNotMatch(html, /id="worker-id"[^>]*(?:pattern|required)/s);
  assert.match(css, /\.worker-form input\[readonly\]\s*\{/);

  assert.match(app, /async function issueWorkerId\(/);
  assert.match(app, /workerFace\.nextWorkerId\(name, taken\)/);
  assert.match(app, /workerId\.value = issued \|\| ""/);
  // Saving merges into whatever document the ID names, so the number is issued
  // again from a fresh read once the scan is over.
  assert.match(app, /issueWorkerId\(\{ fresh: true \}\)/);
  assert.match(app, /workerId: issued,/);
  // The roster read and the numbering are the same read.
  assert.match(app, /function readWorkers\(/);
  assert.doesNotMatch(app, /await cloud\.getWorkerFaces\(\)/);
});

test("the recording page moves worker onboarding into the shared page drawer", () => {
  const capture = readFileSync(resolve(root, "index.html"), "utf8");
  const sidebar = readFileSync(resolve(root, "sidebar.js"), "utf8");
  assert.match(capture, /data-sidebar-mount/);
  assert.doesNotMatch(capture, /id="worker-onboarding"|Enroll worker faces/);
  assert.match(sidebar, /file: "onboarding\.html", label: "Worker onboarding"/);
});
