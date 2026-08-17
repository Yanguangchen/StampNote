(function initializeFaceIdentity(globalScope) {
  "use strict";

  // MediaPipe has already found each face. Align that small crop by its eyes,
  // ask a recognition network for a numeric descriptor, then immediately clear
  // the crop. Descriptors are used only by person-tracker's in-memory gallery.
  const DEFAULTS = Object.freeze({
    cropSize: 150,
    minimumEyePixels: 12,
    modelPath: "./vendor/face-api/model",
    sampleMs: 1_000,
    enrollmentSamples: 3,
    enrollmentMinimumEyePixels: 52,
    enrollmentMinimumEyeRatio: 0.055,
    enrollmentMaximumRoll: 0.16,
    enrollmentMaximumCenterShift: 0.085,
    enrollmentMaximumScaleShift: 0.28,
    enrollmentMaximumRollShift: 0.14,
    enrollmentConsistencyThreshold: 0.72,
    // Unit normalization makes front/rear-camera distances comparable. Three
    // independently sampled views must agree, and the nearest worker must be
    // clearly separated from the runner-up on every accepted view.
    knownIdentityThreshold: 0.55,
    knownIdentityMargin: 0.08,
    knownIdentityVotes: 3,
  });

  // One page, one recognition network.
  //
  // `createFaceIdentity` is built fresh for every camera start and every
  // enrolment scan, so a cache held per instance was empty each time and asked
  // face-api to load again. Its `faceRecognitionNet` is a module singleton, and
  // loading it a second time replaces its weights without disposing the old
  // ones: 117 tensors, about 21MB, stranded per start, climbing for as long as
  // the page lives. Holding the promise out here means the weights are fetched
  // and uploaded exactly once however often the camera is restarted.
  //
  // Keyed by loader as well as path so an injected loader in a test never reads
  // another test's network, and the real page — which always passes the same
  // hoisted `defaultLoadFaceApi` — always hits.
  const loadedNetworks = new Map();

  const defaultLoadFaceApi = () => import("./vendor/face-api/face-api.esm.js");

  function sharedNetwork(loadFaceApi, modelPath) {
    let byPath = loadedNetworks.get(loadFaceApi);
    if (!byPath) {
      byPath = new Map();
      loadedNetworks.set(loadFaceApi, byPath);
    }

    const cached = byPath.get(modelPath);
    if (cached) return cached;

    const pending = Promise.resolve()
      .then(loadFaceApi)
      .then(async (loaded) => {
        const api = loaded?.default || loaded;
        if (!api?.nets?.faceRecognitionNet) throw new Error("Face recognition model is missing.");
        if (api.tf?.setBackend) {
          try {
            const selected = await api.tf.setBackend("webgl");
            if (!selected) await api.tf.setBackend("cpu");
          } catch {
            await api.tf.setBackend("cpu");
          }
        }
        await api.tf?.ready?.();
        await api.nets.faceRecognitionNet.loadFromUri(modelPath);
        return api;
      })
      .catch((error) => {
        // A refused download is forgotten rather than remembered, so the next
        // camera start gets to try again instead of inheriting the failure.
        byPath.delete(modelPath);
        throw error;
      });

    byPath.set(modelPath, pending);
    return pending;
  }

  function featureCenter(face, feature) {
    const points = (face?.[feature] || [])
      .flat(2)
      .filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y));
    if (points.length === 0) return null;
    return {
      x: points.reduce((total, point) => total + point.x, 0) / points.length,
      y: points.reduce((total, point) => total + point.y, 0) / points.length,
    };
  }

  function sourceSize(source) {
    return {
      width: Number(source?.videoWidth || source?.naturalWidth || source?.width || 0),
      height: Number(source?.videoHeight || source?.naturalHeight || source?.height || 0),
    };
  }

  function createAlignedCrop(body, source, options = {}) {
    const settings = { ...DEFAULTS, ...options };
    const documentRef = settings.document || globalScope.document;
    const { width, height } = sourceSize(source);
    if (!body?.face || !source || !width || !height || !documentRef?.createElement) return null;

    const firstEye = featureCenter(body.face, "eyeLeft");
    const secondEye = featureCenter(body.face, "eyeRight");
    if (!firstEye || !secondEye) return null;
    let leftEye = firstEye;
    let rightEye = secondEye;
    if (leftEye.x > rightEye.x) [leftEye, rightEye] = [rightEye, leftEye];

    const left = { x: leftEye.x * width, y: leftEye.y * height };
    const right = { x: rightEye.x * width, y: rightEye.y * height };
    const dx = right.x - left.x;
    const dy = right.y - left.y;
    const eyeDistance = Math.hypot(dx, dy);
    if (!Number.isFinite(eyeDistance) || eyeDistance < settings.minimumEyePixels) return null;

    const canvas = documentRef.createElement("canvas");
    canvas.width = settings.cropSize;
    canvas.height = settings.cropSize;
    // The crop is only ever drawn to and then uploaded to the recognition
    // network as a texture; its pixels are never read back here. Asking for the
    // readback-friendly canvas moved it off the GPU and made every sample pull
    // the whole camera frame through the CPU to fill 150 pixels square.
    const context = canvas.getContext?.("2d");
    if (!context) return null;

    const desiredCenter = { x: settings.cropSize * 0.5, y: settings.cropSize * 0.4 };
    const desiredEyeDistance = settings.cropSize * 0.36;
    const scale = desiredEyeDistance / eyeDistance;
    const cosine = dx / eyeDistance;
    const sine = dy / eyeDistance;
    const a = scale * cosine;
    const b = -scale * sine;
    const c = scale * sine;
    const d = scale * cosine;
    const sourceCenter = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
    const e = desiredCenter.x - a * sourceCenter.x - c * sourceCenter.y;
    const f = desiredCenter.y - b * sourceCenter.x - d * sourceCenter.y;

    context.fillStyle = "rgb(128, 128, 128)";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.setTransform(a, b, c, d, e, f);
    try {
      context.drawImage(source, 0, 0);
    } catch {
      return null;
    } finally {
      context.resetTransform?.();
    }
    return canvas;
  }

  function normalizedEmbedding(value) {
    const array = ArrayBuffer.isView(value) ? Array.from(value) : value;
    if (!Array.isArray(array) || array.length !== 128 || !array.every(Number.isFinite)) {
      return null;
    }
    const magnitude = Math.sqrt(array.reduce((total, entry) => total + entry ** 2, 0));
    return magnitude > 0 ? array.map((entry) => entry / magnitude) : [...array];
  }

  function embeddingDistance(left, right) {
    const first = normalizedEmbedding(left);
    const second = normalizedEmbedding(right);
    if (!first || !second) return null;
    return Math.sqrt(
      first.reduce((total, value, index) => total + (value - second[index]) ** 2, 0),
    );
  }

  function averageEmbedding(samples) {
    const valid = (samples || []).map(normalizedEmbedding).filter(Boolean);
    if (valid.length === 0) return null;
    const averaged = Array.from({ length: 128 }, (_, index) =>
      valid.reduce((total, sample) => total + sample[index], 0) / valid.length,
    );
    const magnitude = Math.sqrt(averaged.reduce((total, value) => total + value ** 2, 0));
    return magnitude > 0 ? averaged.map((value) => value / magnitude) : averaged;
  }

  function normalizedIdentity(value) {
    const workerId = String(value?.workerId || "").trim().toUpperCase();
    const embeddings = [
      ...(Array.isArray(value?.embeddings) ? value.embeddings : []),
      value?.embedding,
    ]
      .map(normalizedEmbedding)
      .filter(Boolean)
      .filter(
        (candidate, index, gallery) =>
          gallery.findIndex((saved) => embeddingDistance(saved, candidate) < 0.000001) === index,
      )
      .slice(0, 7);
    if (!/^[A-Z0-9][A-Z0-9_-]{1,31}$/.test(workerId) || embeddings.length === 0) {
      return null;
    }
    const displayName = String(value?.displayName || "").trim().replace(/\s+/g, " ");
    return {
      workerId,
      displayName: displayName || null,
      personLabel: displayName || workerId,
      embedding: embeddings[0],
      embeddings,
    };
  }

  function evaluateKnownIdentity(embedding, identities, settings = DEFAULTS) {
    const ranked = identities
      .map((identity) => ({
        identity,
        distance: identity.embeddings
          .map((template) => embeddingDistance(embedding, template))
          .filter(Number.isFinite)
          .sort((left, right) => left - right)[0] ?? null,
      }))
      .filter((candidate) => Number.isFinite(candidate.distance))
      .sort((left, right) => left.distance - right.distance);
    const nearest = ranked[0];
    if (!nearest) return { match: null, nearest: null, reason: "no_template" };
    if (nearest.distance > settings.knownIdentityThreshold) {
      return { match: null, nearest, reason: "too_far" };
    }
    if (
      ranked[1] &&
      ranked[1].distance - nearest.distance < settings.knownIdentityMargin
    ) {
      // Repeated ambiguity is still ambiguity. Returning the nearest worker as
      // a match here allowed the same uncertain candidate to collect enough
      // votes to record attendance under the wrong name.
      return {
        match: null,
        nearest,
        runnerUp: ranked[1],
        reason: "ambiguous",
      };
    }
    return {
      match: { ...nearest.identity, distance: nearest.distance },
      nearest,
      reason: "matched",
    };
  }

  function matchKnownIdentity(embedding, identities, settings) {
    const normalized = (identities || []).map(normalizedIdentity).filter(Boolean);
    return evaluateKnownIdentity(embedding, normalized, { ...DEFAULTS, ...settings }).match;
  }

  function enrollmentQuality(body, source, settings) {
    const { width, height } = sourceSize(source);
    if (!body?.face || !width || !height) return { status: "no_face" };
    const firstEye = featureCenter(body.face, "eyeLeft");
    const secondEye = featureCenter(body.face, "eyeRight");
    if (!firstEye || !secondEye) return { status: "no_face" };

    const dx = (secondEye.x - firstEye.x) * width;
    const dy = (secondEye.y - firstEye.y) * height;
    const eyeDistance = Math.hypot(dx, dy);
    const requiredDistance = Math.max(
      settings.enrollmentMinimumEyePixels,
      width * settings.enrollmentMinimumEyeRatio,
    );
    const centerX = (firstEye.x + secondEye.x) / 2;
    const centerY = (firstEye.y + secondEye.y) / 2;
    const roll = dy / Math.max(1, eyeDistance);
    const geometry = {
      centerX,
      centerY,
      eyeRatio: eyeDistance / Math.max(1, width),
      roll,
    };
    if (!Number.isFinite(eyeDistance) || eyeDistance < requiredDistance) {
      return { status: "move_closer", geometry };
    }
    if (Math.abs(roll) > settings.enrollmentMaximumRoll) {
      return { status: "look_straight", geometry };
    }

    if (centerX < 0.25 || centerX > 0.75 || centerY < 0.16 || centerY > 0.58) {
      return { status: "center_face", geometry };
    }
    return { status: "ready", eyeDistance, geometry };
  }

  function enrollmentIsStable(previous, current, settings) {
    if (!previous || !current) return true;
    const centerShift = Math.hypot(
      current.centerX - previous.centerX,
      current.centerY - previous.centerY,
    );
    const scaleShift =
      Math.abs(current.eyeRatio - previous.eyeRatio) / Math.max(0.001, previous.eyeRatio);
    const rollShift = Math.abs(current.roll - previous.roll);
    return (
      centerShift <= settings.enrollmentMaximumCenterShift &&
      scaleShift <= settings.enrollmentMaximumScaleShift &&
      rollShift <= settings.enrollmentMaximumRollShift
    );
  }

  function createFaceIdentity(options = {}) {
    const settings = { ...DEFAULTS, ...options };
    const loadFaceApi = options.loadFaceApi || defaultLoadFaceApi;
    let faceApi = options.faceApi || null;
    let loading = null;
    let failed = false;
    let lastSampleAt = -Infinity;
    let enrollmentSamples = 0;
    let enrollmentStatus = faceApi ? "no_face" : "loading";
    let enrollmentMatches = [];
    let enrollmentEmbeddings = [];
    let lastEnrollmentGeometry = null;
    let matchedIdentity = null;
    let matchDiagnostic = null;
    const knownIdentities = (options.knownIdentities || []).map(normalizedIdentity).filter(Boolean);

    function enrollmentState() {
      return {
        required: true,
        status: failed ? "unavailable" : enrollmentStatus,
        samples: enrollmentSamples,
        total: settings.enrollmentSamples,
        progress: Math.min(1, enrollmentSamples / settings.enrollmentSamples),
        workerId: matchedIdentity?.workerId || null,
        personLabel: matchedIdentity?.personLabel || null,
        ...(knownIdentities.length > 0
          ? {
              candidateWorkerId: matchDiagnostic?.workerId || null,
              matchDistance: Number.isFinite(matchDiagnostic?.distance)
                ? matchDiagnostic.distance
                : null,
              matchThreshold: settings.knownIdentityThreshold,
              matchReason: matchDiagnostic?.reason || "waiting",
              matchVotes: matchDiagnostic?.votes || 0,
              requiredVotes: Math.min(
                settings.knownIdentityVotes,
                settings.enrollmentSamples,
              ),
            }
          : {}),
      };
    }

    async function load() {
      if (faceApi) return faceApi;
      if (loading) return loading;
      loading = sharedNetwork(loadFaceApi, settings.modelPath)
        .then((api) => {
          faceApi = api;
          failed = false;
          if (enrollmentStatus === "loading") enrollmentStatus = "no_face";
          return api;
        })
        .catch((error) => {
          failed = true;
          throw error;
        });
      return loading;
    }

    async function describe(bodies = [], source = null, timestamp = Date.now()) {
      if (!faceApi) {
        if (!failed) load().catch(() => {});
        enrollmentStatus = failed ? "unavailable" : "loading";
        return bodies;
      }
      const enrolling = enrollmentStatus !== "complete";
      if (enrolling && bodies.length > 1) {
        enrollmentStatus = "one_person";
        lastEnrollmentGeometry = null;
        return bodies;
      }
      if (enrolling) {
        const quality = enrollmentQuality(bodies[0], source, settings);
        if (quality.status !== "ready") {
          enrollmentStatus = quality.status;
          lastEnrollmentGeometry = null;
          return bodies;
        }
        if (!enrollmentIsStable(lastEnrollmentGeometry, quality.geometry, settings)) {
          enrollmentStatus = "hold_still";
          lastEnrollmentGeometry = quality.geometry;
          return bodies;
        }
        lastEnrollmentGeometry = quality.geometry;
      }
      if (timestamp - lastSampleAt < settings.sampleMs) return bodies;

      const candidates = enrolling ? bodies.slice(0, 1) : bodies;
      const prepared = candidates
        .map((body, index) => ({
          body,
          index,
          crop: createAlignedCrop(body, source, settings),
        }))
        .filter((entry) => entry.crop);
      if (prepared.length === 0) return bodies;
      lastSampleAt = timestamp;

      try {
        const input = prepared.length === 1 ? prepared[0].crop : prepared.map((entry) => entry.crop);
        const result = await faceApi.nets.faceRecognitionNet.computeFaceDescriptor(input);
        const descriptors = prepared.length === 1 ? [result] : result;
        const enriched = [...bodies];
        prepared.forEach((entry, descriptorIndex) => {
          const faceEmbedding = normalizedEmbedding(descriptors?.[descriptorIndex]);
          if (faceEmbedding) {
            let enrollmentAccepted = false;
            if (enrolling) {
              if (knownIdentities.length > 0) {
                const evaluation = evaluateKnownIdentity(
                  faceEmbedding,
                  knownIdentities,
                  settings,
                );
                const match = evaluation.match;
                enrollmentAccepted = Boolean(match);
                enrollmentMatches.push(match);
                if (enrollmentMatches.length > settings.enrollmentSamples) {
                  enrollmentMatches.shift();
                }
                enrollmentSamples = enrollmentMatches.length;
                const votes = new Map();
                enrollmentMatches.filter(Boolean).forEach((candidate) => {
                  const vote = votes.get(candidate.workerId) || { count: 0, candidate };
                  vote.count += 1;
                  if (candidate.distance < vote.candidate.distance) vote.candidate = candidate;
                  votes.set(candidate.workerId, vote);
                });
                const winner = [...votes.values()].sort((left, right) => right.count - left.count)[0];
                const diagnosticCandidate = winner?.candidate || evaluation.nearest?.identity || null;
                matchDiagnostic = {
                  workerId: diagnosticCandidate?.workerId || null,
                  distance: winner?.candidate?.distance ?? evaluation.nearest?.distance ?? null,
                  reason: evaluation.reason,
                  votes: winner?.count || 0,
                };
                if (
                  enrollmentMatches.length >= settings.enrollmentSamples &&
                  winner?.count >= Math.min(settings.knownIdentityVotes, settings.enrollmentSamples)
                ) {
                  matchedIdentity = winner.candidate;
                  enrollmentStatus = "complete";
                } else {
                  enrollmentStatus =
                    enrollmentMatches.length >= settings.enrollmentSamples
                      ? "retrying"
                      : "scanning";
                }
              } else {
                const reference = averageEmbedding(enrollmentEmbeddings);
                const separation = reference
                  ? embeddingDistance(faceEmbedding, reference)
                  : 0;
                if (
                  reference &&
                  (!Number.isFinite(separation) ||
                    separation > settings.enrollmentConsistencyThreshold)
                ) {
                  enrollmentStatus = "face_changed";
                } else {
                  enrollmentEmbeddings.push(faceEmbedding);
                  enrollmentSamples = enrollmentEmbeddings.length;
                  enrollmentAccepted = true;
                  enrollmentStatus =
                    enrollmentSamples >= settings.enrollmentSamples ? "complete" : "scanning";
                }
              }
            }
            enriched[entry.index] = {
              ...entry.body,
              faceEmbedding,
              ...(enrolling ? { enrollmentAccepted } : {}),
            };
          }
        });
        return enriched;
      } catch {
        if (enrolling) enrollmentStatus = "unavailable";
        return bodies;
      } finally {
        prepared.forEach(({ crop }) => {
          const context = crop.getContext?.("2d");
          context?.clearRect?.(0, 0, crop.width, crop.height);
          crop.width = 1;
          crop.height = 1;
        });
      }
    }

    function reset() {
      lastSampleAt = -Infinity;
      enrollmentSamples = 0;
      enrollmentMatches = [];
      enrollmentEmbeddings = [];
      lastEnrollmentGeometry = null;
      matchedIdentity = null;
      matchDiagnostic = null;
      enrollmentStatus = failed ? "unavailable" : faceApi ? "no_face" : "loading";
    }

    function status() {
      return faceApi ? "ready" : failed ? "unavailable" : loading ? "loading" : "idle";
    }

    return Object.freeze({ describe, enrollmentState, load, reset, status });
  }

  const api = Object.freeze({
    DEFAULTS,
    createAlignedCrop,
    createFaceIdentity,
    embeddingDistance,
    evaluateKnownIdentity,
    matchKnownIdentity,
  });
  globalScope.StampNoteFaceIdentity = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
