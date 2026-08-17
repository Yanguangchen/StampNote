/* The default screen: with nothing recording, the page is the shutter on a
   drifting field rather than a camera shell with a bar across it. This file
   only decides when the screen is idle, and keeps the phone's status bar in
   step with whichever palette that screen is using. */
(function initializeStageWatcher() {
  "use strict";

  const record = document.querySelector("#monitor-toggle");
  const aiReviewLoader = document.querySelector("#ai-review-loader");
  const themeColour = document.querySelector('meta[name="theme-color"]');

  if (!record || typeof window.matchMedia !== "function") {
    return;
  }

  const darkScheme = window.matchMedia("(prefers-color-scheme: dark)");

  function isIdle() {
    return (
      record.dataset.running !== "true" &&
      record.dataset.loading !== "true" &&
      aiReviewLoader?.hidden !== false
    );
  }

  function syncStage() {
    const idle = isIdle();
    document.body.dataset.stage = idle ? "idle" : "live";
    // The phone's status bar follows the idle palette. A live camera always
    // keeps the dark shell regardless of the system preference.
    const idleThemeColour = darkScheme.matches ? "#0d1512" : "#f6f7f6";
    themeColour?.setAttribute("content", idle ? idleThemeColour : "#0d1512");
    if (!idle) {
      // The first press ends the opening screen for this visit: from here the
      // strip of photographs behaves normally, including after a stop.
      document.body.dataset.recorded = "true";
    }
  }

  const stageWatcher = new MutationObserver(syncStage);
  stageWatcher.observe(record, {
    attributes: true,
    attributeFilter: ["data-running", "data-loading"],
  });
  if (aiReviewLoader) {
    stageWatcher.observe(aiReviewLoader, { attributes: true, attributeFilter: ["hidden"] });
  }

  if (typeof darkScheme.addEventListener === "function") {
    darkScheme.addEventListener("change", syncStage);
  } else {
    darkScheme.addListener?.(syncStage);
  }

  // Photos left in the queue from a previous visit stay out of sight until the
  // camera has been started: the opening screen is the shutter and nothing else.
  document.body.dataset.recorded = "false";

  syncStage();
})();
