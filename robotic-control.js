/* Robotic control is the dedicated live camera for robot teleoperation: the
   picture, a lens switch, live incoming audio, and a Live tunnel share.
   Attendance, MediaPipe, and auto-capture stay on Recording. */
(function initializeRoboticControl(globalScope) {
  "use strict";

  const document = globalScope.document;
  if (!document?.querySelector("#robotic-video")) return;

  const cameraFacing = globalScope.StampNoteCameraFacing;
  const captureCamera = globalScope.StampNoteCaptureCamera;
  const cloud = globalScope.StampNoteFirebase;
  const liveTunnelApi = globalScope.StampNoteLiveTunnel;
  const telemetry = globalScope.StampNoteObservability;
  const THEME_KEY = "stampnote-theme";
  const FACING_KEY = "stampnote-robotic-control-camera-facing";

  const video = document.querySelector("#robotic-video");
  const frame = document.querySelector("#robotic-frame");
  const toggle = document.querySelector("#robotic-toggle");
  const iconStart = document.querySelector("#robotic-icon-start");
  const iconStop = document.querySelector("#robotic-icon-stop");
  const status = document.querySelector("#robotic-status");
  const cameraFacingToggle = document.querySelector("#camera-facing-toggle");
  const cameraFacingName = document.querySelector("#camera-facing-name");
  const cameraLoader = document.querySelector("#camera-loader");
  const cameraLoaderDetail = document.querySelector("#camera-loader-detail");
  const roboticAuth = document.querySelector("#robotic-auth");
  const liveVoiceNotice = document.querySelector("#live-voice-notice");
  const incomingAudio = document.querySelector("#robotic-incoming-audio");
  const incomingAudioNotice = document.querySelector("#robotic-incoming-audio-notice");
  const speakerToggle = document.querySelector("#robotic-speaker-toggle");
  const speakerName = document.querySelector("#robotic-speaker-name");
  const themeToggle = document.querySelector("#theme-toggle");
  const themeToggleIcon = document.querySelector("#theme-toggle-icon");
  const themeToggleLabel = document.querySelector("#theme-toggle-label");

  telemetry?.configure({ surface: "robotic-control" });

  const cameraFacingPreference = cameraFacing?.createPreference({
    key: FACING_KEY,
    fallback: cameraFacing.BACK,
  });

  let stream = null;
  let streamActive = false;
  let streamStarting = false;
  let cameraSwitching = false;
  let signedInUser = null;
  let livePublisher = null;
  let incomingVoiceUrl = "";
  let incomingAudioStream = null;
  let speakerMuted = false;
  let pendingVoiceUrl = "";
  let voicePlayer = null;
  let wakeLock = null;

  function environment() {
    let embedded = false;
    try {
      embedded = globalScope.top !== globalScope.self;
    } catch {
      embedded = true;
    }
    return {
      isSecureContext: globalScope.isSecureContext !== false,
      userAgent: globalScope.navigator?.userAgent || "",
      maxTouchPoints: globalScope.navigator?.maxTouchPoints || 0,
      standalone:
        globalScope.navigator?.standalone === true ||
        globalScope.matchMedia?.("(display-mode: standalone)").matches === true ||
        globalScope.matchMedia?.("(display-mode: fullscreen)").matches === true,
      embedded,
    };
  }

  function readStoredTheme() {
    try {
      const saved = globalScope.localStorage?.getItem(THEME_KEY);
      return saved === "dark" || saved === "light" ? saved : null;
    } catch {
      return null;
    }
  }

  function systemPrefersDark() {
    return globalScope.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
  }

  function applyTheme(theme) {
    const root = document.documentElement;
    if (root) {
      if (theme) root.dataset.theme = theme;
      else delete root.dataset.theme;
    }
    const dark = theme ? theme === "dark" : systemPrefersDark();
    if (themeToggle) {
      themeToggle.setAttribute("aria-pressed", dark ? "true" : "false");
      themeToggle.setAttribute("title", dark ? "Switch to light theme" : "Switch to dark theme");
    }
    if (themeToggleIcon) themeToggleIcon.textContent = dark ? "☀" : "☾";
    if (themeToggleLabel) themeToggleLabel.textContent = dark ? "Light" : "Dark";
  }

  function toggleTheme() {
    const next =
      (readStoredTheme() || (systemPrefersDark() ? "dark" : "light")) === "dark" ? "light" : "dark";
    try {
      globalScope.localStorage?.setItem(THEME_KEY, next);
    } catch {
      /* The theme still applies for this visit even when storage is blocked. */
    }
    applyTheme(next);
  }

  function setStatus(message, state = "idle") {
    if (!status) return;
    status.textContent = message;
    status.dataset.state = state;
  }

  function setStage(live) {
    if (document.body?.dataset) {
      document.body.dataset.stage = live ? "live" : "idle";
    }
  }

  function setToggleLabel(running) {
    if (!toggle) return;
    toggle.dataset.running = String(running);
    toggle.setAttribute("aria-pressed", String(running));
    toggle.setAttribute("aria-label", running ? "Stop camera" : "Start camera");
    iconStart?.toggleAttribute("hidden", running);
    iconStop?.toggleAttribute("hidden", !running);
    setStage(running);
  }

  function setCameraLoader(active, detail = "Preparing the secure camera connection…") {
    if (cameraLoader) {
      cameraLoader.hidden = !active;
      cameraLoader.setAttribute("aria-busy", String(Boolean(active)));
    }
    if (active && cameraLoaderDetail) cameraLoaderDetail.textContent = detail;
    if (toggle) {
      toggle.disabled = Boolean(active);
      toggle.dataset.loading = String(Boolean(active));
    }
  }

  function currentCameraFacing() {
    return cameraFacingPreference?.get() || "environment";
  }

  function cameraRequest(facing = currentCameraFacing()) {
    return captureCamera?.videoRequest(cameraFacing, facing) || {
      video: { facingMode: facing },
      audio: false,
    };
  }

  function setCameraFacingLabel() {
    if (!cameraFacingToggle) return;
    const facing = currentCameraFacing();
    const next = cameraFacing?.opposite(facing) || facing;
    cameraFacingToggle.dataset.facing = facing;
    cameraFacingToggle.setAttribute(
      "aria-label",
      `${cameraFacing?.name(facing) || "Back"} camera in use. Switch to the ${
        cameraFacing?.describe(next) || "front camera"
      }.`,
    );
    if (cameraFacingName) {
      cameraFacingName.textContent = cameraFacing?.name(facing) || "Back";
    }
  }

  function describeCloudError(error) {
    switch (error?.code) {
      case "auth/unauthorized-domain":
        return "This site must be added to Firebase Authentication's authorized domains.";
      case "auth/operation-not-allowed":
        return "Enable Google sign-in in Firebase Authentication first.";
      case "permission-denied":
        return "Firebase denied access. Sign out and sign in again with this Gmail.";
      default:
        return error?.message || "Firebase sign-in failed.";
    }
  }

  function updateCloudControls(user) {
    signedInUser = user || null;
    if (!roboticAuth) return;
    roboticAuth.dataset.signedIn = String(Boolean(user));
    roboticAuth.setAttribute("aria-pressed", String(Boolean(user)));
    const name = roboticAuth.querySelector(".hint");
    if (name) name.textContent = "Account";
    const signInIcon = roboticAuth.querySelector(".sign-in-icon");
    const signOutIcon = roboticAuth.querySelector(".sign-out-icon");
    if (signInIcon) signInIcon.hidden = Boolean(user);
    if (signOutIcon) signOutIcon.hidden = !user;
    roboticAuth.setAttribute("aria-label", user ? "Sign out of account" : "Sign in to account");
  }

  function sessionForLiveTunnel() {
    const data = globalScope.StampNoteCloudData;
    const capturedAt = new Date();
    const session = data?.sessionDefinitionFor?.(capturedAt) || { id: "", label: "" };
    return {
      location: "Robotic control",
      dateKey: data?.createDateKey?.(capturedAt),
      sessionId: session.id,
      sessionLabel: "Robotic control",
      startedAtMs: capturedAt.getTime(),
    };
  }

  function stopIncomingVoice() {
    if (incomingVoiceUrl) {
      URL.revokeObjectURL(incomingVoiceUrl);
      incomingVoiceUrl = "";
    }
    pendingVoiceUrl = "";
    if (liveVoiceNotice) {
      liveVoiceNotice.hidden = true;
      liveVoiceNotice.textContent = "Playing a voice message";
    }
  }

  // One reusable player: a browser that let it play once after a tap keeps
  // letting it play, where a fresh Audio per message would be blocked again.
  function ensureVoicePlayer() {
    if (voicePlayer) return voicePlayer;
    const AudioCtor = globalScope.Audio;
    if (typeof AudioCtor !== "function") return null;
    voicePlayer = new AudioCtor();
    voicePlayer.addEventListener("ended", stopIncomingVoice);
    voicePlayer.addEventListener("error", stopIncomingVoice);
    return voicePlayer;
  }

  function playVoiceUrl(url) {
    const player = ensureVoicePlayer();
    if (!player || !url) return;
    player.src = url;
    pendingVoiceUrl = "";
    if (liveVoiceNotice) {
      liveVoiceNotice.hidden = false;
      liveVoiceNotice.textContent = "Playing a voice message";
    }
    player.play?.()?.catch?.((error) => {
      if (url !== incomingVoiceUrl) return;
      if (error?.name !== "NotAllowedError") {
        stopIncomingVoice();
        return;
      }
      // Autoplay is blocked until someone touches this page. Keep the message
      // and play it on the next tap instead of discarding it.
      pendingVoiceUrl = url;
      if (liveVoiceNotice) {
        liveVoiceNotice.hidden = false;
        liveVoiceNotice.textContent = "Voice message waiting — tap anywhere to play";
      }
    });
  }

  function playIncomingVoiceMessage(message) {
    const blob = liveTunnelApi?.voiceMessageToBlob?.(message);
    if (!blob) return;
    stopIncomingVoice();
    incomingVoiceUrl = URL.createObjectURL(blob);
    if (liveVoiceNotice) liveVoiceNotice.hidden = false;
    playVoiceUrl(incomingVoiceUrl);
  }

  function setSpeakerState(live, muted = false) {
    if (!speakerToggle) return;
    speakerToggle.dataset.live = String(Boolean(live));
    speakerToggle.setAttribute("aria-pressed", String(Boolean(live) && !muted));
    speakerToggle.setAttribute(
      "aria-label",
      !live
        ? "Speaker — no live audio yet"
        : muted
          ? "Unmute incoming audio"
          : "Mute incoming audio",
    );
    if (speakerName) speakerName.textContent = !live ? "Speaker" : muted ? "Muted" : "Live";
  }

  function playIncomingAudioElement() {
    if (!incomingAudio?.srcObject || speakerMuted) return;
    incomingAudio.muted = false;
    incomingAudio.play?.()?.then?.(
      () => {
        if (!incomingAudio.srcObject || speakerMuted) return;
        setSpeakerState(true, false);
        if (incomingAudioNotice) incomingAudioNotice.textContent = "Live audio in";
      },
      () => {
        incomingAudio.muted = true;
        setSpeakerState(true, true);
        if (incomingAudioNotice) {
          incomingAudioNotice.hidden = false;
          incomingAudioNotice.textContent = "Tap anywhere to hear live audio";
        }
      },
    );
  }

  function streamIncomingAudio(media) {
    const tracks = media?.getAudioTracks?.() || media?.getTracks?.() || [];
    incomingAudioStream = tracks.length ? media : null;
    if (!incomingAudio) return incomingAudioStream;
    incomingAudio.srcObject = incomingAudioStream;
    if (!incomingAudioStream) {
      try {
        incomingAudio.pause?.();
      } catch {
        /* Clearing is the goal. */
      }
      incomingAudio.muted = true;
      if (incomingAudioNotice) {
        incomingAudioNotice.hidden = true;
        incomingAudioNotice.textContent = "Live audio in";
      }
      setSpeakerState(false);
      return null;
    }
    if (incomingAudioNotice) {
      incomingAudioNotice.hidden = false;
      incomingAudioNotice.textContent = "Live audio in";
    }
    setSpeakerState(true, speakerMuted);
    incomingAudio.muted = speakerMuted;
    playIncomingAudioElement();
    telemetry?.event("live_tunnel.audio.in", { status: "success" });
    return incomingAudioStream;
  }

  async function startLiveTunnel() {
    if (!cloud || !signedInUser || !liveTunnelApi?.createPublisher || livePublisher) return;
    livePublisher = liveTunnelApi.createPublisher({
      cloud,
      getStream: () => stream,
      getPreview: () => video,
      onVoiceMessage: playIncomingVoiceMessage,
      onAudioStream: streamIncomingAudio,
    });
    try {
      await livePublisher.publish(sessionForLiveTunnel());
    } catch (error) {
      livePublisher = null;
      console.warn("[StampNote robotic control] The live camera could not be shared.", {
        errorCode: telemetry?.safeErrorCode(error, "live_tunnel_publish_failed"),
      });
    }
  }

  function stopLiveTunnel() {
    const publisher = livePublisher;
    livePublisher = null;
    stopIncomingVoice();
    streamIncomingAudio(null);
    publisher?.close?.();
  }

  function releaseCameraTracks() {
    stream?.getTracks?.().forEach((track) => track.stop());
    stream = null;
    if (video) video.srcObject = null;
  }

  async function requestWakeLock() {
    if (!globalScope.navigator?.wakeLock?.request) return;
    try {
      wakeLock = await globalScope.navigator.wakeLock.request("screen");
    } catch {
      wakeLock = null;
    }
  }

  function releaseWakeLock() {
    wakeLock?.release?.().catch(() => {});
    wakeLock = null;
  }

  function describeCameraError(error) {
    return (
      captureCamera?.describeCameraError(error, environment()) ||
      error?.message ||
      "The camera could not be started."
    );
  }

  async function useCameraFacing(facing, previousFacing) {
    stream?.getTracks?.().forEach((track) => track.stop());
    stream = null;
    if (video) video.srcObject = null;

    let failure = null;
    try {
      stream = await globalScope.navigator.mediaDevices.getUserMedia(cameraRequest(facing));
    } catch (error) {
      failure = error;
      telemetry?.event(
        "capture.camera.facing.failed",
        {
          errorCode: telemetry.safeErrorCode(error, "camera_switch_failed"),
          facing,
          status: "failed",
        },
        { immediate: true },
      );
      try {
        stream = await globalScope.navigator.mediaDevices.getUserMedia(
          cameraRequest(previousFacing),
        );
      } catch {
        stopStream();
        setStatus(describeCameraError(failure), "error");
        return false;
      }
      cameraFacingPreference?.set(previousFacing);
      setCameraFacingLabel();
    }

    if (video) {
      video.srcObject = stream;
      try {
        await video.play();
      } catch {
        /* Some browsers resolve the frame without play() ever settling. */
      }
    }

    if (failure) {
      setStatus(
        `The ${cameraFacing?.describe(facing) || "other camera"} could not be opened, so the ${
          cameraFacing?.describe(previousFacing) || "camera"
        } is still in use.`,
        "error",
      );
      return false;
    }
    livePublisher?.setStream?.();
    return true;
  }

  async function switchCameraFacing() {
    if (!cameraFacingPreference || cameraSwitching || streamStarting) return;

    const previousFacing = currentCameraFacing();
    const facing = cameraFacingPreference.toggle();
    setCameraFacingLabel();
    telemetry?.event("capture.camera.facing", { facing });

    if (!stream) return;

    cameraSwitching = true;
    if (cameraFacingToggle) cameraFacingToggle.disabled = true;
    try {
      await useCameraFacing(facing, previousFacing);
    } finally {
      cameraSwitching = false;
      if (cameraFacingToggle) cameraFacingToggle.disabled = false;
    }
  }

  async function startStream() {
    if (streamActive || streamStarting) return;
    streamStarting = true;
    setCameraLoader(true);
    try {
      const startedAt = performance.now();
      if (!globalScope.navigator?.mediaDevices?.getUserMedia) {
        setStatus("This browser cannot open a live camera.", "error");
        telemetry?.event(
          "capture.monitor.failed",
          { errorCode: "camera_unsupported", status: "failed" },
          { immediate: true },
        );
        return;
      }

      setStatus(`Starting the ${cameraFacing?.describe(currentCameraFacing()) || "camera"}…`);
      try {
        stream = await globalScope.navigator.mediaDevices.getUserMedia(cameraRequest());
      } catch (error) {
        setStatus(describeCameraError(error), "error");
        telemetry?.event(
          "capture.monitor.failed",
          {
            durationMs: performance.now() - startedAt,
            errorCode: telemetry.safeErrorCode(error, "camera_failed"),
            status: "failed",
          },
          { immediate: true },
        );
        return;
      }

      if (video) {
        video.srcObject = stream;
        try {
          await video.play();
        } catch {
          /* Some browsers resolve the frame without play() ever settling. */
        }
      }

      await startLiveTunnel();

      if (frame) frame.hidden = false;
      streamActive = true;
      setToggleLabel(true);
      setStatus(
        signedInUser
          ? "Streaming video — Live tunnel can share this camera."
          : "Streaming video. Sign in to share it over Live tunnel.",
      );
      telemetry?.event("capture.monitor.started", {
        durationMs: performance.now() - startedAt,
        status: "success",
        vision: false,
      });
      requestWakeLock();
    } finally {
      streamStarting = false;
      setCameraLoader(false);
    }
  }

  function stopStream() {
    streamActive = false;
    releaseCameraTracks();
    stopLiveTunnel();
    releaseWakeLock();
    if (frame) frame.hidden = true;
    setToggleLabel(false);
    setStatus("Video stream stopped.");
  }

  function initializeCloud() {
    if (!cloud) {
      if (roboticAuth) roboticAuth.disabled = true;
      return;
    }

    cloud.subscribeAuth((user, error) => {
      if (error) {
        updateCloudControls(null);
        setStatus(describeCloudError(error), "error");
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
        stopLiveTunnel();
        if (streamActive) {
          setStatus("Streaming video. Sign in to share it over Live tunnel.");
        }
        return;
      }
      if (streamActive) {
        startLiveTunnel();
        setStatus("Streaming video — Live tunnel can share this camera.");
      }
    });
  }

  toggle?.addEventListener("click", () => {
    if (streamActive) stopStream();
    else startStream();
  });

  cameraFacingToggle?.addEventListener("click", switchCameraFacing);

  speakerToggle?.addEventListener("click", () => {
    if (!incomingAudio?.srcObject) {
      setStatus("No live audio is coming in yet.");
      return;
    }
    if (incomingAudio.muted) {
      speakerMuted = false;
      incomingAudio.muted = false;
      playIncomingAudioElement();
      setSpeakerState(true, false);
      return;
    }
    speakerMuted = true;
    incomingAudio.muted = true;
    setSpeakerState(true, true);
  });

  roboticAuth?.addEventListener("click", async () => {
    if (!cloud) return;
    roboticAuth.disabled = true;
    try {
      if (signedInUser) {
        await cloud.signOut();
        setStatus("Signed out of Firebase.");
      } else {
        setStatus("Opening Google sign-in…");
        await cloud.signIn();
      }
    } catch (error) {
      if (
        error?.code !== "auth/popup-closed-by-user" &&
        error?.code !== "auth/cancelled-popup-request"
      ) {
        setStatus(describeCloudError(error), "error");
        telemetry?.event(
          "cloud.auth.failed",
          { errorCode: telemetry.safeErrorCode(error), status: "failed" },
          { immediate: true, dedupeMs: 60000 },
        );
      }
    } finally {
      roboticAuth.disabled = false;
    }
  });

  themeToggle?.addEventListener("click", toggleTheme);

  document.addEventListener("visibilitychange", () => {
    if (!streamActive) return;
    if (document.hidden) return;
    video?.play?.()?.catch?.(() => {});
    if (!wakeLock) requestWakeLock();
  });

  globalScope.addEventListener("pagehide", () => {
    if (streamActive) stopStream();
  });

  // Browsers only allow sound after a user gesture, and a touchscreen's
  // pointerdown does not count as one. Retry blocked audio on the events that
  // do, so one tap anywhere turns on Talk and waiting voice messages.
  function resumeBlockedAudio(event) {
    if (event?.target && speakerToggle?.contains?.(event.target)) return;
    if (incomingAudio?.srcObject && !speakerMuted) playIncomingAudioElement();
    if (pendingVoiceUrl) playVoiceUrl(pendingVoiceUrl);
  }
  ["click", "touchend", "keydown"].forEach((name) => {
    document.addEventListener(name, resumeBlockedAudio, true);
  });

  setToggleLabel(false);
  setCameraFacingLabel();
  setSpeakerState(false);
  applyTheme(readStoredTheme());
  initializeCloud();
  startStream();

  globalScope.StampNoteRoboticControl = Object.freeze({
    streamIncomingAudio,
  });
})(typeof globalThis !== "undefined" ? globalThis : this);
