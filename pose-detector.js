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
    // Roughly a second and a half of memory at four frames a second.
    motionDecay: 0.8,
    motionFloor: 0.25,
    minComponentArea: 12,
    minSkinPixels: 8,
    minSkinFraction: 0.03,
    maxAreaFraction: 0.75,
    presentConfidence: 0.5,
    vehicleConfidence: 0.55,
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
    subject: "none",
    vehicle: null,
    vehicles: 0,
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
  //
  // Movement between two frames alone is not enough: a person standing still to
  // read their phone disappears from the waist down between one frame and the
  // next, and half a silhouette rigs half a skeleton. So motion is remembered
  // and allowed to fade over a second or so, which spans those pauses.
  //
  // A remembered pixel is only still part of the body while it still looks like
  // the body did when it moved there. That distinction is what stops the memory
  // becoming a smear: stand still and your pixels keep their value, so you stay
  // whole; walk on and the pixels behind you revert to the room, no longer match
  // what was remembered, and are dropped at once instead of trailing after you.
  // Without it the silhouette fattens, the trunk measures wider than it is, and
  // the arms are swallowed by their own wake.
  function readMotion(luma, previousLuma, settings, trail) {
    const motion = new Uint8Array(luma.length);
    const comparable = previousLuma && previousLuma.length === luma.length;
    let motionCount = 0;

    if (!comparable && !trail) {
      return { motion, motionCount };
    }

    for (let index = 0; index < luma.length; index += 1) {
      const moved =
        comparable && Math.abs(luma[index] - previousLuma[index]) > settings.motionThreshold;

      if (!trail) {
        if (moved) {
          motion[index] = 1;
          motionCount += 1;
        }
        continue;
      }

      if (moved) {
        trail.weight[index] = 1;
        trail.luma[index] = luma[index];
      } else {
        trail.weight[index] *= settings.motionDecay;
      }

      if (trail.weight[index] < settings.motionFloor) {
        continue;
      }

      if (moved || Math.abs(luma[index] - trail.luma[index]) <= settings.motionThreshold) {
        motion[index] = 1;
        motionCount += 1;
      } else {
        trail.weight[index] = 0;
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
  function findComponents(foreground, skin, motion, luma, width, height, settings) {
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
      let lumaSum = 0;
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
        lumaSum += luma[index];
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
        components.push({
          label,
          area,
          skinArea,
          motionArea,
          meanLuma: lumaSum / area,
          minX,
          maxX,
          minY,
          maxY,
        });
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

  // Each row also keeps its runs — the separate spans the row is cut into. Two
  // runs low down are two legs; the run holding the body's axis is the torso,
  // whatever the arms are doing beside it.
  function profileRows(labels, width, component) {
    const rows = [];

    for (let y = component.minY; y <= component.maxY; y += 1) {
      let count = 0;
      let minX = Infinity;
      let maxX = -Infinity;
      let sumX = 0;
      const runs = [];
      let runStart = -1;

      for (let x = component.minX; x <= component.maxX + 1; x += 1) {
        const inside = x <= component.maxX && labels[y * width + x] === component.label;

        if (inside) {
          count += 1;
          sumX += x;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (runStart === -1) {
            runStart = x;
          }
        } else if (runStart !== -1) {
          runs.push({ start: runStart, end: x - 1, width: x - runStart });
          runStart = -1;
        }
      }

      rows.push(
        count === 0
          ? { y, count: 0, minX: 0, maxX: 0, centerX: 0, width: 0, runs }
          : { y, count, minX, maxX, centerX: sumX / count, width: maxX - minX + 1, runs },
      );
    }

    return rows;
  }

  // The run a given column falls in, or the nearest one to it.
  function runAt(row, x) {
    let best = null;
    let bestDistance = Infinity;

    row.runs.forEach((run) => {
      const distance = x < run.start ? run.start - x : x > run.end ? x - run.end : 0;

      if (distance < bestDistance) {
        bestDistance = distance;
        best = run;
      }
    });

    return best;
  }

  function median(values) {
    if (values.length === 0) {
      return 0;
    }

    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);

    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
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

  // ---------------------------------------------------------------------------
  // Vehicles
  //
  // Not so a car can be photographed on a schedule — the cadence answers to
  // people only — but so a car stops being mistaken for one. Warm paint (tan,
  // bronze, red, gold) sits inside the same chrominance band as skin, because
  // that band is a hue test and hue is exactly what a bronze wing and a forearm
  // have in common. A car's cabin sitting on its body then reads as a narrow
  // head above broad shoulders, and the last cue that should have caught it
  // waves it through.
  //
  // What a car is not is upright, and what it is not is full of gaps. A person
  // fills about half their bounding box, arms and legs leaving daylight around
  // them; a car fills three quarters of a box far wider than it is tall, and
  // carries two dark wheels along the bottom. Judged on that, the two never
  // trade places.
  // ---------------------------------------------------------------------------

  const VEHICLE_WEIGHTS = Object.freeze({
    solid: 0.45,
    size: 0.3,
    wheels: 0.25,
  });

  // Long and low is what makes a vehicle a vehicle, so it gates the rest the way
  // the head gates a person. Left as one term among several it does not bite: a
  // solid upright body scores enough on the others to be called a car with its
  // one disqualifying measurement reading zero.
  const VEHICLE_SHAPE_GATE = Object.freeze({ low: 0.25, high: 0.85, under: 0.12, over: 0.2 });

  // Tyres are dark, but so are trousers, so what counts is being much darker
  // than the body they sit under rather than dark in absolute terms.
  const WHEEL_LUMA = 85;
  const WHEEL_CONTRAST = 0.6;
  const WHEEL_PIXELS = 4;

  function countWheels(labels, component, luma, width, bodyLuma) {
    const boxWidth = component.maxX - component.minX + 1;
    const boxHeight = component.maxY - component.minY + 1;
    const band = Math.max(2, Math.round(boxHeight * 0.35));
    const third = boxWidth / 3;

    let left = 0;
    let right = 0;

    for (let y = component.maxY - band; y <= component.maxY; y += 1) {
      if (y < component.minY) {
        continue;
      }

      for (let x = component.minX; x <= component.maxX; x += 1) {
        const index = y * width + x;

        if (
          labels[index] !== component.label ||
          luma[index] > WHEEL_LUMA ||
          luma[index] > bodyLuma * WHEEL_CONTRAST
        ) {
          continue;
        }

        if (x < component.minX + third) {
          left += 1;
        } else if (x > component.maxX - third) {
          right += 1;
        }
      }
    }

    return (left >= WHEEL_PIXELS ? 1 : 0) + (right >= WHEEL_PIXELS ? 1 : 0);
  }

  function scoreVehicle(labels, component, luma, width, height) {
    const boxWidth = component.maxX - component.minX + 1;
    const boxHeight = component.maxY - component.minY + 1;
    const aspect = boxHeight / boxWidth;
    const fill = component.area / (boxWidth * boxHeight);
    const areaFraction = component.area / (width * height);

    // The upper end of the gate is tight: anything approaching square is as
    // likely to be a person sitting down as a car seen head-on, and a person
    // called a vehicle costs a photograph that should have been taken.
    const low = plateau(
      aspect,
      VEHICLE_SHAPE_GATE.low,
      VEHICLE_SHAPE_GATE.high,
      VEHICLE_SHAPE_GATE.under,
      VEHICLE_SHAPE_GATE.over,
    );

    const wheels = countWheels(labels, component, luma, width, component.meanLuma);

    const confidence = clamp(
      low *
        // Solid through the middle, where a body has daylight between its limbs.
        (VEHICLE_WEIGHTS.solid * clamp((fill - 0.45) / 0.25) +
          VEHICLE_WEIGHTS.size * plateau(areaFraction, 0.02, 0.7, 0.015, 0.2) +
          VEHICLE_WEIGHTS.wheels * (wheels / 2)),
    );

    return {
      confidence,
      aspect,
      fill,
      wheels,
      box: {
        x: component.minX / width,
        y: component.minY / height,
        width: boxWidth / width,
        height: boxHeight / height,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Rigging
  //
  // Limbs come out of the silhouette's own geometry. A breadth-first walk from
  // the middle of the body measures every pixel's distance *through* the body
  // rather than across it, so the farthest points are the ends of the limbs —
  // hands, feet, head — even when an arm is bent right back. Walking that path
  // in reverse from a fingertip and stopping halfway puts the elbow where the
  // arm actually folds, which no straight line from shoulder to wrist can do.
  // It is the classical star-skeleton idea with a geodesic field standing in
  // for the contour scan.
  // ---------------------------------------------------------------------------

  const RIG = Object.freeze({
    // A limb tip has to be the farthest point in this much of its neighbourhood.
    peakRadius: 4,
    // Two tips closer than this belong to the same limb.
    separation: 7,
    // Head, two hands, two feet, and one spare for a stray elbow or a bag.
    maxTips: 6,
    // Tips nearer the middle than this are folds in the outline, not limbs.
    minReach: 0.35,
  });

  function pixelAt(index, width) {
    const x = index % width;
    return { x, y: (index - x) / width };
  }

  // The centre of a body is usually inside it, but not for someone bent double,
  // so the walk starts from the nearest pixel that really is part of them.
  function findStart(labels, component, width, x, y) {
    const originX = Math.round(clamp(x, component.minX, component.maxX));
    const originY = Math.round(clamp(y, component.minY, component.maxY));

    if (labels[originY * width + originX] === component.label) {
      return originY * width + originX;
    }

    const reach = Math.max(
      component.maxX - component.minX,
      component.maxY - component.minY,
    );

    for (let radius = 1; radius <= reach; radius += 1) {
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) {
            continue;
          }

          const nextX = originX + dx;
          const nextY = originY + dy;

          if (
            nextX < component.minX ||
            nextX > component.maxX ||
            nextY < component.minY ||
            nextY > component.maxY
          ) {
            continue;
          }

          const index = nextY * width + nextX;
          if (labels[index] === component.label) {
            return index;
          }
        }
      }
    }

    return -1;
  }

  // Steps cost 3 straight and 4 diagonally — the standard chamfer weights, whose
  // ratio is within a couple of percent of √2. Counting every step the same
  // instead measures city blocks, and a city-block field piles up extra distance
  // along the outer edge of a diagonal limb: the edge of a leg then reads as
  // farther away than the foot, and the phantom peak crowds out the real hand.
  // Integer weights keep this a bucket queue rather than a heap, so it stays a
  // linear pass.
  const STRAIGHT_STEP = 3;
  const DIAGONAL_STEP = 4;

  function geodesicField(labels, component, width, height, start) {
    const size = width * height;
    const distance = new Int32Array(size).fill(-1);
    const previous = new Int32Array(size).fill(-1);
    const buckets = [];

    let farthest = 0;

    function push(index, cost) {
      if (!buckets[cost]) {
        buckets[cost] = [];
      }
      buckets[cost].push(index);
    }

    distance[start] = 0;
    push(start, 0);

    for (let cost = 0; cost < buckets.length; cost += 1) {
      const bucket = buckets[cost];
      if (!bucket) {
        continue;
      }

      for (let position = 0; position < bucket.length; position += 1) {
        const index = bucket[position];

        // A shorter route reached this pixel after it was queued.
        if (distance[index] !== cost) {
          continue;
        }
        if (cost > farthest) {
          farthest = cost;
        }

        const x = index % width;
        const y = (index - x) / width;

        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) {
              continue;
            }

            const nextX = x + dx;
            const nextY = y + dy;

            if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) {
              continue;
            }

            const next = nextY * width + nextX;
            if (labels[next] !== component.label) {
              continue;
            }

            const step = cost + (dx === 0 || dy === 0 ? STRAIGHT_STEP : DIAGONAL_STEP);
            if (distance[next] === -1 || step < distance[next]) {
              distance[next] = step;
              previous[next] = index;
              push(next, step);
            }
          }
        }
      }
    }

    return { distance, previous, farthest };
  }

  // Local maxima of the walk, thinned so each limb contributes one tip.
  function findLimbTips(field, width, height, component) {
    const { distance, farthest } = field;
    const threshold = farthest * RIG.minReach;
    const candidates = [];

    for (let y = component.minY; y <= component.maxY; y += 1) {
      for (let x = component.minX; x <= component.maxX; x += 1) {
        const index = y * width + x;
        const reach = distance[index];

        if (reach < threshold) {
          continue;
        }

        let isPeak = true;

        for (let dy = -RIG.peakRadius; dy <= RIG.peakRadius && isPeak; dy += 1) {
          for (let dx = -RIG.peakRadius; dx <= RIG.peakRadius; dx += 1) {
            const nextX = x + dx;
            const nextY = y + dy;

            if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) {
              continue;
            }
            if (distance[nextY * width + nextX] > reach) {
              isPeak = false;
              break;
            }
          }
        }

        if (isPeak) {
          candidates.push({ index, x, y, reach });
        }
      }
    }

    candidates.sort((left, right) => right.reach - left.reach);

    const tips = [];
    candidates.forEach((candidate) => {
      if (tips.length >= RIG.maxTips) {
        return;
      }

      const crowded = tips.some(
        (tip) => Math.hypot(tip.x - candidate.x, tip.y - candidate.y) < RIG.separation,
      );

      if (!crowded) {
        tips.push(candidate);
      }
    });

    return tips;
  }

  // Feet are the lowest tips, the head is the highest, and whatever is left in
  // between is a hand. A limb the silhouette has swallowed — an arm held flat
  // against the body — simply yields no tip, and that joint stays null.
  function assignTips(tips, component, rows, trunk) {
    const { axisX } = trunk;
    const boxHeight = component.maxY - component.minY + 1;

    // The surest sign of an arm is that its row is cut into more than one piece
    // and the tip is not in the piece holding the body's axis. Distance from the
    // axis is only the fallback, because a body that has been moving leaves the
    // trunk measuring wider than it is.
    // The gap and the limb both have to be real. Differencing two frames marks
    // an edge in both its old and its new position, which litters the outline
    // with single-pixel slivers a hair away from the body; treating one as an
    // arm hangs a stub off the shoulder.
    const clearOfTrunk = (tip) => {
      const row = rows[tip.y - component.minY];
      const run = row?.runs.find((piece) => tip.x >= piece.start && tip.x <= piece.end);
      const trunkRun = row && runAt(row, axisX);

      if (!run || !trunkRun || run === trunkRun || run.width < 2) {
        return false;
      }

      const gap = run.end < trunkRun.start ? trunkRun.start - run.end : run.start - trunkRun.end;

      return gap >= 2;
    };
    const remaining = [...tips].sort((left, right) => left.y - right.y);

    // The head is the tip nearest the body's axis in the upper reaches, not
    // simply the highest one: hands held above the head are higher still, and
    // taking the topmost would rig an arm to the neck.
    const overhead = remaining.filter((tip) => tip.y <= component.minY + boxHeight * 0.4);
    const head =
      overhead.sort(
        (left, right) => Math.abs(left.x - axisX) - Math.abs(right.x - axisX),
      )[0] ||
      remaining[0] ||
      null;

    if (head) {
      remaining.splice(remaining.indexOf(head), 1);
    }

    // A head is round enough to peak more than once, and a second peak on the
    // crown would otherwise pass as a hand raised beside the face. Anything
    // within a head's width of the head is the head.
    const headSpread = Math.max(4, trunk.headWidth * 0.9);
    const away = head
      ? remaining.filter((tip) => Math.hypot(tip.x - head.x, tip.y - head.y) > headSpread)
      : remaining;

    // Feet are what reaches the bottom of the silhouette. Hands hang around
    // thigh height on a standing body — well below halfway — so splitting at the
    // waist files both hands as failed feet and throws the arms away.
    const footLine = component.maxY - boxHeight * 0.2;
    const lower = away
      .filter((tip) => tip.y > footLine)
      .sort((left, right) => right.y - left.y);
    const feet = lower.slice(0, 2).sort((left, right) => left.x - right.x);

    // A hand has to have left the trunk — reaching out to the side, or up past
    // the shoulders. An arm hanging flat against the body is swallowed by the
    // silhouette, and the corner of a shoulder is not an arm; without this the
    // rig sprouts a stub limb wherever the outline happens to turn.
    const hands = away
      .filter(
        (tip) =>
          tip.y <= footLine &&
          // Reaching out to the side, or up past the shoulders. Distance is
          // counted in head widths, the steadiest measurement on a body: the
          // trunk is only ever measured through rows the arms are lying across.
          (clearOfTrunk(tip) ||
            Math.abs(tip.x - axisX) > trunk.headWidth * 1.5 ||
            tip.y < trunk.shoulderY - trunk.width * 0.3),
      )
      .sort((left, right) => left.x - right.x);

    const side = (group, wanted) => {
      if (group.length === 0) {
        return null;
      }
      if (group.length === 1) {
        // One tip only: it belongs to whichever side of the axis it sits on.
        const isLeft = group[0].x < axisX;
        return (wanted === "left") === isLeft ? group[0] : null;
      }

      return wanted === "left" ? group[0] : group[group.length - 1];
    };

    return {
      head,
      wristLeft: side(hands, "left"),
      wristRight: side(hands, "right"),
      ankleLeft: side(feet, "left"),
      ankleRight: side(feet, "right"),
    };
  }

  // Follows a limb back from its tip to the joint it hangs off, and puts the
  // fold — elbow or knee — half way along. Measuring through the body rather
  // than across the gap is what places the fold correctly on a bent limb.
  //
  // A limb also has to be limb-length. The outline of a shoulder turns a corner
  // that reads as a tip, and without a length to clear, the rig sprouts a
  // three-pixel arm there. Requiring the path itself to be long enough rejects
  // that whatever the trunk happens to measure.
  function traceLimb(field, width, tip, root, minimumLength) {
    if (!tip || !root) {
      return null;
    }

    const path = [];
    let index = tip.index;

    while (index !== -1 && path.length < field.distance.length) {
      path.push(index);
      index = field.previous[index];
    }

    if (path.length < 2) {
      return null;
    }

    // Where the path passes closest to the shoulder or hip is where the limb
    // starts; everything beyond that belongs to the torso.
    let rootPosition = path.length - 1;
    let best = Infinity;

    path.forEach((step, position) => {
      const point = pixelAt(step, width);
      const gap = (point.x - root.x) ** 2 + (point.y - root.y) ** 2;

      if (gap < best) {
        best = gap;
        rootPosition = position;
      }
    });

    if (rootPosition < minimumLength) {
      return null;
    }

    return {
      tip: { x: tip.x, y: tip.y },
      fold: pixelAt(path[Math.round(rootPosition / 2)], width),
    };
  }

  function buildRig(labels, component, rows, width, height) {
    const boxHeight = component.maxY - component.minY + 1;
    const rowAt = (fraction) =>
      rows[clamp(Math.round((rows.length - 1) * fraction), 0, rows.length - 1)];

    // The body's axis and the width of its trunk are read from the chest and
    // waist, the one stretch of a person that arms and legs stay out of.
    const chest = rows.slice(
      Math.floor(rows.length * 0.3),
      Math.max(Math.floor(rows.length * 0.3) + 1, Math.floor(rows.length * 0.62)),
    );
    const seedX = median(chest.filter((row) => row.count > 0).map((row) => row.centerX));
    const trunkRuns = chest
      .filter((row) => row.count > 0)
      .map((row) => runAt(row, seedX))
      .filter(Boolean);

    const axisX = median(trunkRuns.map((run) => (run.start + run.end) / 2)) || seedX;

    // The head's own run, not the width of the whole row: with both arms raised
    // the top of the silhouette spans hand to hand, and measuring across that
    // would report a head as wide as a doorway.
    const headWidth =
      median(
        rows
          .slice(0, Math.max(1, Math.floor(rows.length * 0.15)))
          .filter((row) => row.count > 0)
          .map((row) => runAt(row, axisX)?.width || 0)
          .filter(Boolean),
      ) || 1;

    // Arms resting against the body share their row with the trunk, so the
    // typical row through the chest measures shoulder-to-fingertip, not the
    // trunk. The narrowest row in the same stretch is the one where the arms
    // have swung clear — that is the trunk, and a trunk is never narrower than
    // the head sitting on it.
    // Shoulders to hips. It starts below the head, which is about a seventh of a
    // standing body and narrower than the trunk, and stops above the hips, which
    // sit near half height — a row of leg is narrower still, and either end
    // would have the trunk measuring as something else entirely.
    const spans = rows
      .slice(Math.floor(rows.length * 0.2), Math.max(2, Math.floor(rows.length * 0.48)))
      .filter((row) => row.count > 0)
      .map((row) => runAt(row, axisX)?.width || 0)
      .filter(Boolean);

    const trunkWidth = Math.max(headWidth, spans.length > 0 ? Math.min(...spans) : headWidth);

    const shoulderRow = rowAt(0.2);
    const hipRow = rowAt(0.58);
    const shoulderSpan = Math.max(trunkWidth, 2) / 2;
    const hipSpan = Math.max(trunkWidth * 0.85, 2) / 2;

    const start = findStart(labels, component, width, axisX, component.minY + boxHeight * 0.45);
    if (start === -1) {
      return null;
    }

    const field = geodesicField(labels, component, width, height, start);
    const tips = assignTips(findLimbTips(field, width, height, component), component, rows, {
      axisX,
      width: trunkWidth,
      headWidth,
      shoulderY: shoulderRow.y,
    });

    const shoulderLeft = { x: axisX - shoulderSpan, y: shoulderRow.y };
    const shoulderRight = { x: axisX + shoulderSpan, y: shoulderRow.y };
    const hipLeft = { x: axisX - hipSpan, y: hipRow.y };
    const hipRight = { x: axisX + hipSpan, y: hipRow.y };

    // An arm held down beside the body only parts from it near the wrist, so the
    // free run of a limb can be much shorter than the limb itself. The bar is set
    // low enough for that and still well clear of the two or three pixels a
    // corner of the outline produces.
    // Legs only exist below the point where the body stops being trunk-wide.
    // Someone framed from the waist up has corners down there, not feet, and
    // without this the rig hangs a pair of legs off the bottom of the crop.
    let trunkBottom = component.maxY;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const run = rows[index].count > 0 ? runAt(rows[index], axisX) : null;

      if (run && run.width >= trunkWidth * 0.8) {
        trunkBottom = rows[index].y;
        break;
      }
    }

    const standsOn = (tip) =>
      tip && tip.y > trunkBottom + trunkWidth * 0.2 ? tip : null;

    // An arm held down beside the body only parts from it near the wrist, so the
    // free run of a limb is far shorter than the limb itself. The bar is set low
    // enough for that and still well clear of the two or three pixels a corner of
    // the outline produces. It scales with the body's height — the one
    // measurement an arm lying against the trunk cannot inflate.
    const minimumLimb = Math.max(4, boxHeight * 0.1);
    const armLeft = traceLimb(field, width, tips.wristLeft, shoulderLeft, minimumLimb);
    const armRight = traceLimb(field, width, tips.wristRight, shoulderRight, minimumLimb);
    const legLeft = traceLimb(field, width, standsOn(tips.ankleLeft), hipLeft, minimumLimb);
    const legRight = traceLimb(field, width, standsOn(tips.ankleRight), hipRight, minimumLimb);

    const headBand = summarizeBand(rows, 0, 0.15);
    const head = tips.head
      ? { x: tips.head.x, y: tips.head.y }
      : headBand && { x: headBand.centerX, y: headBand.centerY };
    const neck = { x: axisX, y: shoulderRow.y };

    return {
      pixels: {
        head,
        neck,
        shoulderLeft,
        shoulderRight,
        elbowLeft: armLeft?.fold || null,
        elbowRight: armRight?.fold || null,
        wristLeft: armLeft?.tip || null,
        wristRight: armRight?.tip || null,
        torso: { x: axisX, y: component.minY + boxHeight * 0.4 },
        hipLeft,
        hipRight,
        kneeLeft: legLeft?.fold || null,
        kneeRight: legRight?.fold || null,
        ankleLeft: legLeft?.tip || null,
        ankleRight: legRight?.tip || null,
      },
      axisX,
      trunkWidth,
      headWidth,
      limbs: {
        arms: Number(Boolean(armLeft)) + Number(Boolean(armRight)),
        legs: Number(Boolean(legLeft)) + Number(Boolean(legRight)),
      },
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
  function describePose(labels, component, rows, width, height, faces) {
    const boxWidth = component.maxX - component.minX + 1;
    const boxHeight = component.maxY - component.minY + 1;
    const aspect = boxHeight / boxWidth;

    const rig = buildRig(labels, component, rows, width, height);

    // Normalised to 0..1 so an overlay of any size can draw the rig without
    // knowing the resolution it was found at.
    const toPoint = (point) =>
      point ? { x: clamp(point.x / width), y: clamp(point.y / height) } : null;
    const keypoints = rig
      ? Object.fromEntries(
          Object.entries(rig.pixels).map(([joint, point]) => [joint, toPoint(point)]),
        )
      : null;

    // A head reads as a head when it is clearly narrower than the body beneath it
    // and sits above the torso. A door, a wall or a wooden floor is a slab of even
    // width, which is what this rejects.
    //
    // The head is measured across its own run rather than the whole row, so arms
    // raised either side of it are not counted as skull. What it is compared
    // against is the widest row below, which needs no anatomy to be right — the
    // rigged trunk width is a finer measurement, and deliberately not used here:
    // whether a person is detected at all should not ride on it.
    const shoulderBand = summarizeBand(rows, 0.15, 0.5);
    const shoulderWidth = shoulderBand?.widest?.width || 0;
    const headRatio = rig && shoulderWidth > 0 ? rig.headWidth / shoulderWidth : 1;
    const headAboveTorso =
      keypoints?.head && keypoints?.torso ? keypoints.head.y < keypoints.torso.y : false;

    const face = matchFace(faces, keypoints?.head, width, height);
    const headScore = face ? 1 : headAboveTorso ? plateau(headRatio, 0.2, 0.85, 0.15, 0.15) : 0;

    return {
      aspect,
      headScore,
      face: Boolean(face),
      pose: classifyPose(aspect, boxWidth / width, boxHeight / height),
      keypoints,
      limbs: rig?.limbs || { arms: 0, legs: 0 },
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
    const { motion, motionCount } = readMotion(
      luma,
      options.previousLuma,
      settings,
      options.motionTrail,
    );

    const foreground = buildForeground(skin, motion, width, height);
    const { labels, components } = findComponents(
      foreground,
      skin,
      motion,
      luma,
      width,
      height,
      settings,
    );
    // Every silhouette is asked what it is before the best person is picked out.
    // A car scored as a person would not only take a photograph it should not
    // have; standing between the camera and someone walking behind it, it would
    // be chosen over them and cost the photograph that mattered.
    const scored = components.map((candidate) => ({
      component: candidate,
      vehicle: scoreVehicle(labels, candidate, luma, width, height),
    }));

    const vehicles = scored
      .filter((entry) => entry.vehicle.confidence >= settings.vehicleConfidence)
      .sort((left, right) => right.component.area - left.component.area);

    const vehicle = vehicles[0]?.vehicle || null;
    const component = chooseComponent(
      scored
        .filter((entry) => entry.vehicle.confidence < settings.vehicleConfidence)
        .map((entry) => entry.component),
      size,
      settings,
    );

    if (!component) {
      return {
        ...EMPTY_DETECTION,
        subject: vehicle ? "vehicle" : "none",
        vehicle,
        vehicles: vehicles.length,
        skinFraction: skinCount / size,
        motionFraction: motionCount / size,
        luma,
      };
    }

    const rows = profileRows(labels, width, component);
    const shape = describePose(labels, component, rows, width, height, options.faces);

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

    const present = confidence >= settings.presentConfidence;

    return {
      present,
      // `present` stays the answer to "is there a person", and it alone reaches
      // the schedule. A vehicle is reported alongside it, never instead of it.
      subject: present ? "person" : vehicle ? "vehicle" : "none",
      vehicle,
      vehicles: vehicles.length,
      confidence,
      pose: shape.pose,
      keypoints: shape.keypoints,
      limbs: shape.limbs,
      box: shape.box,
      aspect: shape.aspect,
      areaFraction,
      skinFraction,
      motionFraction,
      face: shape.face,
      luma,
    };
  }

  // Carries the previous frame and the fading motion memory, so the caller only
  // has to hand over pixels.
  function createPoseDetector(options = {}) {
    let previousLuma = null;
    let motionTrail = null;

    return {
      detect(frame, hints = {}) {
        const pixels = (frame?.width || 0) * (frame?.height || 0);

        if (!motionTrail || motionTrail.weight.length !== pixels) {
          motionTrail = {
            weight: new Float32Array(pixels),
            luma: new Uint8ClampedArray(pixels),
          };
        }

        const detection = analyzeFrame(frame, {
          ...options,
          ...hints,
          previousLuma,
          motionTrail,
        });

        previousLuma = detection.luma;
        return detection;
      },
      reset() {
        previousLuma = null;
        motionTrail = null;
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

    // Vehicles are steadied the same way and kept in their own drawer. They are
    // reported so they can be drawn; they are deliberately no part of `present`,
    // which is what the capture schedule reads.
    let vehiclePresent = false;
    let vehicleStreak = 0;
    let vehicleSeenAt = 0;
    let vehicleConfidence = 0;
    let vehicleBox = null;

    function state(timestamp) {
      return {
        present,
        confidence,
        pose: present ? pose : "none",
        keypoints: present ? keypoints : null,
        box: present ? box : null,
        vehicle: {
          present: vehiclePresent,
          confidence: vehicleConfidence,
          box: vehiclePresent ? vehicleBox : null,
        },
        lastSeenAt,
        sinceMs: present ? Math.max(0, timestamp - enteredAt) : 0,
        awayMs: present || lastSeenAt === 0 ? 0 : Math.max(0, timestamp - lastSeenAt),
      };
    }

    return {
      update(detection, timestamp) {
        const reading = detection || EMPTY_DETECTION;
        confidence += settings.smoothing * (reading.confidence - confidence);

        if (reading.vehicle) {
          vehicleStreak += 1;
          vehicleSeenAt = timestamp;
          vehicleBox = reading.vehicle.box;
          vehicleConfidence = reading.vehicle.confidence;

          if (!vehiclePresent && vehicleStreak >= settings.enterFrames) {
            vehiclePresent = true;
          }
        } else {
          vehicleStreak = 0;

          if (vehiclePresent && timestamp - vehicleSeenAt >= settings.holdMs) {
            vehiclePresent = false;
            vehicleBox = null;
            vehicleConfidence = 0;
          }
        }

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
        vehiclePresent = false;
        vehicleStreak = 0;
        vehicleSeenAt = 0;
        vehicleConfidence = 0;
        vehicleBox = null;
      },
    };
  }

  const api = Object.freeze({
    DEFAULTS,
    HEAD_GATE_FLOOR,
    TRACKER_DEFAULTS,
    VEHICLE_WEIGHTS,
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
