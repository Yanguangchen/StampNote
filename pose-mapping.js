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

  // COCO's classes, narrowed to things with wheels that carry people. The bar is
  // set high because a wrong label is drawn over the picture and believed: a
  // detector asked for its opinion at 0.4 will name something in an empty room.
  const VEHICLES = Object.freeze(["car", "truck", "bus", "motorcycle"]);
  const VEHICLE_SCORE = 0.6;

  // A box covering nearly the whole frame is the detector shrugging, not a lorry
  // parked against the lens.
  const VEHICLE_MAX_AREA = 0.85;

  // In video the pose landmarker detects once and then tracks, so a pose it
  // locked onto by mistake is reported again on every later frame — the reading
  // has to be earned each time rather than taken on the landmarks existing at
  // all. A body seen properly reports its trunk at well over 0.9; anything in
  // the middle needs a second opinion.
  const PRESENT_CONFIDENCE = 0.8;
  const CORROBORATED_CONFIDENCE = 0.55;
  const PERSON_SCORE = 0.45;

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
  // the last ones to be occluded. A landmark that carries no score at all counts
  // as nothing — reading a missing number as full confidence is how a phantom
  // pose gets waved through at maximum certainty.
  function trunkConfidence(landmarks) {
    const trunk = [
      LANDMARK.shoulderLeft,
      LANDMARK.shoulderRight,
      LANDMARK.hipLeft,
      LANDMARK.hipRight,
    ].map((index) => {
      const value = landmarks?.[index]?.visibility;
      return typeof value === "number" ? value : 0;
    });

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
        if ((box.width / width) * (box.height / height) > VEHICLE_MAX_AREA) {
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

  // The object detector's own opinion on whether anybody is there. It detects
  // afresh on every frame rather than tracking, so it does not inherit a
  // mistake the way the landmarker can.
  function readPeople(detections) {
    return (detections?.detections || []).filter((detection) => {
      const best = detection.categories?.[0];
      return best?.categoryName === "person" && best.score >= PERSON_SCORE;
    }).length;
  }

  // The face as outlines rather than the full mesh: the tesselation is 2,556
  // edges, which at any size that fits on a phone is a grey smear, while the
  // oval, brows, eyes, irises and lips read as a face.
  //
  // Which point joins which comes from MediaPipe itself — `FACE_LANDMARKS_LIPS`
  // and its siblings, passed in by the loader — rather than indices written out
  // here by hand. There are 478 of them and no way to eyeball a wrong one.
  function toFaceOutlines(faceLandmarks, connections) {
    if (!faceLandmarks || faceLandmarks.length === 0 || !connections) {
      return null;
    }

    const trace = (edges) =>
      (edges || [])
        .map(({ start, end }) => {
          const from = faceLandmarks[start];
          const to = faceLandmarks[end];

          return from && to
            ? [
                { x: from.x, y: from.y },
                { x: to.x, y: to.y },
              ]
            : null;
        })
        .filter(Boolean);

    const outlines = Object.fromEntries(
      Object.entries(connections).map(([feature, edges]) => [feature, trace(edges)]),
    );

    return Object.values(outlines).every((edges) => edges.length === 0) ? null : outlines;
  }

  // Two ways to be sure enough: the pose is plainly a body, or it is arguable and
  // something else agrees — a face where the head should be, or the object
  // detector naming a person. One model tracking a ghost cannot satisfy either.
  function isPresent(confidence, corroboration = {}) {
    if (confidence >= PRESENT_CONFIDENCE) {
      return true;
    }

    const seconded = Boolean(corroboration.face) || Boolean(corroboration.person);
    return seconded && confidence >= CORROBORATED_CONFIDENCE;
  }

  // `present` stays the answer to "is there a person", and it alone reaches the
  // capture schedule. A vehicle rides alongside it, never instead of it.
  function buildDetection(landmarks, vehicles = [], extra = {}) {
    const vehicle = vehicles[0] || null;
    const face = extra.face || null;

    if (!landmarks || landmarks.length === 0) {
      return {
        present: false,
        subject: vehicle ? "vehicle" : "none",
        confidence: 0,
        pose: "none",
        keypoints: null,
        box: null,
        limbs: { arms: 0, legs: 0 },
        face: null,
        vehicle,
        vehicles: vehicles.length,
      };
    }

    const keypoints = toKeypoints(landmarks);
    const confidence = trunkConfidence(landmarks);
    const present = isPresent(confidence, { face, person: extra.person });

    return {
      present,
      subject: present ? "person" : vehicle ? "vehicle" : "none",
      confidence,
      pose: present ? describePosture(keypoints) : "none",
      // A pose that did not convince is not drawn either, so the picture never
      // shows a skeleton the schedule is ignoring.
      keypoints: present ? keypoints : null,
      box: present ? boundsOf(keypoints) : null,
      limbs: present ? countLimbs(keypoints) : { arms: 0, legs: 0 },
      face: present ? face : null,
      vehicle,
      vehicles: vehicles.length,
    };
  }

  const api = Object.freeze({
    LANDMARK,
    CORROBORATED_CONFIDENCE,
    PERSON_SCORE,
    PRESENT_CONFIDENCE,
    VEHICLES,
    VEHICLE_MAX_AREA,
    VEHICLE_SCORE,
    VISIBLE,
    boundsOf,
    buildDetection,
    countLimbs,
    describePosture,
    isPresent,
    readPeople,
    readVehicles,
    toFaceOutlines,
    toKeypoints,
    trunkConfidence,
  });

  globalScope.StampNotePoseMapping = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
