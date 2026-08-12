// Loads MediaPipe's pose landmarker and object detector and dresses them as the
// detector the rest of the app already talks to, so the tracker, the capture
// schedule, the overlay and the store all keep working unchanged. The mapping
// itself lives in pose-mapping.js, where it can be tested without a browser.
//
// The files are vendored under vendor/mediapipe and never fetched from a CDN,
// so the watch still runs with no network and nothing about its use leaves the
// device. See vendor/mediapipe/README.md for versions and licence.
import {
  FaceLandmarker,
  FilesetResolver,
  HandLandmarker,
  ObjectDetector,
  PoseLandmarker,
} from "./vendor/mediapipe/vision_bundle.mjs";

const BASE = "./vendor/mediapipe";

// Inference is synchronous and runs on the same thread as the drawing, so every
// model asked on a tick is time the overlay cannot move. Measured on a phone
// standing in for the worst case, the object detector is by far the dearest and
// the one whose answer changes slowest — a parked car is still parked two
// seconds later — so it is asked rarely. A face and fingers only mean anything
// on a body, so on an empty scene neither is asked at all, which is the case a
// watch spends most of its life in.
const CADENCE = Object.freeze({
  face: 0,
  hands: 400,
  objects: 2000,
});

// How many people the watch will rig at once. The models run a detector and
// then one landmark pass per person found, so the cost follows how many are
// actually there rather than the cap — an empty room costs the same at four as
// at one. Hands are the dearest of the three and the least missed, so they are
// held to two people's worth while bodies and faces go wider.
const MAX_PEOPLE = 4;
const MAX_HANDS = 4;

// MediaPipe's own answer to which of the 478 points join up. Taken from the
// library rather than written out here, where a wrong index could not be seen.
const FACE_CONNECTIONS = Object.freeze({
  oval: FaceLandmarker.FACE_LANDMARKS_FACE_OVAL,
  browLeft: FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW,
  browRight: FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW,
  eyeLeft: FaceLandmarker.FACE_LANDMARKS_LEFT_EYE,
  eyeRight: FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE,
  irisLeft: FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS,
  irisRight: FaceLandmarker.FACE_LANDMARKS_RIGHT_IRIS,
  lips: FaceLandmarker.FACE_LANDMARKS_LIPS,
});

function createAdapter(landmarker) {
  const mapping = window.StampNotePoseMapping;
  let objects = null;
  let faces = null;
  let hands = null;

  // What each model last said, and when. A model not asked on this tick keeps
  // its previous answer rather than blinking out of the picture.
  const ran = { face: 0, hands: 0, objects: 0 };
  const cached = { faces: [], hands: [], vehicles: [], person: 0 };

  return {
    // The model reads the video element directly, at whatever resolution the
    // camera is giving, rather than the downscaled copy the built-in detector
    // needs.
    wantsVideo: true,
    kind: "model",

    attachObjectDetector(detector) {
      objects = detector;
    },

    attachFaceLandmarker(detector) {
      faces = detector;
    },

    attachHandLandmarker(detector) {
      hands = detector;
    },

    detect(video) {
      if (!video?.videoWidth) {
        return mapping.buildCrowd([], []);
      }

      const now = performance.now();
      const pose = landmarker.detect(video);
      const poses = pose?.landmarks || [];

      if (objects && now - ran.objects >= CADENCE.objects) {
        const seen = objects.detect(video);

        cached.vehicles = mapping.readVehicles(seen, video.videoWidth, video.videoHeight);
        cached.person = mapping.readPeople(seen);
        ran.objects = now;
      }

      if (poses.length === 0) {
        // Nobody to hang them on.
        cached.faces = [];
        cached.hands = [];
      } else {
        if (faces && now - ran.face >= CADENCE.face) {
          cached.faces = (faces.detect(video)?.faceLandmarks || [])
            .map((face) => mapping.toFaceOutlines(face, FACE_CONNECTIONS))
            .filter(Boolean);
          ran.face = now;
        }
        if (hands && now - ran.hands >= CADENCE.hands) {
          cached.hands = mapping.toHands(hands.detect(video), HandLandmarker.HAND_CONNECTIONS);
          ran.hands = now;
        }
      }

      // Every pose the model found, each judged on its own confidence, with the
      // faces and hands handed to whichever body they belong to.
      return mapping.buildCrowd(poses, cached.vehicles, {
        faces: cached.faces,
        hands: cached.hands,
        person: cached.person,
      });
    },

    reset() {
      ran.face = 0;
      ran.hands = 0;
      ran.objects = 0;
      cached.faces = [];
      cached.hands = [];
      cached.vehicles = [];
      cached.person = 0;
    },

    close() {
      landmarker?.close?.();
      objects?.close?.();
      faces?.close?.();
      hands?.close?.();
    },
  };
}

// The GPU delegate is much faster on a phone but wants WebGL2, so a device
// without it drops to CPU rather than to nothing.
async function createLandmarker(fileset) {
  const options = {
    baseOptions: { modelAssetPath: `${BASE}/models/pose_landmarker_lite.task` },
    // Not VIDEO. In video the landmarker detects once and then tracks, and a
    // pose it locked onto by mistake is handed back on every later frame — a
    // phone pointed at a ceiling kept a skeleton across the beams. Looking at
    // each frame afresh puts the model's own detection confidence back in
    // charge every time, and against a ceiling it then reports nothing at all.
    // Tracking is what makes video mode cheaper, and at four frames a second
    // there is little to save.
    runningMode: "IMAGE",
    numPoses: MAX_PEOPLE,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  };

  try {
    return await PoseLandmarker.createFromOptions(fileset, {
      ...options,
      baseOptions: { ...options.baseOptions, delegate: "GPU" },
    });
  } catch {
    return PoseLandmarker.createFromOptions(fileset, options);
  }
}

// The pose model is what the capture schedule depends on, so it is awaited. The
// detector that names vehicles is another four megabytes and nothing waits on
// it, so it arrives when it arrives and starts labelling from then on.
async function load() {
  if (!window.StampNotePoseMapping) {
    throw new Error("The pose mapping is missing.");
  }

  const fileset = await FilesetResolver.forVisionTasks(`${BASE}/wasm`);
  const adapter = createAdapter(await createLandmarker(fileset));

  // Asked at a lower bar than the mapping accepts, so the mapping is the one
  // place a threshold lives and `person` can be read without being drawn.
  ObjectDetector.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: `${BASE}/models/efficientdet_lite0.tflite` },
    runningMode: "IMAGE",
    scoreThreshold: 0.3,
    maxResults: 8,
  })
    .then((detector) => adapter.attachObjectDetector(detector))
    .catch(() => {
      // People are still tracked; nothing simply gets labelled a vehicle.
    });

  FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: `${BASE}/models/face_landmarker.task` },
    runningMode: "IMAGE",
    numFaces: MAX_PEOPLE,
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: false,
  })
    .then((detector) => adapter.attachFaceLandmarker(detector))
    .catch(() => {
      // The body is still rigged; there is simply no face drawn on it.
    });

  // The pose model reports a wrist and three coarse hand points; fingers come
  // only from here. Another seven and a half megabytes, so it follows the others
  // in rather than holding the watch up.
  HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: `${BASE}/models/hand_landmarker.task` },
    runningMode: "IMAGE",
    numHands: MAX_HANDS,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
  })
    .then((detector) => adapter.attachHandLandmarker(detector))
    .catch(() => {
      // Arms still reach the wrist; there are simply no fingers on the end.
    });

  return adapter;
}

window.StampNoteModel = Object.freeze({ load });
