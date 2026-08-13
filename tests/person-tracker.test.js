const assert = require("node:assert/strict");
const { resolve } = require("node:path");
const { test } = require("node:test");

const people = require(resolve(__dirname, "..", "person-tracker.js"));

function body(x, options = {}) {
  const width = options.width || 0.18;
  const height = options.height || 0.62;
  const center = x + width / 2;
  const result = {
    confidence: 0.95,
    box: { x, y: 0.18, width, height },
    keypoints: {
      head: { x: center, y: 0.18 },
      shoulderLeft: { x: center - width * 0.28, y: 0.32 },
      shoulderRight: { x: center + width * 0.28, y: 0.32 },
      torso: { x: center, y: 0.48 },
      hipLeft: { x: center - width * 0.2, y: 0.58 },
      hipRight: { x: center + width * 0.2, y: 0.58 },
    },
  };
  if (options.appearance) result.appearance = options.appearance;
  if (options.faceSignature) result.faceSignature = options.faceSignature;
  if (options.faceTexture) result.faceTexture = options.faceTexture;
  if (options.faceEmbedding) result.faceEmbedding = options.faceEmbedding;
  return result;
}

function clothing(upperBin, lowerBin = upperBin + 16) {
  const histogram = new Array(people.APPEARANCE_BINS).fill(0);
  histogram[upperBin] = 0.5;
  histogram[lowerBin] = 0.5;
  return histogram;
}

function shiftedClothing(amount) {
  const histogram = new Array(people.APPEARANCE_BINS).fill(0);
  histogram[0] = (1 - amount) * 0.5;
  histogram[1] = amount * 0.5;
  histogram[16] = (1 - amount) * 0.5;
  histogram[17] = amount * 0.5;
  return histogram;
}

function facial(offset = 0) {
  return Array.from({ length: 105 }, (unused, index) => 0.5 + (index % 11) * 0.03 + offset);
}

function facialTexture(variant = 0, brightness = 0, contrast = 1) {
  return Array.from({ length: 12 * 14 }, (unused, index) => {
    const row = Math.floor(index / 12);
    const column = index % 12;
    const base =
      variant === 0
        ? Math.sin(column * 0.73) * 34 + Math.cos(row * 0.41) * 21 + ((row * column) % 5) * 9
        : Math.cos(column * 0.27 + row * 0.81) * 37 + ((row + column * 3) % 7) * 11;
    return brightness + contrast * (128 + base);
  });
}

function faceEmbedding(offset = 0, variation = 0) {
  return Array.from(
    { length: 128 },
    (unused, index) => Math.sin(index * 0.37) * 0.05 + offset + (index % 2 ? variation : 0),
  );
}

test("people keep anonymous IDs when detector result order changes", () => {
  const tracker = people.createPersonTracker();
  const first = tracker.update([body(0.1), body(0.7)], 1_000);
  assert.deepEqual(first.bodies.map((entry) => entry.personId), [1, 2]);

  const reordered = tracker.update([body(0.68), body(0.12)], 1_250);
  assert.deepEqual(reordered.bodies.map((entry) => entry.personId), [1, 2]);
  assert.ok(reordered.bodies[0].box.x < reordered.bodies[1].box.x);
  assert.deepEqual(reordered.bodies.map((entry) => entry.personLabel), [
    "UNMATCHED WORKER",
    "UNMATCHED WORKER",
  ]);
  assert.equal(reordered.uniqueCount, 2);
});

test("an enrolled face restores its stable worker ID before anonymous tracking begins", () => {
  const enrolledEmbedding = faceEmbedding();
  const tracker = people.createPersonTracker({
    identities: [
      { workerId: "worker-007", displayName: "Ari Tan", embedding: enrolledEmbedding },
    ],
  });
  assert.equal(tracker.peek(1_000).uniqueCount, 0, "unseen roster entries do not inflate counts");

  const matched = tracker.update(
    [body(0.2, { faceEmbedding: faceEmbedding(0, 0.005) })],
    1_000,
  );
  assert.equal(matched.bodies[0].workerId, "WORKER-007");
  assert.equal(matched.bodies[0].personLabel, "WORKER-007");
  assert.equal(matched.uniqueCount, 1);

  tracker.reset();
  const returned = tracker.update(
    [body(0.7, { faceEmbedding: enrolledEmbedding })],
    5_000,
  );
  assert.equal(returned.bodies[0].workerId, "WORKER-007");
});

test("unmatched workers stay explicit while the internal track ID remains stable", () => {
  const tracker = people.createPersonTracker();
  const first = tracker.update([body(0.2)], 1_100).bodies[0];
  const sameSecond = tracker.update([body(0.21)], 1_900).bodies[0];
  const nextSecond = tracker.update([body(0.22)], 2_100).bodies[0];

  assert.equal(first.personLabel, "UNMATCHED WORKER");
  assert.equal(sameSecond.personLabel, "UNMATCHED WORKER");
  assert.equal(nextSecond.personLabel, "UNMATCHED WORKER");
  assert.equal(first.personId, 1);
  assert.equal(nextSecond.personId, 1);
});

test("motion prediction keeps IDs attached while people cross", () => {
  const tracker = people.createPersonTracker();
  tracker.update([body(0.1), body(0.7)], 1_000);
  tracker.update([body(0.28), body(0.52)], 1_250);

  // MediaPipe returns the right-hand body first after the crossing. Person 1
  // was moving right and Person 2 left, so order and nearest-old-position are
  // both insufficient without the motion estimate.
  const crossed = tracker.update([body(0.46), body(0.34)], 1_500);
  assert.equal(crossed.bodies.find((entry) => entry.personId === 1).box.x, 0.46);
  assert.equal(crossed.bodies.find((entry) => entry.personId === 2).box.x, 0.34);
});

test("a person keeps their ID after leaving the frame until the session resets", () => {
  const tracker = people.createPersonTracker({ missingMs: 2_000 });
  const red = clothing(0);
  const blue = clothing(8, 24);
  assert.equal(tracker.update([body(0.2, { appearance: red })], 1_000).bodies[0].personId, 1);
  assert.equal(tracker.update([], 2_000).activeCount, 1);
  assert.equal(
    tracker.update([body(0.21, { appearance: red })], 2_500).bodies[0].personId,
    1,
  );

  // A quick return from a different edge is too far for ordinary motion
  // matching but still reconnects through transient clothing appearance.
  tracker.update([], 2_700);
  assert.equal(
    tracker.update([body(0.7, { appearance: red })], 2_900).bodies[0].personId,
    1,
  );

  tracker.update([], 5_000);
  assert.equal(tracker.peek(5_100).dormantCount, 1);
  assert.equal(
    tracker.update([body(0.2, { appearance: red })], 5_100).bodies[0].personId,
    1,
  );

  tracker.update([], 8_000);
  assert.equal(
    tracker.update([body(0.2, { appearance: blue })], 8_100).bodies[0].personId,
    2,
  );
  tracker.reset();
  assert.equal(tracker.update([body(0.21, { appearance: red })], 9_000).bodies[0].personId, 1);
});

test("clothing appearance reconnects two people returning at swapped positions", () => {
  const tracker = people.createPersonTracker({ missingMs: 1_000 });
  const red = clothing(0);
  const blue = clothing(8, 24);
  tracker.update(
    [body(0.1, { appearance: red }), body(0.7, { appearance: blue })],
    1_000,
  );
  tracker.update([], 2_100);

  const returned = tracker.update(
    [body(0.1, { appearance: blue }), body(0.7, { appearance: red })],
    2_200,
  );
  assert.equal(returned.bodies.find((entry) => entry.personId === 1).box.x, 0.7);
  assert.equal(returned.bodies.find((entry) => entry.personId === 2).box.x, 0.1);
  assert.equal(returned.uniqueCount, 2);
});

test("an appearance gallery survives gradual lighting changes and restores the original ID", () => {
  const tracker = people.createPersonTracker({ missingMs: 1_000, appearanceSampleMs: 0 });
  const appearances = [0, 0.2, 0.4, 0.6, 0.8, 1];

  appearances.forEach((amount, index) => {
    const reading = tracker.update(
      [body(0.2 + index * 0.01, { appearance: shiftedClothing(amount) })],
      1_000 + index * 250,
    );
    assert.equal(reading.bodies[0].personId, 1);
  });

  tracker.update([], 4_000);
  const returned = tracker.update(
    [body(0.65, { appearance: shiftedClothing(0) })],
    4_100,
  );
  assert.equal(returned.bodies[0].personId, 1);
  assert.equal(returned.uniqueCount, 1);
});

test("a partially visible person returning at the frame edge does not get a new ID", () => {
  const tracker = people.createPersonTracker({ missingMs: 1_000 });
  tracker.update([body(0.3, { appearance: shiftedClothing(0) })], 1_000);
  tracker.update([], 2_100);

  const partialReturn = tracker.update(
    [body(0, { appearance: shiftedClothing(0.7), height: 0.42, width: 0.12 })],
    2_200,
  );
  assert.equal(partialReturn.bodies[0].personId, 1);
  assert.equal(partialReturn.uniqueCount, 1);
});

test("a face signature restores an ID even when the person changes clothing", () => {
  const tracker = people.createPersonTracker({ missingMs: 1_000 });
  const firstFace = facial();
  const differentFace = facial(0.6);
  tracker.update(
    [body(0.2, { appearance: clothing(0), faceSignature: firstFace })],
    1_000,
  );
  tracker.update([], 2_100);

  const changedClothes = tracker.update(
    [body(0.7, { appearance: clothing(8, 24), faceSignature: firstFace })],
    2_200,
  );
  assert.equal(changedClothes.bodies[0].personId, 1);
  assert.equal(changedClothes.uniqueCount, 1);

  tracker.update([], 3_300);
  const newPerson = tracker.update(
    [body(0.2, { appearance: clothing(8, 24), faceSignature: differentFace })],
    3_400,
  );
  assert.equal(newPerson.bodies[0].personId, 2);
  assert.equal(newPerson.uniqueCount, 2);
  assert.equal("faceSignature" in newPerson.bodies[0], false);
  assert.equal(people.faceSignatureDistance(firstFace, firstFace), 0);
  assert.ok(people.faceSignatureDistance(firstFace, differentFace) > 0.5);
});

test("facial texture survives lighting changes but rejects a different face with similar landmarks", () => {
  const tracker = people.createPersonTracker({ missingMs: 1_000 });
  const sharedLandmarks = facial();
  const firstTexture = facialTexture(0);
  const relitTexture = facialTexture(0, 35, 0.72);
  const differentTexture = facialTexture(1);

  const first = tracker.update(
    [
      body(0.2, {
        appearance: clothing(0),
        faceSignature: sharedLandmarks,
        faceTexture: firstTexture,
      }),
    ],
    1_000,
  );
  assert.equal(first.faceRecognitionReady, false);
  tracker.update([], 2_100);

  const returned = tracker.update(
    [
      body(0.7, {
        appearance: clothing(8, 24),
        faceSignature: sharedLandmarks,
        faceTexture: relitTexture,
      }),
    ],
    2_200,
  );
  assert.equal(returned.bodies[0].personId, 1);
  assert.ok(people.faceTextureDistance(firstTexture, relitTexture) < 0.001);

  tracker.update([], 3_300);
  const otherPerson = tracker.update(
    [
      body(0.2, {
        appearance: clothing(8, 24),
        faceSignature: sharedLandmarks,
        faceTexture: differentTexture,
      }),
    ],
    3_400,
  );
  assert.ok(people.faceTextureDistance(firstTexture, differentTexture) > 0.9);
  assert.equal(otherPerson.bodies[0].personId, 2);
  assert.equal("faceSignature" in otherPerson.bodies[0], false);
  assert.equal("faceTexture" in otherPerson.bodies[0], false);
});

test("the trained face embedding overrides misleading geometry and texture fallbacks", () => {
  const tracker = people.createPersonTracker({ missingMs: 1_000 });
  const firstEmbedding = faceEmbedding();
  const nearEmbedding = faceEmbedding(0, 0.003);
  const otherEmbedding = faceEmbedding(0.08);
  const sharedFace = {
    appearance: clothing(0),
    faceSignature: facial(),
    faceTexture: facialTexture(0),
  };

  const first = tracker.update(
    [body(0.2, { ...sharedFace, faceEmbedding: firstEmbedding })],
    1_000,
  );
  assert.equal(first.faceRecognitionReady, true);
  tracker.update([], 2_100);
  const returned = tracker.update(
    [body(0.7, { ...sharedFace, faceEmbedding: nearEmbedding })],
    2_200,
  );
  assert.equal(returned.bodies[0].personId, 1);
  assert.ok(people.faceEmbeddingDistance(firstEmbedding, nearEmbedding) < 0.1);

  tracker.update([], 3_300);
  const differentPerson = tracker.update(
    [body(0.2, { ...sharedFace, faceEmbedding: otherEmbedding })],
    3_400,
  );
  assert.ok(people.faceEmbeddingDistance(firstEmbedding, otherEmbedding) > 0.72);
  assert.equal(differentPerson.bodies[0].personId, 2);
  assert.equal("faceEmbedding" in differentPerson.bodies[0], false);
});

test("coarse frame colours produce distinct transient appearance signatures", () => {
  const width = 40;
  const height = 20;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = x < width / 2 ? 255 : 0;
      data[offset + 1] = 0;
      data[offset + 2] = x < width / 2 ? 0 : 255;
      data[offset + 3] = 255;
    }
  }

  const frame = { data, width, height };
  const red = people.appearanceOf(body(0, { width: 0.4, height: 0.8 }), frame);
  const blue = people.appearanceOf(body(0.6, { width: 0.4, height: 0.8 }), frame);
  assert.ok(red);
  assert.ok(blue);
  assert.ok(people.appearanceDistance(red, blue) > 0.9);
});

test("the tracker exposes helpers without publishing its private signatures", () => {
  assert.deepEqual(people.centerOf(body(0.2)), { x: 0.29000000000000004, y: 0.48 });
  assert.equal(people.signatureOf(body(0.2)).length, 4);
  const tracker = people.createPersonTracker();
  const identified = tracker.update(
    [body(0.2, { appearance: clothing(0), faceSignature: facial() })],
    1_000,
  ).bodies[0];
  assert.deepEqual(Object.keys(identified).sort(), [
    "box",
    "confidence",
    "keypoints",
    "personId",
    "personLabel",
  ]);
});
