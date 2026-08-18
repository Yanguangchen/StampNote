(function initializeAiAssistantShim(globalScope) {
  "use strict";

  if (typeof require === "function" && typeof module !== "undefined" && module.exports) {
    module.exports = require("./src/services/ai-assistant.js");
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
