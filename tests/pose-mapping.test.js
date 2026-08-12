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

test("presence has to be earned, not assumed from landmarks existing", () => {
  // In video the landmarker detects once and then tracks, so a pose it locked
  // onto by mistake comes back on every later frame. Reporting a person just
  // because landmarks exist is how a ceiling ends up on the 30-second cadence.
  const unsure = standing();
  [LANDMARK.shoulderLeft, LANDMARK.shoulderRight, LANDMARK.hipLeft, LANDMARK.hipRight].forEach(
    (index) => {
      unsure[index] = { ...unsure[index], visibility: 0.3 };
    },
  );

  const detection = mapping.buildDetection(unsure, []);

  assert.equal(detection.present, false);
  assert.equal(detection.subject, "none");
  // Nor is it drawn: the picture never shows a skeleton the schedule ignores.
  assert.equal(detection.keypoints, null);
  assert.equal(detection.box, null);
});

test("a landmark with no score at all counts as nothing", () => {
  // Reading a missing number as full confidence waves a phantom through at
  // maximum certainty, which is exactly what it did.
  const scoreless = standing();
  [LANDMARK.shoulderLeft, LANDMARK.shoulderRight, LANDMARK.hipLeft, LANDMARK.hipRight].forEach(
    (index) => {
      scoreless[index] = { x: 0.5, y: 0.5, z: 0 };
    },
  );

  assert.equal(mapping.trunkConfidence(scoreless), 0);
  assert.equal(mapping.buildDetection(scoreless, []).present, false);
});

test("a half-sure pose is believed when something else agrees", () => {
  const middling = standing();
  [LANDMARK.shoulderLeft, LANDMARK.shoulderRight, LANDMARK.hipLeft, LANDMARK.hipRight].forEach(
    (index) => {
      middling[index] = { ...middling[index], visibility: 0.65 };
    },
  );

  // On its own it is not enough.
  assert.equal(mapping.buildDetection(middling, []).present, false);

  // A face where the head should be settles it, and so does the object
  // detector — which looks afresh every frame and cannot inherit the mistake.
  assert.equal(mapping.buildDetection(middling, [], { face: { jaw: [] } }).present, true);
  assert.equal(mapping.buildDetection(middling, [], { person: 1 }).present, true);

  // But corroboration cannot rescue a reading with nothing behind it.
  const empty = standing();
  [LANDMARK.shoulderLeft, LANDMARK.shoulderRight, LANDMARK.hipLeft, LANDMARK.hipRight].forEach(
    (index) => {
      empty[index] = { ...empty[index], visibility: 0.2 };
    },
  );
  assert.equal(mapping.buildDetection(empty, [], { person: 1 }).present, false);
});

test("the face is traced along the joins the model itself gives", () => {
  // Which of the 478 points join up comes from MediaPipe — there is no
  // eyeballing a wrong index among that many — so the mapping is handed the
  // connection sets rather than carrying a list of its own.
  const mesh = Array.from({ length: 478 }, (unused, index) => ({
    x: index / 478,
    y: 1 - index / 478,
    z: 0,
  }));
  const connections = {
    oval: [
      { start: 10, end: 20 },
      { start: 20, end: 30 },
    ],
    eyeLeft: [{ start: 33, end: 160 }],
    lips: [{ start: 61, end: 40 }],
  };

  const face = mapping.toFaceOutlines(mesh, connections);

  // Each connection becomes a segment: the two points it joins.
  assert.equal(face.oval.length, 2);
  assert.deepEqual(face.oval[0], [
    { x: 10 / 478, y: 1 - 10 / 478 },
    { x: 20 / 478, y: 1 - 20 / 478 },
  ]);
  assert.equal(face.eyeLeft.length, 1);
  assert.equal(face.lips.length, 1);

  // A connection reaching past the end of the mesh is dropped, not drawn to
  // nowhere.
  assert.deepEqual(mapping.toFaceOutlines(mesh, { oval: [{ start: 10, end: 9999 }] }), null);

  assert.equal(mapping.toFaceOutlines(null, connections), null);
  assert.equal(mapping.toFaceOutlines([], connections), null);
  assert.equal(mapping.toFaceOutlines(mesh, null), null);
});

test("the object detector's own count of people is read", () => {
  const raw = {
    detections: [
      { categories: [{ categoryName: "person", score: 0.9 }], boundingBox: {} },
      { categories: [{ categoryName: "person", score: 0.2 }], boundingBox: {} },
      { categories: [{ categoryName: "car", score: 0.9 }], boundingBox: {} },
    ],
  };

  assert.equal(mapping.readPeople(raw), 1, "only the one it is sure of");
  assert.equal(mapping.readPeople(null), 0);
});

test("a vehicle box covering the whole frame is the detector shrugging", () => {
  const raw = {
    detections: [
      { categories: [{ categoryName: "bus", score: 0.9 }], boundingBox: { originX: 0, originY: 0, width: 200, height: 100 } },
    ],
  };

  assert.deepEqual(mapping.readVehicles(raw, 200, 100), []);
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
      { categories: [{ categoryName: "bus", score: 0.2 }], boundingBox: { originX: 0, originY: 0, width: 60, height: 40 } },
      { categories: [{ categoryName: "truck", score: 0.7 }], boundingBox: { originX: 50, originY: 10, width: 150, height: 80 } },
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

// The hand landmarker reports 21 points per hand and which hand it is.
function handResult(sides = ["Left"]) {
  return {
    landmarks: sides.map((unused, hand) =>
      Array.from({ length: 21 }, (ignored, index) => ({
        x: 0.3 + hand * 0.4 + index / 200,
        y: 0.5 - index / 200,
        z: 0,
      })),
    ),
    handedness: sides.map((side) => [{ categoryName: side, score: 0.97 }]),
  };
}

const HAND_BONES = [
  { start: 0, end: 1 },
  { start: 1, end: 2 },
  { start: 0, end: 5 },
];

test("fingers come back as bones and joints, per hand", () => {
  const hands = mapping.toHands(handResult(["Left", "Right"]), HAND_BONES);

  assert.equal(hands.length, 2);
  assert.deepEqual(
    hands.map((hand) => hand.side),
    ["Left", "Right"],
  );

  // Twenty-one points apiece — wrist, then four joints along every finger —
  // which is the whole reason for a second model: the pose landmarker stops at
  // the wrist.
  hands.forEach((hand) => {
    assert.equal(hand.points.length, 21);
    assert.equal(hand.segments.length, HAND_BONES.length);
    assert.equal(hand.confidence, 0.97);
  });

  assert.deepEqual(hands[0].segments[0], [hands[0].points[0], hands[0].points[1]]);
  assert.deepEqual(mapping.toHands(null, HAND_BONES), []);
  assert.deepEqual(mapping.toHands(handResult(), null), []);
});

test("hands ride along with the rest of a detection", () => {
  const hands = mapping.toHands(handResult(), HAND_BONES);
  const detection = mapping.buildDetection(standing(), [], { hands });

  assert.equal(detection.hands.length, 1);

  // And go when the person does, like every other part of the rig.
  const gone = mapping.buildDetection(null, [], { hands });
  assert.deepEqual(gone.hands, []);
});

test("what is drawn eases towards the latest reading", () => {
  // Detection runs a few times a second and the screen redraws sixty. Easing
  // between the two is what turns a row of stills into movement.
  const from = { x: 0, y: 0 };
  const to = { x: 1, y: 1 };

  assert.deepEqual(mapping.blendPoint(from, to, 0.25), { x: 0.25, y: 0.25 });
  assert.deepEqual(mapping.blendPoint(from, to, 1), to);

  // A joint that has just appeared has nothing to ease from, and one that has
  // gone should go at once rather than drift off across the picture.
  assert.deepEqual(mapping.blendPoint(null, to, 0.25), to);
  assert.equal(mapping.blendPoint(from, null, 0.25), null);
});

test("easing covers the whole rig, and gives up when the shape changes", () => {
  const before = mapping.toKeypoints(standing());
  const after = mapping.toKeypoints(
    standing({ [LANDMARK.wristLeft]: { x: 0.1, y: 0.3 } }),
  );

  const midway = mapping.blendKeypoints(before, after, 0.5);
  assert.equal(midway.wristLeft.x, (before.wristLeft.x + after.wristLeft.x) / 2);
  assert.deepEqual(midway.neck, before.neck, "a joint that has not moved stays put");

  // Segments only line up frame to frame while there are the same number of
  // them; when the model changes its mind, the new reading is taken whole.
  const faceBefore = { oval: [[{ x: 0, y: 0 }, { x: 0, y: 0 }]] };
  const faceAfter = { oval: [[{ x: 1, y: 1 }, { x: 1, y: 1 }]] };
  assert.deepEqual(mapping.blendSegments(faceBefore, faceAfter, 0.5).oval[0][0], { x: 0.5, y: 0.5 });
  assert.deepEqual(
    mapping.blendSegments({ oval: [] }, faceAfter, 0.5).oval,
    faceAfter.oval,
    "a different number of segments is taken as it comes",
  );

  // Hands are matched up by which hand they are, not by their place in the list.
  const left = mapping.toHands(handResult(["Left"]), HAND_BONES);
  const swapped = mapping.toHands(handResult(["Right", "Left"]), HAND_BONES);
  const blended = mapping.blendHands(left, swapped, 0.5);
  assert.equal(blended.length, 2);
  assert.equal(blended[0].side, "Right");
  assert.deepEqual(mapping.blendHands(null, left, 0.5), left);
});

test("hands above the head is the shutter, and nothing else is", () => {
  // It has to be something nobody does by accident in front of a camera that
  // is already photographing them.
  const overhead = mapping.toKeypoints(
    standing({
      [LANDMARK.wristLeft]: { x: 0.4, y: 0.02 },
      [LANDMARK.wristRight]: { x: 0.6, y: 0.02 },
    }),
  );
  assert.equal(mapping.isCaptureGesture(overhead), true);

  // Standing normally, waving with one hand, or reaching only as high as the
  // shoulders are all just somebody in the room.
  assert.equal(mapping.isCaptureGesture(mapping.toKeypoints(standing())), false);
  assert.equal(
    mapping.isCaptureGesture(
      mapping.toKeypoints(standing({ [LANDMARK.wristLeft]: { x: 0.4, y: 0.02 } })),
    ),
    false,
  );
  assert.equal(
    mapping.isCaptureGesture(
      mapping.toKeypoints(
        standing({
          [LANDMARK.wristLeft]: { x: 0.4, y: 0.2 },
          [LANDMARK.wristRight]: { x: 0.6, y: 0.2 },
        }),
      ),
    ),
    false,
    "level with the face is not above the head",
  );

  // A hand the model could not see cannot be raised.
  assert.equal(
    mapping.isCaptureGesture(
      mapping.toKeypoints(
        standing({
          [LANDMARK.wristLeft]: { x: 0.4, y: 0.02, visibility: 0.1 },
          [LANDMARK.wristRight]: { x: 0.6, y: 0.02 },
        }),
      ),
    ),
    false,
  );
  assert.equal(mapping.isCaptureGesture(null), false);
});
