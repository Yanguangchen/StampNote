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
const TYRE = [35, 35, 38];

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

// The detector learns the room first, the way it does on a real camera, and the
// subject is then whatever fails to match it. Two frames of the subject, shifted,
// so there is movement as well as presence.
function detectFigure(bones, options = {}) {
  const detector = pose.createPoseDetector();

  detector.detect(createFrame(emptyRoom));
  detector.detect(createFrame(paintFigure(bones, 0)));

  return detector.detect(createFrame(paintFigure(bones, options.shift ?? 2)));
}

// Whatever the painter draws, introduced into a room the detector already knows.
function detectAgainstRoom(painter, frames = 3) {
  const detector = pose.createPoseDetector();
  let detection = detector.detect(createFrame(emptyRoom));

  for (let step = 0; step < frames; step += 1) {
    detection = detector.detect(createFrame(painter(step)));
  }

  return detection;
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
  const detection = detectAgainstRoom(() => emptyRoom);

  assert.equal(detection.present, false);
  assert.equal(detection.confidence, 0);
  assert.equal(detection.keypoints, null);
  assert.equal(detection.pose, "none");
  assert.equal(detection.subject, "none");
});

test("a person in frame is found, with keypoints in anatomical order", () => {
  const detector = pose.createPoseDetector();
  detector.detect(createFrame(emptyRoom));
  detector.detect(createFrame(paintPerson(0)));
  const detection = detector.detect(createFrame(paintPerson(2)));

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

test("a person who stops moving is still there", () => {
  // Movement is what reveals somebody, but it is not what keeps them: they are
  // compared against the room, and standing still does not turn them into it.
  const detector = pose.createPoseDetector();

  detector.detect(createFrame(emptyRoom));
  detector.detect(createFrame(paintPerson(0)));
  detector.detect(createFrame(paintPerson(2)));

  let detection = null;
  for (let held = 0; held < 8; held += 1) {
    detection = detector.detect(createFrame(paintPerson(2)));
  }

  assert.equal(detection.present, true);
  assert.equal(detection.motionFraction, 0, "nothing has moved for eight frames");
  assert.ok(detection.box.height > 0.8, `still whole: ${detection.box.height}`);
});

test("a skin-toned slab carried into the room is not a person", () => {
  // A flat of cardboard or a varnished door: the right colour, a plausible size
  // and an upright aspect, but an even width from top to bottom.
  const detection = detectAgainstRoom(
    () => (x, y) => (x >= 44 && x <= 84 && y >= 18 && y <= 78 ? SKIN : ROOM),
  );

  assert.equal(detection.present, false);
  assert.ok(detection.confidence < 0.5, `confidence was ${detection.confidence}`);
});

test("a warm floor is scenery, not a subject", () => {
  // Varnished boards, terracotta, beige carpet: all sit in the same chrominance
  // band as skin. They are also exactly where they were a moment ago, which is
  // what settles it. Getting this wrong put the floor in every silhouette and
  // swallowed anyone standing on it.
  const floor = (x, y) => (y > 60 ? [150, 116, 84] : ROOM);
  const detector = pose.createPoseDetector();

  let detection = null;
  for (let step = 0; step < 6; step += 1) {
    detection = detector.detect(createFrame(floor));
  }

  assert.equal(detection.present, false);
  assert.equal(detection.subject, "none");
  assert.equal(detection.box, null);
});

test("a wall of skin tone is rejected for filling the frame", () => {
  const detection = detectAgainstRoom(() => () => SKIN);

  assert.equal(detection.present, false);
});

test("moving scenery without skin is not a person", () => {
  // Leaves in the wind: plenty of movement, no skin anywhere.
  const detection = detectAgainstRoom(
    (step) => (x, y) => weave(x + step * 2, y, SHIRT_A, SHIRT_B),
  );

  assert.equal(detection.present, false);
});

test("a face hint lifts a detection the silhouette alone would miss", () => {
  const slab = (x, y) => (x >= 44 && x <= 84 && y >= 18 && y <= 78 ? SKIN : ROOM);
  const run = (hints) => {
    const detector = pose.createPoseDetector();
    detector.detect(createFrame(emptyRoom));
    detector.detect(createFrame(slab));
    return detector.detect(createFrame(slab), hints);
  };

  const withoutFace = run();
  // Where Chrome's Shape Detection API is available it reports boxes in the
  // analysed frame's own pixels.
  const withFace = run({ faces: [{ x: 54, y: 20, width: 20, height: 24 }] });

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

test("the stateless entry point works when it is handed the scene", () => {
  // analyzeFrame keeps no state of its own; the caller owns the scene and can
  // hold it wherever it likes. One frame cannot tell a subject from a room, so
  // the first call only learns.
  const scene = pose.createScene(WIDTH * HEIGHT);
  const bones = [...ARMS_DOWN, ...LEGS];

  const learning = pose.analyzeFrame(createFrame(emptyRoom), { scene });
  assert.equal(learning.present, false, "the opening frame is the room");

  const detection = pose.analyzeFrame(createFrame(paintFigure(bones, 2)), { scene });

  assert.equal(detection.present, true);
  assert.equal(detection.limbs.legs, 2);
});

// A car seen from the side: body, cabin on top, two dark wheels, panel shading
// so the paint has texture to move against.
function paintCar(paint, shift = 0, options = {}) {
  const shade = (color, factor) => color.map((value) => Math.round(value * factor));

  return (x, y) => {
    const px = x - shift;

    if (px >= 30 && px <= 98 && y >= 52 && y <= 70) {
      return shade(paint, (px + y) % 8 < 4 ? 1 : 0.82);
    }
    if (options.cabin !== false && px >= 46 && px <= 80 && y >= 40 && y <= 52) {
      return shade(paint, (px + y) % 8 < 4 ? 0.9 : 0.72);
    }
    if ((px - 46) ** 2 + (y - 72) ** 2 <= 36 || (px - 84) ** 2 + (y - 72) ** 2 <= 36) {
      return TYRE;
    }

    return ROOM;
  };
}

// Driving past a room the detector already knows.
function detectCar(paint, options) {
  const detector = pose.createPoseDetector();
  let detection = detector.detect(createFrame(emptyRoom));

  for (let step = 0; step < 6; step += 1) {
    detection = detector.detect(createFrame(paintCar(paint, step * 3, options)));
  }

  return detection;
}

test("a car is called a vehicle, whatever it is painted", () => {
  // Warm paint sits in the same chrominance band as skin — that band is a hue
  // test, and a bronze wing and a forearm share a hue. Cool paint has no skin
  // tone at all and is found by movement alone. Both are cars.
  Object.entries({
    silver: [178, 180, 185],
    white: [225, 225, 228],
    tan: [196, 158, 120],
    gold: [205, 168, 96],
    red: [168, 58, 44],
  }).forEach(([paint, color]) => {
    const detection = detectCar(color);

    assert.equal(detection.subject, "vehicle", `${paint} car`);
    assert.ok(detection.vehicle, `${paint} car has a box`);
    assert.ok(detection.vehicle.confidence >= 0.55, `${paint} car confidence`);

    // The whole point: a vehicle is not a person, so the schedule never hears
    // about it.
    assert.equal(detection.present, false, `${paint} car is not a person`);
  });
});

test("a vehicle reports where it is, so it can be drawn", () => {
  const { vehicle } = detectCar([196, 158, 120]);

  // Normalised, like every other box the detector hands out.
  assert.ok(vehicle.box.x >= 0 && vehicle.box.x <= 1);
  assert.ok(vehicle.box.width > 0.4, `a car spans the frame: ${vehicle.box.width}`);
  assert.ok(vehicle.box.height < vehicle.box.width, "and is wider than it is tall");
  assert.equal(vehicle.wheels, 2);
});

test("a car with no cabin is still a vehicle, not a slab", () => {
  // The cabin is what used to read as a head on shoulders; without one the old
  // scoring rejected the car as nothing at all rather than naming it.
  const detection = detectCar([196, 158, 120], { cabin: false });

  assert.equal(detection.subject, "vehicle");
  assert.equal(detection.present, false);
});

test("people are not mistaken for vehicles", () => {
  [
    [...ARMS_DOWN, ...LEGS],
    [...ARMS_OUT, ...LEGS],
    [...ARMS_UP, ...LEGS],
    [],
  ].forEach((bones, index) => {
    const detection = detectFigure(bones);

    assert.equal(detection.subject, "person", `pose ${index} is a person`);
    assert.equal(detection.vehicle, null, `pose ${index} has no vehicle`);
  });
});

test("a person beside a car is still found, and both are reported", () => {
  // A car scored as a person would not only take a photograph it should not
  // have — standing between the camera and someone, it would be picked over
  // them and cost the photograph that mattered.
  //
  // The person on the left, the car on the right, with clear room between them.
  // Both shift back and forth rather than drifting, so each stays put while
  // still registering as movement.
  const detector = pose.createPoseDetector();
  let detection = detector.detect(createFrame(emptyRoom));

  for (let step = 0; step < 6; step += 1) {
    const sway = (step % 2) * 2;
    const person = paintFigure([...ARMS_DOWN, ...LEGS], sway);
    const car = paintCar([196, 158, 120], sway ? 3 : 0);

    detection = detector.detect(
      createFrame((x, y) => {
        const body = person(x + 44, y);

        return body === ROOM ? car(x - 30, y) : body;
      }),
    );
  }

  assert.equal(detection.present, true, "the person is found");
  assert.equal(detection.subject, "person");
  assert.ok(detection.vehicle, "and the car alongside them");
  assert.ok(
    detection.box.x < detection.vehicle.box.x,
    "they are separate silhouettes, not one blob",
  );
});

test("a tracked vehicle is held and released on its own, apart from people", () => {
  const tracker = pose.createPoseTracker({ enterFrames: 2, holdMs: 4000 });
  const car = { present: false, confidence: 0.1, vehicle: { confidence: 0.9, box: { x: 0.1 } } };
  const empty = { present: false, confidence: 0, vehicle: null };

  assert.equal(tracker.update(car, 0).vehicle.present, false, "one frame is not a vehicle");

  const seen = tracker.update(car, 250);
  assert.equal(seen.vehicle.present, true);
  assert.equal(seen.present, false, "a vehicle never makes a person present");

  // Held through a gap, then released — the same hysteresis people get.
  assert.equal(tracker.update(empty, 1000).vehicle.present, true);
  assert.equal(tracker.update(empty, 4300).vehicle.present, false);
  assert.equal(tracker.update(empty, 4400).vehicle.box, null);
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
