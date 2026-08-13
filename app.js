(function initializeApp() {
  "use strict";

  const service = window.StampNoteAddress;
  const stamp = window.StampNoteStamp;
  const pose = window.StampNotePose;
  const schedule = window.StampNoteSchedule;
  const storage = window.StampNoteStore;
  const cloud = window.StampNoteFirebase;
  const telemetry = window.StampNoteObservability;
  const facialRecognition = window.StampNoteFaceIdentity;
  const personIdentity = window.StampNotePersonTracker;
  const triage = window.StampNoteTriage;
  const autoCapture = window.StampNoteAutoCapture;
  const addressField = document.querySelector("#address-field");
  const status = document.querySelector("#location-status");
  const addressPanel = document.querySelector("#address-panel");
  const previews = document.querySelector("#previews");
  const shareButton = document.querySelector("#share-button");
  const diagnostics = document.querySelector("#location-diagnostics");
  const diagnosticsBody = document.querySelector("#location-diagnostics-body");
  // The live camera is the camera now, so the only file input left is the one
  // that stamps a photograph you already have.
  const galleryInput = document.querySelector("#gallery-input");

  const monitorFrame = document.querySelector("#monitor-frame");
  const monitorVideo = document.querySelector("#monitor-video");
  const monitorToggle = document.querySelector("#monitor-toggle");
  const monitorToggleName = document.querySelector("#monitor-toggle-name");
  const monitorIconStart = document.querySelector("#monitor-icon-start");
  const monitorIconStop = document.querySelector("#monitor-icon-stop");
  const monitorStatus = document.querySelector("#monitor-status");
  const captureFlash = document.querySelector("#capture-flash");
  const poseOverlay = document.querySelector("#pose-overlay");
  const poseBadge = document.querySelector("#pose-badge");
  const faceEnrollment = document.querySelector("#face-enrollment");
  const faceEnrollmentKicker = document.querySelector("#face-enrollment-kicker");
  const faceEnrollmentTitle = document.querySelector("#face-enrollment-title");
  const faceEnrollmentMessage = document.querySelector("#face-enrollment-message");
  const faceEnrollmentMatch = document.querySelector("#face-enrollment-match");
  const faceEnrollmentWorkerId = document.querySelector("#face-enrollment-worker-id");
  const faceEnrollmentProgress = document.querySelector("#face-enrollment-progress");
  const faceEnrollmentCount = document.querySelector("#face-enrollment-count");
  const faceEnrollmentSkip = document.querySelector("#face-enrollment-skip");
  const capturesList = document.querySelector("#captures");
  const capturesSummary = document.querySelector("#captures-summary");
  const capturesSave = document.querySelector("#captures-save");
  const capturesClear = document.querySelector("#captures-clear");
  const aiReviewButton = document.querySelector("#ai-review");
  const aiReviewBin = document.querySelector("#ai-review-bin");
  const aiReviewPurge = document.querySelector("#ai-review-purge");
  const aiReviewLoader = document.querySelector("#ai-review-loader");
  const aiReviewLoaderTitle = document.querySelector("#ai-review-loader-title");
  const aiReviewLoaderDetail = document.querySelector("#ai-review-loader-detail");
  const cloudAuth = document.querySelector("#cloud-auth");
  const adminDashboard = document.querySelector("#admin-dashboard");
  const stageEmpty = document.querySelector("#stage-empty");
  const filmstrip = document.querySelector("#filmstrip");
  const placeToggle = document.querySelector("#place-toggle");
  const viewer = document.querySelector("#viewer");
  const viewerImage = document.querySelector("#viewer-image");
  const viewerAiReview = document.querySelector("#viewer-ai-review");
  const viewerRestore = document.querySelector("#viewer-restore");
  const viewerShare = document.querySelector("#viewer-share");
  const viewerDelete = document.querySelector("#viewer-delete");
  const viewerClose = document.querySelector("#viewer-close");

  telemetry?.configure({ surface: "capture" });

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
        window.matchMedia?.("(display-mode: standalone)").matches === true ||
        window.matchMedia?.("(display-mode: fullscreen)").matches === true,
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

      // A tile in the strip, like a capture, and it opens the same viewer.
      const tile = document.createElement("button");

      tile.type = "button";
      tile.className = "preview";
      tile.setAttribute("aria-label", "Stamped photo — open");
      tile.append(photo.canvas);
      tile.addEventListener("click", () => {
        openViewer({ url: photo.canvas.toDataURL("image/jpeg", 0.92), label: "Stamped photo" });
      });
      previews.append(tile);
    });

    if (shareButton && typeof navigator.canShare === "function") {
      shareButton.hidden = false;
    }
    showFilmstrip();
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

  galleryInput?.addEventListener("change", () => {
    if (galleryInput.files && galleryInput.files.length > 0) {
      addPhotos(galleryInput.files);
    }
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
  // device's own store. With explicit consent, scheduled photos are reviewed
  // in complete groups of eight and compact reviewed copies are cloud-synced.
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
  const AI_REVIEW_BATCH_SIZE = 8;
  const AI_REVIEW_MAX_EDGE = 512;
  const FACE_MATCH_CONFIRMATION_MS = 1_800;
  // Version 2 covers automatic uploads. The old button-only consent must not be
  // silently broadened to include background review.
  const AI_REVIEW_CONSENT_KEY = "stampnote-ai-review-consent-v2";
  const LOCAL_LIVE_SERVER =
    ["127.0.0.1", "localhost"].includes(window.location.hostname) &&
    window.location.port === "5500";
  const AI_REVIEW_ENDPOINT = LOCAL_LIVE_SERVER
    ? "https://stampnote-omega.vercel.app/api/triage"
    : "/api/triage";

  // Head, neck and trunk in white; the four limbs in the accent, so an arm or a
  // leg can be picked out against the body at a glance.
  const SPINE_COLOR = "rgba(255, 255, 255, 0.92)";
  const LIMB_COLOR = "rgba(120, 255, 200, 0.95)";
  // Amber, so a vehicle never reads as the green the watch uses for a person.
  const VEHICLE_COLOR = "rgba(255, 190, 90, 0.95)";
  const FACE_COLOR = "rgba(190, 235, 255, 0.9)";
  const HAND_COLOR = "rgba(255, 225, 150, 0.95)";

  // How far the drawn pose travels towards the latest reading each animation
  // frame. Detection runs a few times a second and the screen redraws sixty;
  // easing between the two is what turns a row of stills into movement.
  const EASE = 0.28;

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
  let enrollmentFaceScanner = null;
  let target = null;
  let drawn = null;
  let painter = null;
  let faceHintAt = 0;
  let facePending = false;
  let aiReviewLock = false;
  let aiReviewRunning = false;
  let automaticAiReviewEnabled = readCache(AI_REVIEW_CONSENT_KEY) === "yes";
  let showingAiDiscarded = false;
  let captureFlashTimer = null;
  let signedInUser = null;
  let cloudSyncPromise = null;
  let cloudSyncRequested = false;
  let lastTrackingErrorCode = null;
  let faceEnrollmentWasActive = false;
  let lastFaceEnrollmentStatus = null;
  let faceMatchConfirmationVisible = false;
  let faceMatchConfirmationShown = false;
  let faceMatchConfirmationTimer = null;

  function setMonitorStatus(message, state = "idle") {
    if (!monitorStatus) {
      return;
    }

    monitorStatus.textContent = message;
    monitorStatus.dataset.state = state;
  }

  function describeCloudError(error) {
    switch (error?.code) {
      case "auth/unauthorized-domain":
        return "This site must be added to Firebase Authentication's authorized domains.";
      case "auth/operation-not-allowed":
        return "Enable Google sign-in in Firebase Authentication first.";
      case "permission-denied":
        return "Firebase denied photo access. Deploy the StampNote security rules.";
      case "resource-exhausted":
        return "Firestore quota has been reached.";
      default:
        return error?.message || "Firebase photo sync failed.";
    }
  }

  function updateCloudControls(user) {
    signedInUser = user || null;

    if (cloudAuth) {
      cloudAuth.dataset.signedIn = String(Boolean(user));
      cloudAuth.setAttribute("aria-pressed", String(Boolean(user)));
      const name = cloudAuth.querySelector(".hint");
      if (name) {
        name.textContent = user
          ? `Sign out ${user.email || "Google account"}`
          : "Sign in with Google";
      }
    }
    if (adminDashboard) {
      adminDashboard.hidden = !user;
    }
  }

  // Retried uploads are idempotent: Firebase uses the local photo ID for both
  // the Firestore document. A network drop can therefore
  // leave the local queue intact without producing a duplicate on retry.
  async function syncPendingReviewedCaptures() {
    cloudSyncRequested = true;

    if (cloudSyncPromise) {
      return cloudSyncPromise;
    }

    cloudSyncPromise = (async () => {
      const syncStartedAt = performance.now();
      const traceId = telemetry?.createTraceId();
      let uploaded = 0;
      let failed = 0;
      let started = false;
      const attempted = new Set();

      do {
        cloudSyncRequested = false;

        if (!cloud || !signedInUser) {
          break;
        }

        const pending = (await store.listPending()).filter(
          (record) => record.blob && record.aiReview && !attempted.has(record.id),
        );
        if (pending.length > 0 && !started) {
          started = true;
          telemetry?.event(
            "cloud.sync.started",
            { queuedCount: pending.length, online: navigator.onLine !== false },
            { traceId },
          );
        }

        for (const record of pending) {
          attempted.add(record.id);
          try {
            await cloud.uploadReviewedPhoto(record);
            await store.markSynced(record.id);
            uploaded += 1;
          } catch (error) {
            failed += 1;
            console.warn("[StampNote cloud] Firestore upload failed.", {
              errorCode: telemetry?.safeErrorCode(error),
            });
          }
        }
      } while (cloudSyncRequested);

      const queued = (await store.listPending()).filter(
        (record) => record.blob && record.aiReview,
      ).length;

      if (started) {
        const eventName = failed > 0 ? "cloud.sync.failed" : "cloud.sync.completed";
        telemetry?.event(
          eventName,
          {
            durationMs: performance.now() - syncStartedAt,
            uploadedCount: uploaded,
            queuedCount: queued,
            failedCount: failed,
            status: failed > 0 ? "failed" : "success",
            online: navigator.onLine !== false,
          },
          { traceId, immediate: failed > 0 },
        );
      }

      return { uploaded, failed, queued };
    })().finally(() => {
      cloudSyncPromise = null;
    });

    return cloudSyncPromise;
  }

  function initializeCloudSync() {
    if (!cloud) {
      if (cloudAuth) {
        cloudAuth.disabled = true;
      }
      return;
    }

    cloud.subscribeAuth((user, error) => {
      if (error) {
        updateCloudControls(null);
        setMonitorStatus(describeCloudError(error), "error");
        telemetry?.event(
          "cloud.auth.failed",
          { errorCode: telemetry.safeErrorCode(error), status: "failed" },
          { immediate: true, dedupeMs: 60000 },
        );
        return;
      }

      updateCloudControls(user);
      telemetry?.event("cloud.auth.state", {
        status: user ? "signed_in" : "signed_out",
      });
      if (!user) {
        return;
      }

      syncPendingReviewedCaptures()
        .then(async ({ uploaded, failed }) => {
          await renderCaptures();
          if (uploaded > 0) {
            setMonitorStatus(
              `${uploaded} queued photo(s) uploaded to Firebase${
                failed > 0 ? `; ${failed} will retry` : ""
              }.`,
              failed > 0 ? "idle" : "success",
            );
          }
        })
        .catch((syncError) => {
          setMonitorStatus(describeCloudError(syncError), "error");
          telemetry?.event(
            "cloud.sync.failed",
            {
              errorCode: telemetry.safeErrorCode(syncError),
              status: "failed",
              online: navigator.onLine !== false,
            },
            { immediate: true, dedupeMs: 60000 },
          );
        });
    });
  }

  cloudAuth?.addEventListener("click", async () => {
    cloudAuth.disabled = true;
    try {
      if (signedInUser) {
        await cloud.signOut();
        setMonitorStatus("Signed out of Firebase.");
      } else {
        setMonitorStatus("Opening Google sign-in…");
        await cloud.signIn();
      }
    } catch (error) {
      if (error?.code !== "auth/popup-closed-by-user" && error?.code !== "auth/cancelled-popup-request") {
        setMonitorStatus(describeCloudError(error), "error");
        telemetry?.event(
          "cloud.auth.failed",
          { errorCode: telemetry.safeErrorCode(error), status: "failed" },
          { immediate: true, dedupeMs: 60000 },
        );
      }
    } finally {
      cloudAuth.disabled = false;
    }
  });

  function showGestureCaptureFlash() {
    setMonitorStatus("Hands up — photo captured.", "success");

    if (!captureFlash) {
      return;
    }

    window.clearTimeout(captureFlashTimer);
    captureFlash.classList.remove("is-visible");
    // Restart the animation even if another gesture capture arrives immediately
    // after the previous confirmation has finished.
    void captureFlash.offsetWidth;
    captureFlash.classList.add("is-visible");
    captureFlashTimer = window.setTimeout(() => {
      captureFlash.classList.remove("is-visible");
      captureFlashTimer = null;
    }, 700);
  }

  function isRunning() {
    return Boolean(controller?.getState().running);
  }

  function setToggleLabel(running) {
    const name = running ? "Stop auto capture" : "Start auto capture";

    monitorToggle.dataset.running = String(running);
    monitorToggle.setAttribute("aria-pressed", String(running));
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

  // The same small frame, for measuring rather than detecting. The model path
  // hands the video straight to MediaPipe and never draws this canvas, so the
  // triage asks for its own copy — once per capture, not once per tick.
  function readSample() {
    if (!frameIsReady()) {
      return null;
    }

    sampleContext.drawImage(monitorVideo, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
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
      (Number.isInteger(state.personId) ? "UNMATCHED WORKER" : "");
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

  function captureImage(reading = {}) {
    return new Promise((resolve, reject) => {
      if (!monitorVideo.videoWidth || !monitorVideo.videoHeight) {
        reject(new Error("The camera has no frame yet."));
        return;
      }

      const date = new Date();
      captureCanvas.width = monitorVideo.videoWidth;
      captureCanvas.height = monitorVideo.videoHeight;
      const captureContext = captureCanvas.getContext("2d");
      captureContext.drawImage(monitorVideo, 0, 0);
      const frame = {
        left: 0,
        top: 0,
        width: captureCanvas.width,
        height: captureCanvas.height,
      };
      (reading.bodies || []).forEach((body) =>
        drawPersonMarker(captureContext, body, frame, captureCanvas.width, { saved: true }),
      );

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

  // Detection publishes a target; the paint loop below walks the drawn pose
  // towards it. Drawing straight from here would show the overlay stepping four
  // times a second, which is what it did.
  function renderFaceEnrollment(state) {
    if (!faceEnrollment) {
      return;
    }

    const enrollment = state.faceEnrollment;
    const active = Boolean(
      state.running && enrollment?.required && !state.activityStarted,
    );
    const total = Math.max(
      1,
      Number(enrollment?.total) || Number(facialRecognition?.DEFAULTS?.enrollmentSamples) || 5,
    );
    const samples = Math.max(0, Math.min(total, Number(enrollment?.samples) || 0));
    const completedNow = Boolean(
      faceEnrollmentWasActive &&
      !active &&
      state.running &&
      enrollment?.status === "complete" &&
      enrollment?.workerId,
    );
    if (completedNow && !faceMatchConfirmationShown) {
      faceMatchConfirmationShown = true;
      faceMatchConfirmationVisible = true;
      window.clearTimeout(faceMatchConfirmationTimer);
      faceMatchConfirmationTimer = window.setTimeout(() => {
        faceMatchConfirmationVisible = false;
        faceMatchConfirmationTimer = null;
        if (!controller?.getState?.().running) return;
        faceEnrollment.hidden = true;
      }, FACE_MATCH_CONFIRMATION_MS);
    }
    const confirming = Boolean(faceMatchConfirmationVisible && state.running);
    const instructions = {
      loading: "Preparing private on-device face matching…",
      no_face: "Step into view and move close to the camera.",
      move_closer: "Move closer until your face fills the oval.",
      look_straight: "Look straight at the camera and hold still.",
      center_face: "Center your face inside the oval.",
      one_person: "Keep one person in frame for this first scan.",
      hold_still: "Hold still for a moment so the next view stays sharp.",
      face_changed: "Keep the same face in view and hold still.",
      scanning: "Great — stay close while five clear views are compared.",
      not_recognized:
        "This face does not match an enrolled worker. Move closer or open worker onboarding.",
      unavailable: "Face scan could not start. You can continue without face matching.",
    };
    let instruction = instructions[enrollment?.status] || instructions.no_face;
    const matchDistance = Number(enrollment?.matchDistance);
    const telemetryMatchDistance =
      enrollment?.matchDistance !== null &&
      enrollment?.matchDistance !== undefined &&
      Number.isFinite(matchDistance)
        ? matchDistance
        : Number.NaN;
    const matchThreshold = Number(enrollment?.matchThreshold);
    const candidateWorkerId = String(enrollment?.candidateWorkerId || "").trim();
    if (
      enrollment?.status === "not_recognized" &&
      candidateWorkerId &&
      Number.isFinite(matchDistance) &&
      Number.isFinite(matchThreshold)
    ) {
      instruction =
        enrollment.matchReason === "ambiguous"
          ? `The scan is too similar to more than one enrollment. Re-enroll ${candidateWorkerId} with seven clear views.`
          : `Closest worker: ${candidateWorkerId} · match distance ${matchDistance.toFixed(2)} (needs ${matchThreshold.toFixed(2)} or less). Re-enroll this worker if the ID is correct.`;
    } else if (
      enrollment?.status === "scanning" &&
      candidateWorkerId &&
      Number(enrollment?.matchVotes) > 0
    ) {
      instruction = `${instructions.scanning} ${candidateWorkerId}: ${enrollment.matchVotes} of ${enrollment.requiredVotes} matching views.`;
    }

    if (faceEnrollmentKicker) {
      faceEnrollmentKicker.textContent = confirming ? "Attendance confirmed" : "Worker check-in";
    }
    if (faceEnrollmentTitle) {
      faceEnrollmentTitle.textContent = confirming
        ? "Attendance recorded"
        : enrollment?.status === "unavailable"
          ? "Attendance taking unavailable"
          : "Attendance taking";
    }
    if (faceEnrollmentMessage) {
      faceEnrollmentMessage.textContent = confirming
        ? `${enrollment?.personLabel || "Worker"} is ready. Auto capture is starting.`
        : instruction;
    }
    if (faceEnrollmentMatch) {
      faceEnrollmentMatch.hidden = !confirming;
    }
    if (faceEnrollmentWorkerId) {
      faceEnrollmentWorkerId.textContent = confirming ? enrollment?.workerId || "" : "";
    }
    if (faceEnrollmentProgress) {
      faceEnrollmentProgress.max = total;
      faceEnrollmentProgress.value = samples;
    }
    if (faceEnrollmentCount) {
      faceEnrollmentCount.textContent = `${samples} of ${total}`;
    }

    faceEnrollment.dataset.status = confirming ? "complete" : enrollment?.status || "no_face";
    faceEnrollment.hidden = !(active || confirming);

    if (
      active &&
      enrollment?.status === "not_recognized" &&
      lastFaceEnrollmentStatus !== "not_recognized"
    ) {
      telemetry?.event(
        "face.match.failed",
        {
          errorCode: enrollment.matchReason || "insufficient_consensus",
          matchDistance: telemetryMatchDistance,
          matchVotes: Number(enrollment.matchVotes) || 0,
          requiredVotes: Number(enrollment.requiredVotes) || 0,
          sampleCount: samples,
          status: "failed",
        },
        { immediate: true },
      );
    }

    if (faceEnrollmentWasActive && !active && state.running) {
      enrollmentFaceScanner?.close?.();
      enrollmentFaceScanner = null;
      const skipped = enrollment?.status === "skipped";
      telemetry?.event(
        skipped ? "face.match.skipped" : "face.match.completed",
        {
          matchDistance: telemetryMatchDistance,
          matchVotes: Number(enrollment?.matchVotes) || 0,
          requiredVotes: Number(enrollment?.requiredVotes) || 0,
          sampleCount: samples,
          status: skipped ? undefined : "success",
        },
        { immediate: true },
      );
      setMonitorStatus(
        skipped
          ? "Worker match skipped — auto capture is now running."
          : enrollment?.personLabel
            ? `${enrollment.personLabel} (${enrollment.workerId}) matched — auto capture is now running.`
            : "Face scan complete — auto capture is now running.",
        skipped ? "idle" : "success",
      );
    }
    faceEnrollmentWasActive = active;
    lastFaceEnrollmentStatus = enrollment?.status || null;
  }

  function renderState(state) {
    if (poseBadge) {
      poseBadge.textContent = autoCapture.describeCadence(state);
      poseBadge.dataset.present = String(state.present);
    }

    renderFaceEnrollment(state);
    target = state;

    if (state.error) {
      setMonitorStatus(state.error, "error");
      const errorCode = "detector_recovery";
      if (lastTrackingErrorCode !== errorCode) {
        lastTrackingErrorCode = errorCode;
        telemetry?.event(
          "tracking.failed",
          { errorCode },
          { immediate: true, dedupeMs: 60000 },
        );
      }
    } else if (lastTrackingErrorCode) {
      lastTrackingErrorCode = null;
      telemetry?.event("tracking.recovered", { status: "success" });
    }
  }

  // Sixty times a second, ease what is drawn a little further towards the last
  // reading. It costs no extra inference — the models are asked no more often
  // than before — and it damps the jitter a per-frame detector always has.
  function paint() {
    painter = window.requestAnimationFrame(paint);

    if (!target) {
      return;
    }

    const mapping = window.StampNotePoseMapping;

    // Without the mapping's blending — the built-in detector's path — the latest
    // reading is simply drawn as it arrives.
    if (!mapping) {
      drawn = target;
    } else if (target.bodies?.length) {
      // Each person is eased towards their own next position. Matching them up
      // between readings is what stops the overlay dragging one skeleton across
      // the room into another when the model reports them in a different order.
      drawn = { ...target, bodies: mapping.blendBodies(drawn?.bodies, target.bodies, EASE) };
    } else {
      drawn = {
        ...target,
        keypoints: mapping.blendKeypoints(drawn?.keypoints, target.keypoints, EASE),
        face: mapping.blendSegments(drawn?.face, target.face, EASE),
        hands: mapping.blendHands(drawn?.hands, target.hands, EASE),
      };
    }

    drawOverlay(drawn);
  }

  function releaseThumbnails() {
    thumbnailUrls.splice(0).forEach((url) => URL.revokeObjectURL(url));
  }

  // The strip is only there when there is something in it, so an empty app is
  // the picture and nothing else.
  function showFilmstrip() {
    if (!filmstrip) {
      return;
    }

    const tiles = (previews?.childElementCount || 0) + (capturesList?.childElementCount || 0);
    filmstrip.hidden = tiles === 0 && aiReviewBin?.hidden !== false;
  }

  async function renderCaptures() {
    if (!capturesList) {
      return;
    }

    const allRecords = await store.list();
    const usage = await store.usage(allRecords);
    const records = showingAiDiscarded
      ? allRecords.filter(storage.isAiFlagged)
      : allRecords.filter((record) => !storage.isAiFlagged(record));

    releaseThumbnails();
    capturesList.replaceChildren();

    records.slice(0, THUMBNAIL_LIMIT).forEach((record) => {
      if (!record.blob) {
        return;
      }

      const url = URL.createObjectURL(record.blob);
      const image = new Image();
      // A button, not a bare image: it opens the photo whole, and a tap target
      // wants to be reachable by a keyboard and named to a screen reader.
      const tile = document.createElement("button");

      thumbnailUrls.push(url);
      image.src = url;
      image.alt = "";

      tile.type = "button";
      tile.className = "capture";
      tile.dataset.pose = String(record.poseDetected);
      tile.dataset.aiReview = record.aiReview?.action || "unreviewed";
      tile.setAttribute(
        "aria-label",
        [
          record.poseDetected ? "Capture with a person in frame" : "Capture",
          `at ${record.capturedAt}`,
          storage.isAiFlagged(record) ? "in the AI review bin" : "",
          "— open",
        ]
          .filter(Boolean)
          .join(" "),
      );
      tile.append(image);
      tile.addEventListener("click", () =>
        openViewer({
          url,
          id: record.id,
          blob: record.blob,
          name: record.name,
          type: record.type,
          label: `Capture at ${record.capturedAt}`,
          aiReview: record.aiReview,
          record,
        }),
      );
      capturesList.append(tile);
    });

    const hasCaptures = usage.active > 0;
    const unreviewed = allRecords.filter(
      (record) =>
        record.blob && record.trigger !== "gesture" && !record.aiReview,
    ).length;
    const cloudQueued = allRecords.filter(
      (record) => record.status === "local" && record.aiReview,
    ).length;

    if (capturesSummary) {
      const kept = usage.active === 1 ? "1 photo" : `${usage.active} photos`;
      const where = store.isPersistent() ? "on this device" : "in this tab only";

      if (showingAiDiscarded) {
        const flagged = usage.discarded === 1 ? "1 AI flag" : `${usage.discarded} AI flags`;
        const uncertain = usage.needsReview > 0 ? ` · ${usage.needsReview} uncertain` : "";
        capturesSummary.textContent = `${flagged}${uncertain} · tap one to restore or delete`;
      } else {
        const flagged = usage.discarded > 0 ? ` · ${usage.discarded} in AI review bin` : "";
        const queued = cloudQueued > 0 ? ` · ${cloudQueued} waiting for cloud` : "";

        capturesSummary.textContent =
          usage.count > 0
            ? `${kept} kept ${where} · ${storage.formatBytes(usage.bytes)}${flagged}${queued}`
            : "";
      }
    }

    // Disabled rather than hidden, so the bar keeps its shape as photographs
    // arrive and the save button does not move under a thumb.
    if (capturesSave) {
      capturesSave.disabled = !hasCaptures;
    }
    if (capturesClear) {
      capturesClear.hidden = usage.count === 0;
    }
    if (aiReviewButton) {
      aiReviewButton.hidden = unreviewed === 0;
      aiReviewButton.disabled = aiReviewRunning;
    }
    if (aiReviewBin) {
      aiReviewBin.hidden = usage.discarded === 0;
      aiReviewBin.setAttribute("aria-pressed", String(showingAiDiscarded));
      const name = aiReviewBin.querySelector(".hint");
      if (name) {
        name.textContent = showingAiDiscarded ? "Show kept photos" : "Show AI review bin";
      }
    }
    if (aiReviewPurge) {
      aiReviewPurge.hidden = !showingAiDiscarded || usage.discarded === 0;
    }

    showFilmstrip();
  }

  // ---------------------------------------------------------------------------
  // Optional semantic review with Gemini

  function setAiReviewLoader(active, detail = "Preparing this batch for AI review…") {
    if (!aiReviewLoader) {
      return;
    }

    aiReviewLoader.hidden = !active;
    aiReviewLoader.setAttribute("aria-busy", String(active));
    if (aiReviewLoaderTitle) {
      aiReviewLoaderTitle.textContent = active ? "Gemini is reviewing" : "Reviewing photos";
    }
    if (active && aiReviewLoaderDetail) {
      aiReviewLoaderDetail.textContent = detail;
    }
  }

  function hasAiReviewConsent() {
    if (readCache(AI_REVIEW_CONSENT_KEY) === "yes") {
      return true;
    }

    const accepted = window.confirm(
      "While auto capture runs, StampNote sends each complete group of eight scheduled photos " +
        "to Gemini for automatic review. Hands-up photos are never included. It sends reduced " +
        "512 px copies and capture metadata through StampNote's server, including any address " +
        "or text visible in a photo. After Gemini finishes, compact reviewed copies upload " +
        "to the authenticated team Firestore workspace; AI flags remain recoverable until you delete them. " +
        "Allow automatic AI review and cloud sync?",
    );

    if (accepted) {
      writeCache(AI_REVIEW_CONSENT_KEY, "yes");
    }

    return accepted;
  }

  function loadBlobImage(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const image = new Image();

      image.addEventListener("load", () => resolve({ image, url }), { once: true });
      image.addEventListener(
        "error",
        () => {
          URL.revokeObjectURL(url);
          reject(new Error("A stored photo could not be prepared for AI review."));
        },
        { once: true },
      );
      image.src = url;
    });
  }

  function canvasBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error("A review copy could not be encoded."));
          }
        },
        "image/jpeg",
        0.72,
      );
    });
  }

  function blobDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.addEventListener("load", () => resolve(String(reader.result || "")), { once: true });
      reader.addEventListener(
        "error",
        () => reject(reader.error || new Error("A review copy could not be read.")),
        { once: true },
      );
      reader.readAsDataURL(blob);
    });
  }

  async function createAiReviewImage(record) {
    const loaded = await loadBlobImage(record.blob);

    try {
      const scale = Math.min(
        1,
        AI_REVIEW_MAX_EDGE / Math.max(loaded.image.naturalWidth, loaded.image.naturalHeight),
      );
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(loaded.image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(loaded.image.naturalHeight * scale));
      canvas.getContext("2d").drawImage(loaded.image, 0, 0, canvas.width, canvas.height);
      const reviewBlob = await canvasBlob(canvas);

      return {
        id: record.id,
        capturedAt: record.capturedAt,
        poseDetected: Boolean(record.poseDetected),
        trigger: record.trigger === "gesture" ? "gesture" : "schedule",
        localScore: typeof record.score === "number" ? record.score : null,
        mediaType: "image/jpeg",
        dataUrl: await blobDataUrl(reviewBlob),
      };
    } finally {
      URL.revokeObjectURL(loaded.url);
    }
  }

  async function requestAiReview(images) {
    const startedAt = performance.now();
    const traceId = telemetry?.createTraceId();
    telemetry?.event(
      "ai.review.started",
      { batchSize: images.length, online: navigator.onLine !== false },
      { traceId },
    );

    try {
      const response = await fetch(AI_REVIEW_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(traceId ? { "X-StampNote-Trace-Id": traceId } : {}),
        },
        body: JSON.stringify({ images }),
      });
      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        const fallback =
          response.status === 404
            ? "AI review is missing from this deployment. Redeploy StampNote with its API function."
            : response.status === 429
              ? "Gemini has reached its current request quota. Try again later or check Google AI Studio billing."
              : `Gemini review failed (HTTP ${response.status}).`;
        throw Object.assign(new Error(result.error || fallback), {
          code: `http_${response.status}`,
          httpStatus: response.status,
        });
      }
      if (!Array.isArray(result.decisions)) {
        throw Object.assign(new Error("Gemini returned an incomplete review."), {
          code: "incomplete_response",
        });
      }

      telemetry?.event(
        "ai.review.completed",
        {
          durationMs: performance.now() - startedAt,
          reviewedCount: result.decisions.length,
          flaggedCount: result.decisions.filter(
            (decision) => decision.recommendation === "discard",
          ).length,
          status: "success",
        },
        { traceId },
      );
      return result;
    } catch (error) {
      telemetry?.event(
        "ai.review.failed",
        {
          durationMs: performance.now() - startedAt,
          batchSize: images.length,
          errorCode: telemetry.safeErrorCode(error),
          httpStatus: Number(error?.httpStatus) || undefined,
          status: "failed",
          online: navigator.onLine !== false,
        },
        { traceId, immediate: true },
      );
      if (error && typeof error === "object") {
        error.telemetryReported = true;
      }
      throw error;
    }
  }

  async function reviewCapturesWithAi(options = {}) {
    const automatic = options?.automatic === true;

    if (aiReviewLock) {
      return false;
    }

    // Acquire the lock before the first database read so a capture and a button
    // press cannot start overlapping Gemini requests.
    aiReviewLock = true;
    let reviewStarted = false;
    let completedAutomaticBatch = false;
    let reviewed = 0;
    let flagged = 0;
    let uncertainFlags = 0;
    let failedCopies = 0;
    let cloudUploaded = 0;
    let cloudQueued = 0;
    let cloudFailed = 0;

    try {
      const active = await store.listActive();
      const eligible = automatic
        ? storage.selectAiReviewBatch(active, AI_REVIEW_BATCH_SIZE)
        : active
            .filter(
              (record) => record.blob && record.trigger !== "gesture" && !record.aiReview,
            )
            .sort(
              (left, right) => (left.capturedAtMs || 0) - (right.capturedAtMs || 0),
            );

      if (eligible.length === 0) {
        if (!automatic) {
          setMonitorStatus("There are no new photos for AI review.");
        }
        return false;
      }
      if (automatic && !automaticAiReviewEnabled) {
        return false;
      }
      if (!automatic) {
        if (!hasAiReviewConsent()) {
          return false;
        }
        automaticAiReviewEnabled = true;
      }

      reviewStarted = true;
      aiReviewRunning = true;
      showingAiDiscarded = false;
      setAiReviewLoader(
        true,
        automatic
          ? `Preparing ${eligible.length} photos for AI review…`
          : `Preparing ${eligible.length} photo${eligible.length === 1 ? "" : "s"} for AI review…`,
      );
      await renderCaptures();

      for (let start = 0; start < eligible.length; start += AI_REVIEW_BATCH_SIZE) {
        const batch = eligible.slice(start, start + AI_REVIEW_BATCH_SIZE);
        const batchEnd = Math.min(start + batch.length, eligible.length);
        setAiReviewLoader(
          true,
          automatic
            ? `Analyzing this batch of ${batch.length} photos for useful details…`
            : `Analyzing photos ${start + 1}–${batchEnd} of ${eligible.length}…`,
        );
        setMonitorStatus(
          automatic
            ? `Gemini is automatically reviewing ${batch.length} photos…`
            : `Gemini is reviewing ${start + 1}–${batchEnd} of ${eligible.length}…`,
        );

        const copies = await Promise.allSettled(batch.map(createAiReviewImage));
        const images = copies
          .filter((copy) => copy.status === "fulfilled")
          .map((copy) => copy.value);
        failedCopies += copies.length - images.length;

        // Automatic requests are deliberately exact groups of eight. If even
        // one local copy cannot be prepared, leave the full batch untouched and
        // retry only after another capture or a manual button press.
        if (automatic && images.length !== AI_REVIEW_BATCH_SIZE) {
          throw new Error("A stored photo could not be prepared for automatic AI review.");
        }
        if (images.length === 0) {
          continue;
        }

        const result = await requestAiReview(images);
        await store.applyAiReviews(result.decisions, { model: result.model });
        const cloudResult = await syncPendingReviewedCaptures();
        cloudUploaded += cloudResult.uploaded;
        cloudQueued = cloudResult.queued;
        cloudFailed += cloudResult.failed;
        reviewed += result.decisions.length;
        flagged += result.decisions.filter(
          (decision) => decision.recommendation === "discard",
        ).length;
        uncertainFlags += result.decisions.filter(
          (decision) =>
            decision.recommendation === "discard" && decision.action === "review",
        ).length;
      }

      completedAutomaticBatch =
        automatic && reviewed === eligible.length && failedCopies === 0;

      const keptVisible = reviewed - flagged;
      const reviewNote = uncertainFlags > 0 ? ` (${uncertainFlags} uncertain)` : "";
      const copyWarning = failedCopies > 0 ? ` ${failedCopies} could not be prepared.` : "";
      const cloudNote = !signedInUser
        ? ` ${reviewed} reviewed photo(s) are queued; sign in with Google to upload them.`
        : cloudQueued > 0
          ? ` ${cloudQueued} photo(s) remain queued for Firebase${
              cloudFailed > 0 ? " after an upload error" : ""
            }.`
          : cloudUploaded > 0
            ? ` ${cloudUploaded} photo(s) uploaded to Firebase.`
            : "";
      setMonitorStatus(
        flagged > 0
          ? `${flagged} flagged photo(s) moved to the AI review bin${reviewNote}; ${keptVisible} kept visible.${copyWarning}${cloudNote}`
          : `Gemini kept all ${reviewed} reviewed photo(s)${reviewNote}.${copyWarning}${cloudNote}`,
        "success",
      );
      return true;
    } catch (error) {
      if (!error?.telemetryReported) {
        telemetry?.event(
          "ai.review.failed",
          {
            errorCode: telemetry.safeErrorCode(error),
            reviewedCount: reviewed,
            failedCount: failedCopies,
            automatic,
            status: "failed",
            online: navigator.onLine !== false,
          },
          { immediate: true },
        );
      }
      const progress =
        reviewed > 0
          ? `${reviewed} completed review(s) remain saved.`
          : "No photos were moved or deleted.";
      setMonitorStatus(
        `${error?.message || "Gemini review failed."} ${progress}`,
        "error",
      );
      return false;
    } finally {
      aiReviewLock = false;
      if (reviewStarted) {
        aiReviewRunning = false;
        setAiReviewLoader(false);
        await renderCaptures();
      }
      if (completedAutomaticBatch) {
        // Drain another complete group if captures accumulated while Gemini was
        // busy. setTimeout avoids growing the promise stack on a long backlog.
        window.setTimeout(() => reviewCapturesWithAi({ automatic: true }), 0);
      }
    }
  }

  async function toggleAiReviewBin() {
    showingAiDiscarded = !showingAiDiscarded;
    closeViewer();
    await renderCaptures();
  }

  async function purgeAiReviewBin() {
    const discarded = await store.listDiscarded();

    if (discarded.length === 0) {
      return;
    }
    if (!window.confirm(`Permanently delete ${discarded.length} AI-flagged photo(s)?`)) {
      return;
    }
    if (!(await deleteCloudCopies(discarded))) {
      return;
    }

    await store.purgeAiDiscarded();
    showingAiDiscarded = false;
    await renderCaptures();
    setMonitorStatus("AI review bin emptied.", "success");
  }

  // ---------------------------------------------------------------------------
  // One photograph, whole

  let viewing = null;

  function openViewer(item) {
    if (!viewer || !viewerImage) {
      return;
    }

    viewing = item;
    viewerImage.src = item.url;
    viewerImage.alt = item.label || "Photo";
    viewer.hidden = false;

    if (viewerAiReview) {
      viewerAiReview.hidden = !item.aiReview;
      viewerAiReview.textContent = item.aiReview
        ? `${storage.isAiFlagged(item) ? (item.aiReview.action === "discard" ? "AI reject" : "Uncertain AI flag") : "AI review"} · ${Math.round(
            (item.aiReview.confidence || 0) * 100,
          )}% confidence · ${item.aiReview.reason}`
        : "";
    }

    // Only a stored capture can be deleted; a stamped upload is not in the
    // store to delete from.
    if (viewerDelete) {
      viewerDelete.hidden = !item.id;
    }
    if (viewerRestore) {
      viewerRestore.hidden = !storage.isAiFlagged(item);
    }
    if (viewerShare) {
      viewerShare.hidden = typeof navigator.canShare !== "function";
    }

    viewerClose?.focus();
  }

  function closeViewer() {
    if (!viewer) {
      return;
    }

    viewer.hidden = true;
    // The URL belongs to the strip, which is still showing it, so it is let go
    // of here rather than revoked.
    viewerImage?.removeAttribute("src");
    if (viewerAiReview) {
      viewerAiReview.hidden = true;
      viewerAiReview.textContent = "";
    }
    viewing = null;
  }

  async function deleteViewed() {
    if (!viewing?.id) {
      return;
    }

    if (!(await deleteCloudCopies([viewing.record]))) {
      return;
    }

    await store.remove(viewing.id);
    closeViewer();
    await renderCaptures();
  }

  async function restoreViewed() {
    if (!viewing?.id || !storage.isAiFlagged(viewing)) {
      return;
    }

    await store.restoreAiDiscard(viewing.id);
    closeViewer();

    if ((await store.listDiscarded()).length === 0) {
      showingAiDiscarded = false;
    }

    const cloudResult = await syncPendingReviewedCaptures();
    await renderCaptures();
    setMonitorStatus(
      cloudResult.queued > 0
        ? "Photo restored locally and queued for Firestore."
        : "Photo restored locally and in Firestore.",
      "success",
    );
  }

  async function shareViewed() {
    if (!viewing?.blob) {
      setMonitorStatus("This photo cannot be shared from here.", "error");
      return;
    }

    const file = new File([viewing.blob], viewing.name || "stampnote.jpg", {
      type: viewing.type || "image/jpeg",
    });

    if (!navigator.canShare?.({ files: [file] })) {
      setMonitorStatus("Sharing is not available here — save it instead.", "error");
      return;
    }

    try {
      await navigator.share({ files: [file] });
    } catch (error) {
      if (error?.name !== "AbortError") {
        setMonitorStatus("Sharing failed — save it instead.", "error");
      }
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

  // Inference is synchronous, so every millisecond of it is a millisecond the
  // overlay cannot move. Rather than a fixed timer that a slow device can never
  // keep up with — queueing ticks behind each other until nothing gets drawn at
  // all — each pass waits at least as long as the last one took. A phone that
  // gets through a frame in twenty milliseconds keeps the full rate; one that
  // takes half a second backs off by itself and leaves half the time for
  // drawing.
  async function look() {
    if (!controller) {
      return;
    }

    const activeController = controller;
    const started = performance.now();
    try {
      const before = activeController.getState().captures;
      const state = await activeController.tick();

      if (state.captures !== before) {
        telemetry?.event("capture.saved", {
          trigger: state.lastRecord?.trigger === "gesture" ? "gesture" : "schedule",
          photoCount: state.captures,
          persistent: store.isPersistent(),
        });
        renderCaptures();
        if (state.lastRecord?.trigger === "gesture") {
          showGestureCaptureFlash();
        }
        reviewCapturesWithAi({ automatic: true });
        // Already in the device's own store by now. If a folder has been armed,
        // the copy out to it happens here — the whole point being that no one has
        // to be holding the phone for it.
        if (folder) {
          writeToFolder(state.lastRecord);
        }
      }
    } catch (error) {
      // No unexpected error is allowed to end the self-scheduling loop. The
      // controller handles detector failures itself; this is the last guard for
      // a browser or storage failure outside that boundary.
      const errorCode = telemetry?.safeErrorCode(error) || "tick_failed";
      console.error("[StampNote tracking] Tick failed; retrying.", { errorCode });
      telemetry?.event(
        "tracking.failed",
        { errorCode },
        { immediate: true, dedupeMs: 60000 },
      );
      setMonitorStatus("Tracking paused for a moment and is retrying.", "error");
    } finally {
      if (controller === activeController) {
        const spent = performance.now() - started;
        sampleTimer = window.setTimeout(look, Math.max(autoCapture.SAMPLE_INTERVAL, spent));
      }
    }
  }

  async function startMonitor() {
    const monitorStartedAt = performance.now();
    if (!navigator.mediaDevices?.getUserMedia) {
      setMonitorStatus("This browser cannot open a live camera — choose a photo instead.", "error");
      telemetry?.event(
        "capture.monitor.failed",
        { errorCode: "camera_unsupported", status: "failed" },
        { immediate: true },
      );
      return;
    }

    let enrolledWorkers = [];
    if (cloud?.getWorkerFaces && facialRecognition) {
      setMonitorStatus("Loading enrolled worker IDs…");
      try {
        enrolledWorkers = await cloud.getWorkerFaces();
      } catch (error) {
        setMonitorStatus(
          error?.code === "auth-required"
            ? "Sign in with Google, then enroll a worker face before recording."
            : "Enrolled worker faces could not be loaded. Try again.",
          "error",
        );
        return;
      }
      if (enrolledWorkers.length === 0) {
        setMonitorStatus(
          "No worker faces are enrolled. Open worker onboarding before recording.",
          "error",
        );
        return;
      }
    }

    setMonitorStatus("Starting the camera…");

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "environment",
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });
    } catch (error) {
      setMonitorStatus(describeCameraError(error), "error");
      telemetry?.event(
        "capture.monitor.failed",
        {
          durationMs: performance.now() - monitorStartedAt,
          errorCode: telemetry.safeErrorCode(error, "camera_failed"),
          status: "failed",
        },
        { immediate: true },
      );
      return;
    }

    monitorVideo.srcObject = stream;
    try {
      await monitorVideo.play();
    } catch {
      // Some browsers resolve the frame without play() ever settling.
    }

    let detectorSetup;
    try {
      detectorSetup = await createDetector();
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      monitorVideo.srcObject = null;
      setMonitorStatus("The tracking model could not start. Try again.", "error");
      telemetry?.event(
        "capture.monitor.failed",
        {
          durationMs: performance.now() - monitorStartedAt,
          errorCode: telemetry.safeErrorCode(error, "detector_start_failed"),
          status: "failed",
        },
        { immediate: true },
      );
      return;
    }
    const { detector, model } = detectorSetup;
    if (enrolledWorkers.length > 0 && !model) {
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      monitorVideo.srcObject = null;
      setMonitorStatus(
        "Worker ID matching needs the face model, which could not start. Try again.",
        "error",
      );
      return;
    }
    modelDetector = detector.kind === "model" ? detector : null;

    // The face hint only ever propped up the built-in detector's head cue; the
    // trained model has no use for it.
    faceDetector = model ? null : createFaceDetector();
    faceHint = null;
    usingModel = model;

    // The built-in fallback has no detailed face landmarks, so enrollment is
    // offered only with the trained model that can accurately assess the scan.
    const faceIdentity = model
      ? facialRecognition?.createFaceIdentity?.({ knownIdentities: enrolledWorkers })
      : null;
    if (faceIdentity && window.StampNoteModel?.loadFaceScanner) {
      try {
        enrollmentFaceScanner = await window.StampNoteModel.loadFaceScanner();
      } catch {
        // The full model still supplies face outlines when enough of the body
        // is visible. The focused scanner is an accuracy improvement, not a
        // reason to make recording unavailable.
        enrollmentFaceScanner = null;
      }
    }
    faceIdentity?.load?.().catch(() => {
      // Landmark geometry, facial texture and clothing matching remain usable
      // when WebGL or the optional face-embedding model is unavailable.
    });

    controller = autoCapture.createAutoCapture({
      detector,
      tracker: pose.createPoseTracker(),
      personTracker: personIdentity?.createPersonTracker({ identities: enrolledWorkers }),
      faceIdentity,
      enrollmentDetector: enrollmentFaceScanner,
      scheduler: schedule.createCaptureScheduler(),
      store,
      sampleFrame: detector.wantsVideo ? sampleVideo : sampleFrame,
      captureImage,
      getAddress: () => addressField.value,
      getFaces: () => faceHint,
      isGesture: (keypoints) => Boolean(window.StampNotePoseMapping?.isCaptureGesture(keypoints)),
      triage,
      readSample,
      onUpdate: renderState,
    });

    controller.start();
    target = null;
    drawn = null;
    window.cancelAnimationFrame(painter);
    painter = window.requestAnimationFrame(paint);
    look();

    if (monitorFrame) {
      monitorFrame.hidden = false;
    }
    if (stageEmpty) {
      stageEmpty.hidden = true;
    }
    setToggleLabel(true);
    setMonitorStatus(
      model && faceIdentity && enrolledWorkers.length > 0
        ? "Move closer for attendance taking before recording begins."
        : model && faceIdentity
          ? "Move closer for attendance taking before auto capture begins."
        : model
          ? "Watching for people — anonymous tracking stays on this device."
        : "Watching with the built-in detector — photos save themselves.",
      model && !faceIdentity ? "success" : "idle",
    );
    telemetry?.event("capture.monitor.started", {
      durationMs: performance.now() - monitorStartedAt,
      status: "success",
    });
    requestWakeLock();
    renderCaptures();
    reviewCapturesWithAi({ automatic: true });
  }

  function stopMonitor() {
    window.clearTimeout(sampleTimer);
    sampleTimer = null;
    window.clearTimeout(captureFlashTimer);
    captureFlashTimer = null;
    window.clearTimeout(faceMatchConfirmationTimer);
    faceMatchConfirmationTimer = null;
    faceMatchConfirmationVisible = false;
    faceMatchConfirmationShown = false;
    captureFlash?.classList.remove("is-visible");
    window.cancelAnimationFrame(painter);
    painter = null;
    target = null;
    drawn = null;

    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    monitorVideo.srcObject = null;

    controller?.stop();
    // The model holds WebAssembly memory and a GPU context; dropping the
    // reference alone would leave both until the tab is closed.
    modelDetector?.close?.();
    modelDetector = null;
    enrollmentFaceScanner?.close?.();
    enrollmentFaceScanner = null;
    controller = null;
    faceDetector = null;
    faceHint = null;

    releaseWakeLock();

    if (poseOverlay?.width) {
      poseOverlay.getContext("2d").clearRect(0, 0, poseOverlay.width, poseOverlay.height);
    }
    if (monitorFrame) {
      monitorFrame.hidden = true;
    }
    if (stageEmpty) {
      stageEmpty.hidden = false;
    }
    if (poseBadge) {
      poseBadge.textContent = "";
    }
    if (faceEnrollment) {
      faceEnrollment.hidden = true;
    }
    faceEnrollmentWasActive = false;
    lastFaceEnrollmentStatus = null;
    setToggleLabel(false);
    setMonitorStatus("Auto capture stopped. Your photos are still stored on this device.");
  }

  // ---------------------------------------------------------------------------
  // Keeping the photographs outside the app
  //
  // Every capture is already written to the device's own store the moment it is
  // taken: that needs no button, no folder and no tap, and it survives a reload.
  // This is the other half — copying them out into the file system, which a page
  // is not allowed to do silently. Where the File System Access API exists a
  // folder is chosen once and everything after it is written there on its own.
  // Where it does not, which today is every phone browser, a photo can only
  // leave the app as a download, and a download needs a press.
  const canKeepFolder = typeof window.showDirectoryPicker === "function";
  const exported = new Set();
  let folder = null;

  function setSaveLabel() {
    const name = capturesSave?.querySelector(".hint");

    if (!name) {
      return;
    }

    name.textContent = folder
      ? `Saving into ${folder.name}`
      : canKeepFolder
        ? "Keep saving into a folder"
        : "Save to this device";
    capturesSave.dataset.armed = String(Boolean(folder));
  }

  async function folderIsWritable() {
    if (!folder) {
      return false;
    }

    try {
      return (await folder.queryPermission({ mode: "readwrite" })) === "granted";
    } catch {
      return false;
    }
  }

  async function writeToFolder(record) {
    if (!record?.blob || exported.has(record.id) || !(await folderIsWritable())) {
      return false;
    }

    try {
      const handle = await folder.getFileHandle(record.name, { create: true });
      const writable = await handle.createWritable();

      await writable.write(record.blob);
      await writable.close();
      exported.add(record.id);
      return true;
    } catch {
      // A folder that has been moved or deleted, or had its permission taken
      // back. Better to fall back to the button than to fail on every capture.
      folder = null;
      setSaveLabel();
      return false;
    }
  }

  async function keepFolder() {
    try {
      folder = await window.showDirectoryPicker({
        id: "stampnote",
        mode: "readwrite",
        startIn: "pictures",
      });
    } catch (error) {
      if (error?.name !== "AbortError") {
        setMonitorStatus("That folder could not be opened.", "error");
      }
      return false;
    }

    setSaveLabel();
    return true;
  }

  async function saveCaptures() {
    const records = await store.listActive();

    if (records.length === 0) {
      return;
    }

    // One press arms the folder; every capture after it writes itself.
    if (canKeepFolder && !folder && !(await keepFolder())) {
      return;
    }

    if (folder) {
      let written = 0;

      for (const record of records) {
        if (await writeToFolder(record)) {
          written += 1;
        }
      }

      setMonitorStatus(
        written > 0
          ? `${written} photo(s) written to ${folder.name}. New ones follow on their own.`
          : `Everything is already in ${folder.name}.`,
        "success",
      );
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

  async function deleteCloudCopies(records) {
    const synced = (records || []).filter(
      (record) => record?.status === "synced" && record.aiReview,
    );

    if (synced.length === 0) {
      return true;
    }
    if (!cloud || !signedInUser) {
      setMonitorStatus(
        `Sign in with Google before deleting ${synced.length} cloud photo(s).`,
        "error",
      );
      return false;
    }

    try {
      for (const record of synced) {
        await cloud.deleteReviewedPhoto(record);
      }
      return true;
    } catch (error) {
      setMonitorStatus(`${describeCloudError(error)} Nothing was deleted locally.`, "error");
      return false;
    }
  }

  async function clearCaptures() {
    const records = await store.list();
    const usage = await store.usage(records);

    if (usage.count === 0) {
      return;
    }
    if (!window.confirm(`Delete ${usage.count} stored photo(s) from this device?`)) {
      return;
    }
    if (!(await deleteCloudCopies(records))) {
      return;
    }

    await store.clear();
    releaseThumbnails();
    await renderCaptures();
    // The empty grid is the confirmation; a line of text saying so is one more
    // thing on screen for something the eye has already been told.
    setMonitorStatus("");
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

  faceEnrollmentSkip?.addEventListener("click", () => {
    controller?.skipFaceEnrollment?.();
  });

  capturesSave?.addEventListener("click", saveCaptures);
  capturesClear?.addEventListener("click", clearCaptures);
  aiReviewButton?.addEventListener("click", () => reviewCapturesWithAi());
  aiReviewBin?.addEventListener("click", toggleAiReviewBin);
  aiReviewPurge?.addEventListener("click", purgeAiReviewBin);

  viewerClose?.addEventListener("click", closeViewer);
  viewerDelete?.addEventListener("click", deleteViewed);
  viewerRestore?.addEventListener("click", restoreViewed);
  viewerShare?.addEventListener("click", shareViewed);

  // The dark around the photograph is a way out of it, as is Escape.
  viewer?.addEventListener("click", (event) => {
    if (event.target === viewer) {
      closeViewer();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && viewer && !viewer.hidden) {
      closeViewer();
    }
  });

  // The address is part of the picture rather than a panel of its own, so this
  // reveals that strip and puts the cursor in it.
  placeToggle?.addEventListener("click", () => {
    addressPanel.hidden = false;
    addressField.focus();

    if (!addressField.value.trim()) {
      autoLocate();
    }
  });

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
  setSaveLabel();
  store
    .ready()
    .then(() => {
      telemetry?.event("capture.store.ready", {
        persistent: store.isPersistent(),
        status: "success",
      });
    })
    .catch((error) => {
      telemetry?.event(
        "client.error",
        { errorCode: telemetry.safeErrorCode(error, "store_start_failed") },
        { immediate: true },
      );
    });
  initializeCloudSync();
  renderCaptures();
})();
