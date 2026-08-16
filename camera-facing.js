/* Which camera a device points at the work is the operator's decision, not the
   page's. A phone propped on a shelf watches the room through the lens on its
   back; the same phone held up to check a face wants the one on its front; a
   laptop only has the front one and calls it the webcam. Both camera pages ask
   the same question, so they ask it the same way and in the same words. */
(function initializeCameraFacing(globalScope) {
  "use strict";

  // getUserMedia names the two cameras by where they point rather than by where
  // they sit: `environment` looks out at the scene, `user` looks back at
  // whoever is holding the device. Those are the values kept everywhere here,
  // so nothing between the button and the constraint has to translate.
  const BACK = "environment";
  const FRONT = "user";
  const DEFAULT_KEY = "stampnote-camera-facing";

  const NAMES = { [BACK]: "Back", [FRONT]: "Front" };
  const DESCRIPTIONS = { [BACK]: "back camera", [FRONT]: "front camera" };

  function normalize(value, fallback = BACK) {
    if (value === BACK || value === FRONT) return value;
    if (fallback === BACK || fallback === FRONT) return fallback;
    return BACK;
  }

  function opposite(value) {
    return normalize(value) === BACK ? FRONT : BACK;
  }

  // "Back" beside the glyph, "back camera" inside a sentence.
  function name(value) {
    return NAMES[normalize(value)];
  }

  function describe(value) {
    return DESCRIPTIONS[normalize(value)];
  }

  // `facingMode` is asked for, never demanded. As an exact constraint it fails
  // outright on a laptop with a single camera — trading a working front camera
  // for no camera at all — whereas as a plain hint the browser hands back the
  // closest lens it has.
  function videoConstraints(value, options = {}) {
    const constraints = { facingMode: normalize(value, options.fallback) };
    if (options.width) constraints.width = { ideal: options.width };
    if (options.height) constraints.height = { ideal: options.height };
    if (options.frameRate) constraints.frameRate = { ideal: options.frameRate };
    return constraints;
  }

  // Reading the property alone throws inside a sandboxed frame, so even getting
  // at storage is guarded.
  function resolveStorage(provided) {
    if (provided) return provided;
    try {
      return globalScope.localStorage || null;
    } catch {
      return null;
    }
  }

  // A device is usually set up once and then left that way, so the choice is
  // remembered across visits. Remembering it is a convenience and never a
  // requirement: private windows and blocked site storage both fail here, and
  // the page's own default is a perfectly good answer when they do.
  function createPreference(options = {}) {
    const key = String(options.key || DEFAULT_KEY);
    const fallback = normalize(options.fallback);
    const storage = resolveStorage(options.storage);
    let current = fallback;

    try {
      current = normalize(storage?.getItem(key), fallback);
    } catch {
      current = fallback;
    }

    function get() {
      return current;
    }

    function set(next) {
      current = normalize(next, fallback);
      try {
        storage?.setItem(key, current);
      } catch {
        // The choice still holds for this visit; only the remembering is lost.
      }
      return current;
    }

    function toggle() {
      return set(opposite(current));
    }

    return Object.freeze({ get, key, set, toggle });
  }

  const api = Object.freeze({
    BACK,
    DEFAULT_KEY,
    FRONT,
    createPreference,
    describe,
    name,
    normalize,
    opposite,
    videoConstraints,
  });
  globalScope.StampNoteCameraFacing = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
