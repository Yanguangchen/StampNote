const assert = require("node:assert/strict");
const { resolve } = require("node:path");
const { test } = require("node:test");

const scaling = require(resolve(__dirname, "..", "frame-scaler.js"));

function canvasHarness() {
  const created = [];
  const document = {
    createElement(tag) {
      assert.equal(tag, "canvas");
      const context = {
        contextOptions: null,
        draws: [],
        drawImage(...args) {
          this.draws.push(args);
        },
      };
      const canvas = {
        width: 0,
        height: 0,
        context,
        getContext(kind, options) {
          assert.equal(kind, "2d");
          context.contextOptions = options ?? null;
          return context;
        },
      };
      created.push(canvas);
      return canvas;
    },
  };
  return { created, document };
}

test("a frame larger than the inference width is drawn down once and reused", () => {
  const harness = canvasHarness();
  const scaler = scaling.createFrameScaler({ document: harness.document });
  const video = { videoWidth: 1920, videoHeight: 1080 };

  const first = scaler.scale(video);
  assert.equal(harness.created.length, 1);
  assert.equal(first.width, 960);
  // The aspect ratio is kept, so every normalized landmark the models return
  // still lands in the same place on the full-resolution frame.
  assert.equal(first.height, 540);
  assert.deepEqual(first.context.draws, [[video, 0, 0, 960, 540]]);

  // A second tick reuses the same canvas rather than allocating another.
  const second = scaler.scale(video);
  assert.equal(second, first);
  assert.equal(harness.created.length, 1);
  assert.equal(second.context.draws.length, 2);
});

test("the shared frame is left on the GPU, since nothing reads its pixels back", () => {
  const harness = canvasHarness();
  const scaler = scaling.createFrameScaler({ document: harness.document });
  const canvas = scaler.scale({ videoWidth: 1280, videoHeight: 720 });

  assert.equal(canvas.context.contextOptions?.willReadFrequently, undefined);
  assert.equal(canvas.context.contextOptions?.alpha, false);
});

test("a frame already small enough is handed straight on", () => {
  const harness = canvasHarness();
  const scaler = scaling.createFrameScaler({ document: harness.document });
  const small = { videoWidth: 640, videoHeight: 480 };
  const exact = { videoWidth: 960, videoHeight: 540 };

  assert.equal(scaler.scale(small), small);
  // A camera already giving exactly the inference width gains nothing from a
  // copy either.
  assert.equal(scaler.scale(exact), exact);
  assert.equal(harness.created.length, 0);
});

test("a frame the camera has not produced yet is passed through untouched", () => {
  const harness = canvasHarness();
  const scaler = scaling.createFrameScaler({ document: harness.document });
  const blank = { videoWidth: 0, videoHeight: 0 };

  assert.equal(scaler.scale(blank), blank);
  assert.equal(scaler.scale(null), null);
  assert.equal(harness.created.length, 0);
});

test("a frame the browser refuses to draw falls back to the source", () => {
  const document = {
    createElement() {
      return {
        width: 0,
        height: 0,
        getContext() {
          return {
            drawImage() {
              throw new Error("The frame is not ready.");
            },
          };
        },
      };
    },
  };
  const scaler = scaling.createFrameScaler({ document });
  const video = { videoWidth: 1920, videoHeight: 1080 };

  assert.equal(scaler.scale(video), video);
});

test("a canvas source is measured by its plain width and height", () => {
  const harness = canvasHarness();
  const scaler = scaling.createFrameScaler({ document: harness.document });

  assert.equal(scaler.scale({ width: 1920, height: 1080 }).height, 540);
});

test("releasing the scaler drops the frame it was holding", () => {
  const harness = canvasHarness();
  const scaler = scaling.createFrameScaler({ document: harness.document });
  const video = { videoWidth: 1920, videoHeight: 1080 };

  scaler.scale(video);
  scaler.release();
  assert.equal(harness.created[0].width, 1);
  assert.equal(harness.created[0].height, 1);

  // A scan started again gets a fresh canvas rather than the released one.
  scaler.scale(video);
  assert.equal(harness.created.length, 2);
});

test("the width is the one the enrollment gates were written against", () => {
  // face-identity asks for eyes at least 52px apart and at least 5.5% of the
  // frame apart. At 960 those two gates coincide, so sharing a frame this size
  // asks no more of the worker than the full-resolution frame did.
  const identity = require(resolve(__dirname, "..", "face-identity.js"));
  const ratioPixels =
    scaling.INFERENCE_WIDTH * identity.DEFAULTS.enrollmentMinimumEyeRatio;

  assert.equal(scaling.INFERENCE_WIDTH, 960);
  assert.ok(ratioPixels >= identity.DEFAULTS.enrollmentMinimumEyePixels);
  assert.ok(ratioPixels < identity.DEFAULTS.enrollmentMinimumEyePixels + 4);
});
