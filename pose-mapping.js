(function initializePoseMapping(globalScope) {
  "use strict";

  // Turns what MediaPipe reports into what the rest of StampNote already speaks:
  // the same joint names the overlay draws, the same detection shape the tracker
  // and the capture schedule read. Kept apart from the loader so it is ordinary
  // testable code rather than something that can only run once a browser has
  // eleven megabytes of WebAssembly in hand.
  //
  // MediaPipe's left and right are the person's own, which is more than the
  // silhouette detector could ever know — it only had the left and right of the
  // picture.
  const LANDMARK = Object.freeze({
    nose: 0,
    earLeft: 7,
    earRight: 8,
    shoulderLeft: 11,
    shoulderRight: 12,
    elbowLeft: 13,
    elbowRight: 14,
    wristLeft: 15,
    wristRight: 16,
    hipLeft: 23,
    hipRight: 24,
    kneeLeft: 25,
    kneeRight: 26,
    ankleLeft: 27,
    ankleRight: 28,
  });

  // Below this MediaPipe is guessing where a limb went rather than seeing it,
  // and a guessed elbow draws a bone through thin air.
  const VISIBLE = 0.5;

  // COCO's classes, narrowed to things with wheels that carry people.
  const VEHICLES = Object.freeze(["car", "truck", "bus", "motorcycle"]);
  const VEHICLE_SCORE = 0.4;

  function midpoint(left, right) {
    if (!left) {
      return right || null;
    }
    if (!right) {
      return left;
    }

    return { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
  }

  function visible(landmarks, index) {
    const point = landmarks?.[index];

    if (!point || (point.visibility !== undefined && point.visibility < VISIBLE)) {
      return null;
    }

    return { x: point.x, y: point.y };
  }

  // The crown, which is where a head looks like it starts. The nose and the ears
  // are all MediaPipe reports up there, and a circle centred on the nose sits
  // over the mouth.
  function crownOf(landmarks, neck) {
    const anchor =
      midpoint(visible(landmarks, LANDMARK.earLeft), visible(landmarks, LANDMARK.earRight)) ||
      visible(landmarks, LANDMARK.nose);

    if (!anchor || !neck) {
      return anchor;
    }

    return {
      x: anchor.x + (anchor.x - neck.x) * 0.35,
      y: anchor.y + (anchor.y - neck.y) * 0.35,
    };
  }

  function toKeypoints(landmarks) {
    const joints = {};

    Object.entries(LANDMARK).forEach(([name, index]) => {
      joints[name] = visible(landmarks, index);
    });

    const neck = midpoint(joints.shoulderLeft, joints.shoulderRight);
    const hips = midpoint(joints.hipLeft, joints.hipRight);

    return {
      head: crownOf(landmarks, neck),
      neck,
      shoulderLeft: joints.shoulderLeft,
      shoulderRight: joints.shoulderRight,
      elbowLeft: joints.elbowLeft,
      elbowRight: joints.elbowRight,
      wristLeft: joints.wristLeft,
      wristRight: joints.wristRight,
      torso: midpoint(neck, hips),
      hipLeft: joints.hipLeft,
      hipRight: joints.hipRight,
      kneeLeft: joints.kneeLeft,
      kneeRight: joints.kneeRight,
      ankleLeft: joints.ankleLeft,
      ankleRight: joints.ankleRight,
    };
  }

  function boundsOf(keypoints) {
    const points = Object.values(keypoints || {}).filter(Boolean);

    if (points.length === 0) {
      return null;
    }

    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);

    return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
  }

  // A limb counts as found when its far joint is, since that is the one a bone
  // is drawn to.
  function countLimbs(keypoints) {
    return {
      arms: Number(Boolean(keypoints.wristLeft)) + Number(Boolean(keypoints.wristRight)),
      legs: Number(Boolean(keypoints.ankleLeft)) + Number(Boolean(keypoints.ankleRight)),
    };
  }

  // Taken from the trunk: the four joints MediaPipe reports most reliably and
  // the last ones to be occluded.
  function trunkConfidence(landmarks) {
    const trunk = [
      LANDMARK.shoulderLeft,
      LANDMARK.shoulderRight,
      LANDMARK.hipLeft,
      LANDMARK.hipRight,
    ].map((index) => landmarks?.[index]?.visibility ?? 1);

    return trunk.reduce((total, value) => total + value, 0) / trunk.length;
  }

  function describePosture(keypoints) {
    const hips = midpoint(keypoints.hipLeft, keypoints.hipRight);
    const ankles = midpoint(keypoints.ankleLeft, keypoints.ankleRight);

    if (!hips || !keypoints.neck) {
      return "partial";
    }
    if (!ankles) {
      return "close-up";
    }

    const trunk = Math.abs(hips.y - keypoints.neck.y) || 0.001;

    // Sitting folds the legs away, so they stop being longer than the trunk.
    return Math.abs(ankles.y - hips.y) < trunk * 0.9 ? "seated" : "standing";
  }

  // Boxes arrive in pixels; everything downstream works in 0..1.
  function readVehicles(detections, width, height) {
    if (!width || !height) {
      return [];
    }

    const found = (detections?.detections || [])
      .map((detection) => {
        const best = detection.categories?.[0];
        const box = detection.boundingBox;

        if (!best || !box || !VEHICLES.includes(best.categoryName)) {
          return null;
        }
        if (best.score < VEHICLE_SCORE) {
          return null;
        }

        return {
          confidence: best.score,
          label: best.categoryName,
          box: {
            x: box.originX / width,
            y: box.originY / height,
            width: box.width / width,
            height: box.height / height,
          },
        };
      })
      .filter(Boolean);

    // Largest first: that is the one worth hanging a label on.
    found.sort(
      (left, right) =>
        right.box.width * right.box.height - left.box.width * left.box.height,
    );

    return found;
  }

  // `present` stays the answer to "is there a person", and it alone reaches the
  // capture schedule. A vehicle rides alongside it, never instead of it.
  function buildDetection(landmarks, vehicles = []) {
    const vehicle = vehicles[0] || null;

    if (!landmarks || landmarks.length === 0) {
      return {
        present: false,
        subject: vehicle ? "vehicle" : "none",
        confidence: 0,
        pose: "none",
        keypoints: null,
        box: null,
        limbs: { arms: 0, legs: 0 },
        vehicle,
        vehicles: vehicles.length,
      };
    }

    const keypoints = toKeypoints(landmarks);

    return {
      present: true,
      subject: "person",
      confidence: trunkConfidence(landmarks),
      pose: describePosture(keypoints),
      keypoints,
      box: boundsOf(keypoints),
      limbs: countLimbs(keypoints),
      vehicle,
      vehicles: vehicles.length,
    };
  }

  const api = Object.freeze({
    LANDMARK,
    VEHICLES,
    VEHICLE_SCORE,
    VISIBLE,
    boundsOf,
    buildDetection,
    countLimbs,
    describePosture,
    readVehicles,
    toKeypoints,
    trunkConfidence,
  });

  globalScope.StampNotePoseMapping = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
