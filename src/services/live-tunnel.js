(function initializeLiveTunnel(globalScope) {
  "use strict";

  // Heartbeats are client timestamps so a viewer can tell a stale camera from a
  // live one without waiting for a server clock. Twenty-five seconds is long
  // enough for a backgrounded tab to miss a beat, and short enough that a
  // closed recording disappears before an administrator tunnels into nothing.
  const HEARTBEAT_MS = 8_000;
  const STALE_MS = 25_000;
  const MAX_VOICE_MS = 30_000;
  const MAX_VOICE_BYTES = 400_000;
  const VOICE_CHANNEL = "stampnote-voice";
  const VOICE_MESSAGE_TYPE = "voice-message";
  const VOICE_MIME_TYPES = Object.freeze([
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ]);
  const ICE_SERVERS = Object.freeze([
    Object.freeze({ urls: "stun:stun.l.google.com:19302" }),
    Object.freeze({ urls: "stun:stun1.l.google.com:19302" }),
  ]);

  function isLiveTunnel(record, now = Date.now()) {
    if (!record || record.status !== "live") return false;
    const seen = Number(record.lastSeenAtMs) || Number(record.startedAtMs) || 0;
    return seen > 0 && now - seen < STALE_MS;
  }

  function liveTunnels(records, now = Date.now()) {
    return (records || [])
      .filter((record) => isLiveTunnel(record, now))
      .sort((left, right) => (Number(right.lastSeenAtMs) || 0) - (Number(left.lastSeenAtMs) || 0));
  }

  function icePayload(candidate) {
    if (!candidate) return null;
    const value = typeof candidate.toJSON === "function" ? candidate.toJSON() : candidate;
    const line = String(value?.candidate || "");
    if (!line) return null;
    return {
      candidate: line,
      sdpMid: value.sdpMid == null ? null : String(value.sdpMid),
      sdpMLineIndex: Number.isFinite(Number(value.sdpMLineIndex))
        ? Number(value.sdpMLineIndex)
        : null,
    };
  }

  function descriptionPayload(description) {
    return {
      type: String(description?.type || ""),
      sdp: String(description?.sdp || ""),
    };
  }

  function peerConfig() {
    return { iceServers: [...ICE_SERVERS] };
  }

  function attachRemoteIce(pc, records, seen) {
    (records || []).forEach((entry) => {
      if (!entry?.id || seen.has(entry.id)) return;
      const line = String(entry.candidate || "");
      if (!line) return;
      seen.add(entry.id);
      try {
        pc.addIceCandidate({
          candidate: line,
          sdpMid: entry.sdpMid,
          sdpMLineIndex: entry.sdpMLineIndex,
        });
      } catch {
        // A candidate that arrives before remote description is ignored; the
        // next snapshot after setRemoteDescription retries with a fresh set.
      }
    });
  }

  function chooseVoiceMimeType(Recorder = globalScope.MediaRecorder) {
    if (typeof Recorder?.isTypeSupported !== "function") return "";
    return VOICE_MIME_TYPES.find((type) => Recorder.isTypeSupported(type)) || "";
  }

  function bytesToBase64(bytes) {
    const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    if (typeof globalScope.btoa === "function") {
      let binary = "";
      raw.forEach((value) => {
        binary += String.fromCharCode(value);
      });
      return globalScope.btoa(binary);
    }
    return Buffer.from(raw).toString("base64");
  }

  function base64ToBytes(value) {
    const binary = typeof globalScope.atob === "function"
      ? globalScope.atob(String(value || ""))
      : Buffer.from(String(value || ""), "base64").toString("binary");
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  async function encodeVoiceMessage(blob, options = {}) {
    if (!blob) throw new Error("The voice message is empty.");
    const buffer = await (blob.arrayBuffer?.() || Promise.reject(new Error("The voice message could not be read.")));
    const bytes = new Uint8Array(buffer);
    if (bytes.byteLength === 0) throw new Error("The voice message is empty.");
    if (bytes.byteLength > MAX_VOICE_BYTES) {
      throw new Error("The voice message is too long to send.");
    }
    return {
      type: VOICE_MESSAGE_TYPE,
      mimeType: String(blob.type || options.mimeType || "audio/webm"),
      audio: bytesToBase64(bytes),
      durationMs: Math.max(0, Number(options.durationMs) || 0),
    };
  }

  function decodeVoiceMessage(payload) {
    try {
      const data = typeof payload === "string" ? JSON.parse(payload) : payload;
      if (data?.type !== VOICE_MESSAGE_TYPE || !data.audio) return null;
      return {
        type: VOICE_MESSAGE_TYPE,
        mimeType: String(data.mimeType || "audio/webm"),
        audio: String(data.audio),
        durationMs: Math.max(0, Number(data.durationMs) || 0),
      };
    } catch {
      return null;
    }
  }

  function voiceMessageToBlob(message, BlobCtor = globalScope.Blob) {
    const decoded = decodeVoiceMessage(message);
    if (!decoded || typeof BlobCtor !== "function") return null;
    return new BlobCtor([base64ToBytes(decoded.audio)], { type: decoded.mimeType });
  }

  function bindVoiceChannel(channel, onVoiceMessage) {
    if (!channel) return;
    channel.onmessage = (event) => {
      const decoded = decodeVoiceMessage(event?.data);
      if (decoded) onVoiceMessage?.(decoded);
    };
  }

  function createVoiceRecorder(options = {}) {
    const Recorder = options.MediaRecorder || globalScope.MediaRecorder;
    const getUserMedia =
      options.getUserMedia ||
      globalScope.navigator?.mediaDevices?.getUserMedia?.bind(globalScope.navigator.mediaDevices);
    let recorder = null;
    let stream = null;
    let chunks = [];
    let startedAt = 0;
    let limitTimer = null;

    function isRecording() {
      return recorder?.state === "recording";
    }

    function release() {
      if (limitTimer != null) {
        globalScope.clearTimeout(limitTimer);
        limitTimer = null;
      }
      stream?.getTracks?.().forEach((track) => track.stop());
      stream = null;
      recorder = null;
    }

    async function start() {
      if (isRecording()) return;
      if (typeof getUserMedia !== "function" || typeof Recorder !== "function") {
        throw new Error("This browser cannot record a voice message.");
      }
      chunks = [];
      stream = await getUserMedia({ audio: true, video: false });
      const mimeType = chooseVoiceMimeType(Recorder);
      recorder = mimeType ? new Recorder(stream, { mimeType }) : new Recorder(stream);
      recorder.ondataavailable = (event) => {
        if (event?.data && event.data.size > 0) chunks.push(event.data);
      };
      startedAt = Date.now();
      recorder.start();
      limitTimer = globalScope.setTimeout(() => {
        stop().catch(() => {});
      }, options.maxMs || MAX_VOICE_MS);
      limitTimer?.unref?.();
    }

    async function stop() {
      const active = recorder;
      const media = stream;
      const began = startedAt;
      if (!active || active.state === "inactive") {
        release();
        return { blob: null, durationMs: 0 };
      }
      const blob = await new Promise((resolve) => {
        active.onstop = () => {
          media?.getTracks?.().forEach((track) => track.stop());
          resolve(new globalScope.Blob(chunks, { type: active.mimeType || chunks[0]?.type || "audio/webm" }));
        };
        try {
          active.stop();
        } catch {
          resolve(null);
        }
      });
      chunks = [];
      recorder = null;
      stream = null;
      if (limitTimer != null) {
        globalScope.clearTimeout(limitTimer);
        limitTimer = null;
      }
      const durationMs = Math.max(0, Date.now() - began);
      if (!blob || blob.size === 0) return { blob: null, durationMs };
      return { blob, durationMs };
    }

    async function cancel() {
      chunks = [];
      try {
        if (recorder && recorder.state !== "inactive") recorder.stop();
      } catch {
        /* Discarding is the goal. */
      }
      release();
      return { blob: null, durationMs: 0 };
    }

    return Object.freeze({ start, stop, cancel, isRecording });
  }

  function createPublisher(options = {}) {
    const cloud = options.cloud;
    const RTCPeerConnection =
      options.RTCPeerConnection || globalScope.RTCPeerConnection;
    const getStream = options.getStream || (() => options.stream || null);
    const getSession = options.getSession || (() => ({}));
    const onVoiceMessage = options.onVoiceMessage || (() => {});
    let tunnel = null;
    let heartbeatTimer = null;
    let unsubscribeViewers = null;
    const peers = new Map();

    function currentStream() {
      return typeof getStream === "function" ? getStream() : null;
    }

    function addLocalTracks(pc) {
      const media = currentStream();
      const tracks = media?.getTracks?.() || [];
      tracks.forEach((track) => {
        const existing = pc.getSenders?.().some((sender) => sender.track === track);
        if (!existing) pc.addTrack(track, media);
      });
    }

    function replaceLocalTracks() {
      const media = currentStream();
      const videoTrack = media?.getVideoTracks?.()[0] || null;
      const audioTrack = media?.getAudioTracks?.()[0] || null;
      peers.forEach((peer) => {
        (peer.pc.getSenders?.() || []).forEach((sender) => {
          const kind = sender.track?.kind;
          if (kind === "video" || (!kind && sender.track == null && videoTrack)) {
            sender.replaceTrack?.(videoTrack);
          }
          if (kind === "audio") sender.replaceTrack?.(audioTrack);
        });
        if (videoTrack && !(peer.pc.getSenders?.() || []).some((sender) => sender.track?.kind === "video")) {
          addLocalTracks(peer.pc);
        }
      });
    }

    async function answerViewer(viewer) {
      if (!tunnel || !viewer?.id || !viewer.offer || peers.has(viewer.id) || !RTCPeerConnection) {
        return;
      }
      if (viewer.answer) return;

      const pc = new RTCPeerConnection(peerConfig());
      const seenIce = new Set();
      const peer = { pc, seenIce, unsubscribeIce: null };
      peers.set(viewer.id, peer);
      addLocalTracks(pc);
      pc.ondatachannel = (event) => {
        if (event?.channel?.label !== VOICE_CHANNEL) return;
        peer.voiceChannel = event.channel;
        bindVoiceChannel(event.channel, onVoiceMessage);
      };

      pc.onicecandidate = (event) => {
        const candidate = icePayload(event?.candidate);
        if (!candidate || !tunnel) return;
        cloud.addTunnelIce?.(tunnel.id, viewer.id, {
          from: "publisher",
          publisherUid: tunnel.ownerId,
          viewerUid: viewer.viewerUid,
          candidate,
        });
      };

      try {
        await pc.setRemoteDescription(viewer.offer);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await cloud.setTunnelViewerAnswer?.(tunnel.id, viewer.id, descriptionPayload(answer));
        peer.unsubscribeIce = cloud.subscribeTunnelIce?.(
          tunnel.id,
          viewer.id,
          (records) => {
            attachRemoteIce(
              pc,
              (records || []).filter((entry) => entry.from === "viewer"),
              seenIce,
            );
          },
        );
      } catch {
        closePeer(viewer.id);
      }
    }

    function closePeer(viewerId) {
      const peer = peers.get(viewerId);
      if (!peer) return;
      peer.unsubscribeIce?.();
      try {
        peer.voiceChannel?.close?.();
      } catch {
        /* A closed channel is the goal. */
      }
      try {
        peer.pc.close();
      } catch {
        /* A closed peer is the goal. */
      }
      peers.delete(viewerId);
    }

    function startHeartbeat() {
      stopHeartbeat();
      if (!cloud?.heartbeatLiveTunnel || !tunnel) return;
      heartbeatTimer = globalScope.setInterval(() => {
        if (!tunnel) return;
        cloud.heartbeatLiveTunnel(tunnel.id).catch(() => {});
      }, options.heartbeatMs || HEARTBEAT_MS);
      heartbeatTimer?.unref?.();
    }

    function stopHeartbeat() {
      if (heartbeatTimer != null) {
        globalScope.clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    }

    async function publish(sessionInput) {
      if (!cloud?.publishLiveTunnel) return null;
      await close();
      const session = sessionInput || getSession() || {};
      tunnel = await cloud.publishLiveTunnel(session);
      startHeartbeat();
      unsubscribeViewers = cloud.subscribeTunnelViewers?.(
        tunnel.id,
        (viewers) => {
          const live = new Set((viewers || []).map((viewer) => viewer.id));
          [...peers.keys()].forEach((viewerId) => {
            if (!live.has(viewerId)) closePeer(viewerId);
          });
          (viewers || []).forEach((viewer) => {
            answerViewer(viewer);
          });
        },
      );
      return tunnel;
    }

    function setStream() {
      replaceLocalTracks();
    }

    async function close() {
      stopHeartbeat();
      unsubscribeViewers?.();
      unsubscribeViewers = null;
      [...peers.keys()].forEach(closePeer);
      const ending = tunnel;
      tunnel = null;
      if (ending?.id && cloud?.endLiveTunnel) {
        try {
          await cloud.endLiveTunnel(ending.id);
        } catch {
          /* Recording still stops even if the presence document cannot. */
        }
      }
    }

    return Object.freeze({
      publish,
      setStream,
      close,
      getTunnel: () => tunnel,
    });
  }

  function createViewer(options = {}) {
    const cloud = options.cloud;
    const RTCPeerConnection =
      options.RTCPeerConnection || globalScope.RTCPeerConnection;
    const onStream = options.onStream || (() => {});
    const onState = options.onState || (() => {});
    let pc = null;
    let voiceChannel = null;
    let tunnel = null;
    let viewer = null;
    let unsubscribeViewer = null;
    let unsubscribeIce = null;
    const seenIce = new Set();
    let closed = false;

    function setState(state, detail) {
      onState(state, detail);
    }

    async function connect(record) {
      await disconnect();
      closed = false;
      tunnel = record;
      if (!record?.id || !record.ownerId) {
        throw new Error("The live recording is missing.");
      }
      if (!RTCPeerConnection) {
        throw new Error("This browser cannot open a live tunnel.");
      }
      if (!cloud?.createTunnelViewer) {
        throw new Error("The live tunnel client is unavailable.");
      }

      setState("connecting");
      pc = new RTCPeerConnection(peerConfig());
      voiceChannel = pc.createDataChannel(VOICE_CHANNEL, { ordered: true });
      bindVoiceChannel(voiceChannel, options.onVoiceMessage);
      pc.addTransceiver("video", { direction: "recvonly" });
      pc.ontrack = (event) => {
        const media = event.streams?.[0] || (event.track && new globalScope.MediaStream([event.track]));
        if (media) onStream(media);
      };
      pc.onconnectionstatechange = () => {
        const state = pc?.connectionState;
        if (state === "connected") setState("live");
        if (state === "failed" || state === "disconnected") {
          setState("failed", "This network could not open a live picture.");
        }
      };
      pc.onicecandidate = (event) => {
        const candidate = icePayload(event?.candidate);
        if (!candidate || !tunnel || !viewer) return;
        cloud.addTunnelIce?.(tunnel.id, viewer.id, {
          from: "viewer",
          publisherUid: tunnel.ownerId,
          viewerUid: viewer.viewerUid,
          candidate,
        });
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      viewer = await cloud.createTunnelViewer(tunnel.id, {
        publisherUid: tunnel.ownerId,
        offer: descriptionPayload(offer),
      });
      if (closed) return viewer;

      unsubscribeIce = cloud.subscribeTunnelIce?.(
        tunnel.id,
        viewer.id,
        (records) => {
          if (!pc) return;
          attachRemoteIce(
            pc,
            (records || []).filter((entry) => entry.from === "publisher"),
            seenIce,
          );
        },
      );
      unsubscribeViewer = cloud.subscribeTunnelViewer?.(
        tunnel.id,
        viewer.id,
        async (next) => {
          if (!pc || !next?.answer || pc.remoteDescription) return;
          try {
            await pc.setRemoteDescription(next.answer);
          } catch {
            setState("failed", "The live recording could not complete the tunnel.");
          }
        },
        (error) => setState("failed", error?.message),
      );
      return viewer;
    }

    function waitForVoiceChannel() {
      if (voiceChannel?.readyState === "open") return Promise.resolve(voiceChannel);
      if (!voiceChannel) {
        return Promise.reject(new Error("Join a live recording before sending a voice message."));
      }
      return new Promise((resolve, reject) => {
        const timer = globalScope.setTimeout(() => {
          reject(new Error("The voice channel is not open yet."));
        }, 8_000);
        timer?.unref?.();
        voiceChannel.onopen = () => {
          globalScope.clearTimeout(timer);
          resolve(voiceChannel);
        };
      });
    }

    async function sendVoiceMessage(blob, extra = {}) {
      if (closed || !voiceChannel) {
        throw new Error("Join a live recording before sending a voice message.");
      }
      const channel = await waitForVoiceChannel();
      const payload = await encodeVoiceMessage(blob, extra);
      channel.send(JSON.stringify(payload));
      return payload;
    }

    async function disconnect() {
      closed = true;
      unsubscribeViewer?.();
      unsubscribeIce?.();
      unsubscribeViewer = null;
      unsubscribeIce = null;
      seenIce.clear();
      const leaving = viewer;
      const leavingTunnel = tunnel;
      viewer = null;
      tunnel = null;
      try {
        voiceChannel?.close?.();
      } catch {
        /* Closed is the goal. */
      }
      voiceChannel = null;
      try {
        pc?.close();
      } catch {
        /* Closed is the goal. */
      }
      pc = null;
      onStream(null);
      if (leaving?.id && leavingTunnel?.id && cloud?.leaveTunnelViewer) {
        try {
          await cloud.leaveTunnelViewer(leavingTunnel.id, leaving.id);
        } catch {
          /* Leaving is best-effort; the publisher treats a stale viewer as gone. */
        }
      }
      setState("idle");
    }

    return Object.freeze({
      connect,
      disconnect,
      sendVoiceMessage,
      getTunnel: () => tunnel,
    });
  }

  const api = Object.freeze({
    HEARTBEAT_MS,
    STALE_MS,
    MAX_VOICE_MS,
    MAX_VOICE_BYTES,
    VOICE_CHANNEL,
    VOICE_MESSAGE_TYPE,
    ICE_SERVERS,
    isLiveTunnel,
    liveTunnels,
    chooseVoiceMimeType,
    encodeVoiceMessage,
    decodeVoiceMessage,
    voiceMessageToBlob,
    createVoiceRecorder,
    createPublisher,
    createViewer,
  });

  globalScope.StampNoteLiveTunnel = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
