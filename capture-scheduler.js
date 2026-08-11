(function initializeCaptureScheduler(globalScope) {
  "use strict";

  // A person in frame is the interesting case, so it gets the close cadence.
  const POSE_INTERVAL = 30000;
  const IDLE_INTERVAL = 120000;

  // The interval always applies from the last capture, not from the moment the
  // pose state changed. So someone walking in 100 seconds into a quiet stretch
  // is already overdue under the 30-second rule and is photographed at once,
  // while someone walking in 5 seconds after a capture waits out the balance of
  // the 30. Walking away pushes the next capture out to 120 seconds after the
  // last one, which may also be overdue and fire immediately. Either way the
  // rule reads the same: the gap between captures is 30 seconds with a pose and
  // 120 seconds without one.
  function createCaptureScheduler(options = {}) {
    const poseInterval = Number(options.poseInterval) || POSE_INTERVAL;
    const idleInterval = Number(options.idleInterval) || IDLE_INTERVAL;

    let lastCaptureAt = null;
    let present = false;

    function intervalFor(isPresent) {
      return isPresent ? poseInterval : idleInterval;
    }

    return {
      intervalFor,

      // Read-only: it reports what should happen now, and the caller confirms
      // with markCaptured() once the photo actually exists. A capture that
      // fails still marks the attempt, so a broken camera cannot spin the loop.
      evaluate({ present: isPresent = false, now = Date.now() } = {}) {
        present = Boolean(isPresent);
        const interval = intervalFor(present);

        if (lastCaptureAt === null) {
          return { shouldCapture: true, reason: "first", interval, dueAt: now, waitMs: 0 };
        }

        const dueAt = lastCaptureAt + interval;

        return {
          shouldCapture: now >= dueAt,
          reason: now >= dueAt ? "due" : "waiting",
          interval,
          dueAt,
          waitMs: Math.max(0, dueAt - now),
        };
      },

      markCaptured(now = Date.now()) {
        lastCaptureAt = now;
        return lastCaptureAt;
      },

      get lastCaptureAt() {
        return lastCaptureAt;
      },

      dueAt() {
        return lastCaptureAt === null ? null : lastCaptureAt + intervalFor(present);
      },

      reset() {
        lastCaptureAt = null;
        present = false;
      },
    };
  }

  const api = Object.freeze({
    IDLE_INTERVAL,
    POSE_INTERVAL,
    createCaptureScheduler,
  });

  globalScope.StampNoteSchedule = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
