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
  // Tolerant of either line ending: a Windows checkout has CRLF on disk, and a
  // strip that quietly failed there left the whole file unrunnable.
  const source = readFileSync(modelPath, "utf8").replace(
    /import \{\r?\n  FaceLandmarker,\r?\n  FilesetResolver,\r?\n  HandLandmarker,\r?\n  ObjectDetector,\r?\n  PoseLandmarker,\r?\n\} from "\.\/vendor\/mediapipe\/vision_bundle\.mjs";/,
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
  assert.equal(harness.calls.face[0].configuration.numFaces, 4);

  // Twelve megabytes between them, and the opening scan wants neither, so they
  // are not built until a tick asks for more than a body.
  assert.equal(harness.calls.objects.length, 0);
  assert.equal(harness.calls.hands.length, 0);

  const emptyVideo = adapter.detect({ videoWidth: 0 });
  assert.equal(emptyVideo.poses.length, 0);
  assert.equal(harness.calls.objects.length, 0, "a frame with no pixels asks for nothing");

  const video = { videoWidth: 1280, videoHeight: 720 };
  const first = adapter.detect(video);
  assert.equal(first.poses.length, 1);
  assert.equal(first.extra.faces.length, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.calls.objects[0].configuration.maxResults, 8);
  assert.equal(harness.calls.hands[0].configuration.numHands, 4);

  harness.setNow(2600);
  const second = adapter.detect(video);
  assert.equal(second.vehicles[0].label, "car");
  assert.equal(second.extra.person, 2);
  assert.equal(second.extra.hands.length, 1);
  assert.equal(harness.calls.readVehicles.width, 1280);
  assert.equal(harness.calls.readVehicles.height, 720);
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
  // The face model is shared, so it is handed back and closes once the last
  // holder has let go rather than in the same breath as the others.
  await new Promise((resolve) => setImmediate(resolve));
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
  assert.equal(harness.calls.objects.length, 0, "nor anything that names a vehicle");
  // One face model serves both the scan and the recording overlay, so it is
  // built to the wider of the two caps and the stricter of the two bars.
  assert.equal(harness.calls.face[0].configuration.numFaces, 4);
  assert.equal(harness.calls.face[0].configuration.minFaceDetectionConfidence, 0.65);
  scanner.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.calls.close, ["faces"]);
});

test("the opening scan and the overlay share one face model rather than loading two", async () => {
  const harness = loadModelHarness();
  const adapter = await harness.model.load();
  const scanner = await harness.model.loadFaceScanner();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.calls.face.length, 1, "four megabytes fetched and compiled once");
  assert.deepEqual(harness.calls.fileset, ["./vendor/mediapipe/wasm"], "one vision runtime");

  // Whichever finishes first must not take the model away from the other.
  scanner.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.calls.close, [], "the overlay is still holding it");

  const video = { videoWidth: 960, videoHeight: 540 };
  adapter.detect(video);
  assert.equal(harness.calls.faceDetectVideo, video, "the overlay can still read a face");

  adapter.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(harness.calls.close.includes("faces"), "the last holder closes it");

  // Closing twice must not close a model somebody else has since taken out.
  scanner.close();
  adapter.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    harness.calls.close.filter((entry) => entry === "faces").length,
    1,
    "an extra close is harmless",
  );
});

test("a camera stopped mid-load still hands back the face model", async () => {
  const harness = loadModelHarness();
  const adapter = await harness.model.load();

  // Closed before the shared model has arrived: it must still be closed when
  // it lands, rather than left holding a GPU context nothing can reach.
  adapter.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.calls.close.sort(), ["faces", "pose"]);
});

test("the scan asks only for a body, and handing over restores the rest at once", async () => {
  const harness = loadModelHarness();
  const adapter = await harness.model.load();
  await new Promise((resolve) => setImmediate(resolve));
  const video = { videoWidth: 960, videoHeight: 540 };

  // Three scanning ticks: the faces come from the focused scanner, so measuring
  // one here would be work thrown away.
  adapter.detect(video, { poseOnly: true });
  harness.setNow(9000);
  adapter.detect(video, { poseOnly: true });
  harness.setNow(20000);
  const scanning = adapter.detect(video, { poseOnly: true });

  assert.equal(harness.calls.faceDetectVideo, undefined, "no face is measured during the scan");
  assert.equal(harness.calls.handDetectVideo, undefined);
  assert.equal(harness.calls.objectDetectVideo, undefined);
  assert.equal(harness.calls.objects.length, 0, "nor are the optional models even built");
  assert.equal(scanning.poses.length, 1, "the body is still tracked throughout");

  // Handing over asks for everything again straight away, rather than waiting
  // out a cadence measured from before the scan started.
  harness.setNow(20001);
  adapter.detect(video, { poseOnly: false });
  await new Promise((resolve) => setImmediate(resolve));
  harness.setNow(20002);
  const full = adapter.detect(video, { poseOnly: false });

  assert.equal(harness.calls.faceDetectVideo, video);
  assert.equal(full.extra.faces.length, 1);
  assert.equal(full.extra.hands.length, 1);
  assert.equal(full.vehicles[0].label, "car");
});

test("a canvas frame is measured by its plain width and height", async () => {
  const harness = loadModelHarness();
  const adapter = await harness.model.load();
  await new Promise((resolve) => setImmediate(resolve));

  // The models are handed a shared downscaled canvas rather than the video.
  adapter.detect({ width: 960, height: 540 });
  await new Promise((resolve) => setImmediate(resolve));
  harness.setNow(9000);
  adapter.detect({ width: 960, height: 540 });
  assert.deepEqual(harness.calls.readVehicles.width, 960);
  assert.deepEqual(harness.calls.readVehicles.height, 540);

  const scanner = await harness.model.loadFaceScanner();
  assert.equal(scanner.detect({ width: 960, height: 540 }).bodies.length, 1);
  assert.equal(scanner.detect({ width: 0, height: 0 }).bodies.length, 0);
});

test("pose loading fails clearly when the mapping layer is absent", async () => {
  const harness = loadModelHarness({ mapping: null });
  await assert.rejects(harness.model.load(), /pose mapping is missing/);
  assert.equal(harness.calls.fileset.length, 0);
});
