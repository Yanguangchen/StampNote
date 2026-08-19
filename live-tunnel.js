(function initializeLiveTunnelPage(globalScope) {
  "use strict";

  const document = globalScope.document;
  if (!document?.querySelector("#live-tunnel-workspace")) return;

  const cloud = globalScope.StampNoteFirebase;
  const liveTunnel = globalScope.StampNoteLiveTunnel;
  const telemetry = globalScope.StampNoteObservability;
  const THEME_KEY = "stampnote-theme";

  const signInButton = document.querySelector("#live-tunnel-sign-in");
  const signOutButton = document.querySelector("#live-tunnel-sign-out");
  const authGate = document.querySelector("#live-tunnel-auth-gate");
  const accountName = document.querySelector("#live-tunnel-account");
  const workspace = document.querySelector("#live-tunnel-workspace");
  const status = document.querySelector("#live-tunnel-status");
  const list = document.querySelector("#live-tunnel-list");
  const empty = document.querySelector("#live-tunnel-empty");
  const countLabel = document.querySelector("#live-tunnel-count");
  const video = document.querySelector("#live-tunnel-video");
  const frame = document.querySelector("#live-tunnel-frame");
  const placeholder = document.querySelector("#live-tunnel-placeholder");
  const caption = document.querySelector("#live-tunnel-caption");
  const badge = document.querySelector("#live-tunnel-badge");
  const leaveButton = document.querySelector("#live-tunnel-leave");
  const voicePanel = document.querySelector("#live-tunnel-voice");
  const voiceRecord = document.querySelector("#live-tunnel-voice-record");
  const voiceCancel = document.querySelector("#live-tunnel-voice-cancel");
  const voiceStatus = document.querySelector("#live-tunnel-voice-status");
  const themeToggle = document.querySelector("#theme-toggle");
  const themeToggleIcon = document.querySelector("#theme-toggle-icon");
  const themeToggleLabel = document.querySelector("#theme-toggle-label");

  telemetry?.configure({ surface: "live-tunnel" });

  let signedInUser = null;
  let tunnels = [];
  let selectedId = "";
  let pendingId = readRequestedTunnelId();
  let unsubscribeTunnels = null;
  let viewer = null;
  let viewerState = "idle";
  let voiceBusy = false;
  const voiceRecorder = liveTunnel?.createVoiceRecorder?.({
    MediaRecorder: globalScope.MediaRecorder,
    getUserMedia: globalScope.navigator?.mediaDevices?.getUserMedia?.bind(
      globalScope.navigator.mediaDevices,
    ),
    maxMs: liveTunnel?.MAX_VOICE_MS,
  });

  function readRequestedTunnelId() {
    try {
      return String(new URLSearchParams(globalScope.location?.search || "").get("tunnel") || "");
    } catch {
      return "";
    }
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
    status.textContent = message;
    status.dataset.state = state;
  }

  function describeError(error) {
    switch (error?.code) {
      case "permission-denied":
        return "Firebase denied access. Sign out and sign in again with this Gmail.";
      case "admin-required":
        return "Live tunnel is available to administrators only.";
      default:
        return error?.message || "The live recordings could not be loaded.";
    }
  }

  function formatStarted(record, now = Date.now()) {
    const started = Number(record?.startedAtMs) || 0;
    if (!started) return record?.sessionLabel || "Live";
    const delta = Math.max(0, now - started);
    const minutes = Math.floor(delta / 60_000);
    if (minutes < 1) return `${record.sessionLabel || "Live"} · just started`;
    if (minutes === 1) return `${record.sessionLabel || "Live"} · started 1 min ago`;
    if (minutes < 60) return `${record.sessionLabel || "Live"} · started ${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    return `${record.sessionLabel || "Live"} · started ${hours}h ago`;
  }

  function setVoiceStatus(message) {
    if (voiceStatus) voiceStatus.textContent = message || "";
  }

  function setVoiceRecording(recording) {
    if (voiceRecord) {
      voiceRecord.setAttribute("aria-pressed", String(Boolean(recording)));
      voiceRecord.textContent = recording ? "Send voice message" : "Voice message";
      voiceRecord.disabled = voiceBusy && !recording;
    }
    if (voiceCancel) voiceCancel.hidden = !recording;
  }

  function setVoiceAvailable(available) {
    if (voicePanel) voicePanel.hidden = !available;
    if (!available) {
      setVoiceRecording(false);
      setVoiceStatus("");
    }
  }

  function setStageLive(live) {
    if (frame) frame.dataset.live = live ? "true" : "false";
    if (badge) badge.hidden = !live;
    if (leaveButton) leaveButton.hidden = viewerState === "idle";
    setVoiceAvailable(live && viewerState === "live");
  }

  function attachStream(stream) {
    if (!video) return;
    video.srcObject = stream || null;
    if (stream) {
      video.play?.()?.catch?.(() => {});
    }
    setStageLive(Boolean(stream) && viewerState === "live");
  }

  function describeTunnel(record) {
    if (!record) return "";
    const who = record.ownerEmail ? ` · ${record.ownerEmail}` : "";
    return `${record.location || "Unknown location"} · ${formatStarted(record)}${who}`;
  }

  async function leaveTunnel() {
    const active = viewer;
    viewer = null;
    viewerState = "idle";
    selectedId = "";
    voiceBusy = false;
    await voiceRecorder?.cancel?.();
    setVoiceAvailable(false);
    await active?.disconnect?.();
    attachStream(null);
    if (placeholder) {
      placeholder.textContent =
        "Choose a live recording. The camera opens here without anyone accepting a call.";
    }
    if (caption) caption.textContent = "";
    setStageLive(false);
    if (leaveButton) leaveButton.hidden = true;
    renderList();
  }

  async function tunnelInto(record) {
    if (!record?.id || !liveTunnel?.createViewer || !cloud) return;
    if (selectedId === record.id && viewer) return;

    await leaveTunnel();
    selectedId = record.id;
    viewerState = "connecting";
    if (placeholder) placeholder.textContent = "Opening the live camera…";
    if (caption) caption.textContent = describeTunnel(record);
    if (leaveButton) leaveButton.hidden = false;
    setStatus("Opening the live camera…");
    renderList();

    viewer = liveTunnel.createViewer({
      cloud,
      RTCPeerConnection: globalScope.RTCPeerConnection,
      onStream: attachStream,
      onState(state, detail) {
        viewerState = state;
        if (state === "live") {
          setStatus("");
          if (placeholder) placeholder.textContent = "";
          setStageLive(true);
          setVoiceAvailable(true);
        } else if (state === "failed") {
          setStatus(detail || "This network could not open a live picture.", "error");
          if (placeholder) {
            placeholder.textContent =
              detail ||
              "This network could not open a live picture. Try the same Wi-Fi, or a phone hotspot.";
          }
          setStageLive(false);
        } else if (state === "connecting") {
          setStatus("Opening the live camera…");
          setVoiceAvailable(false);
        }
        if (leaveButton) leaveButton.hidden = state === "idle";
      },
    });

    try {
      await viewer.connect(record);
      telemetry?.event("live_tunnel.joined", { status: "success" });
    } catch (error) {
      viewerState = "failed";
      setStatus(describeError(error), "error");
      if (placeholder) placeholder.textContent = describeError(error);
      telemetry?.event(
        "live_tunnel.join_failed",
        {
          errorCode: telemetry?.safeErrorCode?.(error, "tunnel_failed") || "tunnel_failed",
          status: "failed",
        },
        { immediate: true, dedupeMs: 60000 },
      );
    }
    renderList();
  }

  function renderList() {
    const live = liveTunnel?.liveTunnels?.(tunnels) || [];
    if (countLabel) {
      countLabel.textContent = live.length === 1 ? "1 live" : `${live.length} live`;
    }
    if (empty) empty.hidden = live.length > 0;
    if (!list) return;
    list.replaceChildren(
      ...live.map((record) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "live-tunnel-item";
        item.setAttribute("aria-pressed", String(record.id === selectedId));
        item.dataset.tunnelId = record.id;

        const location = document.createElement("span");
        location.className = "live-tunnel-item-location";
        location.textContent = record.location || "Unknown location";

        const meta = document.createElement("span");
        meta.className = "live-tunnel-item-meta";
        meta.textContent = `${formatStarted(record)}${record.ownerEmail ? ` · ${record.ownerEmail}` : ""}`;

        item.append(location, meta);
        item.addEventListener("click", () => tunnelInto(record));
        return item;
      }),
    );
  }

  function handleTunnels(records) {
    tunnels = records || [];
    const live = liveTunnel?.liveTunnels?.(tunnels) || [];
    renderList();

    if (pendingId) {
      const requested = live.find((record) => record.id === pendingId);
      if (requested) {
        pendingId = "";
        tunnelInto(requested);
        return;
      }
    }

    if (selectedId && !live.some((record) => record.id === selectedId)) {
      const ended = selectedId;
      leaveTunnel();
      setStatus("That recording stopped.");
      telemetry?.event("live_tunnel.ended", { tunnelId: ended, status: "ended" });
    }
  }

  function stopListening() {
    unsubscribeTunnels?.();
    unsubscribeTunnels = null;
  }

  function startListening() {
    stopListening();
    if (!cloud?.subscribeLiveTunnels) return;
    setStatus("Watching for live recordings…");
    unsubscribeTunnels = cloud.subscribeLiveTunnels(
      (records) => {
        setStatus("");
        handleTunnels(records);
      },
      (error) => setStatus(describeError(error), "error"),
    );
  }

  themeToggle?.addEventListener("click", toggleTheme);
  applyTheme(readStoredTheme());

  signInButton?.addEventListener("click", async () => {
    signInButton.disabled = true;
    try {
      await cloud.signIn();
    } catch (error) {
      setStatus(describeError(error), "error");
    } finally {
      signInButton.disabled = false;
    }
  });

  async function sendRecordedVoice() {
    if (!viewer?.sendVoiceMessage || voiceBusy) return;
    voiceBusy = true;
    setVoiceStatus("Sending voice message…");
    try {
      const recorded = await voiceRecorder.stop();
      setVoiceRecording(false);
      if (!recorded?.blob) {
        setVoiceStatus("The voice message was empty.");
        return;
      }
      await viewer.sendVoiceMessage(recorded.blob, { durationMs: recorded.durationMs });
      setVoiceStatus("Voice message sent.");
      telemetry?.event("live_tunnel.voice.sent", { status: "success" });
    } catch (error) {
      setVoiceRecording(false);
      setVoiceStatus(describeError(error));
      telemetry?.event(
        "live_tunnel.voice.failed",
        {
          errorCode: telemetry?.safeErrorCode?.(error, "voice_failed") || "voice_failed",
          status: "failed",
        },
        { immediate: true, dedupeMs: 60000 },
      );
    } finally {
      voiceBusy = false;
      if (voiceRecord) voiceRecord.disabled = false;
    }
  }

  async function startVoiceRecord() {
    if (!voiceRecorder || voiceBusy || viewerState !== "live") return;
    try {
      await voiceRecorder.start();
      setVoiceRecording(true);
      setVoiceStatus("Recording… tap send when you are done.");
    } catch (error) {
      setVoiceRecording(false);
      setVoiceStatus(
        error?.name === "NotAllowedError"
          ? "Microphone permission was denied."
          : describeError(error),
      );
    }
  }

  async function cancelVoiceRecord() {
    await voiceRecorder?.cancel?.();
    setVoiceRecording(false);
    setVoiceStatus("Voice message discarded.");
  }

  voiceRecord?.addEventListener("click", () => {
    if (voiceRecorder?.isRecording()) sendRecordedVoice();
    else startVoiceRecord();
  });
  voiceCancel?.addEventListener("click", () => cancelVoiceRecord());
  signOutButton?.addEventListener("click", () => cloud.signOut());
  leaveButton?.addEventListener("click", () => leaveTunnel());

  if (!cloud || !liveTunnel) {
    setStatus("The live tunnel dependencies are unavailable. Reload the page.", "error");
    if (signInButton) signInButton.disabled = true;
    return;
  }

  cloud.subscribeAuth(async (user, error) => {
    signedInUser = user;
    authGate.hidden = Boolean(user);
    workspace.hidden = !user;
    signOutButton.hidden = !user;
    accountName.textContent = user?.email || "";
    if (error) {
      setStatus(describeError(error), "error");
      return;
    }
    telemetry?.event("cloud.auth.state", { status: user ? "signed_in" : "signed_out" });
    if (!user) {
      stopListening();
      await leaveTunnel();
      tunnels = [];
      renderList();
      setStatus("");
      return;
    }
    startListening();
  });
})(typeof window !== "undefined" ? window : globalThis);
