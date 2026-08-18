const assert = require("node:assert/strict");
const { resolve } = require("node:path");
const { test } = require("node:test");

const autoCapture = require(resolve(__dirname, "..", "auto-capture.js"));
const people = require(resolve(__dirname, "..", "person-tracker.js"));
const pose = require(resolve(__dirname, "..", "pose-detector.js"));
const schedule = require(resolve(__dirname, "..", "capture-scheduler.js"));

const SECOND = 1000;

// Drives the real scheduler and tracker with a fake clock, a fake camera and a
// fake store, so a two-hour watch runs in a millisecond.
function createHarness(options = {}) {
  const saved = [];
  const harness = {
    time: 0,
    present: false,
    vehicle: false,
    gesture: false,
    frame: { width: 2, height: 2, data: new Uint8ClampedArray(16) },
    address: "10 Bayfront Avenue",
    gpsLocation: { latitude: 1.2868, longitude: 103.8545, accuracyMeters: 12.5 },
    captureFails: false,
    detectionFails: 0,
    detectOptions: [],
    saved,
  };

  const detector = {
    detect: (frame, detectOptions) => {
      harness.detectOptions.push(detectOptions);

      if (harness.detectionFails > 0) {
        harness.detectionFails -= 1;
        throw new Error("GPU context was lost");
      }

      return {
        present: harness.present,
        confidence: harness.present ? 0.9 : 0.05,
        pose: harness.present ? "standing" : "none",
        keypoints: harness.present ? { head: { x: 0.5, y: 0.2 } } : null,
        box: harness.present ? { x: 0.4, y: 0.1, width: 0.2, height: 0.8 } : null,
        vehicle: harness.vehicle
          ? { confidence: 0.9, box: { x: 0.5, y: 0.5, width: 0.4, height: 0.2 } }
          : null,
      };
    },
    reset() {},
  };

  harness.controller = autoCapture.createAutoCapture({
    detector,
    tracker: pose.createPoseTracker({ enterFrames: 1, holdMs: 0, ...options.tracker }),
    scheduler: schedule.createCaptureScheduler(options.intervals),
    store: {
      async save(input) {
        saved.push(input);
        return { ...input, id: `capture-${saved.length}` };
      },
    },
    sampleFrame: () => harness.frame,
    captureImage: async () => {
      if (harness.captureFails) {
        throw new Error("The camera has no frame yet.");
      }

      return { blob: { size: 1024, type: "image/jpeg" }, date: new Date(harness.time) };
    },
    getAddress: () => harness.address,
    getGpsLocation: () => harness.gpsLocation,
    faceIdentity: options.faceIdentity,
    enrollmentDetector: options.enrollmentDetector,
    isGesture: () => harness.gesture,
    gestureHold: options.gestureHold ?? 700,
    now: () => harness.time,
    onUpdate: options.onUpdate,
  });

  // Runs the sampling loop forward, ticking at the real sampling rate.
  harness.advance = async (milliseconds) => {
    const target = harness.time + milliseconds;

    while (harness.time < target) {
      harness.time = Math.min(target, harness.time + autoCapture.SAMPLE_INTERVAL);
      await harness.controller.tick();
    }
  };

  return harness;
}

function createEnrollmentIdentity(total = 2) {
  let samples = 0;
  return {
    async describe(bodies) {
      samples = Math.min(total, samples + 1);
      return bodies;
    },
    enrollmentState() {
      return {
        required: true,
        status: samples >= total ? "complete" : samples > 0 ? "scanning" : "no_face",
        samples,
        total,
        progress: samples / total,
      };
    },
    reset() {
      samples = 0;
    },
  };
}

test("face enrollment pauses every shutter until two close samples are ready", async () => {
  const harness = createHarness({ faceIdentity: createEnrollmentIdentity() });
  harness.present = true;
  harness.controller.start();

  assert.equal(harness.controller.getState().activityStarted, false);
  await harness.controller.tick();
  assert.equal(harness.saved.length, 0);
  assert.equal(harness.controller.getState().faceEnrollment.samples, 1);

  await harness.controller.tick();
  assert.equal(harness.saved.length, 0, "completion waits for an explicit start-work action");
  assert.equal(harness.controller.getState().activityStarted, false);

  await harness.controller.tick();
  assert.equal(harness.saved.length, 0, "attendance confirmation cannot take a work photo");
  harness.controller.startWork();
  assert.equal(harness.controller.getState().activityStarted, true);
  await harness.controller.tick();
  assert.equal(harness.saved.length, 1);
});

test("the opening scan uses the focused face detector even without a visible pose", async () => {
  let focusedScans = 0;
  const harness = createHarness({
    faceIdentity: createEnrollmentIdentity(2),
    enrollmentDetector: {
      detect() {
        focusedScans += 1;
        return { bodies: [{ face: { eyeLeft: [], eyeRight: [] } }] };
      },
      reset() {},
    },
  });
  harness.present = false;
  harness.controller.start();

  await harness.controller.tick();
  await harness.controller.tick();

  assert.equal(focusedScans, 2);
  assert.equal(harness.controller.getState().activityStarted, false);
});

test("the opening scan asks the detector for the body alone, not a second face", async () => {
  const harness = createHarness({
    faceIdentity: createEnrollmentIdentity(2),
    enrollmentDetector: {
      detect: () => ({ bodies: [{ face: { eyeLeft: [], eyeRight: [] } }] }),
      reset() {},
    },
  });
  harness.present = true;
  harness.controller.start();

  // Two scanning ticks: the faces come from the focused landmarker, so the
  // detector must not measure one of its own and have it thrown away.
  await harness.controller.tick();
  await harness.controller.tick();
  assert.deepEqual(
    harness.detectOptions.map((entry) => entry.poseOnly),
    [true, true],
  );
  assert.equal(harness.controller.getState().activityStarted, false);

  // Once the scan hands over, the full set of parts is wanted again.
  harness.controller.startWork();
  await harness.controller.tick();
  assert.equal(harness.detectOptions.at(-1).poseOnly, false);
});

test("without a focused scanner the detector is still asked for everything", async () => {
  const harness = createHarness({ faceIdentity: createEnrollmentIdentity(2) });
  harness.present = true;
  harness.controller.start();

  await harness.controller.tick();
  assert.equal(harness.detectOptions.at(-1).poseOnly, false);
});

test("face enrollment can be skipped without trapping the activity", async () => {
  const harness = createHarness({ faceIdentity: createEnrollmentIdentity() });
  harness.controller.start();

  const skipped = harness.controller.skipFaceEnrollment();
  assert.equal(skipped.activityStarted, true);
  assert.equal(skipped.faceEnrollment.status, "skipped");
  assert.equal(skipped.faceEnrollment.required, false);

  await harness.controller.tick();
  assert.equal(harness.saved.length, 1);
});

test("another attendance resets the face scan while every shutter remains paused", async () => {
  const identity = createEnrollmentIdentity();
  const harness = createHarness({ faceIdentity: identity });
  harness.present = true;
  harness.controller.start();

  await harness.controller.tick();
  await harness.controller.tick();
  assert.equal(harness.controller.getState().faceEnrollment.status, "complete");
  assert.equal(harness.controller.getState().activityStarted, false);

  const another = harness.controller.takeAnotherAttendance();
  assert.equal(another.faceEnrollment.status, "no_face");
  assert.equal(another.activityStarted, false);
  await harness.controller.tick();
  await harness.controller.tick();
  assert.equal(harness.controller.getState().faceEnrollment.status, "complete");
  assert.equal(harness.saved.length, 0);

  harness.controller.startWork();
  await harness.controller.tick();
  assert.equal(harness.saved.length, 1);
});

test("manual attendance reaches the review checkpoint without starting work", async () => {
  const harness = createHarness({ faceIdentity: createEnrollmentIdentity() });
  harness.controller.start();

  const manual = harness.controller.recordManualAttendance({
    workerId: "worker-9",
    personLabel: "Bo Lim",
  });
  assert.equal(manual.activityStarted, false);
  assert.equal(manual.faceEnrollment.status, "complete");
  assert.equal(manual.faceEnrollment.workerId, "WORKER-9");
  assert.equal(manual.faceEnrollment.source, "manual");
  assert.equal(manual.faceEnrollment.reviewStatus, "flagged");

  await harness.controller.tick();
  assert.equal(harness.saved.length, 0);
  harness.controller.startWork();
  await harness.controller.tick();
  assert.equal(harness.saved.length, 1);
});

test("starting the watch takes the first photo straight away", async () => {
  const harness = createHarness();

  harness.controller.start();
  assert.equal(harness.saved.length, 0);

  await harness.controller.tick();
  assert.equal(harness.saved.length, 1);
  assert.equal(harness.controller.getState().captures, 1);
});

test("a person in frame is photographed every 30 seconds", async () => {
  const harness = createHarness();

  harness.present = true;
  harness.controller.start();
  await harness.controller.tick();

  await harness.advance(29 * SECOND);
  assert.equal(harness.saved.length, 1, "nothing extra before the interval is up");

  await harness.advance(SECOND);
  assert.equal(harness.saved.length, 2);

  // Two more minutes of company: one photo every 30 seconds.
  await harness.advance(120 * SECOND);
  assert.equal(harness.saved.length, 6);
});

test("an empty frame is photographed every 120 seconds", async () => {
  const harness = createHarness();

  harness.controller.start();
  await harness.controller.tick();

  await harness.advance(119 * SECOND);
  assert.equal(harness.saved.length, 1);

  await harness.advance(SECOND);
  assert.equal(harness.saved.length, 2);

  await harness.advance(120 * SECOND);
  assert.equal(harness.saved.length, 3);
});

test("a vehicle is reported but leaves the cadence alone", async () => {
  const harness = createHarness();

  harness.controller.start();
  await harness.controller.tick();
  assert.equal(harness.saved.length, 1);

  // A car pulls up. It is tracked and surfaced …
  harness.vehicle = true;
  await harness.advance(SECOND);

  const state = harness.controller.getState();
  assert.ok(state.vehicle, "the vehicle is carried for the interface to draw");
  assert.equal(state.present, false, "but it is not a person");

  // … and the schedule does not budge: still the empty-frame interval, and no
  // photograph until the full 120 seconds have passed.
  assert.equal(state.intervalMs, 120 * SECOND);
  await harness.advance(118 * SECOND);
  assert.equal(harness.saved.length, 1, "no photograph on the 30-second cadence");

  await harness.advance(SECOND);
  assert.equal(harness.saved.length, 2, "just the ordinary 120-second one");
});

test("a person arriving at a car still switches the cadence", async () => {
  const harness = createHarness();

  harness.vehicle = true;
  harness.controller.start();
  await harness.controller.tick();

  // The driver gets out 100 seconds later: overdue under the 30-second rule.
  await harness.advance(100 * SECOND);
  assert.equal(harness.saved.length, 1);

  harness.present = true;
  await harness.advance(SECOND);

  const state = harness.controller.getState();
  assert.equal(state.intervalMs, 30 * SECOND);
  assert.ok(state.vehicle, "the car is still there alongside them");
  assert.equal(harness.saved.length, 2);
});

test("hands above the head take a photograph there and then", async () => {
  const harness = createHarness();

  harness.present = true;
  harness.controller.start();
  await harness.controller.tick();
  assert.equal(harness.saved.length, 1, "the opening photograph");

  // A hand thrown up in conversation is not a shutter press. The hold is
  // counted from the first frame it is seen in, which is a quarter-second in.
  harness.gesture = true;
  await harness.advance(500);
  assert.equal(harness.saved.length, 1);
  assert.equal(harness.controller.getState().gesture, "holding");

  // Held past the 700 milliseconds, it is.
  await harness.advance(600);
  assert.equal(harness.saved.length, 2);
  assert.equal(harness.saved[1].trigger, "gesture", "and it is recorded as one");

  // One gesture is one photograph: keeping the pose does not fire a burst.
  await harness.advance(4 * SECOND);
  assert.equal(harness.saved.length, 2);

  // Letting go and doing it again does.
  harness.gesture = false;
  await harness.advance(SECOND);
  harness.gesture = true;
  await harness.advance(SECOND);
  assert.equal(harness.saved.length, 3);
});

test("the gesture does not disturb the schedule it interrupted", async () => {
  const harness = createHarness();

  harness.present = true;
  harness.controller.start();
  await harness.controller.tick();

  // Ten seconds in, someone asks for one by hand.
  await harness.advance(10 * SECOND);
  harness.gesture = true;
  await harness.advance(SECOND);
  assert.equal(harness.saved.length, 2);

  harness.gesture = false;

  // The 30-second cadence then carries on from the photograph just taken,
  // rather than from the one before it.
  await harness.advance(28 * SECOND);
  assert.equal(harness.saved.length, 2);
  await harness.advance(2 * SECOND);
  assert.equal(harness.saved.length, 3);
});

test("nobody in frame means nobody to make the gesture", async () => {
  const harness = createHarness();

  harness.gesture = true;
  harness.controller.start();
  await harness.controller.tick();
  await harness.advance(3 * SECOND);

  // The pose comes off a body; with no body there is nothing to read.
  assert.equal(harness.saved.length, 1, "only the opening photograph");
  assert.equal(harness.controller.getState().gesture, null);
});

test("the cadence switches the moment someone walks in or out", async () => {
  const harness = createHarness();

  harness.controller.start();
  await harness.controller.tick();
  assert.equal(harness.controller.getState().intervalMs, 120 * SECOND);

  // Someone arrives 100 seconds in, when the last photo is already older than
  // the 30-second rule allows, so it is taken at once.
  await harness.advance(100 * SECOND);
  assert.equal(harness.saved.length, 1);

  harness.present = true;
  await harness.advance(SECOND);
  assert.equal(harness.saved.length, 2);
  assert.equal(harness.controller.getState().intervalMs, 30 * SECOND);

  // They stay for a minute: two more photos.
  await harness.advance(60 * SECOND);
  assert.equal(harness.saved.length, 4);

  // They leave, and the watch drops back to the slow cadence.
  harness.present = false;
  await harness.advance(SECOND);
  const state = harness.controller.getState();
  assert.equal(state.intervalMs, 120 * SECOND);
  assert.equal(state.present, false);
  assert.equal(harness.saved.length, 4, "leaving does not trigger a photo of its own");

  await harness.advance(119 * SECOND);
  assert.equal(harness.saved.length, 5);
});

test("each stored capture carries its automatic GPS fix, address, pose and cadence", async () => {
  const harness = createHarness();

  harness.present = true;
  harness.controller.start();
  await harness.controller.tick();

  const [capture] = harness.saved;
  assert.equal(capture.address, "10 Bayfront Avenue");
  assert.deepEqual(capture.gpsLocation, {
    latitude: 1.2868,
    longitude: 103.8545,
    accuracyMeters: 12.5,
  });
  assert.equal(capture.intervalMs, 30 * SECOND);
  assert.equal(capture.pose.present, true);
  assert.equal(capture.pose.pose, "standing");
  assert.equal(capture.blob.type, "image/jpeg");
  assert.ok(capture.date instanceof Date);
});

test("hysteresis keeps a flickering detection from switching the cadence", async () => {
  // The shipping tracker settings: two frames to enter, four seconds to leave.
  const harness = createHarness({ tracker: pose.TRACKER_DEFAULTS });

  harness.controller.start();
  await harness.controller.tick();

  harness.present = true;
  await harness.advance(SECOND);
  assert.equal(harness.controller.getState().present, true);

  // A single missed frame — someone turning their head — holds the cadence.
  harness.present = false;
  await harness.controller.tick();
  assert.equal(harness.controller.getState().present, true);
  assert.equal(harness.controller.getState().intervalMs, 30 * SECOND);

  // Four seconds of nobody, and the watch lets go.
  await harness.advance(5 * SECOND);
  assert.equal(harness.controller.getState().present, false);
  assert.equal(harness.controller.getState().intervalMs, 120 * SECOND);
});

test("a failed capture is reported without spinning the schedule", async () => {
  const harness = createHarness();

  harness.captureFails = true;
  harness.controller.start();
  await harness.controller.tick();

  assert.equal(harness.saved.length, 0);
  assert.match(harness.controller.getState().error, /no frame/);

  // The failed attempt still counts as an attempt: the next one waits its turn
  // rather than retrying on every one of the four samples a second.
  await harness.advance(10 * SECOND);
  assert.equal(harness.saved.length, 0);

  harness.captureFails = false;
  await harness.advance(115 * SECOND);
  assert.equal(harness.saved.length, 1);
  assert.equal(harness.controller.getState().error, null);
});

test("a one-frame detector failure clears the frozen pose and tracking recovers", async () => {
  const harness = createHarness();

  harness.present = true;
  harness.controller.start();
  await harness.controller.tick();
  assert.equal(harness.controller.getState().present, true);

  harness.detectionFails = 1;
  await harness.controller.tick();
  const failed = harness.controller.getState();
  assert.equal(failed.present, false);
  assert.equal(failed.keypoints, null);
  assert.match(failed.error, /restarted/i);

  await harness.controller.tick();
  const recovered = harness.controller.getState();
  assert.equal(recovered.present, true);
  assert.deepEqual(recovered.keypoints, { head: { x: 0.5, y: 0.2 } });
  assert.equal(recovered.error, null);
});

test("a hidden page pauses tracking and catches up when it returns", async () => {
  const harness = createHarness();

  harness.controller.start();
  await harness.controller.tick();

  harness.controller.setPaused(true);
  assert.equal(harness.controller.getState().paused, true);

  await harness.advance(600 * SECOND);
  assert.equal(harness.saved.length, 1, "a hidden page has no camera to photograph with");

  harness.controller.setPaused(false);
  await harness.controller.tick();

  // One photo is owed for the whole gap, not one per missed interval.
  assert.equal(harness.saved.length, 2);
});

test("stopping ends the watch and clears the tracked pose", async () => {
  const harness = createHarness();

  harness.present = true;
  harness.controller.start();
  await harness.controller.tick();

  const stopped = harness.controller.stop();
  assert.equal(stopped.running, false);
  assert.equal(stopped.present, false);
  assert.equal(stopped.keypoints, null);

  await harness.advance(300 * SECOND);
  assert.equal(harness.saved.length, 1);
});

test("every update is published so the interface can follow along", async () => {
  const seen = [];
  const harness = createHarness({ onUpdate: (state) => seen.push(state) });

  harness.present = true;
  harness.controller.start();
  await harness.controller.tick();

  assert.ok(seen.length >= 2);
  assert.equal(seen.at(-1).present, true);
  assert.deepEqual(seen.at(-1).keypoints, { head: { x: 0.5, y: 0.2 } });
});

test("the badge says who is in frame, at what cadence, and when the next photo lands", () => {
  assert.equal(autoCapture.describeCadence({ running: false }), "Auto capture is off.");
  assert.match(autoCapture.describeCadence({ running: true, paused: true }), /Paused/);
  assert.equal(
    autoCapture.describeCadence({
      running: true,
      activityStarted: false,
      faceEnrollment: { required: true, status: "retrying", samples: 2, total: 2 },
    }),
    "No match yet — scanning continues automatically",
  );
  assert.doesNotMatch(
    autoCapture.describeCadence({
      running: true,
      activityStarted: false,
      faceEnrollment: { required: true, status: "scanning", samples: 1, total: 2 },
    }),
    /\d+\s+of\s+\d+/i,
  );

  assert.equal(
    autoCapture.describeCadence({
      running: true,
      present: true,
      intervalMs: 30 * SECOND,
      waitMs: 12400,
    }),
    "Tracked worker in frame · every 30s · next in 12s",
  );
  assert.equal(
    autoCapture.describeCadence({
      running: true,
      present: false,
      faceRecognitionReady: true,
      intervalMs: 120 * SECOND,
      waitMs: 0,
    }),
    "No one in frame · face match on-device · every 120s · next in 0s",
  );

  // A vehicle is named, but never where it could be read as the reason for the
  // interval that follows it.
  assert.equal(
    autoCapture.describeCadence({
      running: true,
      present: false,
      vehicle: { present: true },
      intervalMs: 120 * SECOND,
      waitMs: 45000,
    }),
    "No one in frame · vehicle · every 120s · next in 45s",
  );

  // While the shutter pose is being held, the badge is about that and nothing
  // else — it is the one moment the cadence is not what matters.
  assert.equal(
    autoCapture.describeCadence({ running: true, present: true, gesture: "holding" }),
    "Hands up — hold it",
  );
  assert.equal(
    autoCapture.describeCadence({ running: true, present: true, gesture: "captured" }),
    "Photo taken",
  );
});

test("the controller refuses to run without its parts", () => {
  assert.throws(() => autoCapture.createAutoCapture({}), TypeError);
  assert.throws(
    () =>
      autoCapture.createAutoCapture({
        detector: {},
        tracker: {},
        scheduler: {},
        store: {},
      }),
    TypeError,
  );
});

// ---------------------------------------------------------------------------
// More than one person

// A detector that reports a crowd, the way the model adapter does.
function createCrowdHarness(bodies = []) {
  const saved = [];
  const captureInputs = [];
  const harness = { time: 0, bodies, captureInputs, saved };

  const controller = autoCapture.createAutoCapture({
    detector: {
      detect: () => {
        const crowd = harness.bodies;
        const lead = crowd[0] || null;

        return {
          present: crowd.length > 0,
          confidence: lead ? 0.9 : 0.05,
          pose: lead ? "standing" : "none",
          keypoints: lead ? lead.keypoints : null,
          box: lead ? lead.box : null,
          bodies: crowd,
          people: crowd.length,
          vehicle: null,
        };
      },
      reset() {},
    },
    tracker: pose.createPoseTracker({ enterFrames: 1, holdMs: 0 }),
    personTracker: people.createPersonTracker(),
    scheduler: schedule.createCaptureScheduler(),
    store: {
      async save(input) {
        saved.push(input);
        return { ...input, id: `capture-${saved.length}` };
      },
    },
    sampleFrame: () => ({ width: 2, height: 2, data: new Uint8ClampedArray(16) }),
    captureImage: async (input) => {
      captureInputs.push(input);
      return {
        blob: { size: 1024, type: "image/jpeg" },
        date: new Date(harness.time),
      };
    },
    getAddress: () => "10 Bayfront Avenue",
    // The real test: hands above the head, read off whichever body has them.
    isGesture: (keypoints) =>
      Boolean(keypoints?.head && keypoints.wristLeft && keypoints.wristRight) &&
      keypoints.wristLeft.y < keypoints.head.y &&
      keypoints.wristRight.y < keypoints.head.y,
    gestureHold: 700,
    now: () => harness.time,
  });

  harness.controller = controller;
  harness.advance = async (milliseconds) => {
    const target = harness.time + milliseconds;

    while (harness.time < target) {
      harness.time = Math.min(target, harness.time + autoCapture.SAMPLE_INTERVAL);
      await controller.tick();
    }
  };

  return harness;
}

function bodyAt(x, { handsUp = false } = {}) {
  const head = { x, y: 0.2 };

  return {
    present: true,
    confidence: 0.9,
    box: { x: x - 0.1, y: 0.1, width: 0.2, height: 0.8 },
    keypoints: {
      head,
      neck: { x, y: 0.3 },
      wristLeft: { x: x - 0.1, y: handsUp ? 0.05 : 0.55 },
      wristRight: { x: x + 0.1, y: handsUp ? 0.05 : 0.55 },
    },
  };
}

test("how many people are in frame reaches the state and the badge", async () => {
  const harness = createCrowdHarness([bodyAt(0.3), bodyAt(0.7)]);

  harness.controller.start();
  await harness.controller.tick();

  const state = harness.controller.getState();
  assert.equal(state.people, 2);
  assert.equal(state.bodies.length, 2);
  assert.deepEqual(state.personIds, [1, 2]);
  assert.equal(state.peopleSeen, 2);
  assert.match(
    autoCapture.describeCadence(state),
    /TRACKING WORKER, TRACKING WORKER in frame/,
  );
  assert.match(autoCapture.describeCadence(state), /2 unique people this session/);

  // One person is still one person, not "1 people".
  harness.bodies = [bodyAt(0.5)];
  await harness.controller.tick();
  assert.match(
    autoCapture.describeCadence(harness.controller.getState()),
    /TRACKING WORKER in frame/,
  );

  harness.bodies = [];
  await harness.controller.tick();
  assert.equal(harness.controller.getState().people, 0);
  assert.match(autoCapture.describeCadence(harness.controller.getState()), /No one in frame/);
});

test("anyone in the frame can raise their hands to take the photo", async () => {
  // The person the model happens to list first has their arms down; the second
  // is the one asking for a photograph.
  const harness = createCrowdHarness([bodyAt(0.3), bodyAt(0.7, { handsUp: true })]);

  harness.controller.start();
  await harness.controller.tick();
  const scheduled = harness.saved.length;

  await harness.advance(900);

  const gestured = harness.saved.filter((record) => record.trigger === "gesture");
  assert.equal(gestured.length, 1, "the second person's raised hands took a photograph");
  assert.ok(harness.saved.length > scheduled);
});

test("a capture records how many people were in it", async () => {
  const harness = createCrowdHarness([bodyAt(0.25), bodyAt(0.5), bodyAt(0.75)]);

  harness.controller.start();
  await harness.controller.tick();

  assert.equal(harness.saved[0].pose.people, 3);
  assert.equal(harness.saved[0].uniquePeopleSeen, 3);
  assert.deepEqual(
    harness.captureInputs[0].bodies.map(({ personId, personLabel }) => ({
      personId,
      personLabel,
    })),
    [
      { personId: 1, personLabel: "TRACKING WORKER" },
      { personId: 2, personLabel: "TRACKING WORKER" },
      { personId: 3, personLabel: "TRACKING WORKER" },
    ],
  );
  assert.ok(harness.captureInputs[0].bodies.every((entry) => entry.box));
  assert.ok(harness.captureInputs[0].bodies.every((entry) => !entry.keypoints));
});

// ---------------------------------------------------------------------------
// Declining to photograph nothing

const triage = require(resolve(__dirname, "..", "photo-triage.js"));

function frameOf(shade) {
  const width = 32;
  const height = 32;
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = data[offset + 1] = data[offset + 2] = shade(x, y);
      data[offset + 3] = 255;
    }
  }

  return { width, height, data };
}

// A room with structure in it, and the same room a moment later.
const room = (x, y) => 40 + ((x * 3) % 90) + (y < 12 ? 70 : 0);
const smeared = (x, y) => 128 + Math.sin((x + y) / 12) * 6;

function createTriagedHarness() {
  const saved = [];
  const harness = { time: 0, present: false, frame: frameOf(room), saved };

  harness.controller = autoCapture.createAutoCapture({
    detector: {
      detect: () => ({
        present: harness.present,
        confidence: harness.present ? 0.95 : 0.05,
        pose: harness.present ? "standing" : "none",
        keypoints: harness.present ? { head: { x: 0.5, y: 0.2 } } : null,
        box: harness.present ? { x: 0.4, y: 0.1, width: 0.2, height: 0.8 } : null,
        people: harness.present ? 1 : 0,
        vehicle: null,
      }),
      reset() {},
    },
    tracker: pose.createPoseTracker({ enterFrames: 1, holdMs: 0 }),
    scheduler: schedule.createCaptureScheduler(),
    store: {
      async save(input) {
        saved.push(input);
        return { ...input, id: `capture-${saved.length}` };
      },
    },
    sampleFrame: () => harness.frame,
    captureImage: async () => ({
      blob: { size: 1024, type: "image/jpeg" },
      date: new Date(harness.time),
    }),
    getAddress: () => "10 Bayfront Avenue",
    isGesture: () => false,
    triage,
    readSample: () => harness.frame,
    now: () => harness.time,
  });

  harness.advance = async (milliseconds) => {
    const target = harness.time + milliseconds;

    while (harness.time < target) {
      harness.time = Math.min(target, harness.time + autoCapture.SAMPLE_INTERVAL);
      await harness.controller.tick();
    }
  };

  return harness;
}

test("the same empty view is photographed once, not every two minutes", async () => {
  const harness = createTriagedHarness();

  harness.controller.start();
  await harness.controller.tick();

  // The first is always taken — there is nothing yet for it to be the same as.
  assert.equal(harness.saved.length, 1);
  assert.ok(harness.saved[0].fingerprint, "the view is fingerprinted so the next can be compared");
  assert.equal(typeof harness.saved[0].score, "number");

  // Half an hour of the same wall. Only the heartbeat gets through.
  await harness.advance(30 * 60 * SECOND);

  const state = harness.controller.getState();
  assert.ok(state.skipped > 5, `expected the identical view to be declined, skipped ${state.skipped}`);
  assert.ok(
    harness.saved.length <= 4,
    `expected roughly one heartbeat per ten minutes, got ${harness.saved.length}`,
  );
  assert.match(autoCapture.describeCadence(state), /skipped/i);
});

test("a person walking in is photographed however dull the frame is", async () => {
  const harness = createTriagedHarness();

  harness.controller.start();
  await harness.controller.tick();
  await harness.advance(10 * SECOND);

  const before = harness.saved.length;

  // Somebody arrives, and the lens has not caught up with them.
  harness.present = true;
  harness.frame = frameOf(smeared);
  await harness.advance(2 * 60 * SECOND);

  assert.ok(harness.saved.length > before + 2, "a person in frame is never declined");
  assert.equal(harness.controller.getState().lastSkip, null);

  // And they score above the empty room that came before them.
  const person = harness.saved[harness.saved.length - 1];
  assert.ok(person.score > harness.saved[0].score);
});

test("a frame the lens never focused on is declined when nobody is in it", async () => {
  const harness = createTriagedHarness();

  harness.controller.start();
  await harness.controller.tick();

  // A new view every time, so novelty cannot be what saves or damns it — only
  // the focus.
  let step = 0;
  Object.defineProperty(harness, "frame", {
    get: () => {
      step += 1;
      return frameOf((x, y) => smeared(x + step * 9, y));
    },
  });

  await harness.advance(8 * 60 * SECOND);
  assert.ok(harness.controller.getState().skipped > 0);
  assert.match(harness.controller.getState().lastSkip || "", /focus/i);
});
