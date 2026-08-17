(function initializeWorkerOnboarding() {
  "use strict";

  const cloud = window.StampNoteFirebase;
  const workerFace = window.StampNoteWorkerFace;
  const faceIdentity = window.StampNoteFaceIdentity;
  const frameScaling = window.StampNoteFrameScaler;
  const cameraFacing = window.StampNoteCameraFacing;
  const telemetry = window.StampNoteObservability;
  const form = document.querySelector("#worker-form");
  const workerId = document.querySelector("#worker-id");
  const workerName = document.querySelector("#worker-name");
  const authButton = document.querySelector("#onboarding-auth");
  const authIcon = document.querySelector("#onboarding-auth-icon");
  const authLabel = document.querySelector("#onboarding-auth-label");
  const signedInState = document.querySelector("#signed-in-state");
  const startButton = document.querySelector("#start-face-scan");
  const cancelButton = document.querySelector("#cancel-face-scan");
  const status = document.querySelector("#onboarding-status");
  const scannerCard = document.querySelector("#scanner-card");
  const scannerView = document.querySelector("#scanner-view");
  const video = document.querySelector("#onboarding-video");
  const instruction = document.querySelector("#scanner-instruction");
  const progress = document.querySelector("#onboarding-progress");
  const progressCount = document.querySelector("#onboarding-progress-count");
  const roster = document.querySelector("#worker-roster");
  const rosterEmpty = document.querySelector("#roster-empty");
  const rosterBody = document.querySelector("#roster-body");
  const rosterToggle = document.querySelector("#roster-toggle");
  const rosterToggleLabel = document.querySelector("#roster-toggle-label");
  const cameraFacingToggle = document.querySelector("#camera-facing-toggle");
  const cameraFacingState = document.querySelector("#camera-facing-state");

  // Enrollment deliberately takes longer than the opening match. Seven
  // spaced, mutually consistent views make the stored template less dependent
  // on one blink, expression, or moment of motion.
  const ONBOARDING_SAMPLES = 7;
  const ONBOARDING_SAMPLE_MS = 900;
  // Enrollment keeps no photograph beyond a badge-sized portrait, so the camera
  // is asked only for what the face model and that portrait can use. A larger
  // frame would be shrunk again before anything looked at it.
  const FACE_CAMERA_WIDTH = 1280;
  const FACE_CAMERA_HEIGHT = 720;

  // The portrait is a badge-sized square, not a photograph: enough to tell two
  // workers apart in a roster, small enough to sit inside the worker document.
  const PROFILE_PHOTO_EDGE = 256;
  const PROFILE_PHOTO_QUALITY = 0.72;

  // Enrolling is normally somebody scanning their own face while holding the
  // device, so the front camera is the default here — the opposite of the
  // recording page, which is normally a device left facing the work. The two
  // pages therefore remember the answer separately rather than dragging each
  // other's default around.
  const cameraFacingPreference = cameraFacing?.createPreference({
    key: "stampnote-onboarding-camera-facing",
    fallback: cameraFacing.FRONT,
  });

  let user = null;
  let profileCanvas = null;
  let profileReady = false;
  let stream = null;
  let scanner = null;
  let recognizer = null;
  let timer = null;
  let scanning = false;
  let saving = false;
  let samples = [];
  let scaler = null;
  // True from the moment a scan is committed to until the camera is released,
  // which is wider than `scanning`: it also covers the seconds spent opening the
  // camera and loading the model, when the card must not be taken away.
  let scanActive = false;
  let rosterOpen = false;
  let rosterStale = true;
  // Both the roster and the numbering need to know who is already enrolled, so
  // they share one read rather than each making their own.
  let workerRead = null;
  // Each request for an ID carries a number, so a slow answer that a later
  // keystroke has already overtaken is dropped instead of overwriting it.
  let issueToken = 0;

  function setStatus(message, state = "idle") {
    status.textContent = message;
    status.dataset.state = state;
  }

  // The same two values `startScan` insists on, asked the same way, so the button
  // becomes usable exactly when the scan would accept it rather than a keystroke
  // before.
  function detailsComplete() {
    return Boolean(
      workerFace?.normalizeWorkerId?.(workerId.value) &&
        workerFace?.normalizeDisplayName?.(workerName.value),
    );
  }

  // An untouched form is two fields and nothing else. The button arrives with the
  // first character typed into either one — disabled until both are valid, so it
  // can say "not yet" next to a field the browser has already marked red — rather
  // than waiting for validity and appearing out of nowhere.
  function detailsStarted() {
    return Boolean(workerId.value.trim() || workerName.value.trim());
  }

  // The ID belongs to the page rather than the operator: the worker's initials and
  // the next number those initials have not used. It is shown before the scan so
  // it can be read out or written on a badge, and issued once more from a fresh
  // read before anything is written.
  async function issueWorkerId({ fresh = false } = {}) {
    const token = ++issueToken;
    const name = workerFace.normalizeDisplayName(workerName.value);
    if (!user || !name) {
      workerId.value = "";
      refreshFlow();
      return null;
    }

    let taken = [];
    try {
      taken = (await readWorkers({ fresh })).map((worker) => worker.workerId);
    } catch {
      // Not knowing which numbers are spent, any guess could name a document that
      // already belongs to somebody — and a save merges into it rather than
      // refusing — so no ID is offered and the scan stays out of reach.
      if (token !== issueToken) return null;
      workerId.value = "";
      refreshFlow();
      setStatus("Enrolled worker IDs could not be read, so no ID can be issued yet.", "error");
      return null;
    }

    if (token !== issueToken) return null;
    const issued = workerFace.nextWorkerId(name, taken);
    workerId.value = issued || "";
    refreshFlow();
    return issued;
  }

  // Step two exists once there is a worker for it to scan, and stays for as long
  // as a scan is running even if the details are edited underneath it.
  function refreshFlow() {
    const ready = Boolean(user) && detailsComplete();
    scannerCard.hidden = !ready && !scanActive;
    startButton.hidden = !detailsStarted() && !scanActive;
    startButton.disabled = !ready || scanActive;
    refreshCameraFacing();
  }

  function currentCameraFacing() {
    return cameraFacingPreference?.get() || "user";
  }

  // The state is named on the left and the switch says what pressing it would
  // do, so neither has to be read as the negative of the other. A running scan
  // dims the switch: its seven samples belong to one view of one face, and
  // swapping the lens under them halfway through would leave a template made of
  // two different framings.
  function refreshCameraFacing() {
    if (!cameraFacingToggle) return;

    const facing = currentCameraFacing();
    const next = cameraFacing?.opposite(facing) || facing;
    cameraFacingToggle.disabled = scanActive || saving;
    cameraFacingToggle.textContent = `Use the ${cameraFacing?.describe(next) || "other camera"}`;
    if (cameraFacingState) {
      cameraFacingState.textContent = `${cameraFacing?.name(facing) || "Front"} camera`;
    }
  }

  function scanMessage(scanState) {
    const messages = {
      loading: "Preparing the on-device face model…",
      no_face: "Step into view and move close to the camera.",
      move_closer: "Move closer until your face fills the oval.",
      look_straight: "Look straight at the camera and hold still.",
      center_face: "Center your face inside the oval.",
      one_person: "Only one worker should be in frame.",
      hold_still: "Pause movement for a moment so this view stays sharp.",
      face_changed: "Keep the same worker in frame and hold still.",
      scanning: "Good — stay close while the remaining clear views are checked.",
      unavailable: "The face model is unavailable on this device.",
    };
    if (scanState?.status === "scanning") {
      const count = Number(scanState.samples) || samples.length;
      if (count >= 5) return "Now turn slightly right and keep your eyes on the camera.";
      if (count >= 3) return "Now turn slightly left and keep your eyes on the camera.";
    }
    return messages[scanState?.status] || messages.no_face;
  }

  function updateProgress(scanState = {}) {
    const total = Math.max(1, Number(scanState.total) || ONBOARDING_SAMPLES);
    const count = Math.max(0, Math.min(total, Number(scanState.samples) || samples.length));
    progress.max = total;
    progress.value = count;
    progressCount.textContent = `${count} of ${total}`;
    instruction.textContent = scanMessage(scanState);
  }

  // Taken from the live frame at the moment a sample is accepted, so the face
  // is the one the scan just measured: centred, lit, and looking at the camera.
  // Only the pixels are kept while scanning; the JPEG is encoded once, at the
  // end, rather than seven times over on the ticks that can least afford it.
  function captureProfileFrame() {
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return;

    try {
      const edge = Math.min(width, height);
      if (!profileCanvas) {
        profileCanvas = document.createElement("canvas");
        profileCanvas.width = PROFILE_PHOTO_EDGE;
        profileCanvas.height = PROFILE_PHOTO_EDGE;
      }
      const context = profileCanvas.getContext("2d");
      if (!context) return;

      // The preview is mirrored, so the portrait is mirrored to match: the
      // worker gets back the face they were just looking at.
      context.setTransform(-1, 0, 0, 1, PROFILE_PHOTO_EDGE, 0);
      context.drawImage(
        video,
        (width - edge) / 2,
        (height - edge) / 2,
        edge,
        edge,
        0,
        0,
        PROFILE_PHOTO_EDGE,
        PROFILE_PHOTO_EDGE,
      );
      context.setTransform(1, 0, 0, 1, 0, 0);
      profileReady = true;
    } catch {
      // A portrait is a nicety; enrollment carries on without one.
    }
  }

  function encodeProfilePhoto() {
    if (!profileReady || !profileCanvas) return null;
    try {
      return profileCanvas.toDataURL("image/jpeg", PROFILE_PHOTO_QUALITY);
    } catch {
      return null;
    }
  }

  function releaseScanner(nextState = "idle") {
    window.clearTimeout(timer);
    timer = null;
    scanning = false;
    saving = false;
    scanActive = false;
    scanner?.close?.();
    scanner = null;
    recognizer?.reset?.();
    recognizer = null;
    scaler?.release?.();
    scaler = null;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    video.srcObject = null;
    scannerView.dataset.status = nextState;
    cancelButton.hidden = true;
    refreshFlow();
  }

  function renderRoster(workers) {
    roster.replaceChildren();
    rosterEmpty.hidden = workers.length > 0;
    rosterEmpty.textContent = user
      ? "No workers enrolled yet."
      : "Sign in to see enrolled worker IDs.";

    workers.forEach((worker) => {
      const row = document.createElement("article");
      row.className = "worker-row";
      const avatar = document.createElement("span");
      avatar.className = "worker-avatar";
      if (worker.profilePhoto) {
        const portrait = document.createElement("img");
        portrait.src = worker.profilePhoto;
        portrait.alt = "";
        portrait.loading = "lazy";
        avatar.append(portrait);
      } else {
        // Enrolled before portraits, or scanned without one.
        avatar.textContent = String(worker.displayName || worker.workerId)
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
          .map((part) => part[0])
          .join("")
          .toUpperCase();
      }
      const identity = document.createElement("div");
      const name = document.createElement("p");
      name.className = "worker-name";
      name.textContent = worker.displayName;
      const id = document.createElement("p");
      id.className = "worker-id";
      id.textContent = worker.workerId;
      identity.append(name, id);
      const remove = document.createElement("button");
      remove.className = "delete-worker";
      remove.type = "button";
      remove.textContent = "Delete template";
      remove.setAttribute("aria-label", `Delete face template for ${worker.workerId}`);
      remove.addEventListener("click", async () => {
        if (!window.confirm(`Delete the stored face template for ${worker.workerId}?`)) return;
        remove.disabled = true;
        try {
          await cloud.deleteWorkerFace(worker.workerId);
          setStatus(`${worker.workerId} face template deleted.`, "success");
          telemetry?.event("onboarding.worker.deleted", { status: "success" });
          await refreshRoster();
        } catch (error) {
          setStatus(error?.message || "The face template could not be deleted.", "error");
          telemetry?.event(
            "onboarding.worker.delete_failed",
            {
              errorCode: telemetry?.safeErrorCode(error, "delete_worker_failed"),
              status: "failed",
            },
            { immediate: true },
          );
          remove.disabled = false;
        }
      });
      row.append(avatar, identity, remove);
      roster.append(row);
    });
  }

  function readWorkers({ fresh = false } = {}) {
    if (!user) return Promise.resolve([]);
    if (fresh) workerRead = null;
    if (!workerRead) {
      workerRead = cloud.getWorkerFaces().catch((error) => {
        // A refusal is forgotten rather than remembered, so the next keystroke or
        // the next open gets to try again instead of inheriting it.
        workerRead = null;
        throw error;
      });
    }
    return workerRead;
  }

  async function loadRoster() {
    if (!user) {
      renderRoster([]);
      return [];
    }
    try {
      const workers = await readWorkers();
      renderRoster(workers);
      return workers;
    } catch (error) {
      renderRoster([]);
      setStatus(error?.message || "Worker enrollments could not be loaded.", "error");
      return [];
    }
  }

  // A closed list is not worth a read. Enrolling somebody, or signing in as
  // somebody else, only notes that what is folded away is out of date; the fetch
  // waits until it is opened.
  async function refreshRoster() {
    // Something has changed, so the shared read is dropped whether or not the
    // list is on screen to show it.
    workerRead = null;
    if (!user) {
      rosterStale = true;
      renderRoster([]);
      return;
    }
    if (!rosterOpen) {
      rosterStale = true;
      return;
    }
    rosterStale = false;
    await loadRoster();
  }

  async function setRosterOpen(open) {
    rosterOpen = open;
    rosterBody.hidden = !open;
    rosterToggle.setAttribute("aria-expanded", String(open));
    const label = open ? "Hide enrolled workers" : "Show enrolled workers";
    rosterToggleLabel.textContent = label;
    rosterToggle.title = label;
    if (!open || !rosterStale) return;
    if (user) {
      // Said before the await, so an empty card cannot read as "nobody is
      // enrolled" while the list is still on its way.
      rosterEmpty.hidden = false;
      rosterEmpty.textContent = "Loading enrolled workers…";
    }
    await refreshRoster();
  }

  async function saveEnrollment() {
    if (saving) return;
    saving = true;
    scannerView.dataset.status = "saving";
    instruction.textContent = "Encrypting the connection and saving the face template…";
    const embedding = workerFace.averageEmbeddings(samples);

    // The number on screen was worked out before a seven-second scan, and another
    // operator may have enrolled somebody since. A save merges into whatever
    // document the ID names, so writing under a stale number would fold two
    // workers into one record: it is issued again, against a fresh read.
    const issued = await issueWorkerId({ fresh: true });
    if (!issued) {
      saving = false;
      scannerView.dataset.status = "scanning";
      cancelButton.hidden = false;
      setStatus("A worker ID could not be issued, so nothing was saved. Try again.", "error");
      instruction.textContent = "The scan is complete but has not been saved. Try again.";
      return;
    }

    try {
      const saved = await cloud.saveWorkerFace({
        workerId: issued,
        displayName: workerName.value,
        embedding,
        embeddings: samples,
        sampleCount: samples.length,
        profilePhoto: encodeProfilePhoto(),
      });
      releaseScanner("complete");
      progress.max = ONBOARDING_SAMPLES;
      progress.value = ONBOARDING_SAMPLES;
      progressCount.textContent = `${ONBOARDING_SAMPLES} of ${ONBOARDING_SAMPLES}`;
      instruction.textContent = `${saved.workerId} is ready for recording.`;
      setStatus(
        `${saved.displayName} (${saved.workerId}) enrolled. Recording can now match this worker ID.`,
        "success",
      );
      await refreshRoster();
    } catch (error) {
      saving = false;
      scannerView.dataset.status = "scanning";
      cancelButton.hidden = false;
      setStatus(error?.message || "The face template could not be saved.", "error");
      instruction.textContent = "The scan is complete but has not been saved. Try again.";
    }
  }

  async function scanOnce() {
    if (!scanning || saving || !scanner || !recognizer) return;

    const started = performance.now();
    try {
      // The landmarker and the recognition crop read the same shrunken copy of
      // the frame, so the camera's full resolution is drawn down once a tick
      // instead of being resized separately by each of them.
      const frame = scaler ? scaler.scale(video) : video;
      const detection = scanner.detect(frame);
      const described = await recognizer.describe(detection?.bodies || [], frame, Date.now());
      const accepted = described.find(
        (body) => body?.faceEmbedding && body?.enrollmentAccepted === true,
      );
      if (accepted && samples.length < ONBOARDING_SAMPLES) {
        samples.push(accepted.faceEmbedding);
        // Keep the most recent accepted frame: by the last sample the worker has
        // settled, so the newest one is usually the best portrait.
        captureProfileFrame();
      }
      const scanState = recognizer.enrollmentState();
      updateProgress({ ...scanState, samples: samples.length });
      if (samples.length >= ONBOARDING_SAMPLES) {
        await saveEnrollment();
        return;
      }
    } catch {
      instruction.textContent = "The camera paused for a moment. Hold still while it retries.";
    }

    // A scan that took longer than its own interval is given that much room
    // again, so a slow device spaces the work out rather than leaving the page
    // no time of its own between ticks.
    if (scanning) {
      timer = window.setTimeout(scanOnce, Math.max(250, performance.now() - started));
    }
  }

  async function startScan() {
    const normalizedId = workerFace.normalizeWorkerId(workerId.value);
    const normalizedName = workerFace.normalizeDisplayName(workerName.value);
    if (!user) {
      setStatus("Sign in with Google before scanning a worker.", "error");
      return;
    }
    if (!normalizedName) {
      setStatus("Enter the worker’s name.", "error");
      workerName.focus();
      return;
    }
    // Nothing the operator can fix in the ID field itself, so the name is what
    // they are sent back to.
    if (!normalizedId) {
      setStatus("No worker ID has been issued yet. Check the worker’s name.", "error");
      workerName.focus();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("This browser cannot open a camera for enrollment.", "error");
      return;
    }
    if (!window.StampNoteModel?.loadFaceScanner || !faceIdentity) {
      setStatus("The on-device face scanner has not loaded. Reload and try again.", "error");
      return;
    }
    workerId.value = normalizedId;
    workerName.value = normalizedName;
    samples = [];
    profileReady = false;
    scanActive = true;
    refreshFlow();
    cancelButton.hidden = false;
    scannerView.dataset.status = "scanning";
    updateProgress({ status: "loading", samples: 0, total: ONBOARDING_SAMPLES });
    const facing = currentCameraFacing();
    setStatus(
      `Starting the ${cameraFacing?.describe(facing) || "camera"} and private face model…`,
    );

    try {
      telemetry?.event("onboarding.scan.started", { facing, status: "ok" });
      stream = await navigator.mediaDevices.getUserMedia({
        video: cameraFacing
          ? cameraFacing.videoConstraints(facing, {
              width: FACE_CAMERA_WIDTH,
              height: FACE_CAMERA_HEIGHT,
              frameRate: 30,
            })
          : {
              facingMode: facing,
              width: { ideal: FACE_CAMERA_WIDTH },
              height: { ideal: FACE_CAMERA_HEIGHT },
              frameRate: { ideal: 30 },
            },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
      scaler = frameScaling?.createFrameScaler() || null;
      [scanner, recognizer] = await Promise.all([
        window.StampNoteModel.loadFaceScanner(),
        Promise.resolve(
          faceIdentity.createFaceIdentity({
            enrollmentSamples: ONBOARDING_SAMPLES,
            sampleMs: ONBOARDING_SAMPLE_MS,
          }),
        ).then(async (instance) => {
          await instance.load();
          return instance;
        }),
      ]);
      scanning = true;
      const resolution =
        video.videoWidth && video.videoHeight
          ? ` at ${video.videoWidth} × ${video.videoHeight}`
          : "";
      setStatus(
        `Face scan in progress${resolution}. Keep one worker close for about six seconds.`,
      );
      scanOnce();
    } catch (error) {
      releaseScanner("idle");
      setStatus(error?.message || "The face scanner could not start.", "error");
      instruction.textContent = "Your face should fill the oval.";
      telemetry?.event(
        "onboarding.scan.failed",
        {
          errorCode: telemetry?.safeErrorCode(error, "scan_start_failed"),
          status: "failed",
        },
        { immediate: true },
      );
    }
  }

  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!scanning && !saving) startScan();
  });

  workerName?.addEventListener("input", () => {
    refreshFlow();
    issueWorkerId();
  });

  cameraFacingToggle?.addEventListener("click", () => {
    cameraFacingPreference?.toggle();
    refreshCameraFacing();
  });

  rosterToggle?.addEventListener("click", () => {
    setRosterOpen(rosterBody.hidden);
  });

  cancelButton?.addEventListener("click", () => {
    releaseScanner("idle");
    samples = [];
    profileReady = false;
    updateProgress({ status: "no_face", samples: 0, total: ONBOARDING_SAMPLES });
    instruction.textContent = "Your face should fill the oval.";
    setStatus("Face scan cancelled. No template was saved.");
  });

  authButton?.addEventListener("click", async () => {
    authButton.disabled = true;
    try {
      if (user) await cloud.signOut();
      else await cloud.signIn();
    } catch (error) {
      setStatus(error?.message || "Google sign-in could not start.", "error");
      telemetry?.event(
        "cloud.auth.failed",
        { errorCode: telemetry?.safeErrorCode(error, "auth_failed"), status: "failed" },
        { immediate: true, dedupeMs: 60000 },
      );
    } finally {
      authButton.disabled = false;
    }
  });

  if (!cloud || !workerFace || !faceIdentity) {
    startButton.disabled = true;
    authButton.disabled = true;
    setStatus("Worker enrollment dependencies are unavailable. Reload the page.", "error");
    telemetry?.event(
      "client.error",
      { errorCode: "onboarding_dependencies_missing" },
      { immediate: true },
    );
    return;
  }

  telemetry?.configure({ surface: "onboarding" });
  startButton.disabled = true;
  refreshCameraFacing();
  cloud.subscribeAuth(async (nextUser, error) => {
    user = nextUser;
    signedInState.textContent = user ? user.email || "Signed in" : "Not signed in";
    signedInState.dataset.signedIn = String(Boolean(user));
    const signedIn = Boolean(user);
    authButton.classList.toggle("sign-out", signedIn);
    authButton.title = signedIn ? "Sign out" : "Sign in with Google";
    if (authIcon) authIcon.hidden = !signedIn;
    if (authLabel) {
      authLabel.classList.toggle("sign-out-label", signedIn);
      authLabel.textContent = signedIn ? "Sign out" : "Sign in with Google";
    }
    refreshFlow();
    if (error) {
      setStatus(error?.message || "Google sign-in is unavailable.", "error");
      telemetry?.event(
        "cloud.auth.failed",
        { errorCode: telemetry?.safeErrorCode(error, "auth_failed"), status: "failed" },
        { immediate: true, dedupeMs: 60000 },
      );
    } else if (user) {
      setStatus("Enter the worker details, then start the face scan.");
    } else {
      setStatus("Sign in, then enter the worker details.");
    }
    telemetry?.event("cloud.auth.state", {
      status: nextUser ? "signed_in" : "signed_out",
    });
    if (!user && (scanning || saving)) releaseScanner("idle");
    await refreshRoster();
    await issueWorkerId();
  });

  // Pre-cache static assets for instant loads and offline resilience.
  const ONBOARDING_CACHE_NAME = "stampnote-onboarding-v1";
  const ONBOARDING_STATIC_ASSETS = [
    "onboarding.html",
    "onboarding.css",
    "onboarding.js",
    "sidebar.css",
    "sidebar.js",
    "worker-face.js",
    "camera-facing.js",
    "frame-scaler.js",
    "face-identity.js",
    "pose-mapping.js",
    "firebase.js",
    "pose-model.js",
    "observability.js",
    "manifest.json",
    "icons/stampnote.svg",
    "vendor/fonts/outfit.css",
    "vendor/fonts/outfit-latin.woff2",
  ];

  async function cacheStaticAssets() {
    if ("caches" in window) {
      try {
        const cache = await window.caches.open(ONBOARDING_CACHE_NAME);
        await Promise.allSettled(
          ONBOARDING_STATIC_ASSETS.map((asset) =>
            fetch(asset).then((res) => (res.ok ? cache.put(asset, res) : null)),
          ),
        );
      } catch {
        /* Storage blocked or offline caching failures are non-fatal. */
      }
    }
    if ("serviceWorker" in navigator) {
      try {
        await navigator.serviceWorker.register("sw.js");
      } catch {
        /* Service worker registration failure is non-fatal. */
      }
    }
  }

  cacheStaticAssets();

  window.addEventListener("pagehide", () => releaseScanner("idle"));
})();
