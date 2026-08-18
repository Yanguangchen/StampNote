(function initializePoseOverlay(globalScope) {
  "use strict";

  // Head, neck and trunk in white; the four limbs in the accent, so an arm or a
  // leg can be picked out against the body at a glance.
  const SPINE_COLOR = "rgba(255, 255, 255, 0.92)";
  const LIMB_COLOR = "rgba(120, 255, 200, 0.95)";
  // Amber, so a vehicle never reads as the green the watch uses for a person.
  const VEHICLE_COLOR = "rgba(255, 190, 90, 0.95)";
  const FACE_COLOR = "rgba(190, 235, 255, 0.9)";
  const HAND_COLOR = "rgba(255, 225, 150, 0.95)";

  // Everything drawn over the camera is sized from the width it is drawn at, so
  // the rig reads the same on a phone and on a wide display.
  function boneWidth(width) {
    return Math.max(2, Math.round(width / 150));
  }

  // The video is painted with object-fit: cover — scaled up until it fills the
  // box, with the overflow cropped off either the sides or the top and bottom.
  // Keypoints are in the camera frame's own coordinates, so they need the same
  // treatment; mapped straight onto the element they drift off the body by
  // however much was cropped. It shows up the moment the camera's shape stops
  // matching the box's, which on a phone is always: the rear camera hands back
  // 16:9 or 4:3 into whatever the layout gives it.
  function coveredFrame(width, height, sourceWidth, sourceHeight) {
    sourceWidth = sourceWidth || width;
    sourceHeight = sourceHeight || height;
    const scale = Math.max(width / sourceWidth, height / sourceHeight);
    const drawnWidth = sourceWidth * scale;
    const drawnHeight = sourceHeight * scale;

    return {
      left: (width - drawnWidth) / 2,
      top: (height - drawnHeight) / 2,
      width: drawnWidth,
      height: drawnHeight,
    };
  }


  function drawPersonMarker(context, state, frame, width, options = {}) {
    if (!state?.box) {
      return;
    }

    const box = state.box;
    const left = frame.left + Math.max(0, Math.min(1, box.x)) * frame.width;
    const top = frame.top + Math.max(0, Math.min(1, box.y)) * frame.height;
    const right =
      frame.left + Math.max(0, Math.min(1, box.x + box.width)) * frame.width;
    const bottom =
      frame.top + Math.max(0, Math.min(1, box.y + box.height)) * frame.height;
    const boxWidth = Math.max(0, right - left);
    const boxHeight = Math.max(0, bottom - top);
    if (boxWidth === 0 || boxHeight === 0) {
      return;
    }

    const stroke = Math.max(
      options.saved ? 3 : 1,
      boneWidth(width) * (options.saved ? 0.85 : 0.6),
    );
    const inset = stroke / 2;
    context.save();
    context.strokeStyle = options.saved ? LIMB_COLOR : "rgba(255, 255, 255, 0.55)";
    context.lineWidth = stroke;
    context.setLineDash(options.saved ? [] : [5, 5]);
    context.strokeRect(
      left + inset,
      top + inset,
      Math.max(0, boxWidth - stroke),
      Math.max(0, boxHeight - stroke),
    );
    context.restore();

    const label =
      state.workerId ||
      state.personLabel ||
      (Number.isInteger(state.personId) ? "TRACKING WORKER" : "");
    if (!label) {
      return;
    }

    const fontSize = Math.max(options.saved ? 18 : 10, Math.round(width / 42));
    const text = label.toUpperCase();
    context.save();
    context.font = `600 ${fontSize}px ui-monospace, SFMono-Regular, monospace`;
    const chipWidth = Math.min(boxWidth, context.measureText(text).width + fontSize);
    const chipHeight = Math.round(fontSize * 1.5);
    const chipTop = top < chipHeight + 2 ? top + stroke : top - chipHeight;
    context.fillStyle = LIMB_COLOR;
    context.fillRect(left, chipTop, chipWidth, chipHeight);
    context.fillStyle = "#062016";
    context.textBaseline = "middle";
    context.fillText(text, left + fontSize / 2, chipTop + chipHeight / 2 + 0.5);
    context.restore();
  }

  // Corner brackets rather than a full box, deliberately unlike the rig: a
  // vehicle is something the watch has recognised and set aside, not something
  // it is waiting on. Brackets mark the same extent with a quarter of the ink,
  // and they do not read as a second body outline over a busy site.
  function drawVehicle(context, box, frame, width) {
    const left = frame.left + box.x * frame.width;
    const top = frame.top + box.y * frame.height;
    const boxWidth = box.width * frame.width;
    const boxHeight = box.height * frame.height;
    const right = left + boxWidth;
    const bottom = top + boxHeight;

    // Lighter than a bone, so the marker sits behind the person in front of it.
    const stroke = Math.max(1.5, boneWidth(width) * 0.8);
    const arm = Math.max(8, Math.min(boxWidth, boxHeight) * 0.22);

    context.save();
    context.strokeStyle = VEHICLE_COLOR;
    context.lineWidth = stroke;
    context.lineCap = "round";
    context.lineJoin = "round";

    context.beginPath();
    [
      [left, top, 1, 1],
      [right, top, -1, 1],
      [left, bottom, 1, -1],
      [right, bottom, -1, -1],
    ].forEach(([x, y, dx, dy]) => {
      context.moveTo(x + dx * arm, y);
      context.lineTo(x, y);
      context.lineTo(x, y + dy * arm);
    });
    context.stroke();

    const label = "VEHICLE";
    const fontSize = Math.max(10, Math.round(width / 48));
    context.font = `600 ${fontSize}px ui-monospace, SFMono-Regular, monospace`;
    const padding = Math.round(fontSize * 0.6);
    const chipWidth = context.measureText(label).width + padding * 2;
    const chipHeight = Math.round(fontSize * 1.6);
    const gap = Math.round(stroke) + 3;

    // Kept inside the picture: a marker at the edge of frame must not push its
    // own label off the screen.
    const chipLeft = Math.min(
      Math.max(left, frame.left),
      frame.left + frame.width - chipWidth,
    );
    const chipTop = top - chipHeight - gap < frame.top ? top + gap : top - chipHeight - gap;

    context.fillStyle = "rgba(10, 14, 8, 0.72)";
    if (typeof context.roundRect === "function") {
      context.beginPath();
      context.roundRect(chipLeft, chipTop, chipWidth, chipHeight, chipHeight / 2);
      context.fill();
    } else {
      context.fillRect(chipLeft, chipTop, chipWidth, chipHeight);
    }

    context.fillStyle = VEHICLE_COLOR;
    context.textBaseline = "middle";
    context.fillText(label, chipLeft + padding, chipTop + chipHeight / 2 + 0.5);
    context.restore();
  }

  // Brows, eyes, nose, lips and jaw, traced as lines. The model reports 478
  // points, and all 478 drawn at a size that fits on a phone is a grey smudge;
  // the outlines are what read as a face.
  function drawFace(context, face, frame, stroke) {
    context.save();
    context.strokeStyle = FACE_COLOR;
    context.lineWidth = Math.max(1, stroke * 0.55);
    context.lineJoin = "round";
    context.lineCap = "round";

    context.beginPath();
    Object.values(face).forEach((edges) => {
      (edges || []).forEach(([from, to]) => {
        context.moveTo(frame.left + from.x * frame.width, frame.top + from.y * frame.height);
        context.lineTo(frame.left + to.x * frame.width, frame.top + to.y * frame.height);
      });
    });
    context.stroke();

    context.restore();
  }

  // Both hands, twenty-one points each: wrist, then four joints along every
  // finger. The pose model reports a wrist and nothing past it.
  function drawHands(context, hands, frame, stroke) {
    if (!hands || hands.length === 0) {
      return;
    }

    const at = (point) => [
      frame.left + point.x * frame.width,
      frame.top + point.y * frame.height,
    ];

    context.save();
    context.strokeStyle = HAND_COLOR;
    context.fillStyle = HAND_COLOR;
    context.lineWidth = Math.max(1, stroke * 0.7);
    context.lineCap = "round";
    context.lineJoin = "round";

    hands.forEach((hand) => {
      context.beginPath();
      hand.segments.forEach(([from, to]) => {
        const start = at(from);
        const end = at(to);

        context.moveTo(start[0], start[1]);
        context.lineTo(end[0], end[1]);
      });
      context.stroke();

      // Fingertips and knuckles, small enough not to swamp a hand held close.
      hand.points.forEach((point) => {
        const [x, y] = at(point);

        context.beginPath();
        context.arc(x, y, Math.max(1, stroke * 0.5), 0, Math.PI * 2);
        context.fill();
      });
    });

    context.restore();
  }

  function drawOverlay(canvas, state, sourceWidth, sourceHeight) {
    if (!canvas || !state) {
      return;
    }

    const width = canvas.clientWidth;
    const height = canvas.clientHeight;

    if (width === 0 || height === 0) {
      return;
    }
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const context = canvas.getContext("2d");
    context.clearRect(0, 0, width, height);

    // Vehicles are drawn whether or not anyone is with them, and are drawn
    // first so a person standing in front of one keeps the foreground.
    const frame = coveredFrame(width, height, sourceWidth, sourceHeight);

    if (state.vehicle?.present && state.vehicle.box) {
      drawVehicle(context, state.vehicle.box, frame, width);
    }

    if (!state.present) {
      return;
    }

    // Everyone the model found. A detector that reports only the one person —
    // the built-in one — is drawn from the flat fields it does fill in.
    const bodies = state.bodies?.length
      ? state.bodies
      : state.keypoints
        ? [state]
        : [];

    bodies.forEach((body) => drawBody(context, body, frame, width));
  }

  // One person: their bones, their box, their face, their hands.
  function drawBody(context, state, frame, width) {
    const points = state.keypoints;

    if (!points) {
      return;
    }

    const at = (point) =>
      point ? [frame.left + point.x * frame.width, frame.top + point.y * frame.height] : null;
    // Bones scale with the frame they are drawn on: a stroke set for a card the
    // width of a phone thins out to a scratch on a larger display.
    const stroke = boneWidth(width);

    // Each chain is drawn between whichever of its joints were found, so an arm
    // the silhouette swallowed simply leaves that limb undrawn instead of
    // pulling a bone across the body to a joint that is not there.
    const chains = [
      [SPINE_COLOR, [points.neck, points.torso]],
      [SPINE_COLOR, [points.shoulderLeft, points.neck, points.shoulderRight]],
      [SPINE_COLOR, [points.hipLeft, points.torso, points.hipRight]],
      [LIMB_COLOR, [points.shoulderLeft, points.elbowLeft, points.wristLeft]],
      [LIMB_COLOR, [points.shoulderRight, points.elbowRight, points.wristRight]],
      [LIMB_COLOR, [points.hipLeft, points.kneeLeft, points.ankleLeft]],
      [LIMB_COLOR, [points.hipRight, points.kneeRight, points.ankleRight]],
    ];

    context.lineWidth = stroke;
    context.lineCap = "round";
    context.lineJoin = "round";

    if (state.box) {
      drawPersonMarker(context, state, frame, width);
    }

    chains.forEach(([color, joints]) => {
      context.strokeStyle = color;

      joints.forEach((joint, index) => {
        const start = at(joints[index - 1]);
        const end = at(joint);

        if (index === 0 || !start || !end) {
          return;
        }

        context.beginPath();
        context.moveTo(start[0], start[1]);
        context.lineTo(end[0], end[1]);
        context.stroke();
      });
    });

    // The head reads as a head rather than another joint. Its keypoint is the
    // crown, so the circle is sized and centred off the run down to the neck —
    // the bounding box is no use here, since outstretched arms widen it without
    // making the head any bigger.
    if (state.face) {
      drawFace(context, state.face, frame, stroke);
    }

    drawHands(context, state.hands, frame, stroke);

    const head = at(points.head);
    const neck = at(points.neck);

    // The circle stands in for a head only while the face model has nothing to
    // say; drawing both puts a ring around a face that is already drawn.
    if (head && neck && !state.face) {
      const reach = Math.hypot(neck[0] - head[0], neck[1] - head[1]);
      const radius = Math.max(4, reach * 0.42);
      const centerX = head[0] + (neck[0] - head[0]) * 0.42;
      const centerY = head[1] + (neck[1] - head[1]) * 0.42;

      context.strokeStyle = SPINE_COLOR;
      context.lineWidth = stroke;
      context.beginPath();
      context.arc(centerX, centerY, radius, 0, Math.PI * 2);
      context.stroke();

      // The neck runs from the edge of the head, not from its middle.
      const span = Math.hypot(neck[0] - centerX, neck[1] - centerY) || 1;
      context.beginPath();
      context.moveTo(
        centerX + ((neck[0] - centerX) / span) * radius,
        centerY + ((neck[1] - centerY) / span) * radius,
      );
      context.lineTo(neck[0], neck[1]);
      context.stroke();
    }

    context.fillStyle = LIMB_COLOR;
    Object.entries(points).forEach(([joint, point]) => {
      const position = at(point);
      if (!position || joint === "head") {
        return;
      }

      context.beginPath();
      context.arc(position[0], position[1], stroke * 1.4, 0, Math.PI * 2);
      context.fill();
    });
  }

  const api = Object.freeze({
    FACE_COLOR,
    HAND_COLOR,
    LIMB_COLOR,
    SPINE_COLOR,
    VEHICLE_COLOR,
    boneWidth,
    coveredFrame,
    drawBody,
    drawFace,
    drawHands,
    drawOverlay,
    drawPersonMarker,
    drawVehicle,
  });
  globalScope.StampNotePoseOverlay = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
