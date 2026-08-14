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
  assert.match(css, /\.worker-form,\s*\n\.scanner\s*\{[^}]*border-radius:/);
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
  assert.match(app, /FACE_CAMERA_WIDTH\s*=\s*1920/);
  assert.match(app, /FACE_CAMERA_HEIGHT\s*=\s*1080/);
  assert.match(app, /enrollmentSamples:\s*ONBOARDING_SAMPLES/);
  assert.match(app, /body\?\.enrollmentAccepted\s*===\s*true/);
  assert.match(app, /loadFaceScanner\(\)/);

  // The one frame that is kept is a badge-sized square, taken from an accepted
  // sample and sent with the enrollment; nothing else is rasterized.
  assert.match(app, /PROFILE_PHOTO_EDGE\s*=\s*256/);
  assert.match(app, /canvas\.toDataURL\("image\/jpeg", PROFILE_PHOTO_QUALITY\)/);
  assert.match(app, /profilePhoto = captureProfilePhoto\(\) \|\| profilePhoto/);
  assert.match(app, /profilePhoto,/);
  // A cancelled scan keeps nothing.
  assert.match(app, /profilePhoto = null;/);
});

test("the recording page links directly to worker onboarding", () => {
  const capture = readFileSync(resolve(root, "index.html"), "utf8");
  assert.match(capture, /id="worker-onboarding"[^>]*href="onboarding\.html"/);
  assert.match(capture, /Enroll worker faces/);
});
