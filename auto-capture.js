(function initializeAutoCapture(globalScope) {
  "use strict";

  // Joins the four pieces — look at a frame, track the pose, ask the schedule,
  // store the photo — without touching the DOM itself. Frames come in through
  // sampleFrame() and photos go out through captureImage(), so the loop can be
  // driven by a real camera in the browser or by plain objects in a test.
  const SAMPLE_INTERVAL = 250;

  function createAutoCapture(options = {}) {
    const {
      detector,
      tracker,
      scheduler,
      store,
      sampleFrame,
      captureImage,
      getAddress = () => "",
      getFaces = () => null,
      now = () => Date.now(),
      onUpdate = () => {},
    } = options;

    if (!detector || !tracker || !scheduler || !store) {
      throw new TypeError("Auto capture needs a detector, tracker, scheduler and store.");
    }
    if (typeof sampleFrame !== "function" || typeof captureImage !== "function") {
      throw new TypeError("Auto capture needs sampleFrame and captureImage functions.");
    }

    const state = {
      running: false,
      paused: false,
      present: false,
      confidence: 0,
      pose: "none",
      keypoints: null,
      box: null,
      face: null,
      hands: [],
      vehicle: null,
      intervalMs: scheduler.intervalFor(false),
      nextDueAt: null,
      waitMs: null,
      captures: 0,
      lastCaptureAt: null,
      lastRecord: null,
      error: null,
    };

    let busy = false;
    let looking = false;

    function publish() {
      onUpdate({ ...state });
      return state;
    }

    async function capture(timestamp, intervalMs) {
      busy = true;

      try {
        const image = await captureImage({
          present: state.present,
          confidence: state.confidence,
          pose: state.pose,
        });

        if (image?.blob) {
          const record = await store.save({
            blob: image.blob,
            date: image.date instanceof Date ? image.date : new Date(timestamp),
            address: getAddress(),
            intervalMs,
            pose: {
              present: state.present,
              confidence: state.confidence,
              pose: state.pose,
            },
          });

          state.captures += 1;
          state.lastRecord = record;
          state.lastCaptureAt = timestamp;
          state.error = null;
        }
      } catch (error) {
        state.error = error?.message || "The capture failed.";
      } finally {
        // The attempt counts either way: a camera that cannot produce a frame
        // must not turn the schedule into a busy loop.
        scheduler.markCaptured(now());
        busy = false;
      }
    }

    return {
      getState() {
        return { ...state };
      },

      start() {
        detector.reset?.();
        tracker.reset();
        scheduler.reset();

        state.running = true;
        state.paused = false;
        state.captures = 0;
        state.error = null;
        state.lastRecord = null;
        state.lastCaptureAt = null;

        return publish();
      },

      stop() {
        state.running = false;
        state.paused = false;
        state.present = false;
        state.pose = "none";
        state.keypoints = null;
        state.box = null;
        state.nextDueAt = null;
        state.waitMs = null;

        return publish();
      },

      // A hidden tab gets no fresh camera frames, so tracking stops rather than
      // scoring stale pixels. The schedule keeps its place and catches up on
      // the first tick after the page comes back.
      setPaused(paused) {
        if (state.paused === Boolean(paused)) {
          return { ...state };
        }

        state.paused = Boolean(paused);
        if (!state.paused) {
          detector.reset?.();
        }

        return publish();
      },

      async tick() {
        // Inference can take longer than the interval between ticks on a slow
        // device. Without this the timer queues them up behind each other and
        // the page never gets a moment to draw.
        if (!state.running || state.paused || busy || looking) {
          return { ...state };
        }

        const timestamp = now();
        const frame = sampleFrame();

        if (frame) {
          looking = true;

          try {
            const detection = detector.detect(frame, { faces: getFaces() });
            const tracked = tracker.update(detection, timestamp);

            state.present = tracked.present;
            state.confidence = tracked.confidence;
            state.pose = tracked.pose;
            state.keypoints = tracked.keypoints;
            state.box = tracked.box;
            state.face = tracked.face || null;
            state.hands = tracked.hands || [];
            state.vehicle = tracked.vehicle?.present ? tracked.vehicle : null;
          } finally {
            looking = false;
          }
        }

        // Only `present` — whether a person is in frame — is put to the
        // schedule. A vehicle is carried along for the interface to draw and
        // changes nothing about when a photograph is taken.
        const decision = scheduler.evaluate({ present: state.present, now: timestamp });
        state.intervalMs = decision.interval;
        state.nextDueAt = decision.dueAt;
        state.waitMs = decision.waitMs;

        if (decision.shouldCapture) {
          await capture(timestamp, decision.interval);
          const next = scheduler.evaluate({ present: state.present, now: now() });
          state.nextDueAt = next.dueAt;
          state.waitMs = next.waitMs;
        }

        return publish();
      },
    };
  }

  function describeCadence(state) {
    if (!state?.running) {
      return "Auto capture is off.";
    }
    if (state.paused) {
      return "Paused — this page has to stay open and awake.";
    }

    const seconds = Math.round((state.intervalMs || 0) / 1000);
    const wait = state.waitMs === null ? null : Math.max(0, Math.round(state.waitMs / 1000));
    const subject = state.present ? "Person in frame" : "No one in frame";
    // Named, but never in the position that explains the cadence — the interval
    // that follows is the one a vehicle did not change.
    const vehicle = state.vehicle?.present ? " · vehicle" : "";
    const next = wait === null ? "" : ` · next in ${wait}s`;

    return `${subject}${vehicle} · every ${seconds}s${next}`;
  }

  const api = Object.freeze({
    SAMPLE_INTERVAL,
    createAutoCapture,
    describeCadence,
  });

  globalScope.StampNoteAutoCapture = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
