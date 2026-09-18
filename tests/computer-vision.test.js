const assert = require("node:assert/strict");
const { test } = require("node:test");

const computerVision = require("../computer-vision.js");

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

test("computer vision and video streaming are the two named modes", () => {
  assert.equal(computerVision.ON, "on");
  assert.equal(computerVision.OFF, "off");
  assert.equal(computerVision.opposite(computerVision.ON), computerVision.OFF);
  assert.equal(computerVision.opposite(computerVision.OFF), computerVision.ON);

  assert.equal(computerVision.name(computerVision.ON), "Vision");
  assert.equal(computerVision.name(computerVision.OFF), "Stream");
  assert.equal(computerVision.describe(computerVision.ON), "computer vision");
  assert.equal(computerVision.describe(computerVision.OFF), "video streaming");
  assert.equal(computerVision.isEnabled(computerVision.ON), true);
  assert.equal(computerVision.isEnabled(computerVision.OFF), false);
});

test("anything that is not a vision mode falls back to computer vision", () => {
  assert.equal(computerVision.normalize("sideways"), "on");
  assert.equal(computerVision.normalize(null), "on");
  assert.equal(computerVision.normalize(undefined, computerVision.OFF), "off");
  assert.equal(computerVision.normalize("", "maybe"), "on");
  assert.equal(computerVision.normalize(true), "on");
  assert.equal(computerVision.normalize(false), "off");
  assert.equal(computerVision.opposite("sideways"), "off");
});

test("the choice is remembered and survives a reload", () => {
  const storage = createStorage();
  const preference = computerVision.createPreference({
    key: "stampnote-computer-vision",
    fallback: computerVision.ON,
    storage,
  });

  assert.equal(preference.get(), "on");
  assert.equal(preference.enabled(), true);
  assert.equal(preference.toggle(), "off");
  assert.equal(storage.getItem("stampnote-computer-vision"), "off");
  assert.equal(preference.enabled(), false);

  const reloaded = computerVision.createPreference({
    key: "stampnote-computer-vision",
    fallback: computerVision.ON,
    storage,
  });
  assert.equal(reloaded.get(), "off");
  assert.equal(reloaded.toggle(), "on");
});

test("a stored value that is not a mode is ignored", () => {
  const preference = computerVision.createPreference({
    fallback: computerVision.OFF,
    storage: createStorage({ "stampnote-computer-vision": "tracking" }),
  });

  assert.equal(preference.key, "stampnote-computer-vision");
  assert.equal(preference.get(), "off");
  assert.equal(preference.set("nonsense"), "off");
});

test("blocked storage costs the remembering, never the mode switch", () => {
  const blocked = {
    getItem() {
      throw new Error("The operation is insecure.");
    },
    setItem() {
      throw new Error("The operation is insecure.");
    },
  };
  const preference = computerVision.createPreference({
    fallback: computerVision.ON,
    storage: blocked,
  });

  assert.equal(preference.get(), "on");
  assert.equal(preference.toggle(), "off");
  assert.equal(preference.get(), "off");
});

test("a page with no storage at all still switches modes", () => {
  const preference = computerVision.createPreference({
    fallback: computerVision.OFF,
    storage: null,
  });

  assert.equal(preference.get(), "off");
  assert.equal(preference.toggle(), "on");
  assert.equal(preference.get(), "on");
});
