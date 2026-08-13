const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const modelPath = resolve(__dirname, "..", "pose-model.js");

function loadModelHarness(options = {}) {
  const calls = {
    buildCrowd: [],
    close: [],
    face: [],
    fileset: [],
    hands: [],
    objects: [],
    pose: [],
  };
  let now = options.now ?? 2500;
  let poseLandmarks = options.poseLandmarks || [[{ x: 0.5, y: 0.5 }]];

  const poseDetector = {
    detect(video) {
      calls.poseDetectVideo = video;
      return { landmarks: poseLandmarks };
    },
    close() {
      calls.close.push("pose");
    },
  };
  const objectDetector = {
    detect(video) {
      calls.objectDetectVideo = video;
      return { detections: [{ category: "car" }] };
    },
    close() {
      calls.close.push("objects");
    },
  };
  const faceDetector = {
    detect(video) {
      calls.faceDetectVideo = video;
      return { faceLandmarks: [[{ x: 0.4, y: 0.3 }], null] };
    },
    close() {
      calls.close.push("faces");
    },
  };
  const handDetector = {
    detect(video) {
      calls.handDetectVideo = video;
      return { landmarks: [[{ x: 0.2, y: 0.2 }]] };
    },
    close() {
      calls.close.push("hands");
    },
  };

  const FaceLandmarker = {
    FACE_LANDMARKS_FACE_OVAL: [[0, 1]],
    FACE_LANDMARKS_LEFT_EYEBROW: [[1, 2]],
    FACE_LANDMARKS_RIGHT_EYEBROW: [[2, 3]],
    FACE_LANDMARKS_LEFT_EYE: [[3, 4]],
    FACE_LANDMARKS_RIGHT_EYE: [[4, 5]],
    FACE_LANDMARKS_LEFT_IRIS: [[5, 6]],
    FACE_LANDMARKS_RIGHT_IRIS: [[6, 7]],
    FACE_LANDMARKS_LIPS: [[7, 8]],
    async createFromOptions(fileset, configuration) {
      calls.face.push({ fileset, configuration });
      if (options.faceFailure) throw options.faceFailure;
      return faceDetector;
    },
  };
  const HandLandmarker = {
    HAND_CONNECTIONS: [[0, 1]],
    async createFromOptions(fileset, configuration) {
      calls.hands.push({ fileset, configuration });
      if (options.handFailure) throw options.handFailure;
      return handDetector;
    },
  };
  const ObjectDetector = {
    async createFromOptions(fileset, configuration) {
      calls.objects.push({ fileset, configuration });
      if (options.objectFailure) throw options.objectFailure;
      return objectDetector;
    },
  };
  const PoseLandmarker = {
    async createFromOptions(fileset, configuration) {
      calls.pose.push({ fileset, configuration });
      if (options.gpuFailure && configuration.baseOptions.delegate === "GPU") {
        throw options.gpuFailure;
      }
      return poseDetector;
    },
  };
  const FilesetResolver = {
    async forVisionTasks(path) {
      calls.fileset.push(path);
      return { path };
    },
  };
  const mapping = options.mapping === null
    ? null
    : {
        buildCrowd(poses, vehicles, extra) {
          const result = { poses, vehicles, extra };
          calls.buildCrowd.push(result);
          return result;
        },
        readPeople(result) {
          calls.readPeople = result;
          return 2;
        },
        readVehicles(result, width, height) {
          calls.readVehicles = { result, width, height };
          return [{ present: true, label: "car" }];
        },
        toFaceOutlines(face, connections) {
          calls.faceOutline = { face, connections };
          return face ? { oval: [[face[0], face[0]]] } : null;
        },
        toHands(result, connections) {
          calls.handMapping = { result, connections };
          return [{ side: "left", points: result.landmarks[0], segments: [] }];
        },
      };
  const window = { StampNotePoseMapping: mapping };
  const context = vm.createContext({
    MediaPipeFakes: { FaceLandmarker, FilesetResolver, HandLandmarker, ObjectDetector, PoseLandmarker },
    performance: { now: () => now },
    window,
  });
  const source = readFileSync(modelPath, "utf8").replace(
    /import \{\n  FaceLandmarker,\n  FilesetResolver,\n  HandLandmarker,\n  ObjectDetector,\n  PoseLandmarker,\n\} from "\.\/vendor\/mediapipe\/vision_bundle\.mjs";/,
    "const {\n  FaceLandmarker,\n  FilesetResolver,\n  HandLandmarker,\n  ObjectDetector,\n  PoseLandmarker,\n} = MediaPipeFakes;",
  );
  assert.doesNotMatch(source, /^import /m);
  vm.runInContext(source, context, { filename: modelPath });

  return {
    calls,
    model: window.StampNoteModel,
    setNow(value) {
      now = value;
    },
    setPoses(value) {
      poseLandmarks = value;
    },
  };
}

test("the MediaPipe adapter caches expensive models by cadence and clears stale body parts", async () => {
  const harness = loadModelHarness();
  const adapter = await harness.model.load();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(adapter.kind, "model");
  assert.equal(adapter.wantsVideo, true);
  assert.deepEqual(harness.calls.fileset, ["./vendor/mediapipe/wasm"]);
  assert.equal(harness.calls.pose[0].configuration.baseOptions.delegate, "GPU");
  assert.equal(harness.calls.pose[0].configuration.numPoses, 4);
  assert.equal(harness.calls.objects[0].configuration.maxResults, 8);
  assert.equal(harness.calls.face[0].configuration.numFaces, 4);
  assert.equal(harness.calls.hands[0].configuration.numHands, 4);

  const emptyVideo = adapter.detect({ videoWidth: 0 });
  assert.equal(emptyVideo.poses.length, 0);

  const video = { videoWidth: 1280, videoHeight: 720 };
  const first = adapter.detect(video);
  assert.equal(first.poses.length, 1);
  assert.equal(first.vehicles[0].label, "car");
  assert.equal(first.extra.person, 2);
  assert.equal(first.extra.faces.length, 1);
  assert.equal(first.extra.hands.length, 1);
  assert.equal(harness.calls.readVehicles.width, 1280);
  assert.equal(harness.calls.readVehicles.height, 720);

  harness.setNow(2600);
  adapter.detect(video);
  assert.equal(harness.calls.faceDetectVideo, video);
  assert.equal(harness.calls.objects.length, 1, "the model is created once");
  assert.equal(harness.calls.buildCrowd.length, 3);

  harness.setPoses([]);
  harness.setNow(2700);
  const noBody = adapter.detect(video);
  assert.equal(noBody.extra.faces.length, 0);
  assert.equal(noBody.extra.hands.length, 0);
  assert.equal(noBody.extra.person, 2, "the slower object reading remains cached");

  adapter.reset();
  harness.setNow(5000);
  adapter.detect(video);
  adapter.close();
  assert.deepEqual(harness.calls.close.sort(), ["faces", "hands", "objects", "pose"]);
});

test("pose loading retries on CPU and optional model failures do not block capture", async () => {
  const harness = loadModelHarness({
    gpuFailure: new Error("WebGL unavailable"),
    objectFailure: new Error("object model unavailable"),
    faceFailure: new Error("face model unavailable"),
    handFailure: new Error("hand model unavailable"),
  });
  const adapter = await harness.model.load();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.calls.pose.length, 2);
  assert.equal(harness.calls.pose[0].configuration.baseOptions.delegate, "GPU");
  assert.equal(harness.calls.pose[1].configuration.baseOptions.delegate, undefined);
  const result = adapter.detect({ videoWidth: 640, videoHeight: 480 });
  assert.equal(result.vehicles.length, 0);
  assert.equal(result.extra.faces.length, 0);
  assert.equal(result.extra.hands.length, 0);
});

test("worker onboarding can scan a close face without requiring a full body pose", async () => {
  const harness = loadModelHarness();
  const scanner = await harness.model.loadFaceScanner();
  const video = { videoWidth: 720, videoHeight: 1280 };
  const result = scanner.detect(video);

  assert.equal(result.bodies.length, 1);
  assert.ok(result.bodies[0].face);
  assert.equal(harness.calls.pose.length, 0, "the onboarding scanner does not load pose");
  assert.equal(harness.calls.face[0].configuration.numFaces, 2);
  scanner.close();
  assert.deepEqual(harness.calls.close, ["faces"]);
});

test("pose loading fails clearly when the mapping layer is absent", async () => {
  const harness = loadModelHarness({ mapping: null });
  await assert.rejects(harness.model.load(), /pose mapping is missing/);
  assert.equal(harness.calls.fileset.length, 0);
});
