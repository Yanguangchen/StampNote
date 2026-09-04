(function initializeRoverBridge(scope) {
  "use strict";

  function parsePairing(hash) {
    const value = new URLSearchParams(String(hash || "").replace(/^#/, "")).get("rover");
    if (!value) return null;
    const input = JSON.parse(value);
    const url = new URL(input.url);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !/^[a-f0-9]{64}$/.test(input.token)) {
      throw new Error("Use a pairing link from Rover Control on this computer.");
    }
    return { url: url.origin, token: input.token };
  }

  async function imageSize(jpeg) {
    const image = new scope.Image();
    image.src = jpeg;
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  }

  // Read the existing WebRTC video only when the browser presents a NEW frame.
  // A frozen element is never polled or restamped as live.
  function createVideoSampler({ video, send, performance = scope.performance, now = () => Date.now(), makeCanvas = () => scope.document.createElement('canvas'), intervalMs = 200 }) {
    let callbackId = null, generation = 0, running = false, busy = null;
    let lastSignature = null, lastSampleAt = -Infinity, lastFreshAt = -Infinity, canvas;
    function stop() {
      running = false; ++generation; busy = null; lastFreshAt = -Infinity;
      if (callbackId !== null) video.cancelVideoFrameCallback?.(callbackId);
      callbackId = null;
    }
    function start() {
      stop();
      if (!video.srcObject || typeof video.requestVideoFrameCallback !== 'function') return;
      const stream = video.srcObject, epoch = generation;
      running = true; lastSignature = null; lastSampleAt = -Infinity;
      function onFrame(tick, metadata) {
        if (!running || generation !== epoch || video.srcObject !== stream) return;
        callbackId = video.requestVideoFrameCallback(onFrame);
        const track = stream.getVideoTracks?.()[0];
        if (!track || track.readyState === 'ended' || track.muted || video.paused || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
        const identity = Number.isFinite(metadata.rtpTimestamp) ? metadata.rtpTimestamp : metadata.mediaTime;
        if (!Number.isFinite(identity) || identity === lastSignature) return;
        lastSignature = identity;
        const kind = Number.isFinite(metadata.captureTime) ? 'webrtc-capture' : Number.isFinite(metadata.receiveTime) ? 'webrtc-receive' : 'webrtc-presentation';
        const timestamp = kind === 'webrtc-capture' ? metadata.captureTime : kind === 'webrtc-receive' ? metadata.receiveTime : metadata.presentationTime;
        const capturedAt = performance.timeOrigin + timestamp;
        if (!Number.isFinite(capturedAt) || now() - capturedAt >= 1500 || capturedAt - now() > 1000) return;
        lastFreshAt = now();
        if (busy || tick - lastSampleAt < intervalMs) return;
        lastSampleAt = tick;
        const operation = {}; busy = operation;
        try {
          canvas ||= makeCanvas();
          const scale = Math.min(640 / video.videoWidth, 480 / video.videoHeight, 1);
          canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
          canvas.getContext('2d', { alpha: false }).drawImage(video, 0, 0, canvas.width, canvas.height);
          const input = { jpeg: canvas.toDataURL('image/jpeg', 0.7), width: canvas.width, height: canvas.height, capturedAt, timestampKind: kind, transport: 'webrtc' };
          Promise.resolve(send(input)).catch(() => {}).finally(() => { if (busy === operation) busy = null; });
        } catch { busy = null; lastFreshAt = -Infinity; }
      }
      callbackId = video.requestVideoFrameCallback(onFrame);
    }
    return { start, stop, hasFreshFrames: () => running && now() - lastFreshAt < 800 };
  }

  function createBridge(options = {}) {
    const pairing = options.pairing;
    const request = options.fetch || scope.fetch?.bind(scope);
    const decode = options.imageSize || imageSize;
    const status = options.onStatus || (() => {});
    let connected = false, connecting = false, revoked = false, epoch = 0;
    let sessionId = "", lastTimestamp = 0, inFlight = null;
    let sampler = null;

    function attachVideo(video) {
      sampler?.stop();
      sampler = video ? createVideoSampler({ video, send: deliver }) : null;
      if (connected) sampler?.start();
    }

    async function post(route, body, extra = {}) {
      const response = await request(`${pairing.url}/stampnote/${route}`, {
        method: "POST", mode: "cors", credentials: "omit", cache: "no-store", redirect: "error",
        headers: { Authorization: `Bearer ${pairing.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(1500), ...extra,
      });
      const data = await response.json();
      if (!response.ok) throw Object.assign(new Error(data.error || "Rover Control could not receive the picture."), { status: response.status });
      return data;
    }

    async function connect(id) {
      if (!pairing || revoked) throw new Error("Create a new pairing link in Rover Control first.");
      if (connected || connecting) throw new Error("Disconnect the current rover pairing first.");
      if (typeof id !== "string" || !/^[\w-]{1,160}$/.test(id)) throw new Error("Select a live recording first.");
      const generation = ++epoch;
      connecting = true;
      status("connecting", "Connecting to Rover Control on this computer…");
      try {
        await post("connect", { sessionId: id });
        if (generation !== epoch) return;
        connected = true; sessionId = id; lastTimestamp = 0;
        sampler?.start();
        status("connected", "Paired with Rover Control. Waiting for a new camera picture…");
      } catch (error) {
        if (generation === epoch) status("error", error.status ? error.message : "Cannot reach Rover Control. Start it on this computer and allow local network access if your browser asks.");
        throw error;
      } finally { if (generation === epoch) connecting = false; }
    }

    async function deliver(input) {
      if (!connected || inFlight) return false;
      const { jpeg, capturedAt } = input;
      if (!Number.isFinite(capturedAt) || capturedAt <= lastTimestamp || capturedAt > Date.now() + 1000 || Date.now() - capturedAt >= 1500) {
        status("stale", "Waiting for a fresh camera picture. Check the recording device and its clock.");
        return false;
      }
      if (typeof jpeg !== "string" || !jpeg.startsWith("data:image/jpeg;base64,") || jpeg.length > 1_500_000) return false;
      const operation = { epoch }; inFlight = operation; lastTimestamp = capturedAt;
      try {
        const dimensions = input.width && input.height ? { width: input.width, height: input.height } : await decode(jpeg);
        if (!connected || operation.epoch !== epoch) return false;
        const result = await post("frame", { ...dimensions, jpeg, capturedAt, sessionId, transport: input.transport, timestampKind: input.timestampKind });
        if (operation.epoch !== epoch) return false;
        status(result.fresh ? "receiving" : "stale", result.fresh ? `${input.transport === 'webrtc' ? 'WebRTC frame' : 'Fallback camera picture'} delivered to Rover Control. Live video stays here.` : "Pictures are arriving too late for rover movement.");
        return true;
      } catch (error) {
        if (operation.epoch === epoch) {
          if (error.status === 401) { connected = false; revoked = true; sampler?.stop(); }
          status("error", error.status ? error.message : "Picture delivery failed. Check Rover Control and local network permission.");
        }
        return false;
      } finally { if (inFlight === operation) inFlight = null; }
    }

    async function forward(record, jpeg) {
      if (sampler?.hasFreshFrames()) return false;
      return deliver({ jpeg, capturedAt: Number(record?.capturedAtMs), transport: 'relay', timestampKind: 'publisher-capture' });
    }

    async function disconnect() {
      if (!connected && !connecting) return;
      ++epoch; connected = false; connecting = false; revoked = true; inFlight = null;
      sampler?.stop();
      status("disconnected", "Rover observations disconnected. Create a new pairing link to reconnect.");
      try { await post("disconnect", {}, { keepalive: true }); }
      catch { status("disconnected", "Disconnected here. Rover Control will reject camera observations once they become stale."); }
    }
    if (options.video) attachVideo(options.video);
    return { connect, forward, attachVideo, disconnect, isConnected: () => connected };
  }

  const api = { parsePairing, createBridge, createVideoSampler };
  // Load before observability: consume the frame-only credential and remove it from the URL.
  if (scope.location && scope.history) {
    try { api.pendingPairing = parsePairing(scope.location.hash); }
    catch { api.pairingError = "Invalid rover pairing link. Create another in Rover Control."; }
    const fragment = new URLSearchParams(String(scope.location.hash || "").replace(/^#/, ""));
    if (fragment.has("rover")) {
      fragment.delete("rover");
      const suffix = fragment.toString();
      scope.history.replaceState(null, "", scope.location.pathname + scope.location.search + (suffix ? `#${suffix}` : ""));
    }
  }
  scope.StampNoteRoverBridge = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
