const assert = require("node:assert/strict");
const { test } = require("node:test");

const cameraFacing = require("../camera-facing.js");

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

test("the two cameras are named as getUserMedia names them", () => {
  assert.equal(cameraFacing.BACK, "environment");
  assert.equal(cameraFacing.FRONT, "user");
  assert.equal(cameraFacing.opposite(cameraFacing.BACK), cameraFacing.FRONT);
  assert.equal(cameraFacing.opposite(cameraFacing.FRONT), cameraFacing.BACK);

  assert.equal(cameraFacing.name(cameraFacing.BACK), "Back");
  assert.equal(cameraFacing.name(cameraFacing.FRONT), "Front");
  assert.equal(cameraFacing.describe(cameraFacing.BACK), "back camera");
  assert.equal(cameraFacing.describe(cameraFacing.FRONT), "front camera");
});

test("anything that is not one of the two cameras falls back", () => {
  assert.equal(cameraFacing.normalize("sideways"), "environment");
  assert.equal(cameraFacing.normalize(null), "environment");
  assert.equal(cameraFacing.normalize(undefined, cameraFacing.FRONT), "user");
  // A caller's own fallback is checked too, so a typo cannot leak through as a
  // constraint the browser would reject.
  assert.equal(cameraFacing.normalize("", "sideways"), "environment");
  assert.equal(cameraFacing.opposite("sideways"), "user");
});

test("the camera is asked for rather than demanded", () => {
  const constraints = cameraFacing.videoConstraints(cameraFacing.FRONT, {
    width: 1920,
    height: 1080,
    frameRate: 30,
  });

  assert.deepEqual(constraints, {
    facingMode: "user",
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 30 },
  });
  // A bare string rather than an `{ exact: … }` object: an exact constraint
  // fails outright on a laptop with one camera, where a plain hint returns the
  // closest lens it has.
  assert.equal(typeof constraints.facingMode, "string");
  assert.deepEqual(cameraFacing.videoConstraints("sideways"), { facingMode: "environment" });
});

test("the choice is remembered per page and survives a reload", () => {
  const storage = createStorage();
  const preference = cameraFacing.createPreference({
    key: "stampnote-camera-facing",
    fallback: cameraFacing.BACK,
    storage,
  });

  assert.equal(preference.get(), "environment");
  assert.equal(preference.toggle(), "user");
  assert.equal(storage.getItem("stampnote-camera-facing"), "user");

  // A reload reads back what was written rather than the page's default.
  const reloaded = cameraFacing.createPreference({
    key: "stampnote-camera-facing",
    fallback: cameraFacing.BACK,
    storage,
  });
  assert.equal(reloaded.get(), "user");
  assert.equal(reloaded.toggle(), "environment");

  // The two camera pages keep separate answers, since their defaults are
  // opposite: the watch faces the work, enrollment faces the worker.
  const onboarding = cameraFacing.createPreference({
    key: "stampnote-onboarding-camera-facing",
    fallback: cameraFacing.FRONT,
    storage,
  });
  assert.equal(onboarding.get(), "user");
  assert.equal(storage.getItem("stampnote-camera-facing"), "environment");
});

test("a stored value that is not a camera is ignored", () => {
  const preference = cameraFacing.createPreference({
    fallback: cameraFacing.FRONT,
    storage: createStorage({ "stampnote-camera-facing": "sideways" }),
  });

  assert.equal(preference.key, "stampnote-camera-facing");
  assert.equal(preference.get(), "user");
  assert.equal(preference.set("nonsense"), "user");
});

test("blocked storage costs the remembering, never the camera", () => {
  const blocked = {
    getItem() {
      throw new Error("The operation is insecure.");
    },
    setItem() {
      throw new Error("The operation is insecure.");
    },
  };
  const preference = cameraFacing.createPreference({
    fallback: cameraFacing.BACK,
    storage: blocked,
  });

  assert.equal(preference.get(), "environment");
  assert.equal(preference.toggle(), "user");
  assert.equal(preference.get(), "user");
});

test("a page with no storage at all still switches cameras", () => {
  const preference = cameraFacing.createPreference({ fallback: cameraFacing.FRONT, storage: null });

  assert.equal(preference.get(), "user");
  assert.equal(preference.toggle(), "environment");
  assert.equal(preference.get(), "environment");
});
