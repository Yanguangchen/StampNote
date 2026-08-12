(function initializeAutoCapture(globalScope) {
  "use strict";

  // Joins the four pieces — look at a frame, track the pose, ask the schedule,
  // store the photo — without touching the DOM itself. Frames come in through
  // sampleFrame() and photos go out through captureImage(), so the loop can be
  // driven by a real camera in the browser or by plain objects in a test.
  const SAMPLE_INTERVAL = 250;

  // Long enough that a hand thrown up in conversation is not a shutter press,
  // short enough that holding the pose does not feel like a punishment.
  const GESTURE_HOLD = 700;

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
      isGesture = () => false,
      // Deciding what is worth keeping, and the small frame to decide it from.
      // Both optional: without them every photograph is taken and kept, which
      // is what the watch did before it could tell one frame from another.
      triage = null,
      readSample = null,
      gestureHold = GESTURE_HOLD,
      now = () => Date.now(),
      onUpdate = () => {},
    } = options;

    if (!detector || !tracker || !scheduler || !store) {
      throw new TypeError("Auto capture needs a detector, tracker, scheduler and store.");
    }
    if (typeof sampleFrame !== "function" || typeof captureImage !== "function") {
      throw new TypeError("Auto capture needs sampleFrame and captureImage functions.");
    }

    // The fingerprint of the last photograph actually kept, and when. Novelty is
    // measured against what is in the store, not against the frame before —
    // otherwise a scene that drifts a little each time is always new.
    let keptFingerprint = null;
    let keptAt = 0;

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
      bodies: [],
      people: 0,
      vehicle: null,
      intervalMs: scheduler.intervalFor(false),
      nextDueAt: null,
      waitMs: null,
      captures: 0,
      lastCaptureAt: null,
      lastRecord: null,
      gesture: null,
      skipped: 0,
      lastSkip: null,
      error: null,
    };

    let busy = false;
    let looking = false;
    let heldSince = null;
    let armed = true;

    function publish() {
      onUpdate({ ...state });
      return state;
    }

    // What the frame itself says: whether the lens found focus, and whether this
    // is the same view as the last photograph kept. Costs one small frame per
    // capture — every thirty seconds at the fastest — not one per tick.
    function measure() {
      if (!triage || !readSample) {
        return null;
      }

      const image = readSample();

      if (!image) {
        return null;
      }

      const fingerprint = triage.fingerprintOf(image);

      return {
        sharpness: triage.sharpnessOf(image),
        fingerprint,
        novelty: triage.noveltyOf(fingerprint, keptFingerprint),
      };
    }

    async function capture(timestamp, intervalMs, trigger = "schedule") {
      busy = true;

      try {
        const measured = measure();
        const reading = {
          ...(measured || {}),
          trigger,
          present: state.present,
          confidence: state.confidence,
          people: state.people,
          vehicle: Boolean(state.vehicle?.present),
          sinceKeptMs: keptAt === 0 ? 0 : timestamp - keptAt,
        };

        // Declining to take one is not a failure: the schedule still moves on
        // in the `finally` below, so the watch waits its interval rather than
        // trying again immediately.
        if (measured && !triage.shouldKeep(reading)) {
          state.skipped += 1;
          state.lastSkip = triage.describeSkip(reading);
          state.error = null;
          return;
        }

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
            trigger,
            pose: {
              present: state.present,
              confidence: state.confidence,
              pose: state.pose,
              people: state.people,
            },
            // What the store sheds first when it runs out of room.
            score: triage ? triage.scoreCapture(reading) : null,
            sharpness: measured?.sharpness ?? null,
            fingerprint: measured?.fingerprint ?? null,
          });

          keptFingerprint = measured?.fingerprint ?? keptFingerprint;
          keptAt = timestamp;
          state.lastSkip = null;
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
        state.bodies = [];
        state.people = 0;
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
            state.bodies = tracked.bodies || [];
            state.people = tracked.people || 0;
            state.vehicle = tracked.vehicle?.present ? tracked.vehicle : null;
          } finally {
            looking = false;
          }
        }

        // Hands above the head is a shutter press: it takes a photograph there
        // and then, whatever the schedule was waiting for. It has to be held to
        // count, and has to be let go of before it can be asked for again, so
        // one gesture is one photograph rather than a burst.
        const posing =
          state.present &&
          (state.bodies?.length
            ? state.bodies.some((body) => isGesture(body.keypoints))
            : isGesture(state.keypoints));

        if (!posing) {
          heldSince = null;
          armed = true;
          state.gesture = null;
        } else if (armed) {
          heldSince = heldSince ?? timestamp;
          state.gesture = "holding";

          if (timestamp - heldSince >= gestureHold) {
            armed = false;
            heldSince = null;
            state.gesture = "captured";
            await capture(timestamp, scheduler.intervalFor(state.present), "gesture");
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
    if (state.gesture === "holding") {
      return "Hands up — hold it";
    }
    if (state.gesture === "captured") {
      return "Photo taken";
    }
    // Said once, in place of the countdown, so a watch quietly declining to
    // photograph a wall does not look like a watch that has stopped.
    if (state.lastSkip) {
      return state.lastSkip;
    }

    // How many, not just whether — the count is the thing being watched, and a
    // room that goes from one person to three should say so.
    const subject = !state.present
      ? "No one in frame"
      : state.people > 1
        ? `${state.people} people in frame`
        : "Person in frame";
    // Named, but never in the position that explains the cadence — the interval
    // that follows is the one a vehicle did not change.
    const vehicle = state.vehicle?.present ? " · vehicle" : "";
    const next = wait === null ? "" : ` · next in ${wait}s`;

    return `${subject}${vehicle} · every ${seconds}s${next}`;
  }

  const api = Object.freeze({
    GESTURE_HOLD,
    SAMPLE_INTERVAL,
    createAutoCapture,
    describeCadence,
  });

  globalScope.StampNoteAutoCapture = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
