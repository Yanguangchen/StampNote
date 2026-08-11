const assert = require("node:assert/strict");
const { resolve } = require("node:path");
const { test } = require("node:test");

const autoCapture = require(resolve(__dirname, "..", "auto-capture.js"));
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
    frame: { width: 2, height: 2, data: new Uint8ClampedArray(16) },
    address: "10 Bayfront Avenue",
    captureFails: false,
    saved,
  };

  const detector = {
    detect: () => ({
      present: harness.present,
      confidence: harness.present ? 0.9 : 0.05,
      pose: harness.present ? "standing" : "none",
      keypoints: harness.present ? { head: { x: 0.5, y: 0.2 } } : null,
      box: harness.present ? { x: 0.4, y: 0.1, width: 0.2, height: 0.8 } : null,
    }),
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

test("each stored capture carries its address, pose and cadence", async () => {
  const harness = createHarness();

  harness.present = true;
  harness.controller.start();
  await harness.controller.tick();

  const [capture] = harness.saved;
  assert.equal(capture.address, "10 Bayfront Avenue");
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
      present: true,
      intervalMs: 30 * SECOND,
      waitMs: 12400,
    }),
    "Person in frame · every 30s · next in 12s",
  );
  assert.equal(
    autoCapture.describeCadence({
      running: true,
      present: false,
      intervalMs: 120 * SECOND,
      waitMs: 0,
    }),
    "No one in frame · every 120s · next in 0s",
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
