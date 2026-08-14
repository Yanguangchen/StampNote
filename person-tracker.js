(function initializePersonTracker(globalScope) {
  "use strict";

  // Anonymous, camera-session identity tracking. This uses body geometry,
  // motion, coarse clothing colour, face landmarks and an aligned greyscale
  // facial texture. The biometric hints have no name or image crop and never
  // reach storage, telemetry, the network or public UI state; reset() destroys
  // them. Dormant tracks remain available for the whole run so a returner keeps
  // their number.
  const DEFAULTS = Object.freeze({
    missingMs: 10_000,
    maximumDistance: 0.32,
    activeAppearanceDistance: 0.58,
    reentryAppearanceDistance: 0.46,
    reentryCorroboratedAppearanceDistance: 0.68,
    reentryCorroboratingGeometryDistance: 0.1,
    reentryEdgeAppearanceDistance: 0.76,
    reentryGeometryDistance: 0.12,
    appearanceGallerySize: 10,
    appearanceSampleMs: 1_500,
    faceReentryDistance: 0.14,
    faceMismatchDistance: 0.3,
    faceGallerySize: 10,
    faceSampleMs: 1_000,
    faceTextureReentryDistance: 0.38,
    faceTextureMismatchDistance: 0.9,
    faceTextureGallerySize: 10,
    faceTextureSampleMs: 1_000,
    faceEmbeddingReentryDistance: 0.55,
    faceEmbeddingMismatchDistance: 0.72,
    faceEmbeddingGallerySize: 10,
    faceEmbeddingSampleMs: 1_000,
    velocitySmoothing: 0.2,
  });
  const APPEARANCE_BINS = 32;
  const IDENTITY_FRAME_WIDTH = 192;
  const IDENTITY_FRAME_HEIGHT = 144;
  const FACE_TEXTURE_COLUMNS = 12;
  const FACE_TEXTURE_ROWS = 14;

  function clamp(value, minimum = 0, maximum = 1) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function midpoint(left, right) {
    if (!left) return right || null;
    if (!right) return left;
    return { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
  }

  function centerOf(body) {
    return (
      body?.keypoints?.torso ||
      midpoint(body?.keypoints?.shoulderLeft, body?.keypoints?.shoulderRight) ||
      (body?.box
        ? {
            x: body.box.x + body.box.width / 2,
            y: body.box.y + body.box.height / 2,
          }
        : null)
    );
  }

  function pointDistance(left, right) {
    return left && right ? Math.hypot(left.x - right.x, left.y - right.y) : Infinity;
  }

  function span(left, right) {
    return left && right ? Math.hypot(left.x - right.x, left.y - right.y) : null;
  }

  // Proportions help distinguish people who cross paths without becoming a
  // biometric template. They are transient ratios from the currently visible
  // skeleton and are discarded when the camera session ends.
  function signatureOf(body) {
    const height = Math.max(0.01, body?.box?.height || 0);
    const width = Math.max(0.01, body?.box?.width || 0);
    const points = body?.keypoints || {};
    const shoulders = span(points.shoulderLeft, points.shoulderRight);
    const hips = span(points.hipLeft, points.hipRight);
    const trunk = pointDistance(
      midpoint(points.shoulderLeft, points.shoulderRight),
      midpoint(points.hipLeft, points.hipRight),
    );

    return [
      Math.log(width / height),
      shoulders === null ? null : shoulders / height,
      hips === null ? null : hips / height,
      Number.isFinite(trunk) ? trunk / height : null,
    ];
  }

  function signatureDistance(left, right) {
    const differences = left
      .map((value, index) =>
        Number.isFinite(value) && Number.isFinite(right[index])
          ? Math.abs(value - right[index])
          : null,
      )
      .filter(Number.isFinite);

    return differences.length
      ? differences.reduce((total, value) => total + value, 0) / differences.length
      : 0;
  }

  function normalizedAppearance(value) {
    if (!Array.isArray(value) || value.length !== APPEARANCE_BINS) return null;
    const safe = value.map((entry) => (Number.isFinite(entry) && entry >= 0 ? entry : 0));
    const total = safe.reduce((sum, entry) => sum + entry, 0);
    return total > 0 ? safe.map((entry) => entry / total) : null;
  }

  function appearanceDistance(left, right) {
    const first = normalizedAppearance(left);
    const second = normalizedAppearance(right);
    if (!first || !second) return null;
    return first.reduce((total, value, index) => total + Math.abs(value - second[index]), 0) / 2;
  }

  function normalizedFaceSignature(value) {
    if (!Array.isArray(value) || value.length < 20 || !value.every(Number.isFinite)) return null;
    return [...value];
  }

  function faceSignatureDistance(left, right) {
    const first = normalizedFaceSignature(left);
    const second = normalizedFaceSignature(right);
    if (!first || !second || first.length !== second.length) return null;
    return Math.sqrt(
      first.reduce((total, value, index) => total + (value - second[index]) ** 2, 0) /
        first.length,
    );
  }

  function normalizedFaceTexture(value) {
    if (
      !Array.isArray(value) ||
      value.length !== FACE_TEXTURE_COLUMNS * FACE_TEXTURE_ROWS ||
      !value.every(Number.isFinite)
    ) {
      return null;
    }
    const mean = value.reduce((total, entry) => total + entry, 0) / value.length;
    const variance =
      value.reduce((total, entry) => total + (entry - mean) ** 2, 0) / value.length;
    const deviation = Math.sqrt(variance);
    // Raw camera luminance commonly has a much larger deviation, while a
    // descriptor already normalized by faceTextureOf() has deviation ~= 1.
    // Accept both; reject only a genuinely featureless patch.
    if (deviation < 0.05) return null;
    return value.map((entry) => (entry - mean) / deviation);
  }

  function faceTextureDistance(left, right) {
    const first = normalizedFaceTexture(left);
    const second = normalizedFaceTexture(right);
    if (!first || !second) return null;
    const correlation =
      first.reduce((total, value, index) => total + value * second[index], 0) /
      first.length;
    return clamp(1 - correlation, 0, 2);
  }

  function normalizedFaceEmbedding(value) {
    const array = ArrayBuffer.isView(value) ? Array.from(value) : value;
    if (!Array.isArray(array) || array.length !== 128 || !array.every(Number.isFinite)) {
      return null;
    }
    const magnitude = Math.sqrt(array.reduce((total, entry) => total + entry ** 2, 0));
    return magnitude > 0 ? array.map((entry) => entry / magnitude) : [...array];
  }

  // The face recognition network is trained so Euclidean distance in this
  // 128-value space represents identity similarity. Unlike landmark geometry,
  // it can distinguish faces with the same broad proportions.
  function faceEmbeddingDistance(left, right) {
    const first = normalizedFaceEmbedding(left);
    const second = normalizedFaceEmbedding(right);
    if (!first || !second) return null;
    return Math.sqrt(
      first.reduce((total, value, index) => total + (value - second[index]) ** 2, 0),
    );
  }

  // Thirty-two coarse bins: twelve hues and four greys, separately for the
  // upper and lower torso. This is enough to tell a red shirt from a blue one
  // without retaining an image or a face descriptor.
  function appearanceOf(body, frame) {
    const box = body?.box;
    const width = Math.floor(Number(frame?.width) || 0);
    const height = Math.floor(Number(frame?.height) || 0);
    const pixels = frame?.data;
    if (!box || !width || !height || !pixels || pixels.length < width * height * 4) return null;

    const left = Math.floor(clamp(box.x + box.width * 0.2) * width);
    const right = Math.ceil(clamp(box.x + box.width * 0.8) * width);
    const top = Math.floor(clamp(box.y + box.height * 0.24) * height);
    const bottom = Math.ceil(clamp(box.y + box.height * 0.72) * height);
    const split = Math.floor(clamp(box.y + box.height * 0.48) * height);
    if (right <= left || bottom <= top) return null;

    const histogram = new Array(APPEARANCE_BINS).fill(0);
    let samples = 0;
    const stride = Math.max(1, Math.floor(Math.min(right - left, bottom - top) / 18));

    for (let y = top; y < bottom; y += stride) {
      for (let x = left; x < right; x += stride) {
        const offset = (y * width + x) * 4;
        if ((pixels[offset + 3] ?? 255) < 128) continue;

        const red = pixels[offset] / 255;
        const green = pixels[offset + 1] / 255;
        const blue = pixels[offset + 2] / 255;
        const maximum = Math.max(red, green, blue);
        const minimum = Math.min(red, green, blue);
        const delta = maximum - minimum;
        const saturation = maximum === 0 ? 0 : delta / maximum;
        let bin;

        if (saturation < 0.16 || delta === 0) {
          bin = 12 + Math.min(3, Math.floor(maximum * 4));
        } else {
          let hue;
          if (maximum === red) hue = ((green - blue) / delta + 6) % 6;
          else if (maximum === green) hue = (blue - red) / delta + 2;
          else hue = (red - green) / delta + 4;
          bin = Math.min(11, Math.floor((hue / 6) * 12));
        }

        const section = y < split ? 0 : 16;
        if (bin < 12) {
          // Spread hue boundaries into their neighbours so a small white-
          // balance change does not turn one shirt into a different identity.
          histogram[section + bin] += 0.5;
          histogram[section + ((bin + 11) % 12)] += 0.25;
          histogram[section + ((bin + 1) % 12)] += 0.25;
        } else {
          histogram[section + bin] += 0.7;
          if (bin > 12) histogram[section + bin - 1] += 0.15;
          else histogram[section + bin] += 0.15;
          if (bin < 15) histogram[section + bin + 1] += 0.15;
          else histogram[section + bin] += 0.15;
        }
        samples += 1;
      }
    }

    return samples >= 8 ? normalizedAppearance(histogram) : null;
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

  function lumaAt(frame, x, y) {
    const width = frame.width;
    const height = frame.height;
    if (x < 0 || y < 0 || x >= width - 1 || y >= height - 1) return null;
    const left = Math.floor(x);
    const top = Math.floor(y);
    const dx = x - left;
    const dy = y - top;
    const read = (sampleX, sampleY) => {
      const offset = (sampleY * width + sampleX) * 4;
      return (
        frame.data[offset] * 0.2126 +
        frame.data[offset + 1] * 0.7152 +
        frame.data[offset + 2] * 0.0722
      );
    };
    return (
      read(left, top) * (1 - dx) * (1 - dy) +
      read(left + 1, top) * dx * (1 - dy) +
      read(left, top + 1) * (1 - dx) * dy +
      read(left + 1, top + 1) * dx * dy
    );
  }

  // Classical aligned face recognition: the landmarker supplies both eye
  // positions, which rotate and scale a small greyscale face patch into a
  // canonical grid. Per-patch normalization removes global brightness. Only
  // the normalized numbers survive, never the crop or its pixels.
  function faceTextureOf(body, frame) {
    if (!body?.face || !frame?.data || !frame.width || !frame.height) return null;
    const firstEye = featureCenter(body.face, "eyeLeft");
    const secondEye = featureCenter(body.face, "eyeRight");
    if (!firstEye || !secondEye) return null;

    let leftEye = firstEye;
    let rightEye = secondEye;
    if (leftEye.x > rightEye.x) [leftEye, rightEye] = [rightEye, leftEye];
    const left = { x: leftEye.x * frame.width, y: leftEye.y * frame.height };
    const right = { x: rightEye.x * frame.width, y: rightEye.y * frame.height };
    const eyeDistance = pointDistance(left, right);
    if (!Number.isFinite(eyeDistance) || eyeDistance < 3) return null;

    const horizontal = {
      x: (right.x - left.x) / eyeDistance,
      y: (right.y - left.y) / eyeDistance,
    };
    const vertical = { x: -horizontal.y, y: horizontal.x };
    const center = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
    const texture = [];

    for (let row = 0; row < FACE_TEXTURE_ROWS; row += 1) {
      const verticalOffset = -0.8 + (row / (FACE_TEXTURE_ROWS - 1)) * 2.75;
      for (let column = 0; column < FACE_TEXTURE_COLUMNS; column += 1) {
        const horizontalOffset = -1.35 + (column / (FACE_TEXTURE_COLUMNS - 1)) * 2.7;
        const sampleX =
          center.x +
          horizontal.x * horizontalOffset * eyeDistance +
          vertical.x * verticalOffset * eyeDistance;
        const sampleY =
          center.y +
          horizontal.y * horizontalOffset * eyeDistance +
          vertical.y * verticalOffset * eyeDistance;
        const value = lumaAt(frame, sampleX, sampleY);
        if (value === null) return null;
        texture.push(value);
      }
    }

    return normalizedFaceTexture(texture);
  }

  function blendVector(previous, next, amount = 0.2) {
    if (!previous) return next;
    if (!next) return previous;
    return previous.map((value, index) => {
      if (!Number.isFinite(value)) return next[index];
      if (!Number.isFinite(next[index])) return value;
      return value + (next[index] - value) * amount;
    });
  }

  function trackAppearanceDistance(track, appearance) {
    const candidate = normalizedAppearance(appearance);
    if (!candidate) return null;

    const samples = [track.appearance, ...(track.appearances || [])]
      .map(normalizedAppearance)
      .filter(Boolean);
    if (samples.length === 0) return null;
    return Math.min(...samples.map((sample) => appearanceDistance(sample, candidate)));
  }

  // One running average is fragile: a turn, a shadow, or a jacket opening can
  // gradually erase the sample from when someone first entered. Keep a small,
  // diverse gallery instead. It remains only in memory and is cleared on stop.
  function rememberAppearance(track, appearance, timestamp, settings) {
    const sample = normalizedAppearance(appearance);
    if (!sample) return;

    track.appearance = blendVector(track.appearance, sample, 0.12);
    track.appearances ||= [];
    const distances = track.appearances.map((entry) => appearanceDistance(entry, sample));
    const nearest = distances.length ? Math.min(...distances) : Infinity;
    const recentlySampled = timestamp - (track.lastAppearanceAt || 0) < settings.appearanceSampleMs;
    if (recentlySampled && nearest < 0.08) return;

    if (track.appearances.length < settings.appearanceGallerySize) {
      track.appearances.push(sample);
      track.lastAppearanceAt = timestamp;
      return;
    }

    // Replace the most redundant stored view only when this view adds more
    // variety. The first useful views therefore survive a long camera run.
    let redundantIndex = 0;
    let redundantDistance = Infinity;
    track.appearances.forEach((entry, index) => {
      track.appearances.forEach((other, otherIndex) => {
        if (index === otherIndex) return;
        const distance = appearanceDistance(entry, other);
        if (distance < redundantDistance) {
          redundantDistance = distance;
          redundantIndex = Math.max(index, otherIndex);
        }
      });
    });
    if (nearest > redundantDistance + 0.02) {
      track.appearances[redundantIndex] = sample;
      track.lastAppearanceAt = timestamp;
    }
  }

  function trackFaceDistance(track, signature) {
    const candidate = normalizedFaceSignature(signature);
    if (!candidate) return null;
    const samples = [track.faceSignature, ...(track.faceSignatures || [])]
      .map(normalizedFaceSignature)
      .filter(Boolean);
    if (samples.length === 0) return null;
    const distances = samples
      .map((sample) => faceSignatureDistance(sample, candidate))
      .filter(Number.isFinite);
    return distances.length ? Math.min(...distances) : null;
  }

  function rememberFaceSignature(track, signature, timestamp, settings) {
    const sample = normalizedFaceSignature(signature);
    if (!sample) return;

    track.faceSignature = blendVector(track.faceSignature, sample, 0.1);
    track.faceSignatures ||= [];
    const distances = track.faceSignatures
      .map((entry) => faceSignatureDistance(entry, sample))
      .filter(Number.isFinite);
    const nearest = distances.length ? Math.min(...distances) : Infinity;
    const recentlySampled = timestamp - (track.lastFaceAt || 0) < settings.faceSampleMs;
    if (recentlySampled && nearest < 0.015) return;

    if (track.faceSignatures.length < settings.faceGallerySize) {
      track.faceSignatures.push(sample);
      track.lastFaceAt = timestamp;
      return;
    }

    let redundantIndex = 0;
    let redundantDistance = Infinity;
    track.faceSignatures.forEach((entry, index) => {
      track.faceSignatures.forEach((other, otherIndex) => {
        if (index === otherIndex) return;
        const distance = faceSignatureDistance(entry, other);
        if (distance < redundantDistance) {
          redundantDistance = distance;
          redundantIndex = Math.max(index, otherIndex);
        }
      });
    });
    if (nearest > redundantDistance + 0.005) {
      track.faceSignatures[redundantIndex] = sample;
      track.lastFaceAt = timestamp;
    }
  }

  function trackFaceTextureDistance(track, texture) {
    const candidate = normalizedFaceTexture(texture);
    if (!candidate) return null;
    const samples = track.faceTextures || [];
    const distances = samples
      .map((sample) => faceTextureDistance(sample, candidate))
      .filter(Number.isFinite);
    return distances.length ? Math.min(...distances) : null;
  }

  function rememberFaceTexture(track, texture, timestamp, settings) {
    const sample = normalizedFaceTexture(texture);
    if (!sample) return;
    track.faceTextures ||= [];
    const distances = track.faceTextures
      .map((entry) => faceTextureDistance(entry, sample))
      .filter(Number.isFinite);
    const nearest = distances.length ? Math.min(...distances) : Infinity;
    const recentlySampled =
      timestamp - (track.lastFaceTextureAt || 0) < settings.faceTextureSampleMs;
    if (recentlySampled && nearest < 0.05) return;

    if (track.faceTextures.length < settings.faceTextureGallerySize) {
      track.faceTextures.push(sample);
      track.lastFaceTextureAt = timestamp;
      return;
    }

    const nearestIndex = distances.indexOf(nearest);
    if (nearestIndex >= 0 && nearest > 0.12) {
      track.faceTextures[nearestIndex] = sample;
      track.lastFaceTextureAt = timestamp;
    }
  }

  function trackFaceEmbeddingDistance(track, embedding) {
    const candidate = normalizedFaceEmbedding(embedding);
    if (!candidate) return null;
    const distances = (track.faceEmbeddings || [])
      .map((sample) => faceEmbeddingDistance(sample, candidate))
      .filter(Number.isFinite);
    return distances.length ? Math.min(...distances) : null;
  }

  function rememberFaceEmbedding(track, embedding, timestamp, settings) {
    const sample = normalizedFaceEmbedding(embedding);
    if (!sample) return;
    track.faceEmbeddings ||= [];
    const distances = track.faceEmbeddings
      .map((entry) => faceEmbeddingDistance(entry, sample))
      .filter(Number.isFinite);
    const nearest = distances.length ? Math.min(...distances) : Infinity;
    const recentlySampled =
      timestamp - (track.lastFaceEmbeddingAt || 0) < settings.faceEmbeddingSampleMs;
    if (recentlySampled && nearest < 0.12) return;

    if (track.faceEmbeddings.length < settings.faceEmbeddingGallerySize) {
      track.faceEmbeddings.push(sample);
      track.lastFaceEmbeddingAt = timestamp;
      return;
    }

    // Replace only the nearest redundant view. The gallery keeps several
    // expressions and angles without letting a later outlier erase all good
    // reference samples.
    const nearestIndex = distances.indexOf(nearest);
    if (nearestIndex >= 0 && nearest > 0.2) {
      track.faceEmbeddings[nearestIndex] = sample;
      track.lastFaceEmbeddingAt = timestamp;
    }
  }

  function predictedCenter(track, timestamp) {
    const elapsed = Math.max(0, Math.min(1_000, timestamp - track.lastSeenAt));
    return {
      x: track.center.x + track.velocity.x * elapsed,
      y: track.center.y + track.velocity.y * elapsed,
    };
  }

  function matchCost(track, observation, timestamp, settings) {
    const {
      body,
      center,
      signature,
      appearance,
      faceSignature,
      faceTexture,
      faceEmbedding,
    } = observation;
    if (!center) return null;

    const movement = pointDistance(predictedCenter(track, timestamp), center);
    const scale = Math.max(
      body?.box?.width || 0,
      body?.box?.height || 0,
      track.body?.box?.width || 0,
      track.body?.box?.height || 0,
    );
    const speed = Math.hypot(track.velocity.x, track.velocity.y);
    const elapsed = Math.max(0, Math.min(1_000, timestamp - track.lastSeenAt));
    const gate = Math.min(
      settings.maximumDistance,
      Math.max(0.12, scale * 0.32 + speed * elapsed * 1.5),
    );

    if (movement > gate) return null;

    const proportions = signatureDistance(track.signature, signature);
    const area = Math.max(0.0001, (body?.box?.width || 0) * (body?.box?.height || 0));
    const previousArea = Math.max(
      0.0001,
      (track.body?.box?.width || 0) * (track.body?.box?.height || 0),
    );
    const scaleChange = Math.abs(Math.log(area / previousArea));

    const clothing = trackAppearanceDistance(track, appearance);
    const facial = trackFaceDistance(track, faceSignature);
    const texture = trackFaceTextureDistance(track, faceTexture);
    const embedding = trackFaceEmbeddingDistance(track, faceEmbedding);
    if (embedding !== null && embedding > settings.faceEmbeddingMismatchDistance) return null;
    if (facial !== null && facial > settings.faceMismatchDistance) return null;
    if (texture !== null && texture > settings.faceTextureMismatchDistance) return null;
    const trustedFace =
      (embedding !== null && embedding <= settings.faceEmbeddingReentryDistance) ||
      (facial !== null && facial <= settings.faceReentryDistance) ||
      (texture !== null && texture <= settings.faceTextureReentryDistance);
    if (
      clothing !== null &&
      clothing > settings.activeAppearanceDistance &&
      !trustedFace
    ) {
      return null;
    }
    return (
      movement +
      proportions * 0.18 +
      scaleChange * 0.04 +
      (clothing ?? 0) * 0.34 +
      (embedding ?? 0) * 0.9 +
      (facial ?? 0) * 0.72 +
      (texture ?? 0) * 0.38
    );
  }

  function reentryCost(track, observation, timestamp, settings) {
    const clothing = trackAppearanceDistance(track, observation.appearance);
    const facial = trackFaceDistance(track, observation.faceSignature);
    const texture = trackFaceTextureDistance(track, observation.faceTexture);
    const embedding = trackFaceEmbeddingDistance(track, observation.faceEmbedding);
    const geometry = signatureDistance(track.signature, observation.signature);
    const box = observation.body?.box;
    const enteringAtEdge = Boolean(
      box &&
        (box.x <= 0.08 ||
          box.y <= 0.04 ||
          box.x + box.width >= 0.92 ||
          box.y + box.height >= 0.96),
    );

    // Facial texture is the stronger biometric signal. A clear mismatch must
    // be applied before either positive threshold: otherwise two people with
    // similar landmark geometry can be incorrectly merged.
    const facialMatch = facial !== null && facial <= settings.faceReentryDistance;
    const textureMatch =
      texture !== null && texture <= settings.faceTextureReentryDistance;
    const embeddingMatch =
      embedding !== null && embedding <= settings.faceEmbeddingReentryDistance;
    if (embedding !== null && embedding > settings.faceEmbeddingMismatchDistance) return null;
    if (facial !== null && facial > settings.faceMismatchDistance) return null;
    if (texture !== null && texture > settings.faceTextureMismatchDistance) return null;
    if (embeddingMatch || facialMatch || textureMatch) {
      return (
        (embedding ?? 0) * 0.82 +
        (facial ?? 0) * 0.65 +
        (texture ?? 0) * 0.32 +
        (clothing ?? 0) * 0.05 +
        Math.min(0.5, geometry) * 0.04
      );
    }
    if (clothing !== null) {
      const appearanceMatch = clothing <= settings.reentryAppearanceDistance;
      const corroboratedMatch =
        clothing <= settings.reentryCorroboratedAppearanceDistance &&
        geometry <= settings.reentryCorroboratingGeometryDistance;
      const partialEntryMatch =
        enteringAtEdge && clothing <= settings.reentryEdgeAppearanceDistance;
      if (!appearanceMatch && !corroboratedMatch && !partialEntryMatch) return null;
      return clothing * 0.72 + Math.min(0.5, geometry) * 0.24;
    }
    if (geometry > settings.reentryGeometryDistance) return null;

    // Geometry-only fallback is deliberately stricter. It keeps the feature
    // usable in a browser that cannot sample camera pixels, while clothing
    // remains the stronger evidence whenever pixels are available.
    return geometry + Math.min(0.04, (timestamp - track.lastSeenAt) / 1_000_000);
  }

  // Greedy nearest-neighbour matching can swap two IDs because the locally
  // cheapest pair may force a terrible remaining pair. With at most four
  // visible people, dynamic programming finds the lowest-cost whole assignment
  // cheaply while preferring to preserve as many valid tracks as possible.
  function assignGlobally(trackIndexes, bodyIndexes, costFor) {
    let states = new Map([[0, { cost: 0, matches: [] }]]);

    trackIndexes.forEach((trackIndex) => {
      const next = new Map(states);
      states.forEach((state, mask) => {
        bodyIndexes.forEach((bodyIndex, position) => {
          const bit = 1 << position;
          if (mask & bit) return;
          const cost = costFor(trackIndex, bodyIndex);
          if (cost === null || !Number.isFinite(cost)) return;

          const nextMask = mask | bit;
          const candidate = {
            cost: state.cost + cost,
            matches: [...state.matches, { trackIndex, bodyIndex }],
          };
          const existing = next.get(nextMask);
          if (!existing || candidate.cost < existing.cost) next.set(nextMask, candidate);
        });
      });
      states = next;
    });

    return [...states.values()].reduce((best, candidate) => {
      if (candidate.matches.length !== best.matches.length) {
        return candidate.matches.length > best.matches.length ? candidate : best;
      }
      return candidate.cost < best.cost ? candidate : best;
    }).matches;
  }

  function createPersonTracker(options = {}) {
    const settings = { ...DEFAULTS, ...options };
    const enrolledIdentities = (options.identities || [])
      .map((identity) => {
        const workerId = String(identity?.workerId || "").trim().toUpperCase();
        const embeddings = [
          ...(Array.isArray(identity?.embeddings) ? identity.embeddings : []),
          identity?.embedding,
        ]
          .map(normalizedFaceEmbedding)
          .filter(Boolean)
          .slice(0, settings.faceEmbeddingGallerySize);
        const displayName = String(identity?.displayName || "").trim().replace(/\s+/g, " ");
        return /^[A-Z0-9][A-Z0-9_-]{1,31}$/.test(workerId) && embeddings.length > 0
          ? { workerId, displayName: displayName || null, embeddings }
          : null;
      })
      .filter(Boolean);
    let tracks = [];
    let nextId = 1;
    let appearanceCanvas = null;
    let appearanceContext = null;

    function readAppearanceFrame(source) {
      if (source?.data && source.width && source.height) return source;
      const documentRef = options.document || globalScope.document;
      if (!source || !documentRef?.createElement) return null;

      try {
        if (!appearanceCanvas) {
          appearanceCanvas = documentRef.createElement("canvas");
          appearanceCanvas.width = IDENTITY_FRAME_WIDTH;
          appearanceCanvas.height = IDENTITY_FRAME_HEIGHT;
          appearanceContext = appearanceCanvas.getContext("2d", { willReadFrequently: true });
        }
        appearanceContext.drawImage(source, 0, 0, appearanceCanvas.width, appearanceCanvas.height);
        return appearanceContext.getImageData(0, 0, appearanceCanvas.width, appearanceCanvas.height);
      } catch {
        return null;
      }
    }

    function reset() {
      tracks = enrolledIdentities.map((identity, index) => ({
        id: index + 1,
        workerId: identity.workerId,
        personLabel: identity.workerId,
        enrolled: true,
        seen: false,
        body: null,
        center: null,
        velocity: { x: 0, y: 0 },
        signature: [null, null, null, null],
        appearance: null,
        appearances: [],
        lastAppearanceAt: 0,
        faceSignature: null,
        faceSignatures: [],
        lastFaceAt: 0,
        faceTextures: [],
        lastFaceTextureAt: 0,
        faceEmbeddings: [...identity.embeddings],
        lastFaceEmbeddingAt: 0,
        firstSeenAt: null,
        lastSeenAt: -Infinity,
      }));
      nextId = tracks.length + 1;
    }

    reset();

    function update(bodies = [], timestamp = Date.now(), source = null) {
      const frame = readAppearanceFrame(source);
      const visible = (bodies || []).filter((body) => centerOf(body));
      const observations = visible.map((body) => ({
        body,
        center: centerOf(body),
        signature: signatureOf(body),
        appearance: normalizedAppearance(body.appearance) || appearanceOf(body, frame),
        faceSignature: normalizedFaceSignature(body.faceSignature),
        faceTexture: normalizedFaceTexture(body.faceTexture) || faceTextureOf(body, frame),
        faceEmbedding: normalizedFaceEmbedding(body.faceEmbedding),
      }));
      const claimedTracks = new Set();
      const claimedBodies = new Set();
      const matches = new Map();
      const activeTrackIndexes = tracks
        .map((track, trackIndex) => ({ track, trackIndex }))
        .filter(({ track }) => timestamp - track.lastSeenAt <= settings.missingMs)
        .map(({ trackIndex }) => trackIndex);
      const bodyIndexes = observations.map((_, bodyIndex) => bodyIndex);
      assignGlobally(activeTrackIndexes, bodyIndexes, (trackIndex, bodyIndex) =>
        matchCost(tracks[trackIndex], observations[bodyIndex], timestamp, settings),
      ).forEach(({ trackIndex, bodyIndex }) => {
        claimedTracks.add(trackIndex);
        claimedBodies.add(bodyIndex);
        matches.set(bodyIndex, tracks[trackIndex]);
      });

      // A second pass considers tracks which have left the frame. Position is
      // intentionally absent here: a person may return from the opposite side.
      const returnTrackIndexes = tracks
        .map((_, trackIndex) => trackIndex)
        .filter((trackIndex) => !claimedTracks.has(trackIndex));
      const returnBodyIndexes = bodyIndexes.filter((bodyIndex) => !claimedBodies.has(bodyIndex));
      assignGlobally(returnTrackIndexes, returnBodyIndexes, (trackIndex, bodyIndex) =>
        tracks[trackIndex].enrolled && !observations[bodyIndex].faceEmbedding
          ? null
          : reentryCost(tracks[trackIndex], observations[bodyIndex], timestamp, settings),
      ).forEach(({ trackIndex, bodyIndex }) => {
        claimedTracks.add(trackIndex);
        claimedBodies.add(bodyIndex);
        matches.set(bodyIndex, tracks[trackIndex]);
      });

      const identified = observations.map((observation, bodyIndex) => {
        const {
          body,
          center,
          signature,
          appearance,
          faceSignature,
          faceTexture,
          faceEmbedding,
        } = observation;
        let track = matches.get(bodyIndex);

        if (!track) {
          track = {
            id: nextId,
            body,
            center,
            velocity: { x: 0, y: 0 },
            signature,
            appearance,
            appearances: appearance ? [appearance] : [],
            lastAppearanceAt: appearance ? timestamp : 0,
            faceSignature,
            faceSignatures: faceSignature ? [faceSignature] : [],
            lastFaceAt: faceSignature ? timestamp : 0,
            faceTextures: faceTexture ? [faceTexture] : [],
            lastFaceTextureAt: faceTexture ? timestamp : 0,
            faceEmbeddings: faceEmbedding ? [faceEmbedding] : [],
            lastFaceEmbeddingAt: faceEmbedding ? timestamp : 0,
            firstSeenAt: timestamp,
            lastSeenAt: timestamp,
            enrolled: false,
            seen: true,
            workerId: null,
            personLabel: null,
          };
          nextId += 1;
          tracks.push(track);
        } else {
          if (track.center && Number.isFinite(track.lastSeenAt)) {
            const elapsed = Math.max(1, timestamp - track.lastSeenAt);
            const measuredVelocity = {
              x: (center.x - track.center.x) / elapsed,
              y: (center.y - track.center.y) / elapsed,
            };
            track.velocity = {
              x:
                track.velocity.x * settings.velocitySmoothing +
                measuredVelocity.x * (1 - settings.velocitySmoothing),
              y:
                track.velocity.y * settings.velocitySmoothing +
                measuredVelocity.y * (1 - settings.velocitySmoothing),
            };
          } else {
            track.velocity = { x: 0, y: 0 };
            track.firstSeenAt = timestamp;
          }
          track.body = body;
          track.center = center;
          track.signature = blendVector(track.signature, signature, 0.2);
          rememberAppearance(track, appearance, timestamp, settings);
          rememberFaceSignature(track, faceSignature, timestamp, settings);
          rememberFaceTexture(track, faceTexture, timestamp, settings);
          rememberFaceEmbedding(track, faceEmbedding, timestamp, settings);
          track.lastSeenAt = timestamp;
          track.seen = true;
        }

        const {
          appearance: _privateAppearance,
          faceSignature: _privateFaceSignature,
          faceTexture: _privateFaceTexture,
          faceEmbedding: _privateFaceEmbedding,
          ...publicBody
        } = body;
        return {
          ...publicBody,
          personId: track.id,
          ...(track.workerId ? { workerId: track.workerId } : {}),
          ...(track.workerId && faceEmbedding ? { faceMatched: true } : {}),
          personLabel: track.workerId || "TRACKING WORKER",
        };
      });

      identified.sort((left, right) => left.personId - right.personId);
      return {
        bodies: identified,
        visibleCount: identified.length,
        uniqueCount: tracks.filter((track) => track.seen).length,
        activeCount: tracks.filter((track) => timestamp - track.lastSeenAt <= settings.missingMs)
          .length,
        dormantCount: tracks.filter((track) => timestamp - track.lastSeenAt > settings.missingMs)
          .length,
        // Only the trained embedding model activates this flag. Landmark and
        // texture fallbacks are weaker and are not presented as full facial
        // recognition to the user.
        faceRecognitionReady: tracks.some(
          (track) => track.seen && track.faceEmbeddings?.length,
        ),
      };
    }

    function peek(timestamp = Date.now()) {
      const active = tracks.filter((track) => timestamp - track.lastSeenAt <= settings.missingMs);
      return {
        visibleCount: 0,
        uniqueCount: tracks.filter((track) => track.seen).length,
        activeCount: active.length,
        dormantCount: tracks.length - active.length,
        faceRecognitionReady: tracks.some(
          (track) => track.seen && track.faceEmbeddings?.length,
        ),
      };
    }

    return Object.freeze({ peek, reset, update });
  }

  const api = Object.freeze({
    APPEARANCE_BINS,
    DEFAULTS,
    appearanceDistance,
    appearanceOf,
    centerOf,
    createPersonTracker,
    faceEmbeddingDistance,
    faceSignatureDistance,
    faceTextureDistance,
    faceTextureOf,
    signatureOf,
  });
  globalScope.StampNotePersonTracker = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
