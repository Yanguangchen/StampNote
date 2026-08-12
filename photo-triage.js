(function initializePhotoTriage(globalScope) {
  "use strict";

  // Deciding which photographs are worth keeping, on the device, from the frame
  // itself. Nothing here asks a model or a network: an out-of-focus photo and a
  // photo of the same empty corridor as the last one are both measurable, and
  // whether anybody was in shot is something the watch already worked out when
  // it decided how often to take pictures.
  //
  // Two jobs, deliberately separate. Ranking scores every capture so the store
  // sheds its worst photographs first instead of merely its oldest. Filtering
  // declines to take a handful of them at all, and only where several signals
  // agree there is nothing there.

  // Variance of the Laplacian, in the units it comes out in on 0-255 luma. A
  // frame in focus is in the hundreds; a smeared one is single digits. The floor
  // is where a photograph stops being worth keeping for what is in it, and is
  // also the half-way point of the focus score.
  const BLUR_FLOOR = 60;

  // Two 64-bit fingerprints this close are the same view. Sensor noise and a
  // little camera shake move a handful of bits; a person walking through moves
  // far more.
  const SAME_VIEW = 6;

  // However dull the scene, keep something every so often — an hour of stored
  // nothing is still the answer to "was it running?".
  const HEARTBEAT_MS = 10 * 60 * 1000;

  // The fingerprint is a difference hash: a 9x8 grey thumbnail, each pixel
  // compared with the one to its right, giving 64 bits that survive exposure
  // changes and re-encoding but not a change of subject.
  const HASH_WIDTH = 9;
  const HASH_HEIGHT = 8;
  const HASH_BITS = (HASH_WIDTH - 1) * HASH_HEIGHT;

  // A bit is only set where one cell is meaningfully brighter than its
  // neighbour. Without this deadband a flat wall — where the two are equal —
  // has every bit decided by whatever noise landed on it, and the same corridor
  // fingerprints differently every time.
  const EDGE_TOLERANCE = 3;

  function luma(data, offset) {
    return 0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2];
  }

  function isImage(image) {
    return Boolean(image?.data && image.width > 0 && image.height > 0);
  }

  // How much high-frequency detail the frame carries. A lens that has not found
  // focus, a moving subject at a long exposure and a photograph of fog all lose
  // the same thing: the sharp steps between neighbouring pixels.
  function sharpnessOf(image) {
    if (!isImage(image) || image.width < 3 || image.height < 3) {
      return 0;
    }

    const { width, height, data } = image;
    let total = 0;
    let totalSquares = 0;
    let count = 0;

    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const offset = (y * width + x) * 4;
        // The four-neighbour Laplacian: how far this pixel sits from the
        // average of the ones around it.
        const edge =
          4 * luma(data, offset) -
          luma(data, offset - 4) -
          luma(data, offset + 4) -
          luma(data, offset - width * 4) -
          luma(data, offset + width * 4);

        total += edge;
        totalSquares += edge * edge;
        count += 1;
      }
    }

    if (count === 0) {
      return 0;
    }

    const mean = total / count;
    return Math.max(0, totalSquares / count - mean * mean);
  }

  // Box-samples the frame down to the hash thumbnail. Averaging rather than
  // picking nearest pixels is the point: the low-pass is what makes the
  // fingerprint survive noise and compression.
  function thumbnailOf(image) {
    const { width, height, data } = image;
    const cells = new Float64Array(HASH_WIDTH * HASH_HEIGHT);

    for (let row = 0; row < HASH_HEIGHT; row += 1) {
      const top = Math.floor((row * height) / HASH_HEIGHT);
      const bottom = Math.max(top + 1, Math.floor(((row + 1) * height) / HASH_HEIGHT));

      for (let column = 0; column < HASH_WIDTH; column += 1) {
        const left = Math.floor((column * width) / HASH_WIDTH);
        const right = Math.max(left + 1, Math.floor(((column + 1) * width) / HASH_WIDTH));
        let total = 0;
        let count = 0;

        for (let y = top; y < bottom; y += 1) {
          for (let x = left; x < right; x += 1) {
            total += luma(data, (y * width + x) * 4);
            count += 1;
          }
        }

        cells[row * HASH_WIDTH + column] = count === 0 ? 0 : total / count;
      }
    }

    return cells;
  }

  function fingerprintOf(image) {
    if (!isImage(image)) {
      return null;
    }

    const cells = thumbnailOf(image);
    let hex = "";
    let byte = 0;
    let bits = 0;

    for (let row = 0; row < HASH_HEIGHT; row += 1) {
      for (let column = 0; column < HASH_WIDTH - 1; column += 1) {
        const here = cells[row * HASH_WIDTH + column];
        const next = cells[row * HASH_WIDTH + column + 1];

        byte = (byte << 1) | (here > next + EDGE_TOLERANCE ? 1 : 0);
        bits += 1;

        if (bits === 8) {
          hex += byte.toString(16).padStart(2, "0");
          byte = 0;
          bits = 0;
        }
      }
    }

    return hex;
  }

  const ONES = Array.from({ length: 256 }, (_, value) => {
    let bits = 0;
    for (let n = value; n > 0; n >>= 1) {
      bits += n & 1;
    }
    return bits;
  });

  // How many of the 64 bits differ. Two fingerprints of different lengths, or a
  // missing one, are treated as entirely unlike rather than as a match.
  function distanceBetween(left, right) {
    if (!left || !right || left.length !== right.length) {
      return HASH_BITS;
    }

    let distance = 0;

    for (let index = 0; index < left.length; index += 2) {
      const a = parseInt(left.slice(index, index + 2), 16);
      const b = parseInt(right.slice(index, index + 2), 16);

      if (Number.isNaN(a) || Number.isNaN(b)) {
        return HASH_BITS;
      }

      distance += ONES[a ^ b];
    }

    return distance;
  }

  // 0 for the same view as last time, 1 for a scene with nothing in common.
  function noveltyOf(fingerprint, previous) {
    if (!fingerprint) {
      return 1;
    }
    if (!previous) {
      // Nothing to be the same as: the first photograph of a watch is new.
      return 1;
    }

    return Math.min(1, distanceBetween(fingerprint, previous) / HASH_BITS);
  }

  function clamp01(value) {
    return Math.min(1, Math.max(0, Number(value) || 0));
  }

  function focusScore(sharpness) {
    const value = Math.max(0, Number(sharpness) || 0);
    // Half a mark at the floor, approaching one as detail climbs above it.
    return value / (value + BLUR_FLOOR);
  }

  // What was in the picture, which the watch already decided when it chose how
  // long to wait. A second person is worth a little more than the first; a
  // vehicle is worth something, but far less than anybody.
  function subjectScore(reading = {}) {
    if (reading.present) {
      const crowd = Math.min(1, 0.8 + 0.1 * Math.max(0, (Number(reading.people) || 1) - 1));
      return crowd * clamp01(reading.confidence ?? 1);
    }

    return reading.vehicle ? 0.2 : 0;
  }

  // One number per photograph, and the only thing the store needs to know to
  // shed the right ones. Weighted towards what was in the frame, because a
  // slightly soft photograph of somebody beats a pin-sharp one of a wall.
  function scoreCapture(input = {}) {
    // A photograph somebody asked for by raising their hands is not up for
    // judgement — they are the one who wanted it.
    if (input.trigger === "gesture") {
      return 1;
    }

    const focus = focusScore(input.sharpness);
    const novelty = clamp01(input.novelty);
    const subject = subjectScore(input);

    // Subject outweighs the other two combined, deliberately: the watch exists
    // to photograph people, so a soft photograph of somebody has to beat a
    // pin-sharp one of a wall.
    return Number(clamp01(0.65 * subject + 0.2 * focus + 0.15 * novelty).toFixed(3));
  }

  // Whether to take the photograph at all. Deliberately hard to fail: a person
  // in frame always passes, a requested photograph always passes, and a dull
  // scene still gets one through every so often. What it does stop is the
  // hundredth identical frame of an empty corridor, and a frame the lens never
  // found focus on.
  function shouldKeep(input = {}) {
    if (input.trigger === "gesture" || input.present) {
      return true;
    }
    if ((Number(input.sinceKeptMs) || 0) >= HEARTBEAT_MS) {
      return true;
    }

    // A missing measurement is unknown, not zero: without a reading there is
    // nothing to convict the photograph on, so it is taken.
    const measured = typeof input.sharpness === "number" && typeof input.novelty === "number";

    if (!measured) {
      return true;
    }

    const blurred = focusScore(input.sharpness) * 2 < 1;
    const unchanged = clamp01(input.novelty) * HASH_BITS <= SAME_VIEW;

    return !(blurred || unchanged);
  }

  // Why a photograph was not taken, for the badge. Not an error — the watch is
  // working exactly as asked.
  function describeSkip(input = {}) {
    return focusScore(input.sharpness) * 2 < 1 ? "Out of focus — skipped" : "Nothing changed — skipped";
  }

  // Worst first: what the store should let go of when it runs out of room. Ties
  // break on age, so a store of photographs that have never been scored sheds
  // its oldest exactly as it always did.
  function byExpendability(left, right) {
    const difference = (left.score ?? 0.5) - (right.score ?? 0.5);

    if (difference !== 0) {
      return difference;
    }

    return (left.capturedAtMs || 0) - (right.capturedAtMs || 0);
  }

  const api = Object.freeze({
    BLUR_FLOOR,
    EDGE_TOLERANCE,
    HASH_BITS,
    HEARTBEAT_MS,
    SAME_VIEW,
    byExpendability,
    describeSkip,
    distanceBetween,
    fingerprintOf,
    focusScore,
    noveltyOf,
    scoreCapture,
    sharpnessOf,
    shouldKeep,
    subjectScore,
  });

  globalScope.StampNoteTriage = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
