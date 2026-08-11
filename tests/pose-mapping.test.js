const assert = require("node:assert/strict");
const { resolve } = require("node:path");
const { test } = require("node:test");

const mapping = require(resolve(__dirname, "..", "pose-mapping.js"));

// MediaPipe hands back 33 landmarks whether it saw them or not, each with a
// visibility saying how much of that was seeing rather than guessing.
function landmarksFor(overrides = {}, fallbackVisibility = 0.9) {
  const points = Array.from({ length: 33 }, () => ({
    x: 0.5,
    y: 0.5,
    z: 0,
    visibility: fallbackVisibility,
  }));

  Object.entries(overrides).forEach(([index, point]) => {
    points[index] = { x: 0.5, y: 0.5, z: 0, visibility: fallbackVisibility, ...point };
  });

  return points;
}

const { LANDMARK } = mapping;

// A person standing square to the camera, arms down, feet on the floor.
function standing(overrides = {}) {
  return landmarksFor({
    [LANDMARK.nose]: { x: 0.5, y: 0.12 },
    [LANDMARK.earLeft]: { x: 0.47, y: 0.13 },
    [LANDMARK.earRight]: { x: 0.53, y: 0.13 },
    [LANDMARK.shoulderLeft]: { x: 0.42, y: 0.26 },
    [LANDMARK.shoulderRight]: { x: 0.58, y: 0.26 },
    [LANDMARK.elbowLeft]: { x: 0.39, y: 0.42 },
    [LANDMARK.elbowRight]: { x: 0.61, y: 0.42 },
    [LANDMARK.wristLeft]: { x: 0.37, y: 0.56 },
    [LANDMARK.wristRight]: { x: 0.63, y: 0.56 },
    [LANDMARK.hipLeft]: { x: 0.45, y: 0.56 },
    [LANDMARK.hipRight]: { x: 0.55, y: 0.56 },
    [LANDMARK.kneeLeft]: { x: 0.45, y: 0.76 },
    [LANDMARK.kneeRight]: { x: 0.55, y: 0.76 },
    [LANDMARK.ankleLeft]: { x: 0.45, y: 0.95 },
    [LANDMARK.ankleRight]: { x: 0.55, y: 0.95 },
    ...overrides,
  });
}

test("every joint the overlay draws comes back named", () => {
  const keypoints = mapping.toKeypoints(standing());

  // The overlay was written against these names long before the model existed,
  // and it still draws them without knowing where they now come from.
  [
    "head",
    "neck",
    "shoulderLeft",
    "shoulderRight",
    "elbowLeft",
    "elbowRight",
    "wristLeft",
    "wristRight",
    "torso",
    "hipLeft",
    "hipRight",
    "kneeLeft",
    "kneeRight",
    "ankleLeft",
    "ankleRight",
  ].forEach((joint) => {
    assert.ok(keypoints[joint], `expected a ${joint}`);
  });
});

test("the rig hangs together anatomically", () => {
  const k = mapping.toKeypoints(standing());

  assert.ok(k.head.y < k.neck.y, "the head is above the neck");
  assert.ok(k.neck.y < k.torso.y, "the neck is above the chest");
  assert.ok(k.torso.y < k.hipLeft.y, "the chest is above the hips");
  assert.ok(k.hipLeft.y < k.kneeLeft.y, "knees below hips");
  assert.ok(k.kneeLeft.y < k.ankleLeft.y, "ankles below knees");
  assert.ok(k.shoulderLeft.x < k.shoulderRight.x, "shoulders span the body");

  // The neck sits between the shoulders and the chest between neck and hips,
  // because MediaPipe reports neither.
  assert.equal(k.neck.x, 0.5);
  assert.equal(k.neck.y, 0.26);
  assert.equal(k.torso.y, (0.26 + 0.56) / 2);
});

test("the head keypoint is the crown, not the nose", () => {
  const k = mapping.toKeypoints(standing());

  // A circle centred on the nose sits over the mouth, so the crown is
  // extrapolated up away from the neck.
  assert.ok(k.head.y < 0.13, `expected above the ears, got ${k.head.y}`);
  assert.ok(Math.abs(k.head.x - 0.5) < 0.01, "and on the body's centre line");
});

test("a joint the model could not see is left out rather than guessed", () => {
  const hidden = standing({
    [LANDMARK.wristLeft]: { x: 0.37, y: 0.56, visibility: 0.1 },
    [LANDMARK.elbowLeft]: { x: 0.39, y: 0.42, visibility: 0.2 },
  });
  const keypoints = mapping.toKeypoints(hidden);

  assert.equal(keypoints.wristLeft, null);
  assert.equal(keypoints.elbowLeft, null);
  assert.ok(keypoints.wristRight, "the arm that was visible is kept");
  assert.deepEqual(mapping.countLimbs(keypoints), { arms: 1, legs: 2 });
});

test("confidence is read off the trunk", () => {
  assert.equal(mapping.trunkConfidence(standing()), 0.9);

  const half = standing();
  half[LANDMARK.hipLeft] = { ...half[LANDMARK.hipLeft], visibility: 0.5 };
  half[LANDMARK.hipRight] = { ...half[LANDMARK.hipRight], visibility: 0.5 };
  assert.equal(mapping.trunkConfidence(half), 0.7);
});

test("the box wraps the joints that were found", () => {
  const box = mapping.boundsOf(mapping.toKeypoints(standing()));

  assert.ok(box.x >= 0.36 && box.x <= 0.38, `left edge ${box.x}`);
  assert.ok(box.height > 0.8, `height ${box.height}`);
  assert.equal(mapping.boundsOf({}), null);
});

test("standing, seated and cropped are told apart", () => {
  assert.equal(mapping.describePosture(mapping.toKeypoints(standing())), "standing");

  // Sitting folds the legs away, so they stop being longer than the trunk.
  const seated = standing({
    [LANDMARK.kneeLeft]: { x: 0.4, y: 0.62 },
    [LANDMARK.kneeRight]: { x: 0.6, y: 0.62 },
    [LANDMARK.ankleLeft]: { x: 0.4, y: 0.72 },
    [LANDMARK.ankleRight]: { x: 0.6, y: 0.72 },
  });
  assert.equal(mapping.describePosture(mapping.toKeypoints(seated)), "seated");

  // Framed from the waist up.
  const cropped = standing({
    [LANDMARK.ankleLeft]: { x: 0.45, y: 0.95, visibility: 0.1 },
    [LANDMARK.ankleRight]: { x: 0.55, y: 0.95, visibility: 0.1 },
  });
  assert.equal(mapping.describePosture(mapping.toKeypoints(cropped)), "close-up");
});

test("a detection carries a person and any vehicle beside them", () => {
  const detection = mapping.buildDetection(standing(), [
    { confidence: 0.8, label: "car", box: { x: 0.6, y: 0.5, width: 0.3, height: 0.2 } },
  ]);

  assert.equal(detection.present, true);
  assert.equal(detection.subject, "person");
  assert.equal(detection.pose, "standing");
  assert.deepEqual(detection.limbs, { arms: 2, legs: 2 });
  assert.equal(detection.vehicle.label, "car");
});

test("a vehicle with nobody there is a vehicle, and nobody there", () => {
  const detection = mapping.buildDetection(null, [
    { confidence: 0.7, label: "truck", box: { x: 0, y: 0, width: 0.5, height: 0.4 } },
  ]);

  // The whole point: `present` is what the capture schedule reads, and a
  // vehicle must never set it.
  assert.equal(detection.present, false);
  assert.equal(detection.subject, "vehicle");
  assert.equal(detection.keypoints, null);
  assert.ok(detection.vehicle);
});

test("an empty frame is empty", () => {
  const detection = mapping.buildDetection(null, []);

  assert.equal(detection.present, false);
  assert.equal(detection.subject, "none");
  assert.equal(detection.vehicle, null);
});

test("only things with wheels are called vehicles", () => {
  const raw = {
    detections: [
      { categories: [{ categoryName: "car", score: 0.9 }], boundingBox: { originX: 10, originY: 20, width: 100, height: 50 } },
      { categories: [{ categoryName: "person", score: 0.95 }], boundingBox: { originX: 0, originY: 0, width: 40, height: 90 } },
      { categories: [{ categoryName: "dog", score: 0.8 }], boundingBox: { originX: 5, originY: 5, width: 20, height: 20 } },
      { categories: [{ categoryName: "bus", score: 0.2 }], boundingBox: { originX: 0, originY: 0, width: 200, height: 100 } },
      { categories: [{ categoryName: "truck", score: 0.6 }], boundingBox: { originX: 50, originY: 10, width: 150, height: 80 } },
    ],
  };

  const found = mapping.readVehicles(raw, 200, 100);

  // A person and a dog are not vehicles, and a bus the model is only 20% sure
  // of is not reported at all.
  assert.deepEqual(
    found.map((entry) => entry.label),
    ["truck", "car"],
  );

  // Boxes arrive in pixels and leave normalised, like every other box.
  assert.deepEqual(found[1].box, { x: 0.05, y: 0.2, width: 0.5, height: 0.5 });
  assert.deepEqual(mapping.readVehicles(raw, 0, 0), []);
  assert.deepEqual(mapping.readVehicles(null, 200, 100), []);
});
