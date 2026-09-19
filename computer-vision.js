/* Recording can watch a room two ways: MediaPipe computer vision for attendance
   and auto capture, or a plain camera stream for live video. Both pages that
   ask the question — only Recording, today — should ask it the same way and in
   the same words, and remember the answer across visits the way the camera
   facing control does. */
(function initializeComputerVision(globalScope) {
  "use strict";

  const ON = "on";
  const OFF = "off";
  const DEFAULT_KEY = "stampnote-computer-vision";

  const NAMES = { [ON]: "Vision", [OFF]: "Stream" };
  const DESCRIPTIONS = { [ON]: "computer vision", [OFF]: "video streaming" };

  function normalize(value, fallback = ON) {
    if (value === ON || value === OFF) return value;
    if (value === true || value === "true") return ON;
    if (value === false || value === "false") return OFF;
    if (fallback === ON || fallback === OFF) return fallback;
    return ON;
  }

  function isEnabled(value) {
    return normalize(value) === ON;
  }

  function opposite(value) {
    return isEnabled(value) ? OFF : ON;
  }

  function name(value) {
    return NAMES[normalize(value)];
  }

  function describe(value) {
    return DESCRIPTIONS[normalize(value)];
  }

  function resolveStorage(provided) {
    if (provided) return provided;
    try {
      return globalScope.localStorage || null;
    } catch {
      return null;
    }
  }

  // A device set up for live video should stay that way on the next visit.
  // Remembering is a convenience: private windows and blocked site storage
  // both fail here, and computer vision remains the default when they do.
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

    function enabled() {
      return isEnabled(current);
    }

    return Object.freeze({ enabled, get, key, set, toggle });
  }

  const api = Object.freeze({
    DEFAULT_KEY,
    OFF,
    ON,
    createPreference,
    describe,
    isEnabled,
    name,
    normalize,
    opposite,
  });
  globalScope.StampNoteComputerVision = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
