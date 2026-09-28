const assert = require("node:assert/strict");
const { test } = require("node:test");

const workerFace = require("../worker-face.js");

function embedding(offset = 0) {
  const values = Array.from(
    { length: workerFace.EMBEDDING_LENGTH },
    (unused, index) => Math.sin(index * 0.37) * 0.05 + offset,
  );
  const magnitude = Math.sqrt(values.reduce((total, value) => total + value ** 2, 0));
  return values.map((value) => value / magnitude);
}

test("worker IDs and face templates are normalized before storage", () => {
  assert.equal(workerFace.normalizeWorkerId(" worker-007 "), "WORKER-007");
  assert.equal(workerFace.normalizeWorkerId("bad/id"), null);
  assert.equal(workerFace.normalizeDisplayName("  Ari   Tan "), "Ari Tan");
  assert.equal(workerFace.normalizeEmbedding(embedding()).length, 128);
  assert.equal(workerFace.normalizeEmbedding([1, 2]), null);
});

test("a worker ID is issued from the initials, numbered within them", () => {
  assert.equal(workerFace.workerIdPrefix("Ari Tan"), "AT");
  // First and last, so the family name survives a middle one.
  assert.equal(workerFace.workerIdPrefix("Ari Bin Tan"), "AT");
  // A mononym has no last name to take a letter from, so it lends its second.
  assert.equal(workerFace.workerIdPrefix("Ari"), "AR");
  assert.equal(workerFace.workerIdPrefix("ari  tan"), "AT");
  assert.equal(workerFace.workerIdPrefix("O'Brien Ng"), "ON");
  // Nothing in the Latin alphabet to read, but an ID still has to be readable.
  assert.equal(workerFace.workerIdPrefix("陈伟"), "WK");
  assert.equal(workerFace.workerIdPrefix(""), "WK");

  assert.equal(workerFace.nextWorkerId("Ari Tan", []), "AT-0001");
  // The point of the number: two people of the same name are two records.
  assert.equal(workerFace.nextWorkerId("Ari Tan", ["AT-0001"]), "AT-0002");
  assert.equal(
    workerFace.nextWorkerId("Ari Tan", ["AT-0001", "AT-0002", "BL-0001"]),
    "AT-0003",
    "another prefix's numbering is none of this one's business",
  );
  // Counted from the highest issued rather than from how many exist, so a number
  // that has been written on a badge is not handed to somebody else later.
  assert.equal(workerFace.nextWorkerId("Ari Tan", ["AT-0003"]), "AT-0004");
  assert.equal(workerFace.nextWorkerId("Ari Tan", ["at-0001", " AT-0002 "]), "AT-0003");
  // An ID from before any of this, sitting where the count would have landed.
  assert.equal(workerFace.nextWorkerId("Ari Tan", ["AT-0002", "AT-0001", "SG-0042"]), "AT-0003");
  assert.equal(workerFace.nextWorkerId("Ari Tan", ["AT-9999"]), "AT-10000");
  assert.equal(workerFace.nextWorkerId("Ari Tan", null), "AT-0001");
  // Every issued ID has to survive the check the save itself makes.
  assert.equal(workerFace.normalizeWorkerId(workerFace.nextWorkerId("A", [])), "A-0001");
  assert.equal(workerFace.normalizeWorkerId(workerFace.nextWorkerId("陈伟", [])), "WK-0001");
});

test("seven face samples form one normalized database template", () => {
  const averaged = workerFace.averageEmbeddings([
    embedding(),
    embedding(0.001),
    embedding(-0.001),
    embedding(0.0005),
    embedding(-0.0005),
    embedding(0.0002),
    embedding(-0.0002),
  ]);
  const magnitude = Math.sqrt(averaged.reduce((total, value) => total + value ** 2, 0));
  assert.ok(Math.abs(magnitude - 1) < 1e-10);
  assert.ok(workerFace.distance(averaged, embedding()) < 0.05);
});

test("a live face resolves to the nearest enrolled worker within the strict threshold", () => {
  const workers = [
    { workerId: "WORKER-1", displayName: "Ari Tan", embedding: embedding() },
    { workerId: "WORKER-2", displayName: "Bo Lim", embedding: embedding(0.08) },
  ];
  const matched = workerFace.match(embedding(0.001), workers);
  assert.equal(matched.workerId, "WORKER-1");
  assert.equal(matched.personLabel, "Ari Tan");

  assert.equal(workerFace.match(embedding(0.5), workers, { threshold: 0.1 }), null);
});

test("matching keeps representative views instead of relying on a blurred centroid", () => {
  const front = [1, ...Array.from({ length: 127 }, () => 0)];
  const profile = [0, 1, ...Array.from({ length: 126 }, () => 0)];
  const centroid = workerFace.averageEmbeddings([front, profile]);
  const worker = {
    workerId: "WORKER-7",
    displayName: "Ari Tan",
    embedding: centroid,
    embeddings: [front, profile],
  };

  assert.equal(workerFace.match(front, [worker], { threshold: 0.1 }).workerId, "WORKER-7");
  assert.equal(
    workerFace.match(front, [{ ...worker, embeddings: [] }], { threshold: 0.1 }),
    null,
    "the averaged vector alone is too far from either representative view",
  );
});

test("a nearest face is rejected when another worker is inside the safety margin", () => {
  const live = [1, ...Array.from({ length: 127 }, () => 0)];
  const closeRunnerUp = [
    Math.cos(0.03),
    Math.sin(0.03),
    ...Array.from({ length: 126 }, () => 0),
  ];

  assert.equal(
    workerFace.match(live, [
      { workerId: "WORKER-1", embedding: live },
      { workerId: "WORKER-2", embedding: closeRunnerUp },
    ]),
    null,
  );
});

// A unit view turned `angle` away from straight on, along its own direction:
// different axes stand for different lighting, angles or cameras.
function view(axis, angle = 0.3) {
  const values = Array.from({ length: 128 }, () => 0);
  values[0] = Math.cos(angle);
  values[axis] += Math.sin(angle);
  return values;
}

function minimumPairDistance(views) {
  let minimum = Infinity;
  views.forEach((left, index) =>
    views.slice(index + 1).forEach((right) => {
      minimum = Math.min(minimum, workerFace.distance(left, right));
    }),
  );
  return minimum;
}

test("improvement scans fill an enrolled gallery until it holds twelve views", () => {
  assert.equal(workerFace.MAX_TEMPLATES, 12);
  const enrolled = [1, 2, 3, 4, 5, 6, 7].map((axis) => view(axis));
  const refined = workerFace.refineGallery(enrolled, [8, 9, 10].map((axis) => view(axis)));

  assert.equal(refined.embeddings.length, 10);
  assert.equal(refined.added, 3);
  assert.equal(refined.skipped, 0);
  assert.equal(refined.retired, 0, "nothing saved is dropped while there is room");
  assert.ok(workerFace.distance(refined.embedding, view(1, 0)) < 0.2);
  refined.embeddings.forEach((embedding) => {
    const magnitude = Math.sqrt(embedding.reduce((total, value) => total + value ** 2, 0));
    assert.ok(Math.abs(magnitude - 1) < 1e-9);
  });
});

test("once full, a scan swaps redundant views for ones that cover something new", () => {
  const full = Array.from({ length: 12 }, (unused, index) => view(index + 1));
  const repeats = [1, 2, 3].map((axis) => view(axis, 0.299));
  const newCondition = view(40, 0.5);
  const refined = workerFace.refineGallery(full, [...repeats, newCondition]);

  assert.equal(refined.embeddings.length, 12);
  assert.ok(
    refined.embeddings.some((embedding) => workerFace.distance(embedding, newCondition) < 1e-9),
    "the view from new conditions is kept",
  );
  assert.equal(refined.added + refined.skipped, 4);
  assert.ok(refined.retired >= 1);
  assert.ok(
    minimumPairDistance(refined.embeddings) > 0.1,
    "no two kept views are near-copies of each other",
  );
  assert.ok(refined.spread > workerFace.refineGallery(full, []).spread);
});

test("a view the worker's own consensus would not match is never kept", () => {
  const enrolled = [1, 2, 3, 4, 5, 6, 7].map((axis) => view(axis));
  const stranger = view(50, 1.4);
  const refined = workerFace.refineGallery(enrolled, [view(8), stranger]);

  assert.equal(refined.added, 1);
  assert.equal(refined.skipped, 1);
  assert.ok(refined.embeddings.every((embedding) => workerFace.distance(embedding, stranger) > 0.5));
  assert.ok(workerFace.distance(refined.embedding, view(1, 0)) < 0.2);

  assert.equal(workerFace.refineGallery([], []), null);
  assert.equal(workerFace.refineGallery([], [Array(128).fill(0)]), null);
  assert.equal(workerFace.refineGallery([stranger], []).embeddings.length, 1);
});
