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
