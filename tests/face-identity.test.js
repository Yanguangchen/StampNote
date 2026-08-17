const assert = require("node:assert/strict");
const { resolve } = require("node:path");
const { test } = require("node:test");

const identity = require(resolve(__dirname, "..", "face-identity.js"));

function faceAt(leftX = 0.4, rightX = 0.6, y = 0.35) {
  return {
    eyeLeft: [[{ x: leftX - 0.01, y }, { x: leftX + 0.01, y }]],
    eyeRight: [[{ x: rightX - 0.01, y }, { x: rightX + 0.01, y }]],
  };
}

function canvasHarness() {
  const contexts = [];
  const document = {
    createElement(tag) {
      assert.equal(tag, "canvas");
      const calls = [];
      const context = {
        calls,
        clearRect(...args) {
          calls.push(["clearRect", ...args]);
        },
        drawImage(...args) {
          calls.push(["drawImage", ...args]);
        },
        fillRect(...args) {
          calls.push(["fillRect", ...args]);
        },
        resetTransform() {
          calls.push(["resetTransform"]);
        },
        setTransform(...args) {
          calls.push(["setTransform", ...args]);
        },
      };
      contexts.push(context);
      return {
        width: 0,
        height: 0,
        getContext() {
          return context;
        },
      };
    },
  };
  return { contexts, document };
}

test("a face is rotated, scaled and centered from its MediaPipe eye positions", () => {
  const harness = canvasHarness();
  const video = { videoWidth: 640, videoHeight: 480 };
  const crop = identity.createAlignedCrop(
    { face: faceAt(0.4, 0.6, 0.35) },
    video,
    { document: harness.document },
  );

  assert.equal(crop.width, 150);
  assert.equal(crop.height, 150);
  const transform = harness.contexts[0].calls.find(([name]) => name === "setTransform");
  assert.ok(transform);
  assert.ok(transform.slice(1).every(Number.isFinite));
  assert.ok(harness.contexts[0].calls.some(([name, source]) => name === "drawImage" && source === video));
});

test("the embedding model is lazy, throttled and returns only a numeric descriptor", async () => {
  const harness = canvasHarness();
  const calls = { compute: 0, load: 0 };
  const descriptor = Float32Array.from({ length: 128 }, (unused, index) => index / 1000);
  const faceApi = {
    nets: {
      faceRecognitionNet: {
        async computeFaceDescriptor() {
          calls.compute += 1;
          return descriptor;
        },
        async loadFromUri(path) {
          calls.load += 1;
          assert.equal(path, "/face-model");
        },
      },
    },
    tf: {
      async ready() {},
      async setBackend() {},
    },
  };
  const recognizer = identity.createFaceIdentity({
    document: harness.document,
    loadFaceApi: async () => faceApi,
    modelPath: "/face-model",
    sampleMs: 1_000,
  });
  assert.equal(recognizer.status(), "idle");
  await recognizer.load();
  assert.equal(recognizer.status(), "ready");
  assert.equal(calls.load, 1);

  const bodies = [{ face: faceAt() }];
  const source = { videoWidth: 640, videoHeight: 480 };
  const first = await recognizer.describe(bodies, source, 1_000);
  const magnitude = Math.sqrt(Array.from(descriptor).reduce((total, value) => total + value ** 2, 0));
  const normalizedDescriptor = Array.from(descriptor, (value) => value / magnitude);
  assert.deepEqual(first[0].faceEmbedding, normalizedDescriptor);
  assert.equal(first[0].enrollmentAccepted, true);
  assert.equal(calls.compute, 1);
  assert.equal("crop" in first[0], false);
  assert.deepEqual(recognizer.enrollmentState(), {
    required: true,
    status: "scanning",
    samples: 1,
    total: 3,
    progress: 1 / 3,
    workerId: null,
    personLabel: null,
  });

  const throttled = await recognizer.describe(bodies, source, 1_500);
  assert.equal(throttled, bodies);
  assert.equal(calls.compute, 1);

  await recognizer.describe(bodies, source, 2_000);
  assert.equal(recognizer.enrollmentState().status, "scanning");
  await recognizer.describe(bodies, source, 3_000);
  assert.equal(recognizer.enrollmentState().status, "complete");
  assert.equal(recognizer.enrollmentState().samples, 3);
  assert.equal(calls.compute, 3);
  assert.ok(harness.contexts[0].calls.some(([name]) => name === "clearRect"));
});

test("faces too small for a reliable descriptor are skipped", async () => {
  const harness = canvasHarness();
  const recognizer = identity.createFaceIdentity({
    document: harness.document,
    faceApi: {
      nets: {
        faceRecognitionNet: {
          async computeFaceDescriptor() {
            throw new Error("should not run");
          },
        },
      },
    },
  });
  const bodies = [{ face: faceAt(0.49, 0.51) }];
  const result = await recognizer.describe(bodies, { videoWidth: 320, videoHeight: 240 }, 1_000);
  assert.equal(result, bodies);
  assert.equal(recognizer.enrollmentState().status, "move_closer");
  assert.equal(recognizer.enrollmentState().samples, 0);
});

test("enrollment asks for one centered, level face at a time", async () => {
  const harness = canvasHarness();
  const recognizer = identity.createFaceIdentity({
    document: harness.document,
    faceApi: {
      nets: {
        faceRecognitionNet: {
          async computeFaceDescriptor() {
            throw new Error("quality failures must not reach the model");
          },
        },
      },
    },
  });
  const source = { videoWidth: 640, videoHeight: 480 };

  await recognizer.describe([{ face: faceAt() }, { face: faceAt() }], source, 1_000);
  assert.equal(recognizer.enrollmentState().status, "one_person");

  await recognizer.describe([{ face: faceAt(0.05, 0.25) }], source, 2_000);
  assert.equal(recognizer.enrollmentState().status, "center_face");

  const tilted = {
    eyeLeft: [[{ x: 0.35, y: 0.27 }]],
    eyeRight: [[{ x: 0.65, y: 0.43 }]],
  };
  await recognizer.describe([{ face: tilted }], source, 3_000);
  assert.equal(recognizer.enrollmentState().status, "look_straight");
});

test("enrollment rejects sudden movement and a descriptor from a different face", async () => {
  const harness = canvasHarness();
  const firstDescriptor = [1, ...Array.from({ length: 127 }, () => 0)];
  const changedDescriptor = [0, 1, ...Array.from({ length: 126 }, () => 0)];
  let descriptor = firstDescriptor;
  let computes = 0;
  const recognizer = identity.createFaceIdentity({
    document: harness.document,
    enrollmentSamples: 2,
    sampleMs: 0,
    faceApi: {
      nets: {
        faceRecognitionNet: {
          async computeFaceDescriptor() {
            computes += 1;
            return Float32Array.from(descriptor);
          },
        },
      },
    },
  });
  const source = { videoWidth: 1280, videoHeight: 720 };

  const first = await recognizer.describe([{ face: faceAt() }], source, 1_000);
  assert.equal(first[0].enrollmentAccepted, true);
  assert.equal(recognizer.enrollmentState().samples, 1);

  await recognizer.describe([{ face: faceAt(0.3, 0.5) }], source, 1_250);
  assert.equal(recognizer.enrollmentState().status, "hold_still");
  assert.equal(computes, 1, "a moving frame never reaches the recognition model");

  descriptor = changedDescriptor;
  const changed = await recognizer.describe([{ face: faceAt(0.3, 0.5) }], source, 1_500);
  assert.equal(changed[0].enrollmentAccepted, false);
  assert.equal(recognizer.enrollmentState().status, "face_changed");
  assert.equal(recognizer.enrollmentState().samples, 1);
});

test("the opening scan requires repeat agreement with a stored worker face", async () => {
  const harness = canvasHarness();
  const descriptor = Array.from(
    { length: 128 },
    (unused, index) => Math.sin(index * 0.37) * 0.05,
  );
  const recognizer = identity.createFaceIdentity({
    document: harness.document,
    faceApi: {
      nets: {
        faceRecognitionNet: {
          async computeFaceDescriptor() {
            return Float32Array.from(descriptor);
          },
        },
      },
    },
    sampleMs: 0,
    knownIdentities: [
      {
        workerId: "worker-7",
        displayName: "Ari Tan",
        embedding: descriptor.map((value) => value + 0.2),
        embeddings: [descriptor, descriptor.map((value) => value + 0.02)],
      },
      { workerId: "worker-9", displayName: "Bo Lim", embedding: descriptor.map((x) => x + 0.1) },
    ],
  });
  const bodies = [{ face: faceAt() }];
  const source = { videoWidth: 640, videoHeight: 480 };

  await recognizer.describe(bodies, source, 1_000);
  await recognizer.describe(bodies, source, 2_000);
  await recognizer.describe(bodies, source, 3_000);

  const state = recognizer.enrollmentState();
  assert.equal(state.status, "complete");
  assert.equal(state.workerId, "WORKER-7");
  assert.equal(state.personLabel, "Ari Tan");
  assert.equal(state.candidateWorkerId, "WORKER-7");
  assert.equal(state.matchVotes, 3);
  assert.equal(state.requiredVotes, 3);
  assert.ok(state.matchDistance < 0.001);
});

test("an unsuccessful opening scan keeps retrying until three later views match", async () => {
  const harness = canvasHarness();
  let live = [1, ...Array.from({ length: 127 }, () => 0)];
  const enrolled = [0, 1, ...Array.from({ length: 126 }, () => 0)];
  const recognizer = identity.createFaceIdentity({
    document: harness.document,
    faceApi: {
      nets: {
        faceRecognitionNet: {
          async computeFaceDescriptor() {
            return Float32Array.from(live);
          },
        },
      },
    },
    sampleMs: 0,
    knownIdentityThreshold: 0.2,
    knownIdentities: [
      { workerId: "worker-7", displayName: "Ari Tan", embeddings: [enrolled] },
    ],
  });
  const bodies = [{ face: faceAt() }];
  const source = { videoWidth: 640, videoHeight: 480 };

  for (let sample = 0; sample < 3; sample += 1) {
    await recognizer.describe(bodies, source, 1_000 + sample * 1_000);
  }

  const state = recognizer.enrollmentState();
  assert.equal(state.status, "retrying");
  assert.equal(state.candidateWorkerId, "WORKER-7");
  assert.equal(state.matchReason, "too_far");
  assert.equal(state.matchThreshold, 0.2);
  assert.ok(Math.abs(state.matchDistance - Math.sqrt(2)) < 0.000001);
  assert.equal("embedding" in state, false, "raw biometric vectors never enter UI state");

  live = enrolled;
  await recognizer.describe(bodies, source, 4_000);
  assert.equal(recognizer.enrollmentState().status, "retrying");
  await recognizer.describe(bodies, source, 5_000);
  assert.equal(recognizer.enrollmentState().status, "retrying");
  await recognizer.describe(bodies, source, 6_000);
  assert.equal(recognizer.enrollmentState().status, "complete");
  assert.equal(recognizer.enrollmentState().workerId, "WORKER-7");
});

test("repeat agreement never turns an ambiguous worker into a match", async () => {
  const harness = canvasHarness();
  const live = [1, ...Array.from({ length: 127 }, () => 0)];
  const closeRunnerUp = [
    Math.cos(0.03),
    Math.sin(0.03),
    ...Array.from({ length: 126 }, () => 0),
  ];
  const recognizer = identity.createFaceIdentity({
    document: harness.document,
    faceApi: {
      nets: {
        faceRecognitionNet: {
          async computeFaceDescriptor() {
            return Float32Array.from(live);
          },
        },
      },
    },
    sampleMs: 0,
    knownIdentities: [
      { workerId: "worker-7", displayName: "Ari Tan", embeddings: [live] },
      { workerId: "worker-9", displayName: "Bo Lim", embeddings: [closeRunnerUp] },
    ],
  });
  const bodies = [{ face: faceAt() }];
  const source = { videoWidth: 640, videoHeight: 480 };

  for (let sample = 0; sample < 5; sample += 1) {
    await recognizer.describe(bodies, source, 1_000 + sample * 1_000);
  }

  const state = recognizer.enrollmentState();
  assert.equal(state.status, "retrying");
  assert.equal(state.workerId, null);
  assert.equal(state.candidateWorkerId, "WORKER-7");
  assert.equal(state.matchVotes, 0);
  assert.equal(state.matchReason, "ambiguous");
});
