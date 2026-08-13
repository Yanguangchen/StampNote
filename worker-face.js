(function initializeWorkerFace(globalScope) {
  "use strict";

  const EMBEDDING_LENGTH = 128;
  const MATCH_THRESHOLD = 0.68;
  const MAX_TEMPLATES = 7;

  function normalizeWorkerId(value) {
    const normalized = String(value || "").trim().toUpperCase();
    return /^[A-Z0-9][A-Z0-9_-]{1,31}$/.test(normalized) ? normalized : null;
  }

  function normalizeDisplayName(value) {
    const normalized = String(value || "").trim().replace(/\s+/g, " ");
    return normalized.length > 0 && normalized.length <= 60 ? normalized : null;
  }

  function normalizeEmbedding(value) {
    const array = ArrayBuffer.isView(value) ? Array.from(value) : value;
    if (
      !Array.isArray(array) ||
      array.length !== EMBEDDING_LENGTH ||
      !array.every((entry) => Number.isFinite(entry) && Math.abs(entry) <= 10)
    ) {
      return null;
    }
    const numeric = array.map(Number);
    const magnitude = Math.sqrt(numeric.reduce((total, entry) => total + entry ** 2, 0));
    return magnitude > 0 ? numeric.map((entry) => entry / magnitude) : numeric;
  }

  function distance(left, right) {
    const first = normalizeEmbedding(left);
    const second = normalizeEmbedding(right);
    if (!first || !second) return null;
    return Math.sqrt(
      first.reduce((total, value, index) => total + (value - second[index]) ** 2, 0),
    );
  }

  function averageEmbeddings(samples) {
    const valid = (samples || []).map(normalizeEmbedding).filter(Boolean);
    if (valid.length === 0) return null;
    const averaged = Array.from({ length: EMBEDDING_LENGTH }, (_, index) =>
      valid.reduce((total, sample) => total + sample[index], 0) / valid.length,
    );
    const magnitude = Math.sqrt(averaged.reduce((total, value) => total + value ** 2, 0));
    return magnitude > 0 ? averaged.map((value) => value / magnitude) : averaged;
  }

  function normalizeEmbeddings(values, fallback = null) {
    const candidates = Array.isArray(values) ? values : [];
    const normalized = candidates.map(normalizeEmbedding).filter(Boolean);
    const fallbackEmbedding = normalizeEmbedding(fallback);
    if (fallbackEmbedding) normalized.push(fallbackEmbedding);
    const unique = [];
    normalized.forEach((embedding) => {
      if (!unique.some((saved) => distance(saved, embedding) < 0.000001)) {
        unique.push(embedding);
      }
    });
    return unique.slice(0, MAX_TEMPLATES);
  }

  function match(embedding, workers = [], options = {}) {
    const candidate = normalizeEmbedding(embedding);
    if (!candidate) return null;
    const threshold = Number.isFinite(options.threshold)
      ? options.threshold
      : MATCH_THRESHOLD;

    return workers
      .map((worker) => {
        const workerId = normalizeWorkerId(worker?.workerId);
        const workerEmbeddings = normalizeEmbeddings(worker?.embeddings, worker?.embedding);
        const separation = workerEmbeddings
          .map((template) => distance(candidate, template))
          .filter(Number.isFinite)
          .sort((left, right) => left - right)[0] ?? null;
        return workerId && separation !== null
          ? {
              workerId,
              displayName: normalizeDisplayName(worker?.displayName),
              personLabel: normalizeDisplayName(worker?.displayName) || workerId,
              distance: separation,
            }
          : null;
      })
      .filter((result) => result && result.distance <= threshold)
      .sort((left, right) => left.distance - right.distance)[0] || null;
  }

  const api = Object.freeze({
    EMBEDDING_LENGTH,
    MAX_TEMPLATES,
    MATCH_THRESHOLD,
    averageEmbeddings,
    distance,
    match,
    normalizeDisplayName,
    normalizeEmbedding,
    normalizeEmbeddings,
    normalizeWorkerId,
  });

  globalScope.StampNoteWorkerFace = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
