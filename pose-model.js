// Loads MediaPipe's pose landmarker and object detector and dresses them as the
// detector the rest of the app already talks to, so the tracker, the capture
// schedule, the overlay and the store all keep working unchanged. The mapping
// itself lives in pose-mapping.js, where it can be tested without a browser.
//
// The files are vendored under vendor/mediapipe and never fetched from a CDN,
// so the watch still runs with no network and nothing about its use leaves the
// device. See vendor/mediapipe/README.md for versions and licence.
import {
  FilesetResolver,
  ObjectDetector,
  PoseLandmarker,
} from "./vendor/mediapipe/vision_bundle.mjs";

const BASE = "./vendor/mediapipe";

function createAdapter(landmarker) {
  const mapping = window.StampNotePoseMapping;
  let objects = null;
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

    detect(video) {
      if (!video?.videoWidth) {
        return mapping.buildDetection(null, []);
      }

      // MediaPipe rejects a timestamp that has not moved on.
      const timestamp = Math.max(lastTimestamp + 1, Math.round(performance.now()));
      lastTimestamp = timestamp;

      const pose = landmarker.detectForVideo(video, timestamp);
      const vehicles = objects
        ? mapping.readVehicles(
            objects.detectForVideo(video, timestamp),
            video.videoWidth,
            video.videoHeight,
          )
        : [];

      return mapping.buildDetection(pose?.landmarks?.[0], vehicles);
    },

    reset() {
      lastTimestamp = -1;
    },

    close() {
      landmarker?.close?.();
      objects?.close?.();
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

  ObjectDetector.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: `${BASE}/models/efficientdet_lite0.tflite` },
    runningMode: "VIDEO",
    scoreThreshold: window.StampNotePoseMapping.VEHICLE_SCORE,
    maxResults: 6,
  })
    .then((detector) => adapter.attachObjectDetector(detector))
    .catch(() => {
      // People are still tracked; nothing simply gets labelled a vehicle.
    });

  return adapter;
}

window.StampNoteModel = Object.freeze({ load });
