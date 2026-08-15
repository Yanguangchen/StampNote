(function initializeWorkerOnboarding() {
  "use strict";

  const cloud = window.StampNoteFirebase;
  const workerFace = window.StampNoteWorkerFace;
  const faceIdentity = window.StampNoteFaceIdentity;
  const frameScaling = window.StampNoteFrameScaler;
  const form = document.querySelector("#worker-form");
  const workerId = document.querySelector("#worker-id");
  const workerName = document.querySelector("#worker-name");
  const authButton = document.querySelector("#onboarding-auth");
  const signedInState = document.querySelector("#signed-in-state");
  const startButton = document.querySelector("#start-face-scan");
  const cancelButton = document.querySelector("#cancel-face-scan");
  const status = document.querySelector("#onboarding-status");
  const scannerView = document.querySelector("#scanner-view");
  const video = document.querySelector("#onboarding-video");
  const instruction = document.querySelector("#scanner-instruction");
  const progress = document.querySelector("#onboarding-progress");
  const progressCount = document.querySelector("#onboarding-progress-count");
  const roster = document.querySelector("#worker-roster");
  const rosterEmpty = document.querySelector("#roster-empty");

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

  function setStatus(message, state = "idle") {
    status.textContent = message;
    status.dataset.state = state;
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
    startButton.disabled = !user;
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
          await loadRoster();
        } catch (error) {
          setStatus(error?.message || "The face template could not be deleted.", "error");
          remove.disabled = false;
        }
      });
      row.append(avatar, identity, remove);
      roster.append(row);
    });
  }

  async function loadRoster() {
    if (!user) {
      renderRoster([]);
      return [];
    }
    try {
      const workers = await cloud.getWorkerFaces();
      renderRoster(workers);
      return workers;
    } catch (error) {
      renderRoster([]);
      setStatus(error?.message || "Worker enrollments could not be loaded.", "error");
      return [];
    }
  }

  async function saveEnrollment() {
    if (saving) return;
    saving = true;
    scannerView.dataset.status = "saving";
    instruction.textContent = "Encrypting the connection and saving the face template…";
    const embedding = workerFace.averageEmbeddings(samples);

    try {
      const saved = await cloud.saveWorkerFace({
        workerId: workerId.value,
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
      await loadRoster();
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
    if (!normalizedId) {
      setStatus("Enter a valid 2–32 character worker ID.", "error");
      workerId.focus();
      return;
    }
    if (!normalizedName) {
      setStatus("Enter the worker’s name.", "error");
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
    startButton.disabled = true;
    cancelButton.hidden = false;
    scannerView.dataset.status = "scanning";
    updateProgress({ status: "loading", samples: 0, total: ONBOARDING_SAMPLES });
    setStatus("Starting the front camera and private face model…");

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
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
    }
  }

  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!scanning && !saving) startScan();
  });

  cancelButton?.addEventListener("click", () => {
    releaseScanner("idle");
    samples = [];
    // A cancelled scan leaves nothing behind, portrait included.
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
    } finally {
      authButton.disabled = false;
    }
  });

  if (!cloud || !workerFace || !faceIdentity) {
    startButton.disabled = true;
    authButton.disabled = true;
    setStatus("Worker enrollment dependencies are unavailable. Reload the page.", "error");
    return;
  }

  startButton.disabled = true;
  cloud.subscribeAuth(async (nextUser, error) => {
    user = nextUser;
    signedInState.textContent = user ? user.email || "Signed in" : "Not signed in";
    signedInState.dataset.signedIn = String(Boolean(user));
    authButton.textContent = user ? "Sign out" : "Sign in with Google";
    startButton.disabled = !user || scanning || saving;
    if (error) setStatus(error?.message || "Google sign-in is unavailable.", "error");
    else if (user) setStatus("Enter the worker details, then start the face scan.");
    else setStatus("Sign in, then enter the worker details.");
    if (!user && (scanning || saving)) releaseScanner("idle");
    await loadRoster();
  });

  window.addEventListener("pagehide", () => releaseScanner("idle"));
})();
