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
  ObjectDetector,
  PoseLandmarker,
} from "./vendor/mediapipe/vision_bundle.mjs";

const BASE = "./vendor/mediapipe";

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
  let lastTimestamp = -1;

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

    detect(video) {
      if (!video?.videoWidth) {
        return mapping.buildDetection(null, []);
      }

      // MediaPipe rejects a timestamp that has not moved on.
      const timestamp = Math.max(lastTimestamp + 1, Math.round(performance.now()));
      lastTimestamp = timestamp;

      const pose = landmarker.detectForVideo(video, timestamp);
      const seen = objects ? objects.detectForVideo(video, timestamp) : null;
      const face = faces
        ? mapping.toFaceOutlines(
            faces.detectForVideo(video, timestamp)?.faceLandmarks?.[0],
            FACE_CONNECTIONS,
          )
        : null;

      return mapping.buildDetection(
        pose?.landmarks?.[0],
        seen ? mapping.readVehicles(seen, video.videoWidth, video.videoHeight) : [],
        { face, person: seen ? mapping.readPeople(seen) : 0 },
      );
    },

    reset() {
      lastTimestamp = -1;
    },

    close() {
      landmarker?.close?.();
      objects?.close?.();
      faces?.close?.();
    },
  };
}

// The GPU delegate is much faster on a phone but wants WebGL2, so a device
// without it drops to CPU rather than to nothing.
async function createLandmarker(fileset) {
  const options = {
    baseOptions: { modelAssetPath: `${BASE}/models/pose_landmarker_lite.task` },
    runningMode: "VIDEO",
    numPoses: 1,
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
    runningMode: "VIDEO",
    scoreThreshold: 0.3,
    maxResults: 8,
  })
    .then((detector) => adapter.attachObjectDetector(detector))
    .catch(() => {
      // People are still tracked; nothing simply gets labelled a vehicle.
    });

  FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: `${BASE}/models/face_landmarker.task` },
    runningMode: "VIDEO",
    numFaces: 1,
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: false,
  })
    .then((detector) => adapter.attachFaceLandmarker(detector))
    .catch(() => {
      // The body is still rigged; there is simply no face drawn on it.
    });

  return adapter;
}

window.StampNoteModel = Object.freeze({ load });
