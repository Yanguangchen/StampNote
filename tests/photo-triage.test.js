const assert = require("node:assert/strict");
const { resolve } = require("node:path");
const { test } = require("node:test");

const triage = require(resolve(__dirname, "..", "photo-triage.js"));

// A frame built pixel by pixel, the way a canvas hands one over.
function imageOf(width, height, shade) {
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const value = shade(x, y);

      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }

  return { width, height, data };
}

// A checkerboard: every pixel steps away from its neighbours, which is what
// detail looks like to the measurement.
const sharp = imageOf(64, 64, (x, y) => ((x + y) % 2 === 0 ? 20 : 235));
// The same picture with the steps smoothed away — what a lens that never found
// focus hands back.
const blurred = imageOf(64, 64, (x, y) => 128 + Math.sin((x + y) / 12) * 6);
const flat = imageOf(64, 64, () => 128);

test("focus is measured from the detail in the frame", () => {
  const detail = triage.sharpnessOf(sharp);
  const smeared = triage.sharpnessOf(blurred);

  assert.ok(detail > triage.BLUR_FLOOR * 10, `expected a sharp frame, got ${detail}`);
  assert.ok(smeared < triage.BLUR_FLOOR, `expected a soft frame, got ${smeared}`);

  // A frame of one flat colour carries no detail at all.
  assert.equal(triage.sharpnessOf(flat), 0);

  // And the score reads as a fraction either side of the floor.
  assert.ok(triage.focusScore(detail) > 0.9);
  assert.ok(triage.focusScore(smeared) < 0.5);
  assert.equal(triage.focusScore(triage.BLUR_FLOOR), 0.5);
});

test("nothing to measure is measured as nothing, not as a crash", () => {
  [null, undefined, {}, { width: 0, height: 0, data: new Uint8ClampedArray(0) }].forEach((bad) => {
    assert.equal(triage.sharpnessOf(bad), 0);
    assert.equal(triage.fingerprintOf(bad), null);
  });
});

test("the same view fingerprints the same, a different one does not", () => {
  // A view with structure in it, the way a room has: bright and dark patches
  // that fall in particular places.
  const room = (x, y) => 40 + ((x * 3) % 90) + (y < 24 ? 70 : 0) + (x > 44 ? 50 : 0);
  const scene = imageOf(64, 64, room);
  // The same room, a stop brighter and with a little sensor noise — what the
  // next frame of an empty corridor actually looks like.
  const again = imageOf(64, 64, (x, y) => Math.min(255, room(x, y) * 1.15 + ((x * 7 + y * 13) % 5)));
  const different = imageOf(64, 64, (x, y) => 40 + ((y * 3) % 90) + (x < 24 ? 70 : 0));

  const first = triage.fingerprintOf(scene);

  assert.equal(typeof first, "string");
  assert.equal(first.length, 16, "64 bits, as hex");

  assert.ok(
    triage.distanceBetween(first, triage.fingerprintOf(again)) <= triage.SAME_VIEW,
    "exposure and noise must not make the same corridor a new scene",
  );
  assert.ok(triage.distanceBetween(first, triage.fingerprintOf(different)) > triage.SAME_VIEW);

  // Novelty is that distance as a fraction, and the first photograph of a watch
  // has nothing to be the same as.
  assert.equal(triage.noveltyOf(first, first), 0);
  assert.equal(triage.noveltyOf(first, null), 1);
  assert.ok(triage.noveltyOf(triage.fingerprintOf(different), first) > 0.1);
});

test("what was in the picture counts for more than how it was taken", () => {
  const person = triage.scoreCapture({ sharpness: 5, novelty: 0, present: true, confidence: 0.9 });
  const wall = triage.scoreCapture({ sharpness: 900, novelty: 1, present: false });

  assert.ok(person > wall, "a soft photograph of somebody beats a sharp one of nothing");

  // A crowd is worth a little more than one person; a vehicle is worth
  // something, and much less than anybody.
  assert.ok(
    triage.subjectScore({ present: true, people: 3, confidence: 1 }) >
      triage.subjectScore({ present: true, people: 1, confidence: 1 }),
  );
  assert.ok(triage.subjectScore({ present: false, vehicle: true }) > 0);
  assert.ok(triage.subjectScore({ present: false, vehicle: true }) < 0.5);
  assert.equal(triage.subjectScore({ present: false }), 0);

  // A photograph somebody asked for is never judged.
  assert.equal(triage.scoreCapture({ trigger: "gesture", sharpness: 0, novelty: 0 }), 1);
  // And every score is a fraction, whatever it is fed.
  assert.ok(triage.scoreCapture({ sharpness: 1e9, novelty: 99, present: true }) <= 1);
  assert.ok(triage.scoreCapture({}) >= 0);
});

test("a photograph is only declined when several things agree there is nothing there", () => {
  const nothing = { present: false, sharpness: 900, novelty: 0, sinceKeptMs: 0 };

  // The hundredth identical frame of an empty corridor.
  assert.equal(triage.shouldKeep(nothing), false);
  // A frame the lens never found focus on.
  assert.equal(triage.shouldKeep({ ...nothing, sharpness: 5, novelty: 1 }), false);

  // Anybody in frame saves it, however dull or soft.
  assert.equal(triage.shouldKeep({ ...nothing, present: true }), true);
  // So does asking for it.
  assert.equal(triage.shouldKeep({ ...nothing, trigger: "gesture" }), true);
  // So does something actually changing.
  assert.equal(triage.shouldKeep({ ...nothing, novelty: 1 }), true);

  // And however dull the scene, one gets through eventually — an hour of stored
  // nothing is still the answer to "was it running?".
  assert.equal(triage.shouldKeep({ ...nothing, sinceKeptMs: triage.HEARTBEAT_MS }), true);

  // With no measurement at all, nothing is declined.
  assert.equal(triage.shouldKeep({}), true);
});

test("the reason a photograph was skipped says which it was", () => {
  assert.match(triage.describeSkip({ sharpness: 2 }), /focus/i);
  assert.match(triage.describeSkip({ sharpness: 900 }), /changed/i);
});

test("the worst photograph goes first, and age only breaks a tie", () => {
  const records = [
    { id: "old-good", capturedAtMs: 1000, score: 0.9 },
    { id: "new-junk", capturedAtMs: 4000, score: 0.1 },
    { id: "mid-good", capturedAtMs: 2000, score: 0.8 },
  ];

  assert.deepEqual(
    [...records].sort(triage.byExpendability).map((record) => record.id),
    ["new-junk", "mid-good", "old-good"],
  );

  // Photographs taken before any of this existed carry no score, and fall back
  // to oldest-first — which is what the store always did.
  const unscored = [
    { id: "newer", capturedAtMs: 2000 },
    { id: "older", capturedAtMs: 1000 },
  ];

  assert.deepEqual(
    [...unscored].sort(triage.byExpendability).map((record) => record.id),
    ["older", "newer"],
  );
});
