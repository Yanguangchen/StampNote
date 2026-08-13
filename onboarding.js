(function initializeWorkerOnboarding() {
  "use strict";

  const cloud = window.StampNoteFirebase;
  const workerFace = window.StampNoteWorkerFace;
  const faceIdentity = window.StampNoteFaceIdentity;
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
  const FACE_CAMERA_WIDTH = 1920;
  const FACE_CAMERA_HEIGHT = 1080;

  let user = null;
  let stream = null;
  let scanner = null;
  let recognizer = null;
  let timer = null;
  let scanning = false;
  let saving = false;
  let samples = [];

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

  function releaseScanner(nextState = "idle") {
    window.clearTimeout(timer);
    timer = null;
    scanning = false;
    saving = false;
    scanner?.close?.();
    scanner = null;
    recognizer?.reset?.();
    recognizer = null;
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
      row.append(identity, remove);
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

    try {
      const detection = scanner.detect(video);
      const described = await recognizer.describe(detection?.bodies || [], video, Date.now());
      const accepted = described.find(
        (body) => body?.faceEmbedding && body?.enrollmentAccepted === true,
      );
      if (accepted && samples.length < ONBOARDING_SAMPLES) {
        samples.push(accepted.faceEmbedding);
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

    if (scanning) timer = window.setTimeout(scanOnce, 250);
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
