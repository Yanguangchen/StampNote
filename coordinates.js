(function initializeCoordinateSessionsShim(globalScope) {
  "use strict";

  if (typeof require === "function" && typeof module !== "undefined" && module.exports) {
    module.exports = require("./src/services/coordinate-sessions.js");
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
