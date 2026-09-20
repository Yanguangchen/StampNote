(function initializeLiveTunnelPage(globalScope) {
  "use strict";

  const document = globalScope.document;
  if (!document?.querySelector("#live-tunnel-workspace")) return;

  const cloud = globalScope.StampNoteFirebase;
  const liveTunnel = globalScope.StampNoteLiveTunnel;
  const robotControlUrl = globalScope.StampNoteRobotControlUrl;
  const telemetry = globalScope.StampNoteObservability;
  const THEME_KEY = "stampnote-theme";
  const ROBOT_IP_KEY = "stampnote-live-tunnel-robot-ip";

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
  const picture = document.querySelector("#live-tunnel-picture");
  const frame = document.querySelector("#live-tunnel-frame");
  const placeholder = document.querySelector("#live-tunnel-placeholder");
  const caption = document.querySelector("#live-tunnel-caption");
  const badge = document.querySelector("#live-tunnel-badge");
  const leaveButton = document.querySelector("#live-tunnel-leave");
  const voicePanel = document.querySelector("#live-tunnel-voice");
  const talkButton = document.querySelector("#live-tunnel-talk");
  const voiceRecord = document.querySelector("#live-tunnel-voice-record");
  const voiceCancel = document.querySelector("#live-tunnel-voice-cancel");
  const voiceStatus = document.querySelector("#live-tunnel-voice-status");
  const themeToggle = document.querySelector("#theme-toggle");
  const themeToggleIcon = document.querySelector("#theme-toggle-icon");
  const themeToggleLabel = document.querySelector("#theme-toggle-label");
  const robotControl = document.querySelector("#live-tunnel-robot");
  const robotControlHost = document.querySelector("#live-tunnel-robot-host");
  const robotControlFrame = document.querySelector("#live-tunnel-robot-frame");
  const split = document.querySelector("#live-tunnel-split");
  const robotIpForm = document.querySelector("#live-tunnel-robot-ip-form");
  const robotIp = document.querySelector("#live-tunnel-robot-ip");
  const robotIpOpen = document.querySelector("#live-tunnel-robot-ip-open");
  const robotIpClose = document.querySelector("#live-tunnel-robot-close");
  const menuButton = document.querySelector("#live-tunnel-menu");
  const menuCount = document.querySelector("#live-tunnel-menu-count");
  const rail = document.querySelector("#live-tunnel-rail");
  const railScrim = document.querySelector("#live-tunnel-rail-scrim");
  const chooser = document.querySelector("#live-tunnel-chooser");

  telemetry?.configure({ surface: "live-tunnel" });

  let signedInUser = null;
  let tunnels = [];
  let selectedId = "";
  let autoSelect = true;
  let pendingId = readRequestedTunnelId();
  let unsubscribeTunnels = null;
  let viewer = null;
  let viewerState = "idle";
  let voiceBusy = false;
  let talkBusy = false;
  let robotOpenId = "";
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

  function readStoredRobotIps() {
    try {
      const raw = globalScope.localStorage?.getItem(ROBOT_IP_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function readStoredRobotIp(tunnelId) {
    const value = readStoredRobotIps()[tunnelId];
    return typeof value === "string" ? value : "";
  }

  function rememberRobotIp(tunnelId, value) {
    try {
      const stored = readStoredRobotIps();
      stored[tunnelId] = value;
      globalScope.localStorage?.setItem(ROBOT_IP_KEY, JSON.stringify(stored));
    } catch {
      /* The address still works for this visit even when storage is blocked. */
    }
  }

  function readDraftRobotIps() {
    const drafts = new Map();
    for (const item of list?.children || []) {
      const id = item.dataset?.tunnelId;
      const input = item.querySelector?.(".live-tunnel-robot-ip-input");
      if (id && input) drafts.set(id, String(input.value || ""));
    }
    if (robotIp) drafts.set("__stage", String(robotIp.value || ""));
    return drafts;
  }

  function currentRobotRecord() {
    const live = liveTunnel?.liveTunnels?.(tunnels) || [];
    return (
      live.find((record) => record.id === selectedId) ||
      live.find((record) => record.id === robotOpenId) ||
      live[0] ||
      { id: "stage" }
    );
  }

  function setMenuOpen(open) {
    if (rail) rail.dataset.open = String(Boolean(open));
    if (railScrim) railScrim.hidden = !open;
    if (workspace) workspace.dataset.menuOpen = String(Boolean(open));
    if (menuButton) menuButton.setAttribute("aria-expanded", String(Boolean(open)));
  }

  function syncStageRobotForm(drafts = readDraftRobotIps()) {
    if (!robotIp) return;
    const record = currentRobotRecord();
    const typed = drafts.get(record.id);
    const stageDraft = drafts.get("__stage");
    robotIp.value =
      typed ??
      (stageDraft ? stageDraft : readStoredRobotIp(record.id));
    if (robotIpOpen) robotIpOpen.hidden = Boolean(robotOpenId);
    if (robotIpClose) robotIpClose.hidden = !robotOpenId;
  }

  function setRobotOpen(open) {
    const isOpen = Boolean(open);
    if (robotControl) robotControl.dataset.open = isOpen ? "true" : "false";
    if (split) split.dataset.robotOpen = isOpen ? "true" : "false";
    if (robotIpOpen) robotIpOpen.hidden = isOpen;
    if (robotIpClose) robotIpClose.hidden = !isOpen;
  }

  function clearRobotControl() {
    if (robotControlFrame) {
      robotControlFrame.removeAttribute("src");
      robotControlFrame.src = "";
    }
    if (robotControlHost) robotControlHost.textContent = "";
    robotOpenId = "";
    setRobotOpen(false);
  }

  function closeRobotControl() {
    if (!robotOpenId && robotControl?.dataset.open !== "true") return;
    clearRobotControl();
    setStatus("Robot control closed.");
    renderList();
  }

  function openRobotControl(record, raw) {
    const parsed = robotControlUrl?.parseRobotControlUrl?.(raw) || {
      ok: false,
      error: "Enter a robot IP address.",
    };
    if (!parsed.ok) {
      setStatus(parsed.error, "error");
      return false;
    }

    rememberRobotIp(record.id, String(raw || "").trim());
    robotOpenId = record.id;
    if (robotIp) robotIp.value = String(raw || "").trim();
    if (robotControlHost) robotControlHost.textContent = parsed.host;
    setRobotOpen(true);
    if (robotControlFrame) robotControlFrame.src = parsed.href;
    setMenuOpen(false);
    const mixedContent =
      globalScope.isSecureContext !== false && String(parsed.href).startsWith("http:");
    const robotStatus = mixedContent
      ? `Opened robot control at ${parsed.host}. This page is HTTPS, so an http robot page may be blocked.`
      : `Opened robot control at ${parsed.host}.`;
    void Promise.resolve(tunnelInto(record)).finally(() => {
      if (robotOpenId === record.id) setStatus(robotStatus);
    });
    renderList();
    return true;
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

  function setTalking(talking) {
    if (talkButton) {
      talkButton.setAttribute("aria-pressed", String(Boolean(talking)));
      talkButton.textContent = talking ? "Stop talk" : "Talk";
      talkButton.disabled = Boolean(talkBusy) || (voiceBusy && !talking);
    }
    if (voiceRecord && talking) voiceRecord.disabled = true;
    if (voiceRecord && !talking && !voiceBusy) voiceRecord.disabled = false;
  }

  function setVoiceRecording(recording) {
    if (voiceRecord) {
      voiceRecord.setAttribute("aria-pressed", String(Boolean(recording)));
      voiceRecord.textContent = recording ? "Send voice message" : "Voice message";
      voiceRecord.disabled = (voiceBusy && !recording) || Boolean(viewer?.isTalking?.());
    }
    if (voiceCancel) voiceCancel.hidden = !recording;
    if (talkButton && !viewer?.isTalking?.()) talkButton.disabled = Boolean(recording) || talkBusy;
  }

  function setVoiceAvailable(available) {
    if (voicePanel) voicePanel.hidden = !available;
    if (!available) {
      setTalking(false);
      setVoiceRecording(false);
      setVoiceStatus("");
    }
  }

  function hasPaintedVideo() {
    return Boolean(video?.srcObject) && Number(video.videoWidth) > 0 && Number(video.videoHeight) > 0;
  }

  function preferredMode() {
    if (hasPaintedVideo()) return "webrtc";
    if (picture?.src) return "relay";
    return "";
  }

  function setStageLive(live, mode) {
    if (frame) {
      frame.dataset.live = live ? "true" : "false";
      const nextMode = live ? mode || preferredMode() : "";
      if (nextMode) frame.dataset.mode = nextMode;
      else delete frame.dataset.mode;
    }
    if (badge) badge.hidden = !live;
    if (leaveButton) leaveButton.hidden = viewerState === "idle";
    setVoiceAvailable(live && viewerState === "live");
  }

  function clearPicture() {
    if (!picture) return;
    picture.removeAttribute("src");
    picture.hidden = true;
  }

  function attachPicture(record) {
    const url = liveTunnel?.pictureToDataUrl?.(record) || "";
    if (!picture || !url) return;
    picture.src = url;
    picture.hidden = false;
    if (viewerState !== "live") viewerState = "live";
    setStatus("");
    if (placeholder) placeholder.textContent = "";
    setStageLive(true, preferredMode());
  }

  function attachStream(stream) {
    if (!video) return;
    video.srcObject = stream || null;
    if (stream) {
      video.play?.()?.catch?.(() => {});
    }
    if (viewerState === "idle") return;
    setStageLive(viewerState === "live" || Boolean(picture?.src), preferredMode());
  }

  ["loadeddata", "playing", "resize", "waiting", "stalled", "emptied", "pause"].forEach((name) => {
    video?.addEventListener(name, () => {
      if (viewerState === "idle") return;
      setStageLive(viewerState === "live" || Boolean(picture?.src), preferredMode());
    });
  });

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
    talkBusy = false;
    await voiceRecorder?.cancel?.();
    active?.stopTalk?.();
    setVoiceAvailable(false);
    await active?.disconnect?.();
    attachStream(null);
    clearPicture();
    if (placeholder) {
      placeholder.hidden = false;
      placeholder.textContent =
        "Choose a live recording. The camera opens here without anyone accepting a call.";
    }
    if (caption) caption.textContent = "";
    setStageLive(false);
    if (leaveButton) leaveButton.hidden = true;
    syncStageRobotForm();
    renderList();
  }

  async function tunnelInto(record) {
    if (!record?.id || !liveTunnel?.createViewer || !cloud) return;
    if (selectedId === record.id && viewer) return;

    autoSelect = true;
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
      getUserMedia: globalScope.navigator?.mediaDevices?.getUserMedia?.bind(
        globalScope.navigator.mediaDevices,
      ),
      onStream: attachStream,
      onPicture: attachPicture,
      onState(state, detail) {
        viewerState = state;
        if (state === "live") {
          setStatus("");
          if (placeholder) placeholder.textContent = "";
          setStageLive(true, preferredMode());
          setVoiceAvailable(true);
        } else if (state === "failed") {
          if (picture?.src) {
            viewerState = "live";
            setStatus("");
            if (placeholder) placeholder.textContent = "";
            setStageLive(true, "relay");
            setVoiceAvailable(true);
            return;
          }
          setStatus(detail || "This network could not open a live picture.", "error");
          if (placeholder) {
            placeholder.textContent =
              detail ||
              "This network could not open a live picture. The recording is still sending stills if this network can reach Firestore.";
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
    if (menuCount) {
      menuCount.hidden = live.length === 0;
      menuCount.textContent = live.length ? String(live.length) : "";
    }
    if (empty) empty.hidden = live.length > 0;
    if (!list) return;
    const draftIps = readDraftRobotIps();
    list.replaceChildren(
      ...live.map((record) => {
        const item = document.createElement("li");
        item.className = "live-tunnel-item";
        item.dataset.tunnelId = record.id;
        item.dataset.selected = String(record.id === selectedId);

        const join = document.createElement("button");
        join.type = "button";
        join.className = "live-tunnel-join";
        join.setAttribute("aria-pressed", String(record.id === selectedId));

        const location = document.createElement("span");
        location.className = "live-tunnel-item-location";
        location.textContent = record.location || "Unknown location";

        const meta = document.createElement("span");
        meta.className = "live-tunnel-item-meta";
        meta.textContent = `${formatStarted(record)}${record.ownerEmail ? ` · ${record.ownerEmail}` : ""}`;

        join.append(location, meta);
        join.addEventListener("click", () => {
          setMenuOpen(false);
          tunnelInto(record);
        });

        const watch = document.createElement("button");
        watch.type = "button";
        watch.className = "live-tunnel-watch";
        watch.textContent = record.id === selectedId ? "Watching" : "Watch";
        watch.disabled = record.id === selectedId;
        watch.addEventListener("click", () => {
          setMenuOpen(false);
          tunnelInto(record);
        });

        const form = document.createElement("form");
        form.className = "live-tunnel-robot-ip";
        form.setAttribute("autocomplete", "off");

        const label = document.createElement("label");
        label.className = "visually-hidden";
        label.setAttribute("for", `live-tunnel-robot-ip-${record.id}`);
        label.textContent = "Robot IP address";

        const input = document.createElement("input");
        input.id = `live-tunnel-robot-ip-${record.id}`;
        input.className = "live-tunnel-robot-ip-input";
        input.name = "robot-ip";
        input.type = "text";
        input.setAttribute("inputmode", "decimal");
        input.setAttribute("enterkeyhint", "go");
        input.setAttribute("autocomplete", "off");
        input.setAttribute("autocapitalize", "off");
        input.setAttribute("spellcheck", "false");
        input.setAttribute("maxlength", "128");
        input.placeholder = "Robot IP address";
        input.value = draftIps.has(record.id)
          ? draftIps.get(record.id)
          : readStoredRobotIp(record.id);

        const open = document.createElement("button");
        open.type = "submit";
        open.className = "live-tunnel-robot-ip-open";
        open.textContent = "Open";
        open.hidden = robotOpenId === record.id;

        const close = document.createElement("button");
        close.type = "button";
        close.className = "live-tunnel-robot-ip-close";
        close.textContent = "Close";
        close.hidden = robotOpenId !== record.id;

        form.append(label, input, open, close);
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          openRobotControl(record, input.value);
        });
        close.addEventListener("click", () => closeRobotControl());

        item.append(join, form, watch);
        return item;
      }),
    );
    renderChooser(live);
    syncStageRobotForm(draftIps);
  }

  function renderChooser(live) {
    if (!chooser) return;
    const idle = !selectedId;
    chooser.hidden = !idle || live.length === 0;
    if (placeholder && idle) {
      placeholder.hidden = live.length > 0;
    }
    if (!idle || live.length === 0) {
      chooser.replaceChildren();
      return;
    }
    chooser.replaceChildren(
      ...live.map((record) => {
        const item = document.createElement("li");
        const watch = document.createElement("button");
        watch.type = "button";
        watch.className = "live-tunnel-watch";
        watch.textContent = `Watch ${record.location || "live recording"}`;
        watch.addEventListener("click", () => tunnelInto(record));
        item.append(watch);
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
        autoSelect = true;
        tunnelInto(requested);
        return;
      }
    }

    if (selectedId && !live.some((record) => record.id === selectedId)) {
      const ended = selectedId;
      const next = autoSelect
        ? live.find((record) => record.id !== ended) || live[0] || null
        : null;
      setStatus("That recording stopped.");
      telemetry?.event("live_tunnel.ended", { tunnelId: ended, status: "ended" });
      if (next) tunnelInto(next);
      else leaveTunnel();
    } else if (autoSelect && !selectedId) {
      const next = live[0] || null;
      if (next) tunnelInto(next);
    }

    if (robotOpenId && !live.some((record) => record.id === robotOpenId)) {
      clearRobotControl();
      renderList();
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

  menuButton?.addEventListener("click", () => {
    setMenuOpen(rail?.dataset.open !== "true");
  });
  railScrim?.addEventListener("click", () => setMenuOpen(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setMenuOpen(false);
  });
  robotIpForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    openRobotControl(currentRobotRecord(), robotIp?.value);
  });
  robotIpClose?.addEventListener("click", () => closeRobotControl());

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

  async function startTalk() {
    if (!viewer?.startTalk || talkBusy || voiceBusy || viewerState !== "live") return;
    if (voiceRecorder?.isRecording?.()) return;
    talkBusy = true;
    try {
      await viewer.startTalk();
      setTalking(true);
      setVoiceStatus("Talking — live audio is going to the camera.");
      telemetry?.event("live_tunnel.talk.started", { status: "success" });
    } catch (error) {
      viewer?.stopTalk?.();
      setTalking(false);
      setVoiceStatus(
        error?.name === "NotAllowedError"
          ? "Microphone permission was denied."
          : describeError(error),
      );
      telemetry?.event(
        "live_tunnel.talk.failed",
        {
          errorCode: telemetry?.safeErrorCode?.(error, "talk_failed") || "talk_failed",
          status: "failed",
        },
        { immediate: true, dedupeMs: 60000 },
      );
    } finally {
      talkBusy = false;
      if (talkButton) {
        talkButton.disabled = Boolean(voiceRecorder?.isRecording?.()) || voiceBusy;
      }
    }
  }

  function stopTalk() {
    viewer?.stopTalk?.();
    setTalking(false);
    if (viewerState === "live") setVoiceStatus("Talk stopped.");
    telemetry?.event("live_tunnel.talk.stopped", { status: "success" });
  }

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
    if (!voiceRecorder || voiceBusy || viewerState !== "live" || viewer?.isTalking?.()) return;
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
  talkButton?.addEventListener("click", () => {
    if (viewer?.isTalking?.()) {
      stopTalk();
      return;
    }
    return startTalk();
  });
  signOutButton?.addEventListener("click", () => cloud.signOut());
  leaveButton?.addEventListener("click", () => {
    autoSelect = false;
    leaveTunnel();
  });

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
    if (menuButton) menuButton.hidden = !user;
    if (!user) setMenuOpen(false);
    accountName.textContent = user?.email || "";
    if (error) {
      setStatus(describeError(error), "error");
      return;
    }
    telemetry?.event("cloud.auth.state", { status: user ? "signed_in" : "signed_out" });
    if (!user) {
      stopListening();
      autoSelect = true;
      await leaveTunnel();
      clearRobotControl();
      tunnels = [];
      renderList();
      setStatus("");
      return;
    }
    startListening();
  });
})(typeof window !== "undefined" ? window : globalThis);
