(function initializeApp() {
  "use strict";

  const service = window.StampNoteAddress;
  const stamp = window.StampNoteStamp;
  const pose = window.StampNotePose;
  const schedule = window.StampNoteSchedule;
  const storage = window.StampNoteStore;
  const autoCapture = window.StampNoteAutoCapture;
  const addressField = document.querySelector("#address-field");
  const status = document.querySelector("#location-status");
  const addressPanel = document.querySelector("#address-panel");
  const previews = document.querySelector("#previews");
  const shareButton = document.querySelector("#share-button");
  const diagnostics = document.querySelector("#location-diagnostics");
  const diagnosticsBody = document.querySelector("#location-diagnostics-body");
  const photoInputs = document.querySelectorAll("#camera-input, #gallery-input");

  const monitorFrame = document.querySelector("#monitor-frame");
  const monitorVideo = document.querySelector("#monitor-video");
  const monitorToggle = document.querySelector("#monitor-toggle");
  const monitorToggleName = document.querySelector("#monitor-toggle-name");
  const monitorIconStart = document.querySelector("#monitor-icon-start");
  const monitorIconStop = document.querySelector("#monitor-icon-stop");
  const monitorStatus = document.querySelector("#monitor-status");
  const poseOverlay = document.querySelector("#pose-overlay");
  const poseBadge = document.querySelector("#pose-badge");
  const capturesList = document.querySelector("#captures");
  const capturesSummary = document.querySelector("#captures-summary");
  const capturesSave = document.querySelector("#captures-save");
  const capturesClear = document.querySelector("#captures-clear");

  if (!service || !stamp || !addressField || !status || !addressPanel) {
    return;
  }

  // One entry per chosen photo: the loaded image, its capture time, its canvas.
  const photos = [];

  // Long enough that typing an address does not save a file per keystroke.
  const AUTO_SAVE_DELAY = 1500;
  let autoSaveTimer = null;
  let autoSaved = false;

  function setStatus(message, state = "idle") {
    status.textContent = message;
    status.dataset.state = state;
  }

  function readCache(key) {
    try {
      return window.sessionStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function writeCache(key, value) {
    try {
      window.sessionStorage.setItem(key, value);
    } catch {
      // Private browsing can disable storage; address lookup still works.
    }
  }

  function environment() {
    let embedded = false;
    try {
      embedded = window.top !== window.self;
    } catch {
      // A cross-origin parent throws on access, which is itself the answer.
      embedded = true;
    }

    return {
      isSecureContext: window.isSecureContext !== false,
      userAgent: navigator.userAgent || "",
      maxTouchPoints: navigator.maxTouchPoints || 0,
      standalone:
        navigator.standalone === true ||
        window.matchMedia?.("(display-mode: standalone)").matches === true,
      embedded,
    };
  }

  function userMessage(error) {
    return service.describeGeolocationError(error, environment());
  }

  // The message alone cannot say which of the several iOS blocks is in play,
  // so the details stay on screen for the user to read back.
  async function showDiagnostics(error) {
    if (!diagnostics || !diagnosticsBody) {
      return;
    }

    diagnosticsBody.textContent = service.describeEnvironment(environment(), {
      permissionState: await service.getPermissionState(navigator.permissions),
      errorCode: error?.code,
      errorMessage: error?.message,
      hasGeolocation: typeof navigator.geolocation?.getCurrentPosition === "function",
    });
    diagnostics.hidden = false;
  }

  function render() {
    if (photos.length === 0) {
      return;
    }

    previews.replaceChildren();

    photos.forEach((photo) => {
      photo.canvas = stamp.drawStampedImage(photo.image, {
        address: addressField.value,
        date: photo.date,
      });
      photo.canvas.className = "preview";
      previews.append(photo.canvas);
    });

    if (shareButton && typeof navigator.canShare === "function") {
      shareButton.hidden = false;
    }
    document.body.classList.add("is-stamped");
    scheduleAutoSave();
  }

  // The file downloads on its own once the stamp settles, so nothing has to be
  // pressed. It waits for an address to avoid saving a half-finished stamp, and
  // saves one set per upload so editing afterwards does not pile up files.
  function scheduleAutoSave() {
    if (autoSaved || !addressField.value.trim()) {
      return;
    }

    window.clearTimeout(autoSaveTimer);
    autoSaveTimer = window.setTimeout(autoSave, AUTO_SAVE_DELAY);
  }

  function downloadFile(file) {
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");

    link.href = url;
    link.download = file.name;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function autoSave() {
    const stamped = photos.filter((photo) => photo.canvas);
    const files = (await Promise.all(stamped.map(toFile))).filter(Boolean);

    if (files.length === 0) {
      return;
    }

    autoSaved = true;

    files.forEach(downloadFile);

    setStatus(files.length === 1 ? "Saved." : `Saved ${files.length} photos.`, "success");
  }

  function loadPhoto(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();

      image.addEventListener("load", () => {
        URL.revokeObjectURL(url);
        resolve({ image, date: new Date(file.lastModified || Date.now()), name: file.name });
      });
      image.addEventListener("error", () => {
        URL.revokeObjectURL(url);
        reject(new Error(`${file.name} could not be opened.`));
      });

      image.src = url;
    });
  }

  async function requestLocation({ focusField = true } = {}) {
    if (environment().isSecureContext === false) {
      setStatus(userMessage(null), "error");
      showDiagnostics(null);
      return;
    }

    setStatus("Locating…");

    try {
      const coordinates = await service.getCurrentCoordinates(navigator.geolocation);
      const cacheKey = service.createCacheKey(coordinates.latitude, coordinates.longitude);
      let address = readCache(cacheKey);

      if (!address) {
        setStatus("Looking up address…");
        const result = await service.reverseGeocode(coordinates.latitude, coordinates.longitude, {
          language: navigator.language || "en",
        });
        address = result.address;
        writeCache(cacheKey, address);
      }

      setStatus("", "success");
      addressField.value = address;
      if (diagnostics) {
        diagnostics.hidden = true;
      }
      if (focusField) {
        addressField.focus();
      }
      render();
    } catch (error) {
      setStatus(userMessage(error), "error");
      showDiagnostics(error);
    }
  }

  // With no location button left, this automatic attempt is the only chance to
  // fill the address, so it runs whenever permission has not already been
  // refused. Browsers that prompt without a gesture (desktop Safari, Chrome,
  // Firefox) still ask here; iOS refuses a request made outside a tap, so auto
  // capture fires this from its own start tap before awaiting the camera.
  async function autoLocate() {
    const context = environment();

    if (context.isSecureContext === false) {
      setStatus(userMessage(null), "error");
      showDiagnostics(null);
      return;
    }

    const blocked =
      (await service.getPermissionState(navigator.permissions)) === "denied" ||
      service.isInAppBrowser(context) ||
      context.embedded;

    if (blocked) {
      setStatus("Type the street address above.");
      showDiagnostics({ code: 1 });
      return;
    }

    requestLocation({ focusField: false });
  }

  async function addPhotos(files) {
    const loaded = await Promise.allSettled([...files].map(loadPhoto));
    const failed = loaded.filter((entry) => entry.status === "rejected");

    // A new upload is a new set to save.
    window.clearTimeout(autoSaveTimer);
    autoSaved = false;

    photos.length = 0;
    loaded
      .filter((entry) => entry.status === "fulfilled")
      .forEach((entry) => photos.push(entry.value));

    if (photos.length === 0) {
      setStatus("That photo could not be opened.", "error");
      return;
    }

    render();

    const firstRun = addressPanel.hidden;
    addressPanel.hidden = false;

    if (failed.length > 0) {
      setStatus(`${failed.length} photo(s) could not be opened.`, "error");
      return;
    }

    if (firstRun) {
      autoLocate();
    }
  }

  function toFile(photo, index) {
    return new Promise((resolve) => {
      photo.canvas.toBlob(
        (blob) => {
          const name = `stamped-${index + 1}-${(photo.name || "photo").replace(/\.[^.]+$/, "")}.jpg`;
          resolve(blob ? new File([blob], name, { type: "image/jpeg" }) : null);
        },
        "image/jpeg",
        0.92,
      );
    });
  }

  // Hands the stamped photos to the OS share sheet, where Telegram (and any
  // other installed app) shows up as a target. There is no way to post into a
  // Telegram chat directly from a page.
  async function share() {
    const stamped = photos.filter((photo) => photo.canvas);
    const files = (await Promise.all(stamped.map(toFile))).filter(Boolean);

    if (files.length === 0 || !navigator.canShare?.({ files })) {
      setStatus("Sharing is not available here — press and hold the photo to save it.", "error");
      return;
    }

    try {
      await navigator.share({ files });
    } catch (error) {
      if (error?.name !== "AbortError") {
        setStatus("Sharing failed — press and hold the photo to save it.", "error");
      }
    }
  }

  photoInputs.forEach((input) => {
    input.addEventListener("change", () => {
      if (input.files && input.files.length > 0) {
        addPhotos(input.files);
      }
    });
  });

  addressField.addEventListener("input", render);

  // Only offer the button where the browser can actually share files.
  if (shareButton && typeof navigator.canShare === "function") {
    shareButton.addEventListener("click", share);
  }

  // ---------------------------------------------------------------------------
  // Autonomous capture
  //
  // The camera runs live, a pose tracker watches the frames, and photos are
  // taken on their own — every 30 seconds while someone is in frame, every 120
  // seconds while no one is. Each photo is stamped and written straight to the
  // device's own store; nothing is uploaded and nothing needs a tap.
  // ---------------------------------------------------------------------------

  if (!pose || !schedule || !storage || !autoCapture || !monitorToggle || !monitorVideo) {
    return;
  }

  // Small enough to analyse several times a second on a phone, large enough to
  // keep a person a few metres away more than a handful of pixels.
  const SAMPLE_WIDTH = 128;
  const SAMPLE_HEIGHT = 96;
  const FACE_HINT_INTERVAL = 2000;
  const THUMBNAIL_LIMIT = 12;
  const DOWNLOAD_SPACING = 400;

  // Head, neck and trunk in white; the four limbs in the accent, so an arm or a
  // leg can be picked out against the body at a glance.
  const SPINE_COLOR = "rgba(255, 255, 255, 0.92)";
  const LIMB_COLOR = "rgba(120, 255, 200, 0.95)";
  // Amber, so a vehicle never reads as the green the watch uses for a person.
  const VEHICLE_COLOR = "rgba(255, 190, 90, 0.95)";
  const FACE_COLOR = "rgba(190, 235, 255, 0.9)";

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
  function coveredFrame(width, height) {
    const sourceWidth = monitorVideo.videoWidth || width;
    const sourceHeight = monitorVideo.videoHeight || height;
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

  const sampleCanvas = document.createElement("canvas");
  sampleCanvas.width = SAMPLE_WIDTH;
  sampleCanvas.height = SAMPLE_HEIGHT;
  const sampleContext = sampleCanvas.getContext("2d", { willReadFrequently: true });
  const captureCanvas = document.createElement("canvas");

  const store = storage.createPhotoStore();
  const thumbnailUrls = [];

  let stream = null;
  let controller = null;
  let sampleTimer = null;
  let wakeLock = null;
  let faceDetector = null;
  let faceHint = null;
  let usingModel = false;
  let modelDetector = null;
  let faceHintAt = 0;
  let facePending = false;

  function setMonitorStatus(message, state = "idle") {
    if (!monitorStatus) {
      return;
    }

    monitorStatus.textContent = message;
    monitorStatus.dataset.state = state;
  }

  function isRunning() {
    return Boolean(controller?.getState().running);
  }

  function setToggleLabel(running) {
    const name = running ? "Stop auto capture" : "Start auto capture";

    monitorToggle.title = name;
    if (monitorToggleName) {
      monitorToggleName.textContent = name;
    }
    if (monitorIconStart && monitorIconStop) {
      // `hidden` is an HTMLElement property, so assigning it on an SVG element
      // sets a stray JavaScript property and leaves the icon on screen. The
      // attribute is what the [hidden] rule matches.
      monitorIconStart.toggleAttribute("hidden", running);
      monitorIconStop.toggleAttribute("hidden", !running);
    }
  }

  // Chrome ships the Shape Detection API; Safari and Firefox do not. Where it
  // exists a face box anchors the head keypoint and lifts the confidence, and
  // where it does not the skin-and-motion cues carry the detection alone.
  function createFaceDetector() {
    if (typeof window.FaceDetector !== "function") {
      return null;
    }

    try {
      return new window.FaceDetector({ fastMode: true, maxDetectedFaces: 4 });
    } catch {
      return null;
    }
  }

  // Runs well below the sampling rate and never blocks it: the loop reads
  // whichever hint finished last.
  function refreshFaceHint(timestamp) {
    if (!faceDetector || facePending || timestamp - faceHintAt < FACE_HINT_INTERVAL) {
      return;
    }

    facePending = true;
    faceDetector
      .detect(sampleCanvas)
      .then((faces) => {
        faceHint = faces.map((face) => ({
          x: face.boundingBox.x,
          y: face.boundingBox.y,
          width: face.boundingBox.width,
          height: face.boundingBox.height,
        }));
      })
      .catch(() => {
        // A detector that throws once will keep throwing; drop it.
        faceDetector = null;
        faceHint = null;
      })
      .finally(() => {
        faceHintAt = timestamp;
        facePending = false;
      });
  }

  function frameIsReady() {
    return Boolean(stream) && monitorVideo.readyState >= 2 && Boolean(monitorVideo.videoWidth);
  }

  // The trained model reads the video element itself, at whatever resolution the
  // camera is giving; only the built-in detector needs the downscaled copy.
  function sampleVideo() {
    return frameIsReady() ? monitorVideo : null;
  }

  function sampleFrame() {
    if (!frameIsReady()) {
      return null;
    }

    sampleContext.drawImage(monitorVideo, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
    refreshFaceHint(Date.now());

    return sampleContext.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
  }

  // The trained model is the detector; the built-in one is what is left when it
  // cannot be had — an old browser, a failed download, no WebAssembly. Better a
  // rougher watch than a dead button.
  async function createDetector() {
    if (!window.StampNoteModel) {
      return { detector: pose.createPoseDetector(), model: false };
    }

    try {
      setMonitorStatus("Loading the pose model — a few megabytes, the first time only…");
      return { detector: await window.StampNoteModel.load(), model: true };
    } catch (error) {
      setMonitorStatus(
        "The pose model could not load, so the built-in detector is watching instead.",
        "error",
      );
      return { detector: pose.createPoseDetector(), model: false, error };
    }
  }

  // Full sensor resolution for the photo itself — the 128x96 frame is only ever
  // used to decide when to take one.
  function captureImage() {
    return new Promise((resolve, reject) => {
      if (!monitorVideo.videoWidth || !monitorVideo.videoHeight) {
        reject(new Error("The camera has no frame yet."));
        return;
      }

      const date = new Date();
      captureCanvas.width = monitorVideo.videoWidth;
      captureCanvas.height = monitorVideo.videoHeight;
      captureCanvas.getContext("2d").drawImage(monitorVideo, 0, 0);

      const stamped = stamp.drawStampedImage(captureCanvas, {
        address: addressField.value,
        date,
      });

      stamped.toBlob(
        (blob) => {
          if (blob) {
            resolve({ blob, date });
          } else {
            reject(new Error("The photo could not be encoded."));
          }
        },
        "image/jpeg",
        0.9,
      );
    });
  }

  // A labelled box, deliberately unlike the rig: a vehicle is something the
  // watch has recognised and set aside, not something it is waiting on.
  function drawVehicle(context, box, frame, width) {
    const left = frame.left + box.x * frame.width;
    const top = frame.top + box.y * frame.height;
    const boxWidth = box.width * frame.width;
    const boxHeight = box.height * frame.height;

    const stroke = boneWidth(width);

    context.save();
    context.strokeStyle = VEHICLE_COLOR;
    context.lineWidth = stroke;
    context.strokeRect(left, top, boxWidth, boxHeight);

    const label = "VEHICLE";
    const fontSize = Math.max(10, Math.round(width / 42));
    context.font = `600 ${fontSize}px ui-monospace, SFMono-Regular, monospace`;
    const textWidth = context.measureText(label).width;
    const chipWidth = textWidth + fontSize;
    const chipHeight = Math.round(fontSize * 1.5);
    // Inside the box when there is no room for it above.
    const chipTop = top < chipHeight + 2 ? top + 2 : top - chipHeight - 2;

    context.fillStyle = VEHICLE_COLOR;
    context.fillRect(left, chipTop, chipWidth, chipHeight);
    context.fillStyle = "#1b1405";
    context.textBaseline = "middle";
    context.fillText(label, left + fontSize / 2, chipTop + chipHeight / 2 + 0.5);
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

  function drawOverlay(state) {
    if (!poseOverlay) {
      return;
    }

    const width = poseOverlay.clientWidth;
    const height = poseOverlay.clientHeight;

    if (width === 0 || height === 0) {
      return;
    }
    if (poseOverlay.width !== width || poseOverlay.height !== height) {
      poseOverlay.width = width;
      poseOverlay.height = height;
    }

    const context = poseOverlay.getContext("2d");
    context.clearRect(0, 0, width, height);

    // Vehicles are drawn whether or not anyone is with them, and are drawn
    // first so a person standing in front of one keeps the foreground.
    const frame = coveredFrame(width, height);

    if (state.vehicle?.present && state.vehicle.box) {
      drawVehicle(context, state.vehicle.box, frame, width);
    }

    const points = state.keypoints;
    if (!state.present || !points) {
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
      context.save();
      context.strokeStyle = "rgba(255, 255, 255, 0.35)";
      context.lineWidth = Math.max(1, stroke * 0.6);
      context.setLineDash([5, 5]);
      context.strokeRect(
        frame.left + state.box.x * frame.width,
        frame.top + state.box.y * frame.height,
        state.box.width * frame.width,
        state.box.height * frame.height,
      );
      context.restore();
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

  function renderState(state) {
    if (poseBadge) {
      poseBadge.textContent = autoCapture.describeCadence(state);
      poseBadge.dataset.present = String(state.present);
    }

    drawOverlay(state);

    if (state.error) {
      setMonitorStatus(state.error, "error");
    }
  }

  function releaseThumbnails() {
    thumbnailUrls.splice(0).forEach((url) => URL.revokeObjectURL(url));
  }

  async function renderCaptures() {
    if (!capturesList) {
      return;
    }

    const records = await store.list();

    releaseThumbnails();
    capturesList.replaceChildren();

    records.slice(0, THUMBNAIL_LIMIT).forEach((record) => {
      if (!record.blob) {
        return;
      }

      const url = URL.createObjectURL(record.blob);
      const image = new Image();

      thumbnailUrls.push(url);
      image.className = "capture";
      image.src = url;
      image.alt = record.poseDetected
        ? `Capture with a person in frame at ${record.capturedAt}`
        : `Capture at ${record.capturedAt}`;
      image.dataset.pose = String(record.poseDetected);
      capturesList.append(image);
    });

    const usage = await store.usage(records);
    const hasCaptures = usage.count > 0;

    if (capturesSummary) {
      const kept = usage.count === 1 ? "1 photo" : `${usage.count} photos`;
      const where = store.isPersistent() ? "on this device" : "in this tab only";

      capturesSummary.textContent = hasCaptures
        ? `${kept} stored ${where} · ${storage.formatBytes(usage.bytes)}`
        : "";
    }

    if (capturesSave) {
      capturesSave.hidden = !hasCaptures;
    }
    if (capturesClear) {
      capturesClear.hidden = !hasCaptures;
    }
  }

  // Keeps the screen awake so the schedule keeps running: a locked phone
  // suspends the camera and the timers along with it.
  async function requestWakeLock() {
    if (!navigator.wakeLock?.request) {
      return;
    }

    try {
      wakeLock = await navigator.wakeLock.request("screen");
    } catch {
      wakeLock = null;
    }
  }

  function releaseWakeLock() {
    wakeLock?.release?.().catch(() => {});
    wakeLock = null;
  }

  function describeCameraError(error) {
    if (environment().isSecureContext === false) {
      return "The camera needs a secure page. Open this site over https:// (or on localhost).";
    }

    switch (error?.name) {
      case "NotAllowedError":
        return "Camera permission was denied — allow it in your browser's site settings and start again.";
      case "NotFoundError":
      case "OverconstrainedError":
        return "No camera was found on this device.";
      case "NotReadableError":
        return "The camera is already in use by another app.";
      default:
        return error?.message || "The camera could not be started.";
    }
  }

  async function startMonitor() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setMonitorStatus("This browser cannot open a live camera — use Add photo below.", "error");
      return;
    }

    setMonitorStatus("Starting the camera…");

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "environment",
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
    } catch (error) {
      setMonitorStatus(describeCameraError(error), "error");
      return;
    }

    monitorVideo.srcObject = stream;
    try {
      await monitorVideo.play();
    } catch {
      // Some browsers resolve the frame without play() ever settling.
    }

    const { detector, model } = await createDetector();
    modelDetector = detector.kind === "model" ? detector : null;

    // The face hint only ever propped up the built-in detector's head cue; the
    // trained model has no use for it.
    faceDetector = model ? null : createFaceDetector();
    faceHint = null;
    usingModel = model;

    controller = autoCapture.createAutoCapture({
      detector,
      tracker: pose.createPoseTracker(),
      scheduler: schedule.createCaptureScheduler(),
      store,
      sampleFrame: detector.wantsVideo ? sampleVideo : sampleFrame,
      captureImage,
      getAddress: () => addressField.value,
      getFaces: () => faceHint,
      onUpdate: renderState,
    });

    controller.start();
    sampleTimer = window.setInterval(async () => {
      const before = controller.getState().captures;
      const state = await controller.tick();

      if (state.captures !== before) {
        renderCaptures();
      }
    }, autoCapture.SAMPLE_INTERVAL);

    if (monitorFrame) {
      monitorFrame.hidden = false;
    }
    document.body.classList.add("is-stamped");
    setToggleLabel(true);
    setMonitorStatus(
      model
        ? "Watching for people — photos save themselves."
        : "Watching with the built-in detector — photos save themselves.",
      model ? "success" : "idle",
    );
    requestWakeLock();
    renderCaptures();
  }

  function stopMonitor() {
    window.clearInterval(sampleTimer);
    sampleTimer = null;

    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    monitorVideo.srcObject = null;

    controller?.stop();
    // The model holds WebAssembly memory and a GPU context; dropping the
    // reference alone would leave both until the tab is closed.
    modelDetector?.close?.();
    modelDetector = null;
    controller = null;
    faceDetector = null;
    faceHint = null;

    releaseWakeLock();

    if (monitorFrame) {
      monitorFrame.hidden = true;
    }
    setToggleLabel(false);
    setMonitorStatus("Auto capture stopped. Your photos are still stored on this device.");
  }

  async function saveCaptures() {
    const records = await store.list();

    if (records.length === 0) {
      return;
    }

    setMonitorStatus(`Saving ${records.length} photo(s)…`);

    // Browsers throttle a burst of downloads, so they are spaced out.
    records.forEach((record, index) => {
      window.setTimeout(() => {
        downloadFile(new File([record.blob], record.name, { type: record.type }));
      }, index * DOWNLOAD_SPACING);
    });

    window.setTimeout(
      () => setMonitorStatus(`Saved ${records.length} photo(s).`, "success"),
      records.length * DOWNLOAD_SPACING,
    );
  }

  async function clearCaptures() {
    const usage = await store.usage();

    if (usage.count === 0) {
      return;
    }
    if (!window.confirm(`Delete ${usage.count} stored photo(s) from this device?`)) {
      return;
    }

    await store.clear();
    releaseThumbnails();
    await renderCaptures();
    setMonitorStatus("Stored photos deleted.");
  }

  monitorToggle.addEventListener("click", () => {
    if (isRunning()) {
      stopMonitor();
      return;
    }

    // iOS only honours a location request made during a tap, so it is started
    // here, before the camera prompt takes the gesture away.
    addressPanel.hidden = false;
    if (!addressField.value.trim()) {
      autoLocate();
    }

    startMonitor();
  });

  capturesSave?.addEventListener("click", saveCaptures);
  capturesClear?.addEventListener("click", clearCaptures);

  // A hidden tab has its camera suspended and its timers throttled, so tracking
  // pauses rather than scoring stale frames, and picks the schedule back up on
  // return.
  document.addEventListener("visibilitychange", () => {
    if (!controller) {
      return;
    }

    if (document.hidden) {
      controller.setPaused(true);
      return;
    }

    controller.setPaused(false);
    monitorVideo.play().catch(() => {});
    if (!wakeLock) {
      requestWakeLock();
    }
  });

  window.addEventListener("pagehide", () => {
    if (isRunning()) {
      stopMonitor();
    }
  });

  setToggleLabel(false);
  renderCaptures();
})();
