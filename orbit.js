/* The default screen: with nothing recording, the tools circle the shutter
   instead of sitting in a bar nobody is looking at. Motion is CSS; this file
   only decides when the screen is idle, how many tools are in the ring, and
   when a pointer has come close enough that the ring should hold still to be
   clicked. */
(function initializeToolOrbit() {
  "use strict";

  const toolbar = document.querySelector(".toolbar");
  const record = document.querySelector("#monitor-toggle");
  const aiReviewLoader = document.querySelector("#ai-review-loader");
  const themeColour = document.querySelector('meta[name="theme-color"]');

  if (!toolbar || !record || typeof window.matchMedia !== "function") {
    return;
  }

  const tools = [...toolbar.querySelectorAll(".tool")];

  // How far from the ring a pointer counts as "arriving at it". Generous
  // enough that the tool stops before the pointer reaches it, rather than the
  // moment it is already too late to click.
  const APPROACH = 76;

  function isIdle() {
    return (
      record.dataset.running !== "true" &&
      record.dataset.loading !== "true" &&
      aiReviewLoader?.hidden !== false
    );
  }

  // A hidden tool would otherwise hold an empty seat in the ring, so the seats
  // are dealt out over whatever is actually on screen.
  function seatTools() {
    const visible = tools.filter((tool) => !tool.hidden);
    tools.forEach((tool) => {
      tool.style.removeProperty("--i");
      tool.style.removeProperty("--n");
    });
    visible.forEach((tool, index) => {
      tool.style.setProperty("--i", String(index));
      tool.style.setProperty("--n", String(visible.length));
    });
    ring = null;
  }

  function syncStage() {
    const idle = isIdle();
    document.body.dataset.stage = idle ? "idle" : "live";
    // The opening screen is white, so the phone's status bar should be too —
    // otherwise a dark bar sits on top of a light page.
    themeColour?.setAttribute("content", idle ? "#f6f7f6" : "#0d1512");
    if (!idle) {
      toolbar.dataset.orbitPaused = "false";
      // The first press ends the opening screen for this visit: from here the
      // strip of photographs behaves normally, including after a stop.
      document.body.dataset.recorded = "true";
    }
    ring = null;
  }

  // The ring's radius comes from a clamp() in the stylesheet, which a custom
  // property will not resolve to pixels for us — so it is measured off a tool
  // instead. Every seat is the same distance out, so any visible one will do.
  let ring = null;

  function measureRing() {
    const frame = record.getBoundingClientRect();
    const centreX = frame.left + frame.width / 2;
    const centreY = frame.top + frame.height / 2;
    const seat = tools.find((tool) => !tool.hidden)?.getBoundingClientRect();

    if (!seat || !seat.width) {
      ring = null;
      return;
    }

    ring = {
      centreX,
      centreY,
      radius: Math.hypot(seat.left + seat.width / 2 - centreX, seat.top + seat.height / 2 - centreY),
    };
  }

  function trackPointer(event) {
    if (document.body.dataset.stage !== "idle") {
      return;
    }

    if (!ring) {
      measureRing();
    }
    if (!ring || !ring.radius) {
      return;
    }

    const distance = Math.hypot(event.clientX - ring.centreX, event.clientY - ring.centreY);
    // Anywhere within the ring's band — approaching from outside, or reaching
    // back out from the shutter in the middle.
    const near = Math.abs(distance - ring.radius) <= APPROACH;
    toolbar.dataset.orbitPaused = near ? "true" : "false";
  }

  const stageWatcher = new MutationObserver(syncStage);
  stageWatcher.observe(record, {
    attributes: true,
    attributeFilter: ["data-running", "data-loading"],
  });
  if (aiReviewLoader) {
    stageWatcher.observe(aiReviewLoader, { attributes: true, attributeFilter: ["hidden"] });
  }

  const seatWatcher = new MutationObserver(seatTools);
  tools.forEach((tool) => seatWatcher.observe(tool, { attributes: true, attributeFilter: ["hidden"] }));

  window.addEventListener("resize", () => {
    ring = null;
  });
  window.addEventListener("pointermove", trackPointer, { passive: true });
  // A touch has no hover, so a tap anywhere near the ring holds it still too.
  window.addEventListener("pointerdown", trackPointer, { passive: true });

  // Photos left in the queue from a previous visit stay out of sight until the
  // camera has been started: the opening screen is the shutter and nothing else.
  document.body.dataset.recorded = "false";

  seatTools();
  syncStage();
})();
