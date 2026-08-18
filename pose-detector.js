(function initializePoseDetectorShim(globalScope) {
  "use strict";

  if (typeof require === "function" && typeof module !== "undefined" && module.exports) {
    module.exports = require("./src/vision/pose-detector.js");
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
