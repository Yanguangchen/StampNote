(function initializeWorkerPhotos(globalScope) {
  "use strict";

  const REVIEW_MAX_EDGE = 512;
  const REVIEW_BATCH_SIZE = 8;

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function localDateKey(value) {
    const date = value instanceof Date ? value : new Date(value);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function unavailableWeather(recordedAtMs = Date.now()) {
    return {
      severity: "unknown",
      condition: "Weather unavailable",
      precipitationMm: null,
      maxGustKph: null,
      temperatureC: null,
      wetHours: 0,
      hours: 0,
      lostHours: null,
      impactPercent: null,
      provisional: true,
      recordedAtMs,
    };
  }

  function fallbackAddress(gps) {
    return `${Number(gps.latitude).toFixed(5)}, ${Number(gps.longitude).toFixed(5)}`;
  }

  function describeWeather(weather) {
    if (!weather || weather.severity === "unknown") return "Weather unavailable";
    const parts = [weather.condition || weather.severity];
    if (weather.temperatureC !== null) parts.push(`${weather.temperatureC} °C`);
    if (weather.precipitationMm > 0) parts.push(`${weather.precipitationMm} mm rain`);
    return parts.join(" · ");
  }

  const api = Object.freeze({ localDateKey, unavailableWeather, fallbackAddress, describeWeather });
  globalScope.StampNoteWorkerPhotos = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;

  if (!globalScope.document?.querySelector("#photo-actions")) return;

  const addressService = globalScope.StampNoteAddress;
  const stamp = globalScope.StampNoteStamp;
  const storage = globalScope.StampNoteStore;
  const weatherService = globalScope.StampNoteWeather;
  const cloud = globalScope.StampNoteFirebase;
  const telemetry = globalScope.StampNoteObservability;
  const store = storage.createPhotoStore();
  const localLiveServer =
    ["127.0.0.1", "localhost"].includes(globalScope.location.hostname) &&
    globalScope.location.port === "5500";
  const reviewEndpoint = localLiveServer
    ? "https://stampnote-omega.vercel.app/api/triage"
    : "/api/triage";

  telemetry?.configure({ surface: "worker-photos" });

  const takeInput = document.querySelector("#take-photo");
  const chooseInput = document.querySelector("#choose-photos");
  const actionArea = document.querySelector("#photo-actions");
  const status = document.querySelector("#worker-photo-status");
  const statusText = document.querySelector("#worker-photo-status-text");
  const sendButton = document.querySelector("#worker-photo-send");
  const authButton = document.querySelector("#worker-photo-auth");
  const authIcon = document.querySelector("#worker-photo-auth-icon");
  const authLabel = document.querySelector("#worker-photo-auth-label");
  const account = document.querySelector("#worker-photo-account");

  let user = null;
  let processing = false;
  let staged = [];

  function setStatus(message, state = "idle") {
    status.hidden = false;
    statusText.textContent = message;
    status.dataset.state = state;
  }

  function setProcessing(active) {
    processing = active;
    takeInput.disabled = active;
    chooseInput.disabled = active;
    sendButton.disabled = active || staged.length === 0;
    // Nothing staged, nothing to send: the screen stays two buttons until a
    // photo has actually been chosen.
    sendButton.hidden = staged.length === 0;
    actionArea.setAttribute("aria-busy", String(active));
  }

  function describeLocationError(error) {
    const environment = {
      isSecureContext: globalScope.isSecureContext,
      embedded: globalScope.top !== globalScope.self,
      maxTouchPoints: navigator.maxTouchPoints,
      standalone: navigator.standalone,
      userAgent: navigator.userAgent,
    };
    return addressService.describeGeolocationError(error, environment);
  }

  async function readCaptureContext(date) {
    setStatus("Getting a fresh GPS fix…", "working");
    const gps = await addressService.getCurrentCoordinates(navigator.geolocation, {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 0,
    });

    setStatus("Adding the address and current weather…", "working");
    const weatherPromise = weatherService
      .fetchDayWeather({
        latitude: gps.latitude,
        longitude: gps.longitude,
        dateKey: localDateKey(date),
      })
      .then((rows) => ({
        ...weatherService.summarizeSessionWeather(rows, {
          dateKey: localDateKey(date),
          fromHour: date.getHours(),
          toHour: Math.min(24, date.getHours() + 1),
        }),
        provisional: true,
        recordedAtMs: date.getTime(),
      }));
    const addressPromise = addressService.reverseGeocode(gps.latitude, gps.longitude);
    const [weatherResult, addressResult] = await Promise.allSettled([
      weatherPromise,
      addressPromise,
    ]);

    return {
      gps,
      address:
        addressResult.status === "fulfilled"
          ? addressResult.value.address
          : fallbackAddress(gps),
      weather:
        weatherResult.status === "fulfilled"
          ? weatherResult.value
          : unavailableWeather(date.getTime()),
      weatherStatus: weatherResult.status === "fulfilled" ? "recorded" : "unavailable",
    };
  }

  function loadImage(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const image = new Image();
      image.onload = () => resolve({ image, url });
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("This image could not be opened."));
      };
      image.src = url;
    });
  }

  function encodeCanvas(canvas, quality = 0.9) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("The photo could not be prepared."))),
        "image/jpeg",
        quality,
      );
    });
  }

  function blobDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(String(reader.result || "")), { once: true });
      reader.addEventListener(
        "error",
        () => reject(reader.error || new Error("The Gemini review copy could not be read.")),
        { once: true },
      );
      reader.readAsDataURL(blob);
    });
  }

  async function stampFile(file, captureContext, date) {
    const loaded = await loadImage(file);
    try {
      return await encodeCanvas(
        stamp.drawStampedImage(loaded.image, { address: captureContext.address, date }),
      );
    } finally {
      URL.revokeObjectURL(loaded.url);
    }
  }

  async function createGeminiCopy(record) {
    const loaded = await loadImage(record.blob);
    try {
      const scale = Math.min(
        1,
        REVIEW_MAX_EDGE / Math.max(loaded.image.naturalWidth, loaded.image.naturalHeight),
      );
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(loaded.image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(loaded.image.naturalHeight * scale));
      canvas.getContext("2d").drawImage(loaded.image, 0, 0, canvas.width, canvas.height);
      const blob = await encodeCanvas(canvas, 0.72);
      return {
        id: record.id,
        capturedAt: record.capturedAt,
        poseDetected: false,
        // The server's strict schema predates this no-recording page. Worker
        // selections use the ordinary review policy, never gesture protection.
        trigger: "schedule",
        localScore: null,
        mediaType: "image/jpeg",
        dataUrl: await blobDataUrl(blob),
      };
    } finally {
      URL.revokeObjectURL(loaded.url);
    }
  }

  async function requestGeminiSanitization(records) {
    const decisions = [];
    const models = new Map();

    for (let start = 0; start < records.length; start += REVIEW_BATCH_SIZE) {
      const batch = records.slice(start, start + REVIEW_BATCH_SIZE);
      setStatus(
        `Gemini is sanitizing photo${records.length === 1 ? "" : `s ${start + 1}–${
          start + batch.length
        }`}${records.length === 1 ? "" : ` of ${records.length}`}…`,
        "working",
      );
      const images = await Promise.all(batch.map(createGeminiCopy));
      const response = await fetch(reviewEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.error || `Gemini sanitization failed (HTTP ${response.status}).`);
      }
      if (!Array.isArray(result.decisions)) {
        throw new Error("Gemini sanitization returned an incomplete result.");
      }
      result.decisions.forEach((decision) => {
        decisions.push(decision);
        models.set(decision.id, String(result.model || ""));
      });
    }

    return { decisions, models };
  }

  async function uploadRecord(record) {
    if (!user || !cloud?.uploadWorkerPhoto) return false;
    await cloud.uploadWorkerPhoto(record);
    await store.markSynced(record.id);
    return true;
  }

  async function syncPendingWorkerPhotos() {
    if (!user || !cloud?.uploadWorkerPhoto) return { uploaded: 0, failed: 0 };
    const pending = (await store.listPending()).filter(
      (record) =>
        record.trigger === "worker" &&
        record.blob &&
        record.aiReview &&
        !storage.isAiFlagged(record),
    );
    let uploaded = 0;
    let failed = 0;
    try {
      for (const record of pending) {
        try {
          await uploadRecord(record);
          uploaded += 1;
        } catch (error) {
          failed += 1;
          console.warn("[StampNote worker photos] Cloud sync failed.", error);
        }
      }
      if (uploaded > 0 || failed > 0) {
        telemetry?.event("worker.photo.sync.completed", {
          uploadedCount: uploaded,
          failedCount: failed,
          status: failed === 0 ? "success" : "failed",
        });
      }
    } catch (error) {
      telemetry?.event(
        "worker.photo.sync.failed",
        {
          errorCode: telemetry?.safeErrorCode(error, "worker_sync_failed"),
          status: "failed",
        },
        { immediate: true },
      );
    }
    return { uploaded, failed };
  }

  async function handleFiles(fileList, source) {
    if (processing) return;
    const files = [...(fileList || [])].filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;

    staged = [];
    setProcessing(true);
    const date = new Date();
    try {
      const captureContext = await readCaptureContext(date);
      for (const [index, file] of files.entries()) {
        setStatus(`Preparing photo ${index + 1} of ${files.length}…`, "working");
        const photoDate = new Date(date.getTime() + index);
        const blob = await stampFile(file, captureContext, photoDate);
        staged.push(
          storage.createCaptureRecord({
            blob,
            date: photoDate,
            address: captureContext.address,
            gpsLocation: captureContext.gps,
            weather: captureContext.weather,
            weatherStatus: captureContext.weatherStatus,
            trigger: "worker",
            source,
          }),
        );
      }
      const weatherNote =
        captureContext.weatherStatus === "recorded"
          ? "GPS and weather are attached."
          : "GPS is attached; weather unavailability is recorded.";
      setStatus(
        `${staged.length} photo${staged.length === 1 ? " is" : "s are"} ready. ${weatherNote}`,
        "success",
      );
      telemetry?.event("worker.photo.staged", {
        photoCount: staged.length,
        source: source === "camera" || source === "library" ? source : undefined,
        status: "success",
      });
    } catch (error) {
      staged = [];
      const message =
        error?.code === 1 || error?.code === 2 || error?.code === 3
          ? describeLocationError(error)
          : error?.message || "The photo could not be prepared.";
      setStatus(`${message} No photo was saved.`, "error");
      telemetry?.event(
        "worker.photo.gps.failed",
        {
          errorCode: telemetry?.safeErrorCode(error, "gps_fix_failed"),
          status: "failed",
        },
        { immediate: true },
      );
    } finally {
      setProcessing(false);
      takeInput.value = "";
      chooseInput.value = "";
    }
  }

  function nowMs() {
    return globalScope.performance?.now?.() ?? Date.now();
  }

  async function sendStagedPhotos() {
    if (processing || staged.length === 0) return;
    setProcessing(true);
    const startedAt = nowMs();
    const traceId = telemetry?.createTraceId();

    try {
      const sanitation = await requestGeminiSanitization(staged);
      const decisionById = new Map(sanitation.decisions.map((decision) => [decision.id, decision]));
      const reviewed = [];

      for (const record of staged) {
        const saved = await store.save({
          blob: record.blob,
          date: new Date(record.capturedAtMs),
          address: record.address,
          gpsLocation: record.gpsLocation,
          weather: record.weather,
          weatherStatus: record.weatherStatus,
          trigger: "worker",
          source: record.source,
        });
        const decision = decisionById.get(record.id);
        if (!decision) throw new Error("Gemini did not return a result for every photo.");
        const [updated] = await store.applyAiReviews(
          [{ ...decision, id: saved.id }],
          { model: sanitation.models.get(record.id) },
        );
        reviewed.push(updated);
      }

      const accepted = reviewed.filter((record) => !storage.isAiFlagged(record));
      const held = reviewed.length - accepted.length;
      let uploaded = 0;
      let uploadFailed = 0;
      for (const record of accepted) {
        try {
          if (await uploadRecord(record)) uploaded += 1;
        } catch (error) {
          uploadFailed += 1;
          console.warn("[StampNote worker photos] Sanitized photo stayed on device.", error);
        }
      }

      const sentCount = staged.length;
      staged = [];
      const sentNote = user
        ? `${uploaded} sent${uploadFailed ? `; ${uploadFailed} kept on device to retry` : ""}.`
        : `${accepted.length} sanitized and saved on this device; sign in to sync.`;
      setStatus(
        `${sentNote}${held ? ` ${held} held back by Gemini sanitization.` : ""}`,
        uploadFailed ? "idle" : "success",
      );
      telemetry?.event(
        "worker.photo.sent",
        {
          durationMs: nowMs() - startedAt,
          photoCount: sentCount,
          uploadedCount: uploaded,
          failedCount: uploadFailed,
          status: "success",
        },
        { traceId },
      );
    } catch (error) {
      setStatus(`${error?.message || "Gemini sanitization failed."} Nothing was sent.`, "error");
      telemetry?.event(
        "worker.photo.send_failed",
        {
          durationMs: nowMs() - startedAt,
          errorCode: telemetry?.safeErrorCode(error, "worker_send_failed"),
          status: "failed",
        },
        { traceId, immediate: true },
      );
    } finally {
      setProcessing(false);
    }
  }

  takeInput.addEventListener("change", () => handleFiles(takeInput.files, "camera"));
  chooseInput.addEventListener("change", () => handleFiles(chooseInput.files, "library"));
  sendButton.addEventListener("click", sendStagedPhotos);

  function updateAccount(nextUser) {
    user = nextUser || null;
    account.textContent = user?.email || "Photos save on this device";
    const signedIn = Boolean(user);
    authButton?.classList?.toggle("sign-out", signedIn);
    if (authButton) {
      authButton.title = signedIn ? "Sign out" : "Sign in to sync";
      authButton.setAttribute("aria-pressed", String(signedIn));
    }
    if (authIcon) authIcon.hidden = !signedIn;
    if (authLabel) {
      authLabel?.classList?.toggle("sign-out-label", signedIn);
      authLabel.textContent = signedIn ? "Sign out" : "Sign in to sync";
    }
  }

  if (!cloud) {
    authButton.hidden = true;
  } else {
    cloud.subscribeAuth((nextUser, error) => {
      if (error) {
        updateAccount(null);
        setStatus(error.message || "Google sign-in is unavailable.", "error");
        telemetry?.event(
          "cloud.auth.failed",
          { errorCode: telemetry?.safeErrorCode(error, "auth_failed"), status: "failed" },
          { immediate: true, dedupeMs: 60000 },
        );
        return;
      }
      updateAccount(nextUser);
      telemetry?.event("cloud.auth.state", {
        status: nextUser ? "signed_in" : "signed_out",
      });
      if (nextUser) {
        syncPendingWorkerPhotos().then(({ uploaded, failed }) => {
          if (uploaded > 0) {
            setStatus(
              `${uploaded} sanitized photo${uploaded === 1 ? "" : "s"} synced${
                failed ? `; ${failed} will retry` : ""
              }.`,
              failed ? "idle" : "success",
            );
          }
        });
      }
    });

    authButton.addEventListener("click", async () => {
      authButton.disabled = true;
      try {
        if (user) await cloud.signOut();
        else await cloud.signIn();
      } catch (error) {
        setStatus(error.message || "Google sign-in could not be completed.", "error");
        telemetry?.event(
          "cloud.auth.failed",
          { errorCode: telemetry?.safeErrorCode(error, "auth_failed"), status: "failed" },
          { immediate: true, dedupeMs: 60000 },
        );
      } finally {
        authButton.disabled = false;
      }
    });
  }

  store.ready().catch((error) => {
    setStatus(error.message || "The local photo store could not be opened.", "error");
    telemetry?.event(
      "client.error",
      { errorCode: "photo_store_failed" },
      { immediate: true },
    );
  });
})(typeof window !== "undefined" ? window : globalThis);
