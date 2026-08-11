(function initializePoseDetector(globalScope) {
  "use strict";

  // A trained pose model would need a third-party runtime and a few megabytes of
  // weights, which this project does not take on. Instead a person is found the
  // way a person differs from a room: exposed skin sits in a narrow chrominance
  // band whatever the skin tone, bodies move between frames, and the resulting
  // silhouette is taller than it is wide with a narrow head above broad
  // shoulders. Each cue is weak on its own; scored together they are steady
  // enough to choose a capture interval. Where the browser ships the Shape
  // Detection API, face boxes can be passed in as a hint to firm up the head.
  //
  // Every threshold is tuned for the 128x96 frame app.js downscales to, which is
  // small enough to analyse well inside a frame budget on a phone.
  const DEFAULTS = Object.freeze({
    minLuma: 50,
    maxLuma: 250,
    motionThreshold: 14,
    minComponentArea: 12,
    minSkinPixels: 8,
    minSkinFraction: 0.03,
    maxAreaFraction: 0.75,
    presentConfidence: 0.5,
  });

  // Sum to 1, so confidence stays a plain 0..1 reading.
  const WEIGHTS = Object.freeze({
    skin: 0.36,
    shape: 0.28,
    size: 0.2,
    motion: 0.16,
  });

  // The head is a gate rather than another term in the sum. Skin tone, size and
  // an upright aspect ratio all describe a cardboard box or a varnished door as
  // happily as a person; a narrow head above broader shoulders is the cue that
  // separates them, so a silhouette without one can never reach the threshold
  // on the other cues alone.
  const HEAD_GATE_FLOOR = 0.5;

  const TRACKER_DEFAULTS = Object.freeze({
    enterFrames: 2,
    holdMs: 4000,
    smoothing: 0.4,
  });

  const EMPTY_DETECTION = Object.freeze({
    present: false,
    confidence: 0,
    pose: "none",
    keypoints: null,
    box: null,
    skinFraction: 0,
    motionFraction: 0,
  });

  function clamp(value, low = 0, high = 1) {
    return Math.min(high, Math.max(low, value));
  }

  // 1 inside the plausible band, tapering to 0 across the falloff outside it.
  function plateau(value, low, high, lowFalloff, highFalloff = lowFalloff) {
    if (value >= low && value <= high) {
      return 1;
    }

    return value < low
      ? clamp(1 - (low - value) / lowFalloff)
      : clamp(1 - (value - high) / highFalloff);
  }

  // The Chai & Ngan chrominance box. It keys on hue rather than brightness, so
  // it holds across skin tones; the luma gate only drops pixels too dark or too
  // blown out to carry colour at all.
  function isSkin(red, green, blue, settings = DEFAULTS) {
    const luma = 0.299 * red + 0.587 * green + 0.114 * blue;

    if (luma < settings.minLuma || luma > settings.maxLuma) {
      return false;
    }

    const chromaBlue = 128 - 0.168736 * red - 0.331264 * green + 0.5 * blue;
    const chromaRed = 128 + 0.5 * red - 0.418688 * green - 0.081312 * blue;

    return chromaBlue >= 77 && chromaBlue <= 127 && chromaRed >= 133 && chromaRed <= 173;
  }

  function readFrame(frame, settings) {
    const width = Math.trunc(frame?.width || 0);
    const height = Math.trunc(frame?.height || 0);
    const data = frame?.data;

    if (!data || width <= 0 || height <= 0 || data.length < width * height * 4) {
      throw new TypeError("A pose frame needs width, height and RGBA data.");
    }

    const size = width * height;
    const luma = new Uint8ClampedArray(size);
    const skin = new Uint8Array(size);
    let skinCount = 0;

    for (let index = 0; index < size; index += 1) {
      const offset = index * 4;
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];

      luma[index] = 0.299 * red + 0.587 * green + 0.114 * blue;

      if (isSkin(red, green, blue, settings)) {
        skin[index] = 1;
        skinCount += 1;
      }
    }

    return { width, height, luma, skin, skinCount };
  }

  // Clothing has no skin tone, so movement is what reveals the rest of a body.
  function readMotion(luma, previousLuma, threshold) {
    const motion = new Uint8Array(luma.length);
    let motionCount = 0;

    if (!previousLuma || previousLuma.length !== luma.length) {
      return { motion, motionCount };
    }

    for (let index = 0; index < luma.length; index += 1) {
      if (Math.abs(luma[index] - previousLuma[index]) > threshold) {
        motion[index] = 1;
        motionCount += 1;
      }
    }

    return { motion, motionCount };
  }

  // Skin and motion together, closed up. Both masks come out speckled — a
  // patterned shirt only registers movement where the pattern changed, and the
  // holes it leaves behind are enough to cut a body into diagonal ribbons under
  // four-neighbour labelling. Dilating and then eroding bridges the single-pixel
  // gaps and hands the labeller one silhouette instead of a dozen slivers.
  function buildForeground(skin, motion, width, height) {
    const size = width * height;
    const dilated = new Uint8Array(size);
    const closed = new Uint8Array(size);

    for (let index = 0; index < size; index += 1) {
      const x = index % width;

      if (
        skin[index] ||
        motion[index] ||
        (x > 0 && (skin[index - 1] || motion[index - 1])) ||
        (x + 1 < width && (skin[index + 1] || motion[index + 1])) ||
        (index >= width && (skin[index - width] || motion[index - width])) ||
        (index + width < size && (skin[index + width] || motion[index + width]))
      ) {
        dilated[index] = 1;
      }
    }

    // Off-frame neighbours count as filled, so a body touching an edge keeps it.
    for (let index = 0; index < size; index += 1) {
      const x = index % width;

      if (
        dilated[index] &&
        (x === 0 || dilated[index - 1]) &&
        (x + 1 === width || dilated[index + 1]) &&
        (index < width || dilated[index - width]) &&
        (index + width >= size || dilated[index + width])
      ) {
        closed[index] = 1;
      }
    }

    return closed;
  }

  // Four-neighbour flood fill over an explicit stack: recursion would blow the
  // call stack on a component covering most of the frame.
  function findComponents(foreground, skin, motion, width, height, settings) {
    const size = width * height;
    const labels = new Int32Array(size).fill(-1);
    const stack = new Int32Array(size);
    const components = [];

    for (let start = 0; start < size; start += 1) {
      if (labels[start] !== -1 || foreground[start] === 0) {
        continue;
      }

      const label = components.length;
      let top = 0;
      let area = 0;
      let skinArea = 0;
      let motionArea = 0;
      let minX = width;
      let maxX = -1;
      let minY = height;
      let maxY = -1;

      labels[start] = label;
      stack[top] = start;
      top += 1;

      while (top > 0) {
        top -= 1;
        const index = stack[top];
        const x = index % width;
        const y = (index - x) / width;

        area += 1;
        skinArea += skin[index];
        motionArea += motion[index];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;

        if (x > 0) {
          const next = index - 1;
          if (labels[next] === -1 && foreground[next]) {
            labels[next] = label;
            stack[top] = next;
            top += 1;
          }
        }
        if (x + 1 < width) {
          const next = index + 1;
          if (labels[next] === -1 && foreground[next]) {
            labels[next] = label;
            stack[top] = next;
            top += 1;
          }
        }
        if (y > 0) {
          const next = index - width;
          if (labels[next] === -1 && foreground[next]) {
            labels[next] = label;
            stack[top] = next;
            top += 1;
          }
        }
        if (y + 1 < height) {
          const next = index + width;
          if (labels[next] === -1 && foreground[next]) {
            labels[next] = label;
            stack[top] = next;
            top += 1;
          }
        }
      }

      if (area >= settings.minComponentArea) {
        components.push({ label, area, skinArea, motionArea, minX, maxX, minY, maxY });
      }
    }

    return { labels, components };
  }

  // Bare skin is the one cue a curtain or a passing shadow cannot fake, so a
  // candidate has to carry some. The largest qualifying blob wins.
  function chooseComponent(components, size, settings) {
    let best = null;

    components.forEach((component) => {
      const areaFraction = component.area / size;

      if (
        component.skinArea < settings.minSkinPixels ||
        component.skinArea / component.area < settings.minSkinFraction ||
        areaFraction > settings.maxAreaFraction
      ) {
        return;
      }

      if (!best || component.area > best.area) {
        best = component;
      }
    });

    return best;
  }

  function profileRows(labels, width, component) {
    const rows = [];

    for (let y = component.minY; y <= component.maxY; y += 1) {
      let count = 0;
      let minX = Infinity;
      let maxX = -Infinity;
      let sumX = 0;

      for (let x = component.minX; x <= component.maxX; x += 1) {
        if (labels[y * width + x] === component.label) {
          count += 1;
          sumX += x;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }

      rows.push(
        count === 0
          ? { y, count: 0, minX: 0, maxX: 0, centerX: 0, width: 0 }
          : { y, count, minX, maxX, centerX: sumX / count, width: maxX - minX + 1 },
      );
    }

    return rows;
  }

  // Summarises a horizontal slice of the silhouette, given as fractions of its
  // height. `meanWidth` describes the slice as a whole; `widest` finds the row
  // where the shoulders or hips flare out.
  function summarizeBand(rows, from, to) {
    const start = clamp(Math.floor(rows.length * from), 0, rows.length - 1);
    const end = clamp(Math.ceil(rows.length * to) - 1, start, rows.length - 1);

    let pixels = 0;
    let sumX = 0;
    let sumY = 0;
    let widthSum = 0;
    let filledRows = 0;
    let widest = null;

    for (let index = start; index <= end; index += 1) {
      const row = rows[index];
      if (row.count === 0) {
        continue;
      }

      pixels += row.count;
      sumX += row.centerX * row.count;
      sumY += row.y * row.count;
      widthSum += row.width;
      filledRows += 1;
      if (!widest || row.width > widest.width) {
        widest = row;
      }
    }

    if (pixels === 0) {
      return null;
    }

    return {
      centerX: sumX / pixels,
      centerY: sumY / pixels,
      meanWidth: widthSum / filledRows,
      widest,
      pixels,
    };
  }

  function classifyPose(aspect, boxWidth, boxHeight) {
    if (boxHeight > 0.75 && boxWidth > 0.45) {
      return "close-up";
    }
    if (aspect >= 1.6) {
      return "standing";
    }
    if (aspect >= 0.9) {
      return "seated";
    }
    return "partial";
  }

  // A face box (in frame pixels) that lands on the head band is strong evidence,
  // so it both anchors the head keypoint and lifts the score.
  function matchFace(faces, head, width, height) {
    if (!Array.isArray(faces) || faces.length === 0 || !head) {
      return null;
    }

    return (
      faces.find((face) => {
        const x = Number(face?.x);
        const y = Number(face?.y);
        const faceWidth = Number(face?.width);
        const faceHeight = Number(face?.height);

        if (![x, y, faceWidth, faceHeight].every(Number.isFinite)) {
          return false;
        }

        const centerX = clamp((x + faceWidth / 2) / width);
        const centerY = clamp((y + faceHeight / 2) / height);

        return Math.abs(centerX - head.x) < 0.2 && Math.abs(centerY - head.y) < 0.2;
      }) || null
    );
  }

  // Keypoints and the box come back normalised to 0..1 so an overlay of any size
  // can draw them without knowing the analysis resolution.
  function describePose(component, rows, width, height, faces) {
    const boxWidth = component.maxX - component.minX + 1;
    const boxHeight = component.maxY - component.minY + 1;
    const aspect = boxHeight / boxWidth;

    const headBand = summarizeBand(rows, 0, 0.15);
    const shoulderBand = summarizeBand(rows, 0.15, 0.5);
    const torsoBand = summarizeBand(rows, 0.3, 0.7);
    const hipBand = summarizeBand(rows, 0.55, 0.8);
    const footRow = [...rows].reverse().find((row) => row.count > 0);

    const toPoint = (x, y) => ({ x: clamp(x / width), y: clamp(y / height) });
    const shoulderRow = shoulderBand?.widest;
    const hipRow = hipBand?.widest;

    const keypoints = {
      head: headBand ? toPoint(headBand.centerX, headBand.centerY) : null,
      shoulderLeft: shoulderRow ? toPoint(shoulderRow.minX, shoulderRow.y) : null,
      shoulderRight: shoulderRow ? toPoint(shoulderRow.maxX, shoulderRow.y) : null,
      torso: torsoBand ? toPoint(torsoBand.centerX, torsoBand.centerY) : null,
      hipLeft: hipRow ? toPoint(hipRow.minX, hipRow.y) : null,
      hipRight: hipRow ? toPoint(hipRow.maxX, hipRow.y) : null,
      feet: footRow ? toPoint(footRow.centerX, footRow.y) : null,
    };

    // A head reads as a head when it is clearly narrower than the shoulders and
    // sits above the torso. A door, a wall or a wooden floor is a slab of even
    // width, which is what this rejects.
    const shoulderWidth = shoulderRow?.width || 0;
    const headRatio = headBand && shoulderWidth > 0 ? headBand.meanWidth / shoulderWidth : 1;
    const headAboveTorso =
      keypoints.head && keypoints.torso ? keypoints.head.y < keypoints.torso.y : false;

    const face = matchFace(faces, keypoints.head, width, height);
    const headScore = face ? 1 : headAboveTorso ? plateau(headRatio, 0.3, 0.85, 0.15, 0.15) : 0;

    return {
      aspect,
      headScore,
      face: Boolean(face),
      pose: classifyPose(aspect, boxWidth / width, boxHeight / height),
      keypoints,
      box: {
        x: component.minX / width,
        y: component.minY / height,
        width: boxWidth / width,
        height: boxHeight / height,
      },
    };
  }

  // Stateless single-frame analysis. `previousLuma` from the frame before turns
  // motion on; leave it out and a still person is still found by skin alone.
  function analyzeFrame(frame, options = {}) {
    const settings = { ...DEFAULTS, ...(options.settings || {}) };
    const { width, height, luma, skin, skinCount } = readFrame(frame, settings);
    const size = width * height;
    const { motion, motionCount } = readMotion(luma, options.previousLuma, settings.motionThreshold);

    const foreground = buildForeground(skin, motion, width, height);
    const { labels, components } = findComponents(
      foreground,
      skin,
      motion,
      width,
      height,
      settings,
    );
    const component = chooseComponent(components, size, settings);

    if (!component) {
      return {
        ...EMPTY_DETECTION,
        skinFraction: skinCount / size,
        motionFraction: motionCount / size,
        luma,
      };
    }

    const rows = profileRows(labels, width, component);
    const shape = describePose(component, rows, width, height, options.faces);

    const areaFraction = component.area / size;
    const skinFraction = component.skinArea / component.area;
    const motionFraction = component.motionArea / component.area;

    const cues =
      WEIGHTS.skin * Math.min(1, skinFraction / 0.15) +
      WEIGHTS.shape * plateau(shape.aspect, 1.2, 3.2, 0.6, 2) +
      WEIGHTS.size * plateau(areaFraction, 0.01, 0.6, 0.02, 0.25) +
      WEIGHTS.motion * Math.min(1, motionFraction / 0.2);

    const confidence = clamp(
      cues * (HEAD_GATE_FLOOR + (1 - HEAD_GATE_FLOOR) * shape.headScore) +
        (shape.face ? 0.25 : 0),
    );

    return {
      present: confidence >= settings.presentConfidence,
      confidence,
      pose: shape.pose,
      keypoints: shape.keypoints,
      box: shape.box,
      aspect: shape.aspect,
      areaFraction,
      skinFraction,
      motionFraction,
      face: shape.face,
      luma,
    };
  }

  // Carries the previous frame so the caller only has to hand over pixels.
  function createPoseDetector(options = {}) {
    let previousLuma = null;

    return {
      detect(frame, hints = {}) {
        const detection = analyzeFrame(frame, {
          ...options,
          ...hints,
          previousLuma,
        });

        previousLuma = detection.luma;
        return detection;
      },
      reset() {
        previousLuma = null;
      },
    };
  }

  // Raw per-frame readings flicker: a person turning away hides their face for a
  // second, a reflection fires once. The tracker only reports someone present
  // after consecutive sightings, and only reports them gone after a quiet hold,
  // so the capture interval never oscillates on a single bad frame.
  function createPoseTracker(options = {}) {
    const settings = { ...TRACKER_DEFAULTS, ...options };

    let present = false;
    let streak = 0;
    let confidence = 0;
    let lastSeenAt = 0;
    let enteredAt = 0;
    let pose = "none";
    let keypoints = null;
    let box = null;

    function state(timestamp) {
      return {
        present,
        confidence,
        pose: present ? pose : "none",
        keypoints: present ? keypoints : null,
        box: present ? box : null,
        lastSeenAt,
        sinceMs: present ? Math.max(0, timestamp - enteredAt) : 0,
        awayMs: present || lastSeenAt === 0 ? 0 : Math.max(0, timestamp - lastSeenAt),
      };
    }

    return {
      update(detection, timestamp) {
        const reading = detection || EMPTY_DETECTION;
        confidence += settings.smoothing * (reading.confidence - confidence);

        if (reading.present) {
          streak += 1;
          lastSeenAt = timestamp;
          pose = reading.pose;
          keypoints = reading.keypoints;
          box = reading.box;

          if (!present && streak >= settings.enterFrames) {
            present = true;
            enteredAt = timestamp;
          }
        } else {
          streak = 0;

          if (present && timestamp - lastSeenAt >= settings.holdMs) {
            present = false;
            pose = "none";
            keypoints = null;
            box = null;
          }
        }

        return state(timestamp);
      },
      peek(timestamp = lastSeenAt) {
        return state(timestamp);
      },
      reset() {
        present = false;
        streak = 0;
        confidence = 0;
        lastSeenAt = 0;
        enteredAt = 0;
        pose = "none";
        keypoints = null;
        box = null;
      },
    };
  }

  const api = Object.freeze({
    DEFAULTS,
    HEAD_GATE_FLOOR,
    TRACKER_DEFAULTS,
    WEIGHTS,
    analyzeFrame,
    createPoseDetector,
    createPoseTracker,
    isSkin,
    plateau,
  });

  globalScope.StampNotePose = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
