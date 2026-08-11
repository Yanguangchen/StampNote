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

  const { head, shoulderLeft, shoulderRight, torso, hipLeft, hipRight, feet } =
    detection.keypoints;

  // Everything is normalised to 0..1 so an overlay of any size can draw it.
  Object.values(detection.keypoints).forEach((point) => {
    assert.ok(point.x >= 0 && point.x <= 1, "x is normalised");
    assert.ok(point.y >= 0 && point.y <= 1, "y is normalised");
  });

  assert.ok(head.y < torso.y, "the head sits above the torso");
  assert.ok(torso.y < hipLeft.y, "the hips sit below the torso");
  assert.ok(hipLeft.y < feet.y, "the feet sit below the hips");
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
