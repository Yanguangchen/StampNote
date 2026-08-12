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

  // Both hands raised clear above the head. It has to be something nobody does
  // by accident in front of a camera that is already photographing them, and it
  // has to be readable from the body alone, so it still works before the hand
  // model has finished downloading.
  function isCaptureGesture(keypoints) {
    if (!keypoints?.head || !keypoints.wristLeft || !keypoints.wristRight) {
      return false;
    }

    // Up the picture is towards zero. Both wrists above the crown means a
    // deliberate reach, not a hand brushing past a face.
    return keypoints.wristLeft.y < keypoints.head.y && keypoints.wristRight.y < keypoints.head.y;
  }

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

  // Both hands, each 21 points: wrist, then four joints along every finger. The
  // pose model reports a wrist and three coarse hand points and no fingers at
  // all, so this is the only place they come from.
  function toHands(result, connections) {
    const hands = result?.landmarks || [];

    if (hands.length === 0 || !connections) {
      return [];
    }

    return hands
      .map((points, index) => {
        const handedness = result.handedness?.[index]?.[0];
        const segments = connections
          .map(({ start, end }) => {
            const from = points[start];
            const to = points[end];

            return from && to
              ? [
                  { x: from.x, y: from.y },
                  { x: to.x, y: to.y },
                ]
              : null;
          })
          .filter(Boolean);

        return segments.length === 0
          ? null
          : {
              // The person's own left and right, as the model reports it.
              side: handedness?.categoryName || "unknown",
              confidence: handedness?.score ?? 0,
              points: points.map((point) => ({ x: point.x, y: point.y })),
              segments,
            };
      })
      .filter(Boolean);
  }

  // Detection runs a few times a second; the screen redraws sixty. Easing what
  // is drawn towards the latest reading turns a row of stills into movement,
  // and damps the jitter a per-frame detector always has, without asking the
  // models for a single extra inference.
  //
  // A joint that has just appeared has nothing to ease from, and one that has
  // gone should go at once rather than drift off across the picture — so both
  // take the new value whole.
  function blendPoint(from, to, amount) {
    if (!from || !to) {
      return to || null;
    }

    return {
      x: from.x + (to.x - from.x) * amount,
      y: from.y + (to.y - from.y) * amount,
    };
  }

  function blendKeypoints(from, to, amount) {
    if (!from || !to) {
      return to || null;
    }

    return Object.fromEntries(
      Object.entries(to).map(([joint, point]) => [joint, blendPoint(from[joint], point, amount)]),
    );
  }

  // Outlines and hands are lists of segments, which only line up frame to frame
  // while the model reports the same number of them.
  function blendSegments(from, to, amount) {
    if (!from || !to) {
      return to || null;
    }

    return Object.fromEntries(
      Object.entries(to).map(([feature, edges]) => {
        const previous = from[feature];

        if (!previous || previous.length !== edges.length) {
          return [feature, edges];
        }

        return [
          feature,
          edges.map(([start, end], index) => [
            blendPoint(previous[index][0], start, amount),
            blendPoint(previous[index][1], end, amount),
          ]),
        ];
      }),
    );
  }

  function blendHands(from, to, amount) {
    if (!from || !to) {
      return to || [];
    }

    return to.map((hand) => {
      const previous = from.find((entry) => entry.side === hand.side);

      if (!previous || previous.segments.length !== hand.segments.length) {
        return hand;
      }

      return {
        ...hand,
        points: hand.points.map((point, index) => blendPoint(previous.points[index], point, amount)),
        segments: hand.segments.map(([start, end], index) => [
          blendPoint(previous.segments[index][0], start, amount),
          blendPoint(previous.segments[index][1], end, amount),
        ]),
      };
    });
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

  // ---------------------------------------------------------------------------
  // More than one person
  //
  // The model reports several poses per frame, in no fixed order. Everything
  // below is about keeping them apart: whose face is whose, whose hands are
  // whose, and which of last frame's bodies each of this frame's is.

  function centerOf(box) {
    return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
  }

  function distanceBetween(left, right) {
    if (!left || !right) {
      return Infinity;
    }

    return Math.hypot(left.x - right.x, left.y - right.y);
  }

  // Faces and hands come back as their own lists with nothing tying them to a
  // body, so each one goes to the nearest joint it belongs to — a face to a
  // head, a hand to a wrist — and only if it is close enough to be plausible.
  function nearestBody(bodies, point, joints, reach) {
    let best = null;
    let bestDistance = reach;

    bodies.forEach((body, index) => {
      joints.forEach((joint) => {
        const distance = distanceBetween(body.keypoints?.[joint], point);

        if (distance < bestDistance) {
          best = index;
          bestDistance = distance;
        }
      });
    });

    return best;
  }

  function centroidOf(segments) {
    const points = (segments || []).flat();

    if (points.length === 0) {
      return null;
    }

    return {
      x: points.reduce((total, point) => total + point.x, 0) / points.length,
      y: points.reduce((total, point) => total + point.y, 0) / points.length,
    };
  }

  // Reach scales with the body, so a person close to the camera can have a face
  // further from their head in frame terms than one standing at the back.
  function reachOf(body) {
    const box = body.box;
    return box ? Math.max(0.08, Math.max(box.width, box.height) * 0.4) : 0.12;
  }

  function attachParts(bodies, faces = [], hands = []) {
    const taken = new Set();

    faces.forEach((face) => {
      const index = nearestBody(bodies, centroidOf(face), ["head", "neck"], 0.25);

      if (index !== null && !taken.has(index)) {
        taken.add(index);
        bodies[index].face = face;
      }
    });

    hands.forEach((hand) => {
      const wrist = hand.points?.[0];
      const index = nearestBody(bodies, wrist, ["wristLeft", "wristRight"], 0.2);

      if (index !== null) {
        bodies[index].hands = [...bodies[index].hands, hand];
      }
    });

    return bodies;
  }

  // Which of last frame's bodies is which of this frame's, so the easing walks
  // each person towards their own next position rather than smearing one across
  // the room into another. Greedy nearest-centre, and a body with nobody near
  // enough is somebody who has just walked in.
  function matchBodies(previous = [], next = []) {
    const claimed = new Set();

    return next.map((body) => {
      const here = centerOf(body.box);
      let best = null;
      let bestDistance = Infinity;

      previous.forEach((earlier, index) => {
        if (claimed.has(index)) {
          return;
        }

        const distance = distanceBetween(centerOf(earlier.box), here);

        if (distance < bestDistance && distance <= reachOf(body)) {
          best = index;
          bestDistance = distance;
        }
      });

      if (best !== null) {
        claimed.add(best);
        return previous[best];
      }

      return null;
    });
  }

  function blendBodies(from, to = [], amount = 1) {
    const matched = matchBodies(from || [], to);

    return to.map((body, index) => {
      const earlier = matched[index];

      // Nobody to ease from: a new arrival is drawn where they are rather than
      // sliding in from wherever somebody else was standing.
      if (!earlier) {
        return body;
      }

      return {
        ...body,
        keypoints: blendKeypoints(earlier.keypoints, body.keypoints, amount),
        face: blendSegments(earlier.face, body.face, amount),
        hands: blendHands(earlier.hands, body.hands, amount),
      };
    });
  }

  // One rigged person, from one pose's landmarks.
  function toBody(landmarks, corroboration = {}) {
    const keypoints = toKeypoints(landmarks);
    const confidence = trunkConfidence(landmarks);

    return {
      present: isPresent(confidence, corroboration),
      confidence,
      keypoints,
      box: boundsOf(keypoints),
      limbs: countLimbs(keypoints),
      pose: describePosture(keypoints),
      face: null,
      hands: [],
    };
  }

  function byConfidence(left, right) {
    return right.confidence - left.confidence;
  }

  // `present` stays the answer to "is there a person", and it alone reaches the
  // capture schedule. A vehicle rides alongside it, never instead of it.
  function buildDetection(landmarks, vehicles = [], extra = {}) {
    const vehicle = vehicles[0] || null;
    const face = extra.face || null;
    const hands = extra.hands || [];

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
        hands: [],
        bodies: [],
        people: 0,
        vehicle,
        vehicles: vehicles.length,
      };
    }

    const keypoints = toKeypoints(landmarks);
    const confidence = trunkConfidence(landmarks);
    const present = isPresent(confidence, { face, person: extra.person });
    const body = present
      ? { present, confidence, keypoints, box: boundsOf(keypoints), limbs: countLimbs(keypoints), pose: describePosture(keypoints), face, hands }
      : null;

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
      hands: present ? hands : [],
      bodies: body ? [body] : [],
      people: body ? 1 : 0,
      vehicle,
      vehicles: vehicles.length,
    };
  }

  // Every pose in the frame, rigged and counted. The flat fields carry the
  // clearest person so the schedule, the stamp and the gesture shutter keep
  // reading exactly what they read when only one person could be seen; the
  // crowd rides alongside in `bodies`, and `people` is how many there are.
  function buildCrowd(poses = [], vehicles = [], extra = {}) {
    const vehicle = vehicles[0] || null;
    const seen = (poses || []).filter((landmarks) => landmarks && landmarks.length > 0);

    // Each pose is judged on its own confidence. A second person half out of
    // frame does not get waved through on the strength of the first.
    const bodies = attachParts(
      seen
        .map((landmarks) => toBody(landmarks, { person: extra.person }))
        .filter((body) => body.present)
        .sort(byConfidence),
      extra.faces || [],
      extra.hands || [],
    );

    const lead = bodies[0] || null;

    return {
      present: Boolean(lead),
      subject: lead ? "person" : vehicle ? "vehicle" : "none",
      confidence: lead ? lead.confidence : 0,
      pose: lead ? lead.pose : "none",
      keypoints: lead ? lead.keypoints : null,
      box: lead ? lead.box : null,
      limbs: lead ? lead.limbs : { arms: 0, legs: 0 },
      face: lead ? lead.face : null,
      hands: lead ? lead.hands : [],
      bodies,
      people: bodies.length,
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
    attachParts,
    blendBodies,
    blendHands,
    blendKeypoints,
    blendPoint,
    blendSegments,
    boundsOf,
    buildCrowd,
    buildDetection,
    matchBodies,
    countLimbs,
    describePosture,
    isCaptureGesture,
    isPresent,
    toBody,
    readPeople,
    readVehicles,
    toFaceOutlines,
    toHands,
    toKeypoints,
    trunkConfidence,
  });

  globalScope.StampNotePoseMapping = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
