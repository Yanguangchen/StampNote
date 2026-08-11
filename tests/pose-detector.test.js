const assert = require("node:assert/strict");
const { resolve } = require("node:path");
const { test } = require("node:test");

const pose = require(resolve(__dirname, "..", "pose-detector.js"));

const WIDTH = 128;
const HEIGHT = 96;

const ROOM = [90, 100, 110];
const SKIN = [215, 160, 130];
const SHIRT_A = [60, 70, 120];
const SHIRT_B = [90, 100, 150];
const TROUSERS_A = [45, 45, 60];
const TROUSERS_B = [80, 80, 100];

function createFrame(painter, width = WIDTH, height = HEIGHT) {
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue] = painter(x, y);
      const offset = (y * width + x) * 4;

      data[offset] = red;
      data[offset + 1] = green;
      data[offset + 2] = blue;
      data[offset + 3] = 255;
    }
  }

  return { width, height, data };
}

// Woven clothing, so shifting the body between frames actually changes pixels —
// a flat colour only moves at its edges.
function weave(x, y, dark, light) {
  return (x + y) % 6 < 3 ? dark : light;
}

// A head above a broader torso above narrower legs: the arrangement the
// detector keys on. `shift` slides the whole figure sideways to fake movement.
function paintPerson(shift = 0) {
  return (x, y) => {
    const px = x - shift;

    if ((px - 64) ** 2 + (y - 18) ** 2 <= 81) {
      return SKIN;
    }
    if (px >= 52 && px <= 76 && y >= 27 && y <= 66) {
      return weave(px, y, SHIRT_A, SHIRT_B);
    }
    if (px >= 56 && px <= 72 && y >= 67 && y <= 94) {
      return weave(px, y, TROUSERS_A, TROUSERS_B);
    }

    return ROOM;
  };
}

// Distance from a point to a line segment, for drawing limbs with thickness.
function nearSegment(px, py, ax, ay, bx, by, radius) {
  const dx = bx - ax;
  const dy = by - ay;
  const along = Math.max(
    0,
    Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)),
  );

  return (px - (ax + along * dx)) ** 2 + (py - (ay + along * dy)) ** 2 <= radius * radius;
}

// A figure with limbs that can be posed: head, trunk, and a list of
// [fromX, fromY, toX, toY, thickness] bones. Proportioned like a person —
// a head about half the width of the chest.
function paintFigure(bones, shift = 0) {
  return (x, y) => {
    const px = x - shift;

    if ((px - 64) ** 2 + (y - 13) ** 2 <= 49) {
      return SKIN;
    }
    if (px >= 52 && px <= 76 && y >= 21 && y <= 53) {
      return weave(px, y, SHIRT_A, SHIRT_B);
    }
    if (bones.some((bone) => nearSegment(px, y, ...bone))) {
      return weave(px, y, SHIRT_A, SHIRT_B);
    }

    return ROOM;
  };
}

const LEGS = [
  [58, 53, 50, 88, 4],
  [70, 53, 78, 88, 4],
];
const ARMS_DOWN = [
  [53, 25, 40, 46, 3],
  [75, 25, 88, 46, 3],
];
const ARMS_OUT = [
  [53, 26, 34, 26, 3],
  [75, 26, 94, 26, 3],
];
const ARMS_UP = [
  [53, 25, 42, 6, 3],
  [75, 25, 86, 6, 3],
];

// Two frames of the same pose, shifted, so motion fills in the clothing.
function detectFigure(bones) {
  const previous = pose.analyzeFrame(createFrame(paintFigure(bones, 0)));

  return pose.analyzeFrame(createFrame(paintFigure(bones, 2)), {
    previousLuma: previous.luma,
  });
}

// Keypoints come back normalised; tests read them in frame pixels.
function toPixels(keypoints) {
  return Object.fromEntries(
    Object.entries(keypoints).map(([joint, point]) => [
      joint,
      point ? { x: point.x * WIDTH, y: point.y * HEIGHT } : null,
    ]),
  );
}

const emptyRoom = () => ROOM;

test("skin test accepts warm tones and rejects the room around them", () => {
  assert.equal(pose.isSkin(...SKIN), true);
  assert.equal(pose.isSkin(...ROOM), false);
  assert.equal(pose.isSkin(...SHIRT_A), false);
  assert.equal(pose.isSkin(...TROUSERS_A), false);

  // The chrominance box is a hue test, so it holds across skin tones while
  // still dropping pixels too dark or too blown out to carry colour.
  assert.equal(pose.isSkin(120, 84, 66), true);
  assert.equal(pose.isSkin(80, 55, 42), true);
  assert.equal(pose.isSkin(255, 255, 255), false);
  assert.equal(pose.isSkin(8, 6, 5), false);
});

test("an empty room holds no pose", () => {
  const frame = createFrame(emptyRoom);
  const detection = pose.analyzeFrame(frame);

  assert.equal(detection.present, false);
  assert.equal(detection.confidence, 0);
  assert.equal(detection.keypoints, null);
  assert.equal(detection.pose, "none");
});

test("a person in frame is found, with keypoints in anatomical order", () => {
  const previous = pose.analyzeFrame(createFrame(paintPerson(0)));
  const detection = pose.analyzeFrame(createFrame(paintPerson(2)), {
    previousLuma: previous.luma,
  });

  assert.equal(detection.present, true);
  assert.ok(detection.confidence > 0.8, `confidence was ${detection.confidence}`);
  assert.equal(detection.pose, "standing");

  const { head, neck, shoulderLeft, shoulderRight, torso, hipLeft, hipRight } =
    detection.keypoints;

  // Everything is normalised to 0..1 so an overlay of any size can draw it.
  Object.values(detection.keypoints)
    .filter(Boolean)
    .forEach((point) => {
      assert.ok(point.x >= 0 && point.x <= 1, "x is normalised");
      assert.ok(point.y >= 0 && point.y <= 1, "y is normalised");
    });

  assert.ok(head.y < neck.y, "the head sits above the neck");
  assert.ok(neck.y < torso.y, "the neck sits above the torso");
  assert.ok(torso.y < hipLeft.y, "the hips sit below the torso");
  assert.ok(shoulderLeft.x < shoulderRight.x, "shoulders span left to right");
  assert.ok(
    shoulderRight.x - shoulderLeft.x > 0.1,
    "the shoulders are wider than a single column",
  );

  // The box wraps the whole figure, head to feet.
  assert.ok(detection.box.height > 0.8, `box height was ${detection.box.height}`);
  assert.ok(detection.box.width < 0.35, `box width was ${detection.box.width}`);
});

test("a still person is still found, because skin alone carries the detection", () => {
  // No previous frame at all: motion contributes nothing.
  const detection = pose.analyzeFrame(createFrame(paintPerson(0)));

  assert.equal(detection.present, true);
  assert.equal(detection.motionFraction, 0);
});

test("a skin-toned slab is rejected for having no head", () => {
  // A cardboard box or a varnished door: the right colour, a plausible size and
  // an upright aspect, but an even width from top to bottom.
  const slab = createFrame((x, y) => (x >= 44 && x <= 84 && y >= 18 && y <= 78 ? SKIN : ROOM));
  const detection = pose.analyzeFrame(slab);

  assert.equal(detection.present, false);
  assert.ok(detection.confidence < 0.5, `confidence was ${detection.confidence}`);
});

test("a wall of skin tone is rejected for filling the frame", () => {
  const wall = createFrame(() => SKIN);
  const detection = pose.analyzeFrame(wall);

  assert.equal(detection.present, false);
});

test("moving scenery without skin is not a person", () => {
  // Leaves in the wind: plenty of motion, no skin anywhere.
  const previous = pose.analyzeFrame(createFrame((x, y) => weave(x, y, SHIRT_A, SHIRT_B)));
  const detection = pose.analyzeFrame(
    createFrame((x, y) => weave(x + 2, y, SHIRT_A, SHIRT_B)),
    { previousLuma: previous.luma },
  );

  assert.equal(detection.present, false);
});

test("a face hint lifts a detection the silhouette alone would miss", () => {
  const slab = createFrame((x, y) => (x >= 44 && x <= 84 && y >= 18 && y <= 78 ? SKIN : ROOM));
  const withoutFace = pose.analyzeFrame(slab);
  const withFace = pose.analyzeFrame(slab, {
    // Where Chrome's Shape Detection API is available it reports boxes in the
    // analysed frame's own pixels.
    faces: [{ x: 54, y: 20, width: 20, height: 24 }],
  });

  assert.equal(withoutFace.present, false);
  assert.equal(withFace.present, true);
  assert.equal(withFace.face, true);
  assert.ok(withFace.confidence > withoutFace.confidence);
});

test("a malformed frame is rejected rather than scored", () => {
  assert.throws(() => pose.analyzeFrame({ width: 0, height: 0, data: null }), TypeError);
  assert.throws(
    () => pose.analyzeFrame({ width: 4, height: 4, data: new Uint8ClampedArray(8) }),
    TypeError,
  );
});

test("the detector carries the previous frame so motion needs no bookkeeping", () => {
  const detector = pose.createPoseDetector();

  const first = detector.detect(createFrame(paintPerson(0)));
  const second = detector.detect(createFrame(paintPerson(2)));

  assert.equal(first.motionFraction, 0);
  assert.ok(second.motionFraction > 0, "the second frame is compared against the first");

  detector.reset();
  assert.equal(detector.detect(createFrame(paintPerson(4))).motionFraction, 0);
});

test("the rig finds both arms and both legs, joint by joint", () => {
  const detection = detectFigure([...ARMS_DOWN, ...LEGS]);
  const joints = toPixels(detection.keypoints);

  assert.equal(detection.present, true);
  assert.deepEqual(detection.limbs, { arms: 2, legs: 2 });

  // Every joint of the rig is placed.
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
    assert.ok(joints[joint], `expected a ${joint}`);
  });

  // Arms run out and down from the shoulders to the drawn hands at (40,46)
  // and (88,46), with the elbows somewhere between.
  assert.ok(Math.abs(joints.wristLeft.x - 40) < 6, `left wrist at ${joints.wristLeft.x}`);
  assert.ok(Math.abs(joints.wristRight.x - 88) < 6, `right wrist at ${joints.wristRight.x}`);
  assert.ok(joints.wristLeft.x < joints.elbowLeft.x, "the left elbow is inboard of the wrist");
  assert.ok(joints.elbowLeft.x < joints.shoulderLeft.x, "and outboard of the shoulder");
  assert.ok(joints.wristRight.x > joints.elbowRight.x, "the right elbow is inboard of the wrist");
  assert.ok(joints.elbowRight.x > joints.shoulderRight.x, "and outboard of the shoulder");

  // Legs run from the hips down to the drawn feet at (50,88) and (78,88).
  assert.ok(Math.abs(joints.ankleLeft.x - 50) < 6, `left ankle at ${joints.ankleLeft.x}`);
  assert.ok(Math.abs(joints.ankleRight.x - 78) < 6, `right ankle at ${joints.ankleRight.x}`);
  assert.ok(joints.hipLeft.y < joints.kneeLeft.y, "the left knee is below the hip");
  assert.ok(joints.kneeLeft.y < joints.ankleLeft.y, "and above the ankle");
  assert.ok(joints.hipRight.y < joints.kneeRight.y, "the right knee is below the hip");
  assert.ok(joints.kneeRight.y < joints.ankleRight.y, "and above the ankle");

  // Left and right never cross over.
  assert.ok(joints.wristLeft.x < joints.wristRight.x);
  assert.ok(joints.ankleLeft.x < joints.ankleRight.x);
});

test("arms held straight out are rigged along the arm, not across the body", () => {
  const detection = detectFigure([...ARMS_OUT, ...LEGS]);
  const joints = toPixels(detection.keypoints);

  assert.equal(detection.present, true);
  assert.equal(detection.limbs.arms, 2);

  // Hands are drawn at (34,26) and (94,26), out at shoulder height.
  assert.ok(Math.abs(joints.wristLeft.x - 34) < 6, `left wrist at ${joints.wristLeft.x}`);
  assert.ok(Math.abs(joints.wristRight.x - 94) < 6, `right wrist at ${joints.wristRight.x}`);
  assert.ok(Math.abs(joints.wristLeft.y - 26) < 8, "the left hand stays at shoulder height");
  assert.ok(Math.abs(joints.wristRight.y - 26) < 8, "the right hand stays at shoulder height");

  // The elbow sits between shoulder and wrist rather than at either end.
  assert.ok(joints.wristLeft.x < joints.elbowLeft.x && joints.elbowLeft.x < joints.neck.x);
  assert.ok(joints.wristRight.x > joints.elbowRight.x && joints.elbowRight.x > joints.neck.x);
});

test("hands raised overhead are still hands, and the head is still the head", () => {
  const detection = detectFigure([...ARMS_UP, ...LEGS]);
  const joints = toPixels(detection.keypoints);

  assert.equal(detection.present, true);
  assert.equal(detection.limbs.arms, 2);

  // The hands reach higher than the head, so the topmost point of the whole
  // silhouette is a hand. The head is the one nearest the body's axis.
  assert.ok(Math.abs(joints.head.x - 64) < 6, `head at ${joints.head.x}`);
  assert.ok(joints.wristLeft.x < joints.head.x, "the left hand is off to one side");
  assert.ok(joints.wristRight.x > joints.head.x, "the right hand to the other");
  assert.ok(joints.wristLeft.y < joints.neck.y, "hands are raised above the neck");
  assert.ok(joints.wristRight.y < joints.neck.y);
});

test("an arm the silhouette has swallowed is left out of the rig", () => {
  // Only the right arm is drawn; the left is flat against the body.
  const detection = detectFigure([ARMS_DOWN[1], ...LEGS]);
  const joints = toPixels(detection.keypoints);

  assert.equal(detection.present, true);
  assert.deepEqual(detection.limbs, { arms: 1, legs: 2 });

  // The missing arm is null rather than a stub drawn off the shoulder corner.
  assert.equal(joints.wristLeft, null);
  assert.equal(joints.elbowLeft, null);
  assert.ok(joints.wristRight, "the visible arm is still rigged");
  assert.ok(joints.shoulderLeft, "the shoulder itself is still placed");
});

test("the rig survives a body with no limbs to find", () => {
  // A head and shoulders filling the frame: no arms, no legs, no crash.
  const detection = detectFigure([]);

  assert.ok(detection.keypoints, "a torso still rigs");
  assert.equal(detection.keypoints.head !== null, true);
  assert.equal(detection.limbs.arms, 0);
  assert.equal(detection.limbs.legs, 0);
});

test("a body that stops moving stays in the silhouette for a moment", () => {
  const detector = pose.createPoseDetector();
  const bones = [...ARMS_DOWN, ...LEGS];

  // Two frames of movement put the whole figure into the silhouette.
  detector.detect(createFrame(paintFigure(bones, 0)));
  const moving = detector.detect(createFrame(paintFigure(bones, 2)));
  assert.ok(moving.box.height > 0.8, `moving box height ${moving.box.height}`);

  // Now the figure holds perfectly still. Frame differencing alone would drop
  // everything but the skin, taking the legs and the rig with it.
  const held = detector.detect(createFrame(paintFigure(bones, 2)));
  assert.ok(held.box.height > 0.8, `held box height ${held.box.height}`);
  assert.equal(held.limbs.legs, 2);

  // The memory fades, so a body that never moves again does not linger forever.
  let faded = held;
  for (let frame = 0; frame < 12; frame += 1) {
    faded = detector.detect(createFrame(paintFigure(bones, 2)));
  }
  assert.ok(faded.box.height < 0.5, `faded box height ${faded.box.height}`);
});

test("the stateless entry point still works with no memory at all", () => {
  const bones = [...ARMS_DOWN, ...LEGS];
  const previous = pose.analyzeFrame(createFrame(paintFigure(bones, 0)));
  const detection = pose.analyzeFrame(createFrame(paintFigure(bones, 2)), {
    previousLuma: previous.luma,
  });

  assert.equal(detection.present, true);
  assert.equal(detection.limbs.legs, 2);
});

test("tracking waits for a repeat sighting before reporting someone present", () => {
  const tracker = pose.createPoseTracker({ enterFrames: 2, holdMs: 4000 });
  const seen = { present: true, confidence: 0.9, pose: "standing", keypoints: {}, box: {} };

  // One frame is a reflection; two in a row is a person.
  assert.equal(tracker.update(seen, 0).present, false);
  assert.equal(tracker.update(seen, 250).present, true);
});

test("a brief occlusion does not drop the tracked pose", () => {
  const tracker = pose.createPoseTracker({ enterFrames: 2, holdMs: 4000 });
  const seen = { present: true, confidence: 0.9, pose: "standing", keypoints: {}, box: {} };
  const missed = { present: false, confidence: 0.1, pose: "none", keypoints: null, box: null };

  tracker.update(seen, 0);
  tracker.update(seen, 250);

  // Turning away for a couple of seconds keeps the person tracked …
  assert.equal(tracker.update(missed, 1000).present, true);
  assert.equal(tracker.update(missed, 4000).present, true);

  // … but once the hold elapses they are gone, and the keypoints go with them.
  const gone = tracker.update(missed, 4300);
  assert.equal(gone.present, false);
  assert.equal(gone.keypoints, null);
  assert.equal(gone.pose, "none");

  // Re-entering starts the two-frame count again.
  assert.equal(tracker.update(seen, 4500).present, false);
  assert.equal(tracker.update(seen, 4750).present, true);
});

test("tracked confidence is smoothed rather than jumping frame to frame", () => {
  const tracker = pose.createPoseTracker({ smoothing: 0.4 });
  const seen = { present: true, confidence: 1, pose: "standing", keypoints: {}, box: {} };

  const first = tracker.update(seen, 0).confidence;
  const second = tracker.update(seen, 250).confidence;

  assert.equal(first, 0.4);
  assert.ok(second > first && second < 1);
});

test("the tracker reports how long a person has been in frame", () => {
  const tracker = pose.createPoseTracker({ enterFrames: 1 });
  const seen = { present: true, confidence: 0.9, pose: "standing", keypoints: {}, box: {} };

  tracker.update(seen, 1000);
  assert.equal(tracker.update(seen, 4000).sinceMs, 3000);
});
