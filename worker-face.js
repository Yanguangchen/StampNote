(function initializeWorkerFace(globalScope) {
  "use strict";

  const EMBEDDING_LENGTH = 128;
  const MATCH_THRESHOLD = 0.6;
  const MATCH_MARGIN = 0.08;
  // Enrollment stores seven views. The remaining room is filled by improvement
  // scans a worker opts into, so a profile can grow to cover the light, angles
  // and camera they are actually seen with.
  const MAX_TEMPLATES = 12;
  // A view further than this from the worker's own consensus is one the
  // consensus would not match either, so keeping it would widen the profile
  // towards other people rather than cover more of this one.
  const REFINE_OUTLIER_DISTANCE = MATCH_THRESHOLD;

  function normalizeWorkerId(value) {
    const normalized = String(value || "").trim().toUpperCase();
    return /^[A-Z0-9][A-Z0-9_-]{1,31}$/.test(normalized) ? normalized : null;
  }

  function normalizeDisplayName(value) {
    const normalized = String(value || "").trim().replace(/\s+/g, " ");
    return normalized.length > 0 && normalized.length <= 60 ? normalized : null;
  }

  const ID_SEQUENCE_DIGITS = 4;
  // Nothing in a name is guaranteed to be a letter A–Z — a name written in
  // another script leaves none at all — and an ID has to be, so those fall back
  // to a prefix that at least says what the record is.
  const ID_FALLBACK_PREFIX = "WK";

  // Initials: the first letter of the first name and of the last. A mononym has
  // no last name to take one from, so it gives up its first two letters instead,
  // which keeps every prefix two characters wide.
  function workerIdPrefix(displayName) {
    const names = String(displayName || "")
      .toUpperCase()
      .split(/[^A-Z]+/)
      .filter(Boolean);
    if (names.length === 0) return ID_FALLBACK_PREFIX;
    if (names.length === 1) return names[0].slice(0, 2);
    return `${names[0][0]}${names[names.length - 1][0]}`;
  }

  function formatWorkerId(prefix, sequence) {
    return `${prefix}-${String(sequence).padStart(ID_SEQUENCE_DIGITS, "0")}`;
  }

  // The number counts up within a prefix, so two people called Ari Tan become
  // AT-0001 and AT-0002 rather than one record holding both their faces.
  //
  // It counts from the highest already issued, not from how many exist, so a
  // deletion leaves its number spent rather than handing it to the next worker
  // enrolled — an ID that has been written on a badge or read out on a site
  // should not come back meaning somebody else.
  function nextWorkerId(displayName, takenIds = []) {
    const prefix = workerIdPrefix(displayName);
    // Built from A–Z only, so it carries nothing a regular expression would read
    // as syntax.
    const issued = new RegExp(`^${prefix}-(\\d+)$`);
    const taken = new Set();
    let highest = 0;

    (Array.isArray(takenIds) ? takenIds : []).forEach((value) => {
      const id = String(value || "").trim().toUpperCase();
      if (!id) return;
      taken.add(id);
      const match = issued.exec(id);
      if (match) highest = Math.max(highest, Number(match[1]));
    });

    let sequence = highest + 1;
    let candidate = formatWorkerId(prefix, sequence);
    // A prefix whose numbering has been sidestepped — an ID typed by hand before
    // this existed — must still not be written over.
    while (taken.has(candidate)) candidate = formatWorkerId(prefix, ++sequence);
    return normalizeWorkerId(candidate);
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

  function uniqueEmbeddings(values) {
    const unique = [];
    (Array.isArray(values) ? values : []).forEach((value) => {
      const embedding = normalizeEmbedding(value);
      // An all-zero vector has no direction, so it describes nobody.
      if (!embedding || embedding.every((entry) => entry === 0)) return;
      if (!unique.some((saved) => distance(saved, embedding) < 0.000001)) {
        unique.push(embedding);
      }
    });
    return unique;
  }

  // Folds the views from an improvement scan into a worker's saved gallery.
  //
  // Every scan is pooled with what is already stored, then views the pooled
  // consensus would not itself match are dropped as bad captures. What is left
  // is chosen for coverage: the most typical view first, then repeatedly the
  // view least like anything already chosen. So while there is room every
  // consistent view is kept, and once the gallery is full a new scan only
  // displaces a view it makes redundant — each opt-in scan can widen what the
  // profile recognises, and none can narrow it to one afternoon's lighting.
  function refineGallery(saved, incoming, options = {}) {
    const max = Math.max(1, Math.floor(Number(options.max) || MAX_TEMPLATES));
    const outlierDistance = Number.isFinite(options.outlierDistance)
      ? options.outlierDistance
      : REFINE_OUTLIER_DISTANCE;
    const savedViews = uniqueEmbeddings(saved);
    const freshViews = uniqueEmbeddings(incoming).filter(
      (view) => !savedViews.some((kept) => distance(kept, view) < 0.000001),
    );
    const pool = [
      ...savedViews.map((embedding) => ({ embedding, fresh: false })),
      ...freshViews.map((embedding) => ({ embedding, fresh: true })),
    ];
    if (pool.length === 0) return null;

    const pooledCenter = averageEmbeddings(pool.map((view) => view.embedding));
    const nearestToCenter = (views, center) =>
      views.reduce((best, view) =>
        distance(view.embedding, center) < distance(best.embedding, center) ? view : best,
      );
    let consistent = pool.filter(
      (view) => distance(view.embedding, pooledCenter) <= outlierDistance,
    );
    // A gallery is never emptied: with nothing consistent, the most typical
    // view still stands for the worker.
    if (consistent.length === 0) consistent = [nearestToCenter(pool, pooledCenter)];

    const embedding = averageEmbeddings(consistent.map((view) => view.embedding));
    const selected = [nearestToCenter(consistent, embedding)];
    let remaining = consistent.filter((view) => view !== selected[0]);
    while (selected.length < max && remaining.length > 0) {
      let best = null;
      let bestGap = -Infinity;
      // Saved views come first in the pool, so a tie keeps what is stored.
      remaining.forEach((view) => {
        const gap = Math.min(...selected.map((kept) => distance(kept.embedding, view.embedding)));
        if (gap > bestGap) {
          best = view;
          bestGap = gap;
        }
      });
      selected.push(best);
      remaining = remaining.filter((view) => view !== best);
    }

    const keptSaved = selected.filter((view) => !view.fresh).length;
    const added = selected.length - keptSaved;
    return {
      embedding,
      embeddings: selected.map((view) => view.embedding),
      // Views from this scan that made it into the gallery.
      added,
      // Views from this scan left out: redundant with the gallery, or outliers.
      skipped: freshViews.length - added,
      // Saved views this scan made redundant, or showed to be outliers.
      retired: savedViews.length - keptSaved,
      // How widely the kept views spread around the consensus. It grows as
      // scans in new conditions are added.
      spread:
        selected.reduce((total, view) => total + distance(view.embedding, embedding), 0) /
        selected.length,
    };
  }

  function match(embedding, workers = [], options = {}) {
    const candidate = normalizeEmbedding(embedding);
    if (!candidate) return null;
    const threshold = Number.isFinite(options.threshold)
      ? options.threshold
      : MATCH_THRESHOLD;

    const ranked = workers
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
      .sort((left, right) => left.distance - right.distance);
    const nearest = ranked[0];
    if (!nearest) return null;
    const margin = Number.isFinite(options.margin) ? options.margin : MATCH_MARGIN;
    if (ranked[1] && ranked[1].distance - nearest.distance < margin) return null;
    return nearest;
  }

  const api = Object.freeze({
    EMBEDDING_LENGTH,
    MAX_TEMPLATES,
    MATCH_MARGIN,
    MATCH_THRESHOLD,
    REFINE_OUTLIER_DISTANCE,
    averageEmbeddings,
    distance,
    match,
    nextWorkerId,
    normalizeDisplayName,
    normalizeEmbedding,
    normalizeEmbeddings,
    normalizeWorkerId,
    refineGallery,
    workerIdPrefix,
  });

  globalScope.StampNoteWorkerFace = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
