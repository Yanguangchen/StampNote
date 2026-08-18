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
      personTracker = null,
      faceIdentity = null,
      enrollmentDetector = null,
      scheduler,
      store,
      sampleFrame,
      captureImage,
      getAddress = () => "",
      getGpsLocation = () => null,
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
    const enrollmentRequired = typeof faceIdentity?.enrollmentState === "function";
    let enrollmentSkipped = false;

    const state = {
      running: false,
      paused: false,
      activityStarted: !enrollmentRequired,
      faceEnrollment: enrollmentRequired ? faceIdentity.enrollmentState() : null,
      present: false,
      confidence: 0,
      pose: "none",
      keypoints: null,
      box: null,
      face: null,
      hands: [],
      bodies: [],
      people: 0,
      personIds: [],
      peopleSeen: 0,
      faceRecognitionReady: false,
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

    function snapshot() {
      return {
        ...state,
        faceEnrollment: state.faceEnrollment ? { ...state.faceEnrollment } : null,
      };
    }

    function publish() {
      onUpdate(snapshot());
      return state;
    }

    function clearTrackedPose() {
      state.present = false;
      state.confidence = 0;
      state.pose = "none";
      state.keypoints = null;
      state.box = null;
      state.face = null;
      state.hands = [];
      state.bodies = [];
      state.people = 0;
      state.personIds = [];
      state.vehicle = null;
      state.gesture = null;
      heldSince = null;
      armed = true;
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
          // Only the public, anonymous marker fields cross into the saved-image
          // renderer. Clothing histograms and tracker state stay in memory.
          bodies: (state.bodies || [])
            .filter((body) => body?.box && Number.isInteger(body.personId))
            .map((body) => ({
              box: body.box,
              personId: body.personId,
              workerId: body.workerId || null,
              personLabel: body.personLabel,
            })),
        });

        if (image?.blob) {
          const record = await store.save({
            blob: image.blob,
            date: image.date instanceof Date ? image.date : new Date(timestamp),
            address: getAddress(),
            gpsLocation: getGpsLocation(),
            // Cumulative anonymous count for this camera run. It is a number,
            // not the transient labels or body signatures used to derive it.
            uniquePeopleSeen: state.peopleSeen,
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
        return snapshot();
      },

      start() {
        detector.reset?.();
        enrollmentDetector?.reset?.();
        tracker.reset();
        personTracker?.reset?.();
        faceIdentity?.reset?.();
        scheduler.reset();
        enrollmentSkipped = false;

        state.running = true;
        state.paused = false;
        state.activityStarted = !enrollmentRequired;
        state.faceEnrollment = enrollmentRequired ? faceIdentity.enrollmentState() : null;
        state.captures = 0;
        state.personIds = [];
        state.peopleSeen = 0;
        state.faceRecognitionReady = false;
        state.error = null;
        state.lastRecord = null;
        state.lastCaptureAt = null;

        return publish();
      },

      stop() {
        state.running = false;
        state.paused = false;
        state.activityStarted = false;
        state.faceEnrollment = null;
        state.present = false;
        state.pose = "none";
        state.keypoints = null;
        state.box = null;
        state.bodies = [];
        state.people = 0;
        state.personIds = [];
        state.peopleSeen = 0;
        state.faceRecognitionReady = false;
        personTracker?.reset?.();
        faceIdentity?.reset?.();
        state.nextDueAt = null;
        state.waitMs = null;

        return publish();
      },

      // Face enrollment improves session-long matching, but it must never trap
      // someone whose camera or device cannot produce an embedding. The user is
      // always given an explicit way to begin without it.
      skipFaceEnrollment() {
        if (!state.running || !enrollmentRequired || state.activityStarted) {
          return snapshot();
        }

        enrollmentSkipped = true;
        state.activityStarted = true;
        state.faceEnrollment = {
          ...faceIdentity.enrollmentState(),
          required: false,
          status: "skipped",
        };
        state.nextDueAt = null;
        state.waitMs = null;
        scheduler.reset();
        return publish();
      },

      // A completed attendance scan is a checkpoint, not permission to begin
      // photographing the work. Keep the camera open while the operator decides
      // whether the next worker should check in or the activity may begin.
      takeAnotherAttendance() {
        if (
          !state.running ||
          !enrollmentRequired ||
          state.activityStarted ||
          state.faceEnrollment?.status !== "complete"
        ) {
          return snapshot();
        }

        faceIdentity.reset?.();
        enrollmentDetector?.reset?.();
        clearTrackedPose();
        state.faceEnrollment = faceIdentity.enrollmentState();
        state.nextDueAt = null;
        state.waitMs = null;
        return publish();
      },

      // A roster-backed manual check-in reaches the same checkpoint as a face
      // match, but carries its evidence source so storage can require review.
      recordManualAttendance(enrollment) {
        if (
          !state.running ||
          !enrollmentRequired ||
          state.activityStarted ||
          state.faceEnrollment?.status === "complete"
        ) {
          return snapshot();
        }

        const workerId = String(enrollment?.workerId || "").trim().toUpperCase();
        const personLabel = String(enrollment?.personLabel || "").trim();
        if (!workerId || !personLabel) {
          return snapshot();
        }

        clearTrackedPose();
        state.faceEnrollment = {
          ...faceIdentity.enrollmentState(),
          required: true,
          status: "complete",
          workerId,
          personLabel,
          source: "manual",
          reviewStatus: "flagged",
        };
        state.nextDueAt = null;
        state.waitMs = null;
        return publish();
      },

      startWork() {
        if (!state.running || state.activityStarted) {
          return snapshot();
        }
        if (enrollmentRequired && state.faceEnrollment?.status !== "complete") {
          return snapshot();
        }

        state.activityStarted = true;
        state.faceEnrollment = state.faceEnrollment
          ? { ...state.faceEnrollment, required: false, status: "accepted" }
          : null;
        state.nextDueAt = null;
        state.waitMs = null;
        scheduler.reset();
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
          enrollmentDetector?.reset?.();
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

        if (!state.activityStarted && state.faceEnrollment?.status === "complete") {
          state.intervalMs = scheduler.intervalFor(state.present);
          state.nextDueAt = null;
          state.waitMs = null;
          state.gesture = null;
          heldSince = null;
          armed = true;
          return publish();
        }

        const frame = sampleFrame();

        if (frame) {
          looking = true;

          try {
            // While the opening scan is running the faces come from the
            // focused landmarker below, so the detector is asked for the body
            // alone and nothing measures a face twice on one tick.
            const scanning =
              enrollmentRequired && !state.activityStarted && Boolean(enrollmentDetector?.detect);
            const detection = detector.detect(frame, {
              faces: getFaces(),
              poseOnly: scanning,
            });
            const tracked = tracker.update(detection, timestamp);

            state.present = tracked.present;
            state.confidence = tracked.confidence;
            state.pose = tracked.pose;
            state.keypoints = tracked.keypoints;
            state.box = tracked.box;
            state.face = tracked.face || null;
            state.hands = tracked.hands || [];
            const trackableBodies = tracked.bodies?.length
              ? tracked.bodies
              : tracked.present && tracked.keypoints
                ? [
                    {
                      present: true,
                      confidence: tracked.confidence,
                      pose: tracked.pose,
                      keypoints: tracked.keypoints,
                      box: tracked.box,
                      face: tracked.face,
                      hands: tracked.hands,
                    },
                  ]
                : [];
            // A close face can fill the guide while the pose model sees too
            // little torso to create a body. During the opening scan, use the
            // focused face-only landmarker so recognition does not depend on a
            // visible shoulder or hip. Normal activity returns to pose bodies.
            const enrollmentBodies = scanning
              ? enrollmentDetector.detect(frame)?.bodies || []
              : trackableBodies;
            // The tracker samples a tiny local colour histogram from this frame
            // so a person can recover their session ID after leaving the view.
            const identityBodies = faceIdentity?.describe
              ? await faceIdentity.describe(enrollmentBodies, frame, timestamp)
              : enrollmentBodies;
            const hasFaceEmbedding = identityBodies.some((body) => body?.faceEmbedding);
            const identified =
              !enrollmentRequired || state.activityStarted || hasFaceEmbedding
                ? personTracker?.update?.(identityBodies, timestamp, frame)
                : null;
            state.bodies = identified?.bodies || tracked.bodies || [];
            state.people = identified?.visibleCount ?? tracked.people ?? 0;
            state.personIds = state.bodies
              .map((body) => body.personId)
              .filter((id) => Number.isInteger(id));
            state.peopleSeen = identified?.uniqueCount ?? state.peopleSeen;
            state.faceRecognitionReady = Boolean(identified?.faceRecognitionReady);
            state.vehicle = tracked.vehicle?.present ? tracked.vehicle : null;
            state.error = null;
            if (enrollmentRequired && !enrollmentSkipped) {
              state.faceEnrollment = faceIdentity.enrollmentState();
            }
          } catch {
            // MediaPipe can throw once when a phone resumes its camera or loses
            // its GPU context. Letting that rejection escape kills the caller's
            // timer and leaves the last skeleton painted forever. Drop the stale
            // pose, reset both sides of tracking, and let the next tick retry.
            detector.reset?.();
            enrollmentDetector?.reset?.();
            tracker.reset();
            clearTrackedPose();
            state.error = "Tracking restarted after a camera hiccup.";
            return publish();
          } finally {
            looking = false;
          }
        }

        // Keep both shutter paths and the schedule still while attendance is
        // collected. A completed match remains here until the operator explicitly
        // starts work, so one check-in can never begin recording by itself.
        if (!state.activityStarted) {
          state.intervalMs = scheduler.intervalFor(state.present);
          state.nextDueAt = null;
          state.waitMs = null;
          state.gesture = null;
          heldSince = null;
          armed = true;
          return publish();
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
    if (!state.activityStarted && state.faceEnrollment?.required) {
      const prompts = {
        loading: "Preparing attendance taking…",
        no_face: "Come closer for attendance taking",
        move_closer: "Move closer — fill the face guide",
        look_straight: "Look straight at the camera",
        center_face: "Center your face in the guide",
        one_person: "One person at a time for the first scan",
        hold_still: "Hold still so the next face view stays sharp",
        face_changed: "Keep the same face in the guide",
        scanning: "Checking attendance — hold still",
        retrying: "No match yet — scanning continues automatically",
        not_recognized: "No match yet — scanning continues automatically",
        unavailable: "Face scan unavailable — continue without it",
        complete: "Attendance recorded — choose another worker or record work",
      };
      return prompts[state.faceEnrollment.status] || "Move closer for attendance taking";
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
    const labels = (state.bodies || [])
      .map((body) => body?.personLabel)
      .filter((label) => typeof label === "string" && label.trim());
    const subject = !state.present
      ? "No one in frame"
      : state.people > 1
        ? labels.length === state.people
          ? `${labels.join(", ")} in frame`
          : `${state.people} tracked workers in frame`
        : labels.length === 1
          ? `${labels[0]} in frame`
          : "Tracked worker in frame";
    // Named, but never in the position that explains the cadence — the interval
    // that follows is the one a vehicle did not change.
    const uniquePeople = Math.max(0, Math.floor(Number(state.peopleSeen) || 0));
    const unique = uniquePeople
      ? ` · ${uniquePeople} unique ${uniquePeople === 1 ? "person" : "people"} this session`
      : "";
    const faceRecognition = state.faceRecognitionReady ? " · face match on-device" : "";
    const vehicle = state.vehicle?.present ? " · vehicle" : "";
    const next = wait === null ? "" : ` · next in ${wait}s`;

    return `${subject}${unique}${faceRecognition}${vehicle} · every ${seconds}s${next}`;
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
