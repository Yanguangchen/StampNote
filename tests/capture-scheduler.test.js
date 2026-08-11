const assert = require("node:assert/strict");
const { resolve } = require("node:path");
const { test } = require("node:test");

const schedule = require(resolve(__dirname, "..", "capture-scheduler.js"));

const SECOND = 1000;

test("the two cadences are 30 and 120 seconds", () => {
  assert.equal(schedule.POSE_INTERVAL, 30 * SECOND);
  assert.equal(schedule.IDLE_INTERVAL, 120 * SECOND);

  const scheduler = schedule.createCaptureScheduler();
  assert.equal(scheduler.intervalFor(true), 30 * SECOND);
  assert.equal(scheduler.intervalFor(false), 120 * SECOND);
});

test("the first look always takes a photo", () => {
  const scheduler = schedule.createCaptureScheduler();
  const decision = scheduler.evaluate({ present: false, now: 5000 });

  assert.equal(decision.shouldCapture, true);
  assert.equal(decision.reason, "first");
});

test("with a person in frame photos are taken every 30 seconds", () => {
  const scheduler = schedule.createCaptureScheduler();

  scheduler.evaluate({ present: true, now: 0 });
  scheduler.markCaptured(0);

  assert.equal(scheduler.evaluate({ present: true, now: 29 * SECOND }).shouldCapture, false);
  assert.equal(scheduler.evaluate({ present: true, now: 29 * SECOND }).waitMs, SECOND);
  assert.equal(scheduler.evaluate({ present: true, now: 30 * SECOND }).shouldCapture, true);

  scheduler.markCaptured(30 * SECOND);
  assert.equal(scheduler.evaluate({ present: true, now: 59 * SECOND }).shouldCapture, false);
  assert.equal(scheduler.evaluate({ present: true, now: 60 * SECOND }).shouldCapture, true);
});

test("with nobody in frame photos are taken every 120 seconds", () => {
  const scheduler = schedule.createCaptureScheduler();

  scheduler.evaluate({ present: false, now: 0 });
  scheduler.markCaptured(0);

  assert.equal(scheduler.evaluate({ present: false, now: 60 * SECOND }).shouldCapture, false);
  assert.equal(scheduler.evaluate({ present: false, now: 119 * SECOND }).shouldCapture, false);
  assert.equal(scheduler.evaluate({ present: false, now: 120 * SECOND }).shouldCapture, true);
});

test("someone walking into a quiet stretch is photographed at once", () => {
  const scheduler = schedule.createCaptureScheduler();

  scheduler.markCaptured(0);

  // 100 seconds of nobody: still 20 seconds short of the idle interval.
  assert.equal(scheduler.evaluate({ present: false, now: 100 * SECOND }).shouldCapture, false);

  // A person appears, and by the 30-second rule the last photo is already old.
  const arrival = scheduler.evaluate({ present: true, now: 100 * SECOND });
  assert.equal(arrival.shouldCapture, true);
  assert.equal(arrival.interval, 30 * SECOND);
});

test("someone arriving right after a photo waits out the balance of the 30", () => {
  const scheduler = schedule.createCaptureScheduler();

  scheduler.markCaptured(0);

  const arrival = scheduler.evaluate({ present: true, now: 5 * SECOND });
  assert.equal(arrival.shouldCapture, false);
  assert.equal(arrival.waitMs, 25 * SECOND);
  assert.equal(arrival.dueAt, 30 * SECOND);
});

test("someone leaving pushes the next photo out to the idle interval", () => {
  const scheduler = schedule.createCaptureScheduler();

  scheduler.markCaptured(0);
  assert.equal(scheduler.evaluate({ present: true, now: 20 * SECOND }).dueAt, 30 * SECOND);

  const left = scheduler.evaluate({ present: false, now: 20 * SECOND });
  assert.equal(left.shouldCapture, false);
  assert.equal(left.dueAt, 120 * SECOND);
  assert.equal(left.interval, 120 * SECOND);
});

test("a long absence is caught up on the next look, not replayed", () => {
  const scheduler = schedule.createCaptureScheduler();

  scheduler.markCaptured(0);

  // The page was hidden for an hour. One photo is owed, not one hundred and
  // twenty of them.
  const resumed = scheduler.evaluate({ present: false, now: 3600 * SECOND });
  assert.equal(resumed.shouldCapture, true);

  scheduler.markCaptured(3600 * SECOND);
  assert.equal(scheduler.evaluate({ present: false, now: 3601 * SECOND }).shouldCapture, false);
});

test("the intervals can be overridden for a faster test or a slower watch", () => {
  const scheduler = schedule.createCaptureScheduler({ poseInterval: 500, idleInterval: 2000 });

  scheduler.markCaptured(0);
  assert.equal(scheduler.evaluate({ present: true, now: 500 }).shouldCapture, true);
  assert.equal(scheduler.evaluate({ present: false, now: 500 }).shouldCapture, false);
  assert.equal(scheduler.evaluate({ present: false, now: 2000 }).shouldCapture, true);
});

test("reset returns the scheduler to its opening state", () => {
  const scheduler = schedule.createCaptureScheduler();

  scheduler.markCaptured(1000);
  assert.equal(scheduler.lastCaptureAt, 1000);
  assert.equal(scheduler.dueAt(), 1000 + 120 * SECOND);

  scheduler.reset();
  assert.equal(scheduler.lastCaptureAt, null);
  assert.equal(scheduler.dueAt(), null);
  assert.equal(scheduler.evaluate({ present: false, now: 0 }).reason, "first");
});
