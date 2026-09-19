const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const liveTunnel = require("../src/services/live-tunnel.js");
const robotControlUrl = require("../src/services/robot-control-url.js");

const root = resolve(__dirname, "..");
const html = readFileSync(resolve(root, "live-tunnel.html"), "utf8");
const css = readFileSync(resolve(root, "live-tunnel.css"), "utf8");
const source = readFileSync(resolve(root, "live-tunnel.js"), "utf8");
const server = readFileSync(resolve(root, "server.js"), "utf8");

test("a tunnel is live only while its heartbeat is fresh", () => {
  const now = Date.parse("2026-08-19T10:00:00.000Z");
  assert.equal(
    liveTunnel.isLiveTunnel({ status: "live", lastSeenAtMs: now - 1_000 }, now),
    true,
  );
  assert.equal(
    liveTunnel.isLiveTunnel({ status: "live", lastSeenAtMs: now - liveTunnel.STALE_MS }, now),
    false,
  );
  assert.equal(
    liveTunnel.isLiveTunnel({ status: "ended", lastSeenAtMs: now }, now),
    false,
  );
  assert.deepEqual(
    liveTunnel.liveTunnels(
      [
        { id: "old", status: "live", lastSeenAtMs: now - 1_000 },
        { id: "fresh", status: "live", lastSeenAtMs: now },
        { id: "dead", status: "ended", lastSeenAtMs: now },
      ],
      now,
    ).map((entry) => entry.id),
    ["fresh", "old"],
  );
});

function createMemoryCloud() {
  const viewersByTunnel = new Map();
  const iceByViewer = new Map();
  const viewerListListeners = [];
  const viewerDocListeners = [];
  const iceListeners = [];
  const pictureListeners = [];
  const voiceListeners = [];
  const pictures = new Map();
  const voices = [];

  function viewerKey(tunnelId, viewerId) {
    return `${tunnelId}/${viewerId}`;
  }

  function emitViewers(tunnelId) {
    const records = [...(viewersByTunnel.get(tunnelId)?.values() || [])];
    viewerListListeners
      .filter((listener) => listener.tunnelId === tunnelId)
      .forEach((listener) => listener.onChange(records));
  }

  return {
    published: [],
    ended: [],
    async publishLiveTunnel(session) {
      const record = {
        id: session.tunnelId || "live-1",
        ownerId: "owner-1",
        status: "live",
        lastSeenAtMs: session.startedAtMs || Date.now(),
        ...session,
      };
      this.published.push(record);
      return record;
    },
    async heartbeatLiveTunnel() {},
    async endLiveTunnel(id) {
      this.ended.push(id);
    },
    subscribeTunnelViewers(tunnelId, onChange) {
      const listener = { tunnelId, onChange };
      viewerListListeners.push(listener);
      onChange([...(viewersByTunnel.get(tunnelId)?.values() || [])]);
      return () => {
        const index = viewerListListeners.indexOf(listener);
        if (index >= 0) viewerListListeners.splice(index, 1);
      };
    },
    subscribeTunnelViewer(tunnelId, viewerId, onChange) {
      const listener = { tunnelId, viewerId, onChange };
      viewerDocListeners.push(listener);
      const record = viewersByTunnel.get(tunnelId)?.get(viewerId) || null;
      onChange(record);
      return () => {
        const index = viewerDocListeners.indexOf(listener);
        if (index >= 0) viewerDocListeners.splice(index, 1);
      };
    },
    subscribeTunnelIce(tunnelId, viewerId, onChange) {
      const listener = { key: viewerKey(tunnelId, viewerId), onChange };
      iceListeners.push(listener);
      onChange([...(iceByViewer.get(listener.key) || [])]);
      return () => {
        const index = iceListeners.indexOf(listener);
        if (index >= 0) iceListeners.splice(index, 1);
      };
    },
    async createTunnelViewer(tunnelId, input) {
      const record = {
        id: input.viewerId || "view-1",
        tunnelId,
        publisherUid: input.publisherUid,
        viewerUid: "admin-1",
        offer: input.offer,
        status: "joining",
      };
      if (!viewersByTunnel.has(tunnelId)) viewersByTunnel.set(tunnelId, new Map());
      viewersByTunnel.get(tunnelId).set(record.id, record);
      emitViewers(tunnelId);
      return record;
    },
    async setTunnelViewerAnswer(tunnelId, viewerId, answer) {
      const record = viewersByTunnel.get(tunnelId).get(viewerId);
      record.answer = answer;
      record.status = "connected";
      viewerDocListeners
        .filter((listener) => listener.tunnelId === tunnelId && listener.viewerId === viewerId)
        .forEach((listener) => listener.onChange(record));
    },
    async addTunnelIce(tunnelId, viewerId, input) {
      const key = viewerKey(tunnelId, viewerId);
      const record = { id: input.iceId || `ice-${Date.now()}`, ...input, candidate: input.candidate?.candidate || input.candidate };
      if (!iceByViewer.has(key)) iceByViewer.set(key, []);
      iceByViewer.get(key).push(record);
      iceListeners.filter((listener) => listener.key === key).forEach((listener) => listener.onChange(iceByViewer.get(key)));
    },
    async leaveTunnelViewer(tunnelId, viewerId) {
      viewersByTunnel.get(tunnelId)?.delete(viewerId);
      emitViewers(tunnelId);
    },
    async publishLiveTunnelPicture(tunnelId, input) {
      const record = { id: "picture", tunnelId, ...input };
      pictures.set(tunnelId, record);
      pictureListeners
        .filter((listener) => listener.tunnelId === tunnelId)
        .forEach((listener) => listener.onChange(record));
      return record;
    },
    subscribeTunnelPicture(tunnelId, onChange) {
      const listener = { tunnelId, onChange };
      pictureListeners.push(listener);
      onChange(pictures.get(tunnelId) || null);
      return () => {
        const index = pictureListeners.indexOf(listener);
        if (index >= 0) pictureListeners.splice(index, 1);
      };
    },
    async sendTunnelVoice(tunnelId, input) {
      const record = {
        id: input.voiceId || `voice-${voices.length + 1}`,
        tunnelId,
        ...input,
      };
      voices.push(record);
      voiceListeners
        .filter((listener) => listener.tunnelId === tunnelId)
        .forEach((listener) => listener.onChange([...voices]));
      return record;
    },
    subscribeTunnelVoices(tunnelId, onChange) {
      const listener = { tunnelId, onChange };
      voiceListeners.push(listener);
      onChange([...voices]);
      return () => {
        const index = voiceListeners.indexOf(listener);
        if (index >= 0) voiceListeners.splice(index, 1);
      };
    },
  };
}

class FakeDataChannel {
  constructor(label) {
    this.label = label;
    this.readyState = "open";
    this.sent = [];
    this.onmessage = null;
    this.onopen = null;
    this.peer = null;
  }

  send(data) {
    this.sent.push(data);
    this.peer?.onmessage?.({ data });
  }

  close() {
    this.readyState = "closed";
  }
}

let pendingVoiceRemote = null;

class FakePeerConnection {
  constructor(config) {
    this.config = config;
    this.localDescription = null;
    this.remoteDescription = null;
    this.connectionState = "new";
    this.senders = [];
    this.transceivers = [];
    this.ice = [];
    this.onicecandidate = null;
    this.ontrack = null;
    this.onconnectionstatechange = null;
    this.ondatachannel = null;
    if (pendingVoiceRemote) {
      const remote = pendingVoiceRemote;
      pendingVoiceRemote = null;
      queueMicrotask(() => this.ondatachannel?.({ channel: remote }));
    }
  }

  addTrack(track, stream) {
    const sender = {
      track,
      async replaceTrack(next) {
        this.track = next;
      },
    };
    this.senders.push(sender);
    return sender;
  }

  getSenders() {
    return this.senders;
  }

  addTransceiver(kind, init) {
    this.transceivers.push({ kind, init });
    return { kind, init };
  }

  async createOffer() {
    return { type: "offer", sdp: "offer-sdp" };
  }

  async createAnswer() {
    return { type: "answer", sdp: `answer-for-${this.remoteDescription?.sdp || "none"}` };
  }

  async setLocalDescription(description) {
    this.localDescription = description;
  }

  async setRemoteDescription(description) {
    this.remoteDescription = description;
    if (description?.type === "answer") {
      this.connectionState = "connected";
      this.onconnectionstatechange?.();
    }
  }

  createDataChannel(label) {
    const local = new FakeDataChannel(label);
    const remote = new FakeDataChannel(label);
    local.peer = remote;
    remote.peer = local;
    pendingVoiceRemote = remote;
    this.voiceChannel = local;
    return local;
  }

  async addIceCandidate(candidate) {
    this.ice.push(candidate);
  }

  close() {
    this.connectionState = "closed";
  }
}

async function settle(turns = 6) {
  for (let index = 0; index < turns; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("the publisher answers every viewer automatically, with no call prompt", async () => {
  pendingVoiceRemote = null;
  const cloud = createMemoryCloud();
  const stream = { getTracks: () => [{ kind: "video", id: "cam" }], getVideoTracks: () => [{ kind: "video", id: "cam" }], getAudioTracks: () => [] };
  const peers = [];
  const publisher = liveTunnel.createPublisher({
    cloud,
    getStream: () => stream,
    RTCPeerConnection: class RecordingPeer extends FakePeerConnection {
      constructor(config) {
        super(config);
        peers.push(this);
      }
    },
  });

  const tunnel = await publisher.publish({
    tunnelId: "live-1",
    location: "10 Marina Bay",
    sessionLabel: "Morning",
  });
  assert.equal(tunnel.id, "live-1");
  assert.equal(cloud.published.length, 1);

  const viewer = liveTunnel.createViewer({
    cloud,
    RTCPeerConnection: class AdminPeer extends FakePeerConnection {
      constructor(config) {
        super(config);
        peers.push(this);
      }
    },
  });
  await viewer.connect({ id: "live-1", ownerId: "owner-1", location: "10 Marina Bay" });
  await settle();

  const answered = peers.find((peer) => peer.localDescription?.type === "answer");
  const offered = peers.find((peer) => peer.localDescription?.type === "offer");
  assert.ok(offered, "the admin creates an offer");
  assert.ok(answered, "the recording answers without a user gesture");
  assert.equal(answered.remoteDescription.sdp, "offer-sdp");
  assert.equal(offered.remoteDescription.sdp, "answer-for-offer-sdp");
  assert.equal(answered.senders[0].track.id, "cam");
  assert.deepEqual(offered.transceivers[0], { kind: "video", init: { direction: "recvonly" } });

  await publisher.close();
  assert.deepEqual(cloud.ended, ["live-1"]);
  assert.equal(answered.connectionState, "closed");
});

test("a voice message is encoded, sent on the open tunnel, and played without an accept step", async () => {
  pendingVoiceRemote = null;
  const received = [];
  const cloud = createMemoryCloud();
  const stream = { getTracks: () => [{ kind: "video", id: "cam" }], getVideoTracks: () => [{ kind: "video", id: "cam" }], getAudioTracks: () => [] };
  const publisher = liveTunnel.createPublisher({
    cloud,
    getStream: () => stream,
    RTCPeerConnection: FakePeerConnection,
    onVoiceMessage(message) {
      received.push(message);
    },
  });
  await publisher.publish({ tunnelId: "live-1", location: "10 Marina Bay" });

  const viewer = liveTunnel.createViewer({
    cloud,
    RTCPeerConnection: FakePeerConnection,
  });
  await viewer.connect({ id: "live-1", ownerId: "owner-1" });
  await settle();

  const blob = new Blob([Uint8Array.of(7, 8, 9)], { type: "audio/webm" });
  const encoded = await liveTunnel.encodeVoiceMessage(blob, { durationMs: 1200 });
  assert.equal(encoded.type, liveTunnel.VOICE_MESSAGE_TYPE);
  assert.equal(liveTunnel.decodeVoiceMessage(JSON.stringify(encoded)).durationMs, 1200);
  assert.equal(liveTunnel.voiceMessageToBlob(encoded).size, 3);

  await viewer.sendVoiceMessage(blob, { durationMs: 1200 });
  await settle();
  assert.equal(received.length, 1);
  assert.equal(received[0].type, "voice-message");
  assert.equal(received[0].durationMs, 1200);
});

test("ICE candidates that arrive before the answer are applied once the tunnel completes", async () => {
  pendingVoiceRemote = null;
  const cloud = createMemoryCloud();
  const peers = [];
  class StrictIcePeer extends FakePeerConnection {
    constructor(config) {
      super(config);
      peers.push(this);
    }

    async addIceCandidate(candidate) {
      if (!this.remoteDescription) {
        throw new Error("Remote description is required.");
      }
      this.ice.push(candidate);
    }
  }

  const viewer = liveTunnel.createViewer({
    cloud,
    RTCPeerConnection: StrictIcePeer,
  });
  await viewer.connect({ id: "live-1", ownerId: "owner-1" });
  await cloud.addTunnelIce("live-1", "view-1", {
    iceId: "ice-early",
    from: "publisher",
    candidate: { candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0 },
  });
  await settle();
  assert.equal(peers[0].ice.length, 0, "candidates must wait for the answer");

  await cloud.setTunnelViewerAnswer("live-1", "view-1", {
    type: "answer",
    sdp: "answer-sdp",
  });
  await settle();
  assert.equal(peers[0].ice.length, 1);
  assert.equal(peers[0].ice[0].candidate, "candidate:1");
});

test("a Firestore picture keeps the tunnel live when this network cannot complete WebRTC", async () => {
  pendingVoiceRemote = null;
  const cloud = createMemoryCloud();
  const states = [];
  const pictures = [];
  const stream = {
    getTracks: () => [{ kind: "video", id: "cam" }],
    getVideoTracks: () => [{ kind: "video", id: "cam" }],
    getAudioTracks: () => [],
  };
  const publisher = liveTunnel.createPublisher({
    cloud,
    getStream: () => stream,
    RTCPeerConnection: FakePeerConnection,
    pictureMs: 20,
    async capturePicture() {
      return { mimeType: "image/jpeg", image: "qqq", capturedAtMs: 1 };
    },
  });
  await publisher.publish({ tunnelId: "live-1", location: "10 Marina Bay" });
  await settle();

  const viewer = liveTunnel.createViewer({
    cloud,
    networkFailMs: 20,
    RTCPeerConnection: class FailingPeer extends FakePeerConnection {
      async setRemoteDescription(description) {
        this.remoteDescription = description;
        this.connectionState = "failed";
        this.onconnectionstatechange?.();
      }
    },
    onPicture(record) {
      pictures.push(record);
    },
    onState(state) {
      states.push(state);
    },
  });
  await viewer.connect({ id: "live-1", ownerId: "owner-1" });
  await settle();

  assert.ok(pictures.some((entry) => entry.image === "qqq"));
  assert.equal(states.at(-1), "live");
  assert.equal(states.includes("failed"), false);
  await publisher.close();
});

test("a dropped camera call keeps the stills instead of going black", async () => {
  pendingVoiceRemote = null;
  const cloud = createMemoryCloud();
  const states = [];
  const stream = {
    getTracks: () => [{ kind: "video", id: "cam" }],
    getVideoTracks: () => [{ kind: "video", id: "cam" }],
    getAudioTracks: () => [],
  };
  const publisher = liveTunnel.createPublisher({
    cloud,
    getStream: () => stream,
    RTCPeerConnection: FakePeerConnection,
    pictureMs: 20,
    async capturePicture() {
      return { mimeType: "image/jpeg", image: "qqq", capturedAtMs: 1 };
    },
  });
  await publisher.publish({ tunnelId: "live-1", location: "10 Marina Bay" });
  await settle();

  const viewer = liveTunnel.createViewer({
    cloud,
    networkFailMs: 20,
    RTCPeerConnection: class FlakyPeer extends FakePeerConnection {
      async setRemoteDescription(description) {
        this.remoteDescription = description;
        this.connectionState = "connected";
        this.onconnectionstatechange?.();
        queueMicrotask(() => {
          this.connectionState = "disconnected";
          this.onconnectionstatechange?.();
        });
      }
    },
    onState(state) {
      states.push(state);
    },
  });
  await viewer.connect({ id: "live-1", ownerId: "owner-1" });
  await settle();

  assert.equal(states.at(-1), "live");
  assert.equal(states.includes("failed"), false);
  await publisher.close();
});

test("a voice message still reaches the recording when the WebRTC channel never opens", async () => {
  pendingVoiceRemote = null;
  const received = [];
  const cloud = createMemoryCloud();
  const stream = {
    getTracks: () => [{ kind: "video", id: "cam" }],
    getVideoTracks: () => [{ kind: "video", id: "cam" }],
    getAudioTracks: () => [],
  };
  const publisher = liveTunnel.createPublisher({
    cloud,
    getStream: () => stream,
    RTCPeerConnection: FakePeerConnection,
    onVoiceMessage(message) {
      received.push(message);
    },
  });
  await publisher.publish({ tunnelId: "live-1", location: "10 Marina Bay" });

  const viewer = liveTunnel.createViewer({
    cloud,
    voiceChannelMs: 10,
    RTCPeerConnection: class SilentVoicePeer extends FakePeerConnection {
      createDataChannel(label) {
        const local = new FakeDataChannel(label);
        local.readyState = "connecting";
        this.voiceChannel = local;
        return local;
      }
    },
  });
  await viewer.connect({ id: "live-1", ownerId: "owner-1" });
  await settle();

  const blob = new Blob([Uint8Array.of(7, 8, 9)], { type: "audio/webm" });
  await viewer.sendVoiceMessage(blob, { durationMs: 900 });
  await settle();
  assert.equal(received.length, 1);
  assert.equal(received[0].type, "voice-message");
  assert.equal(received[0].durationMs, 900);
});

test("a picture payload becomes a data URL the stage can show", () => {
  assert.equal(
    liveTunnel.pictureToDataUrl({ mimeType: "image/jpeg", image: "abc" }),
    "data:image/jpeg;base64,abc",
  );
  assert.equal(liveTunnel.picturePayload({ image: "" }), null);
});

test("live stills are taken from the recording preview, not a second camera element", async () => {
  const created = [];
  const encoded = await liveTunnel.encodeLivePicture(
    { getVideoTracks: () => [{ id: "cam" }] },
    {
      getPreview: () => ({ videoWidth: 800, videoHeight: 400 }),
      document: {
        createElement(name) {
          created.push(name);
          return {
            width: 0,
            height: 0,
            getContext() {
              return { drawImage() {} };
            },
            toBlob(callback) {
              callback(new Blob([Uint8Array.of(1, 2, 3)], { type: "image/jpeg" }));
            },
          };
        },
      },
    },
  );
  assert.equal(created.includes("video"), false);
  assert.equal(encoded.mimeType, "image/jpeg");
  assert.ok(encoded.image);
});

test("an empty or oversized voice message is refused", async () => {
  await assert.rejects(liveTunnel.encodeVoiceMessage(new Blob([])), /empty/i);
  const huge = new Blob([new Uint8Array(liveTunnel.MAX_VOICE_BYTES + 1)]);
  await assert.rejects(liveTunnel.encodeVoiceMessage(huge), /too long/i);
  assert.equal(liveTunnel.decodeVoiceMessage("not-json"), null);
});

test("an ended or stale recording does not stay on the live list", () => {
  const now = Date.parse("2026-08-19T10:00:00.000Z");
  const live = {
    id: "live",
    status: "live",
    lastSeenAtMs: now,
    location: "10 Marina Bay",
  };
  const stale = {
    id: "stale",
    status: "live",
    lastSeenAtMs: now - liveTunnel.STALE_MS - 1,
    location: "Airport",
  };
  const ended = {
    id: "ended",
    status: "ended",
    lastSeenAtMs: now,
    location: "10 Marina Bay",
  };
  assert.deepEqual(
    liveTunnel.liveTunnels([ended, stale, live], now).map((entry) => entry.id),
    ["live"],
  );
});

test("the page is a dedicated admin surface with no accept or reject controls", () => {
  assert.match(html, /<html lang="en" data-surface="live-tunnel">/);
  assert.match(html, /id="live-tunnel-workspace"/);
  assert.match(html, /id="live-tunnel-sign-in"/);
  assert.match(html, /Continue with Google/);
  assert.match(html, /id="live-tunnel-list"/);
  assert.match(html, /id="live-tunnel-video"/);
  assert.match(html, /id="live-tunnel-picture"/);
  assert.match(html, /without anyone accepting a call/);
  assert.match(html, /id="live-tunnel-voice-record"/);
  assert.match(html, /Voice message/);
  assert.match(html, /id="live-tunnel-robot"/);
  assert.match(html, /id="live-tunnel-robot-frame"/);
  assert.match(html, /id="live-tunnel-menu"/);
  assert.match(html, /id="live-tunnel-split"/);
  assert.match(html, /id="live-tunnel-robot-ip-form"/);
  assert.match(html, /sandbox="allow-scripts allow-forms allow-same-origin"/);
  assert.match(html, /src\/services\/robot-control-url\.js/);
  assert.match(css, /\.live-tunnel-robot-ip\s*\{/);
  assert.match(css, /\.live-tunnel-split\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*minmax\(0,\s*1fr\)/);
  assert.match(css, /\.live-tunnel-menu\s*\{/);
  assert.doesNotMatch(html, /accept call|reject call|incoming call/i);
  assert.match(html, /<header[^>]*data-sidebar-mount/);
  assert.match(html, /<script src="sidebar\.js" defer><\/script>/);
  assert.match(html, /src\/services\/live-tunnel\.js/);
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(server, /"live-tunnel\.html",\s*\n\s*"live-tunnel\.css",\s*\n\s*"live-tunnel\.js",/);
});

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = String(tagName).toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.className = "";
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.id = "";
    this.type = "";
    this.textContent = "";
    this.srcObject = null;
    this.listeners = new Map();
    this.parentElement = null;
    this.src = "";
    this.value = "";
    this.placeholder = "";
    this.videoWidth = 0;
    this.videoHeight = 0;
  }

  querySelector(selector) {
    const match = (el) => {
      if (selector.startsWith(".")) {
        return String(el.className || "")
          .split(/\s+/)
          .includes(selector.slice(1));
      }
      if (selector.startsWith("#")) return el.id === selector.slice(1);
      return el.tagName === String(selector).toUpperCase();
    };
    for (const child of this.children) {
      if (match(child)) return child;
      const nested = child.querySelector?.(selector);
      if (nested) return nested;
    }
    return null;
  }

  append(...children) {
    children.forEach((child) => {
      this.children.push(child);
      child.parentElement = this;
    });
  }

  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }

  addEventListener(name, callback) {
    const list = this.listeners.get(name) || [];
    list.push(callback);
    this.listeners.set(name, list);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === "src") this.src = "";
  }

  async dispatch(name, event = {}) {
    const list = this.listeners.get(name) || [];
    for (const callback of list) {
      await callback({ preventDefault() {}, target: this, ...event });
    }
  }

  play() {
    return Promise.resolve();
  }
}

function createPageHarness(options = {}) {
  pendingVoiceRemote = null;
  const ids = [
    "live-tunnel-sign-in",
    "live-tunnel-sign-out",
    "live-tunnel-auth-gate",
    "live-tunnel-account",
    "live-tunnel-workspace",
    "live-tunnel-status",
    "live-tunnel-menu",
    "live-tunnel-menu-count",
    "live-tunnel-rail",
    "live-tunnel-rail-scrim",
    "live-tunnel-list",
    "live-tunnel-empty",
    "live-tunnel-count",
    "live-tunnel-split",
    "live-tunnel-robot-ip-form",
    "live-tunnel-robot-ip",
    "live-tunnel-robot-ip-open",
    "live-tunnel-robot-close",
    "live-tunnel-video",
    "live-tunnel-picture",
    "live-tunnel-frame",
    "live-tunnel-placeholder",
    "live-tunnel-caption",
    "live-tunnel-robot",
    "live-tunnel-robot-host",
    "live-tunnel-robot-frame",
    "live-tunnel-badge",
    "live-tunnel-leave",
    "live-tunnel-voice",
    "live-tunnel-voice-record",
    "live-tunnel-voice-cancel",
    "live-tunnel-voice-status",
    "theme-toggle",
    "theme-toggle-icon",
    "theme-toggle-label",
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  elements["live-tunnel-workspace"].hidden = true;
  elements["live-tunnel-sign-out"].hidden = true;
  elements["live-tunnel-badge"].hidden = true;
  elements["live-tunnel-leave"].hidden = true;
  elements["live-tunnel-voice"].hidden = true;
  elements["live-tunnel-voice-cancel"].hidden = true;
  elements["live-tunnel-voice-record"].textContent = "Voice message";
  elements["live-tunnel-empty"].hidden = false;
  elements["live-tunnel-menu"].hidden = true;
  elements["live-tunnel-menu-count"].hidden = true;
  elements["live-tunnel-rail"].dataset.open = "false";
  elements["live-tunnel-rail-scrim"].hidden = true;
  elements["live-tunnel-robot"].dataset.open = "false";
  elements["live-tunnel-robot-close"].hidden = true;
  elements["live-tunnel-robot-ip"].placeholder = "Robot IP address";

  const storage = new Map(
    options.storedRobotIps
      ? [["stampnote-live-tunnel-robot-ip", JSON.stringify(options.storedRobotIps)]]
      : [],
  );
  const cloudCalls = { signIn: 0, joined: [], left: [] };
  let authCallback;
  let tunnelsCallback;
  const liveRecords = options.tunnels || [
    {
      id: "live-1",
      ownerId: "owner-1",
      ownerEmail: "field@example.com",
      location: "10 Marina Bay",
      sessionLabel: "Morning",
      status: "live",
      lastSeenAtMs: Date.now(),
      startedAtMs: Date.now() - 60_000,
    },
  ];

  const cloud = {
    async signIn() {
      cloudCalls.signIn += 1;
    },
    async signOut() {},
    subscribeAuth(callback) {
      authCallback = callback;
      return () => {};
    },
    subscribeLiveTunnels(onChange) {
      tunnelsCallback = onChange;
      queueMicrotask(() => onChange(liveRecords));
      return () => {};
    },
    async createTunnelViewer(tunnelId, input) {
      cloudCalls.joined.push({ tunnelId, input });
      if (options.delayJoinMs) {
        await new Promise((resolve) => setTimeout(resolve, options.delayJoinMs));
      }
      return { id: `view-${cloudCalls.joined.length}`, tunnelId, ...input };
    },
    subscribeTunnelViewer(tunnelId, viewerId, onChange) {
      queueMicrotask(() =>
        onChange({
          id: viewerId,
          answer: { type: "answer", sdp: "answer-sdp" },
        }),
      );
      return () => {};
    },
    subscribeTunnelIce() {
      return () => {};
    },
    addTunnelIce() {},
    async leaveTunnelViewer(tunnelId, viewerId) {
      cloudCalls.left.push({ tunnelId, viewerId });
      if (options.delayLeaveMs) {
        await new Promise((resolve) => setTimeout(resolve, options.delayLeaveMs));
      }
    },
    subscribeTunnelPicture(tunnelId, onChange) {
      queueMicrotask(() => onChange(options.picture || null));
      return () => {};
    },
    async sendTunnelVoice(tunnelId, input) {
      cloudCalls.voices = cloudCalls.voices || [];
      cloudCalls.voices.push({ tunnelId, input });
      return { id: "voice-1", tunnelId, ...input };
    },
  };

  const document = {
    documentElement: { dataset: {} },
    createElement(tagName) {
      return new FakeElement(tagName);
    },
    querySelector(selector) {
      return elements[selector.replace(/^#/, "")] || null;
    },
    addEventListener() {},
  };

  const mediaRecorders = [];
  class FakeMediaRecorder {
    constructor(stream, recorderOptions = {}) {
      this.stream = stream;
      this.mimeType = recorderOptions.mimeType || "audio/webm";
      this.state = "inactive";
      this.ondataavailable = null;
      this.onstop = null;
      mediaRecorders.push(this);
    }

    start() {
      this.state = "recording";
    }

    stop() {
      this.state = "inactive";
      this.ondataavailable?.({
        data: new Blob([Uint8Array.of(3, 2, 1)], { type: this.mimeType }),
      });
      this.onstop?.();
    }

    static isTypeSupported() {
      return true;
    }
  }

  const context = {
    Blob,
    console,
    document,
    location: { search: options.search || "" },
    URL: globalThis.URL,
    isSecureContext: false,
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
    },
    matchMedia() {
      return { matches: false };
    },
    MediaRecorder: FakeMediaRecorder,
    navigator: {
      mediaDevices: {
        async getUserMedia() {
          return {
            getTracks() {
              return [{ stop() {} }];
            },
          };
        },
      },
    },
    RTCPeerConnection: options.PeerConnection || FakePeerConnection,
    StampNoteFirebase: cloud,
    StampNoteLiveTunnel: liveTunnel,
    StampNoteRobotControlUrl: robotControlUrl,
    StampNoteObservability: {
      configure() {},
      event() { return true; },
      safeErrorCode(error, fallback) {
        return String(error?.code || fallback || "unknown_error");
      },
    },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: resolve(root, "live-tunnel.js") });

  return {
    async auth(user, error = null) {
      return authCallback?.(user, error);
    },
    emitTunnels(records) {
      return tunnelsCallback?.(records);
    },
    cloudCalls,
    elements,
    storedRobotIps() {
      try {
        return JSON.parse(storage.get("stampnote-live-tunnel-robot-ip") || "{}");
      } catch {
        return {};
      }
    },
  };
}

function sessionJoin(harness, index = 0) {
  return harness.elements["live-tunnel-list"].children[index].querySelector(".live-tunnel-join");
}

function sessionRobotForm(harness, index = 0) {
  return harness.elements["live-tunnel-list"].children[index].querySelector(".live-tunnel-robot-ip");
}

function sessionRobotInput(harness, index = 0) {
  return sessionRobotForm(harness, index).querySelector(".live-tunnel-robot-ip-input");
}

test("signing in lists live recordings and tunnels in without an accept step", async () => {
  const harness = createPageHarness();
  assert.equal(harness.elements["live-tunnel-auth-gate"].hidden, false);
  assert.equal(harness.elements["live-tunnel-workspace"].hidden, true);

  await harness.auth({ email: "yanguangchensp@gmail.com", uid: "admin-1" });
  await settle();

  assert.equal(harness.elements["live-tunnel-auth-gate"].hidden, true);
  assert.equal(harness.elements["live-tunnel-workspace"].hidden, false);
  assert.equal(harness.elements["live-tunnel-menu"].hidden, false);
  assert.equal(harness.elements["live-tunnel-list"].children.length, 1);
  assert.equal(harness.elements["live-tunnel-empty"].hidden, true);
  assert.match(harness.elements["live-tunnel-count"].textContent, /1 live/);
  assert.equal(harness.elements["live-tunnel-menu-count"].hidden, false);
  assert.equal(harness.elements["live-tunnel-menu-count"].textContent, "1");
  assert.equal(harness.elements["live-tunnel-rail"].dataset.open, "false");

  assert.equal(sessionRobotInput(harness).placeholder, "Robot IP address");
  assert.equal(harness.elements["live-tunnel-robot-ip"].placeholder, "Robot IP address");
  assert.equal(harness.cloudCalls.joined.length, 1);
  assert.equal(harness.cloudCalls.joined[0].tunnelId, "live-1");
  assert.equal(harness.elements["live-tunnel-leave"].hidden, false);

  await sessionJoin(harness).dispatch("click");
  await settle();

  assert.equal(harness.cloudCalls.joined.length, 1);
  assert.equal(harness.cloudCalls.joined[0].tunnelId, "live-1");
  assert.equal(harness.cloudCalls.joined[0].input.offer.type, "offer");
  assert.equal(harness.elements["live-tunnel-leave"].hidden, false);
  assert.match(harness.elements["live-tunnel-caption"].textContent, /10 Marina Bay/);
});

test("the page shows a live picture when this network cannot open the camera call", async () => {
  const harness = createPageHarness({
    picture: { mimeType: "image/jpeg", image: "abc123", capturedAtMs: 1 },
    PeerConnection: class FailingPeer extends FakePeerConnection {
      async setRemoteDescription(description) {
        this.remoteDescription = description;
        this.connectionState = "failed";
        this.onconnectionstatechange?.();
      }
    },
  });
  await harness.auth({ email: "yanguangchensp@gmail.com", uid: "admin-1" });
  await settle();
  await sessionJoin(harness).dispatch("click");
  await settle();

  assert.match(harness.elements["live-tunnel-picture"].src, /data:image\/jpeg;base64,abc123/);
  assert.equal(harness.elements["live-tunnel-frame"].dataset.live, "true");
  assert.equal(harness.elements["live-tunnel-frame"].dataset.mode, "relay");
  assert.equal(harness.elements["live-tunnel-status"].dataset.state, "idle");
  assert.doesNotMatch(
    harness.elements["live-tunnel-status"].textContent,
    /could not open a live picture/i,
  );
});

test("a black camera call keeps the stills instead of covering them", async () => {
  const harness = createPageHarness({
    picture: { mimeType: "image/jpeg", image: "abc123", capturedAtMs: 1 },
    PeerConnection: class ConnectedBlackPeer extends FakePeerConnection {
      async setRemoteDescription(description) {
        this.remoteDescription = description;
        this.connectionState = "connected";
        this.onconnectionstatechange?.();
        this.ontrack?.({
          streams: [{ id: "remote" }],
          track: { kind: "video", readyState: "live", muted: true },
        });
      }
    },
  });
  await harness.auth({ email: "yanguangchensp@gmail.com", uid: "admin-1" });
  await settle();
  await sessionJoin(harness).dispatch("click");
  await settle();

  assert.match(harness.elements["live-tunnel-picture"].src, /data:image\/jpeg;base64,abc123/);
  assert.equal(harness.elements["live-tunnel-frame"].dataset.live, "true");
  assert.equal(harness.elements["live-tunnel-frame"].dataset.mode, "relay");
  assert.ok(harness.elements["live-tunnel-video"].srcObject);

  harness.elements["live-tunnel-video"].videoWidth = 640;
  harness.elements["live-tunnel-video"].videoHeight = 360;
  await harness.elements["live-tunnel-video"].dispatch("playing");
  await settle();
  assert.equal(harness.elements["live-tunnel-frame"].dataset.mode, "webrtc");
  assert.match(harness.elements["live-tunnel-picture"].src, /data:image\/jpeg;base64,abc123/);

  harness.elements["live-tunnel-video"].videoWidth = 0;
  harness.elements["live-tunnel-video"].videoHeight = 0;
  await harness.elements["live-tunnel-video"].dispatch("waiting");
  await settle();
  assert.equal(harness.elements["live-tunnel-frame"].dataset.mode, "relay");
  assert.match(harness.elements["live-tunnel-picture"].src, /data:image\/jpeg;base64,abc123/);
});

test("a live tunnel can record and send a voice message without an accept step", async () => {
  const harness = createPageHarness();
  await harness.auth({ email: "yanguangchensp@gmail.com", uid: "admin-1" });
  await settle();
  await sessionJoin(harness).dispatch("click");
  await settle();

  assert.equal(harness.elements["live-tunnel-voice"].hidden, false);
  assert.equal(harness.elements["live-tunnel-voice-record"].textContent, "Voice message");

  await harness.elements["live-tunnel-voice-record"].dispatch("click");
  await settle();
  assert.equal(harness.elements["live-tunnel-voice-record"].getAttribute("aria-pressed"), "true");
  assert.match(harness.elements["live-tunnel-voice-status"].textContent, /Recording/);
  assert.equal(harness.elements["live-tunnel-voice-cancel"].hidden, false);

  await harness.elements["live-tunnel-voice-record"].dispatch("click");
  await settle();
  assert.equal(harness.elements["live-tunnel-voice-record"].getAttribute("aria-pressed"), "false");
  assert.match(harness.elements["live-tunnel-voice-status"].textContent, /Voice message sent/);
});

test("parseRobotControlUrl only accepts http(s) robot IP addresses", () => {
  const parse = robotControlUrl.parseRobotControlUrl;
  const ipv4 = parse("192.168.1.50");
  assert.equal(ipv4.ok, true);
  assert.equal(ipv4.href, "http://192.168.1.50/");
  assert.equal(ipv4.host, "192.168.1.50");
  assert.equal(parse("10.0.0.8:8080/control").ok, true);
  assert.equal(parse("[::1]").ok, true);
  assert.equal(parse("").ok, false);
  assert.equal(parse("robot.local").ok, false);
  assert.equal(parse("javascript:alert(1)").ok, false);
  assert.equal(parse("http://user:pass@192.168.1.50/").ok, false);
  assert.equal(parse("https://example.com").ok, false);
});

test("every live tunnel session has a robot IP field that opens an iframe", async () => {
  const harness = createPageHarness({
    tunnels: [
      {
        id: "live-1",
        ownerEmail: "field@example.com",
        location: "10 Marina Bay",
        sessionLabel: "Morning",
        status: "live",
        lastSeenAtMs: Date.now(),
        startedAtMs: Date.now() - 60_000,
      },
      {
        id: "live-2",
        ownerEmail: "field@example.com",
        location: "Airport",
        sessionLabel: "Afternoon",
        status: "live",
        lastSeenAtMs: Date.now(),
        startedAtMs: Date.now() - 120_000,
      },
    ],
  });
  await harness.auth({ email: "yanguangchensp@gmail.com", uid: "admin-1" });
  await settle();

  assert.equal(harness.elements["live-tunnel-list"].children.length, 2);
  assert.equal(sessionRobotInput(harness, 0).placeholder, "Robot IP address");
  assert.equal(sessionRobotInput(harness, 1).placeholder, "Robot IP address");
  assert.equal(harness.elements["live-tunnel-robot"].dataset.open, "false");

  sessionRobotInput(harness, 1).value = "192.168.1.50:8080";
  await sessionRobotForm(harness, 1).dispatch("submit");
  await settle();

  assert.equal(harness.elements["live-tunnel-robot"].dataset.open, "true");
  assert.equal(harness.elements["live-tunnel-robot-frame"].src, "http://192.168.1.50:8080/");
  assert.equal(harness.elements["live-tunnel-robot-host"].textContent, "192.168.1.50:8080");
  assert.equal(harness.storedRobotIps()["live-2"], "192.168.1.50:8080");
  assert.equal(sessionRobotForm(harness, 1).querySelector(".live-tunnel-robot-ip-open").hidden, true);
  assert.equal(sessionRobotForm(harness, 1).querySelector(".live-tunnel-robot-ip-close").hidden, false);
  assert.equal(sessionRobotForm(harness, 0).querySelector(".live-tunnel-robot-ip-open").hidden, false);
  assert.match(harness.elements["live-tunnel-status"].textContent, /Opened robot control/);

  await sessionRobotForm(harness, 1).querySelector(".live-tunnel-robot-ip-close").dispatch("click");
  await settle();
  assert.equal(harness.elements["live-tunnel-robot"].dataset.open, "false");
  assert.equal(harness.elements["live-tunnel-robot-frame"].src, "");
  assert.match(harness.elements["live-tunnel-status"].textContent, /Robot control closed/);
});

test("a stored robot IP fills that session field but does not open the iframe", async () => {
  const harness = createPageHarness({
    storedRobotIps: { "live-1": "10.0.0.9" },
  });
  await harness.auth({ email: "yanguangchensp@gmail.com", uid: "admin-1" });
  await settle();
  assert.equal(sessionRobotInput(harness).value, "10.0.0.9");
  assert.equal(harness.elements["live-tunnel-robot"].dataset.open, "false");
  assert.equal(harness.elements["live-tunnel-robot-frame"].src, "");
});

test("an invalid robot IP stays on the live tunnel without opening the iframe", async () => {
  const harness = createPageHarness();
  await harness.auth({ email: "yanguangchensp@gmail.com", uid: "admin-1" });
  await settle();
  sessionRobotInput(harness).value = "javascript:alert(1)";
  await sessionRobotForm(harness).dispatch("submit");
  await settle();
  assert.equal(harness.elements["live-tunnel-robot"].dataset.open, "false");
  assert.equal(harness.elements["live-tunnel-robot-frame"].src, "");
  assert.match(harness.elements["live-tunnel-status"].textContent, /http or https/i);
});

test("the live recordings menu hides as an icon and opens over the split", async () => {
  const harness = createPageHarness();
  await harness.auth({ email: "yanguangchensp@gmail.com", uid: "admin-1" });
  await settle();

  assert.equal(harness.elements["live-tunnel-menu"].hidden, false);
  assert.equal(harness.elements["live-tunnel-rail"].dataset.open, "false");
  assert.equal(harness.elements["live-tunnel-rail-scrim"].hidden, true);

  await harness.elements["live-tunnel-menu"].dispatch("click");
  assert.equal(harness.elements["live-tunnel-rail"].dataset.open, "true");
  assert.equal(harness.elements["live-tunnel-menu"].getAttribute("aria-expanded"), "true");
  assert.equal(harness.elements["live-tunnel-rail-scrim"].hidden, false);

  await sessionJoin(harness).dispatch("click");
  await settle();
  assert.equal(harness.elements["live-tunnel-rail"].dataset.open, "false");
  assert.equal(harness.cloudCalls.joined.length, 1);
});

test("signing in auto-joins a Robotic control session on the live tunnel", async () => {
  const harness = createPageHarness({
    tunnels: [
      {
        id: "field-1",
        ownerId: "owner-1",
        ownerEmail: "field@example.com",
        location: "10 Marina Bay",
        sessionLabel: "Morning",
        status: "live",
        lastSeenAtMs: Date.now(),
        startedAtMs: Date.now() - 60_000,
      },
      {
        id: "robot-1",
        ownerId: "owner-2",
        ownerEmail: "robot@example.com",
        location: "Robotic control",
        sessionLabel: "Robotic control",
        status: "live",
        lastSeenAtMs: Date.now(),
        startedAtMs: Date.now() - 10_000,
      },
    ],
  });
  await harness.auth({ email: "yanguangchensp@gmail.com", uid: "admin-1" });
  await settle();

  assert.equal(harness.cloudCalls.joined.length, 1);
  assert.equal(harness.cloudCalls.joined[0].tunnelId, "robot-1");
  assert.match(harness.elements["live-tunnel-caption"].textContent, /Robotic control/);
  assert.equal(harness.elements["live-tunnel-leave"].hidden, false);
});

test("Leave keeps the live tunnel idle until the operator picks a session", async () => {
  const harness = createPageHarness({
    tunnels: [
      {
        id: "robot-1",
        ownerId: "owner-2",
        ownerEmail: "robot@example.com",
        location: "Robotic control",
        sessionLabel: "Robotic control",
        status: "live",
        lastSeenAtMs: Date.now(),
        startedAtMs: Date.now() - 10_000,
      },
    ],
  });
  await harness.auth({ email: "yanguangchensp@gmail.com", uid: "admin-1" });
  await settle();
  assert.equal(harness.cloudCalls.joined.length, 1);

  await harness.elements["live-tunnel-leave"].dispatch("click");
  await settle();
  harness.emitTunnels([
    {
      id: "robot-1",
      ownerId: "owner-2",
      ownerEmail: "robot@example.com",
      location: "Robotic control",
      sessionLabel: "Robotic control",
      status: "live",
      lastSeenAtMs: Date.now(),
      startedAtMs: Date.now() - 10_000,
    },
  ]);
  await settle();
  assert.equal(harness.cloudCalls.joined.length, 1);
  assert.match(
    harness.elements["live-tunnel-placeholder"].textContent,
    /Choose a live recording/i,
  );
});

test("switching sessions waits for the in-flight join instead of racing it", async () => {
  const harness = createPageHarness({
    delayJoinMs: 25,
    tunnels: [
      {
        id: "field-1",
        ownerId: "owner-1",
        ownerEmail: "field@example.com",
        location: "10 Marina Bay",
        sessionLabel: "Morning",
        status: "live",
        lastSeenAtMs: Date.now(),
        startedAtMs: Date.now() - 60_000,
      },
      {
        id: "robot-1",
        ownerId: "owner-2",
        ownerEmail: "robot@example.com",
        location: "Robotic control",
        sessionLabel: "Robotic control",
        status: "live",
        lastSeenAtMs: Date.now(),
        startedAtMs: Date.now() - 10_000,
      },
    ],
  });
  await harness.auth({ email: "yanguangchensp@gmail.com", uid: "admin-1" });
  await settle();
  await sessionJoin(harness, 0).dispatch("click");
  await new Promise((resolve) => setTimeout(resolve, 80));
  await settle();

  assert.equal(harness.cloudCalls.joined.at(-1).tunnelId, "field-1");
  assert.match(harness.elements["live-tunnel-caption"].textContent, /10 Marina Bay/);
  assert.equal(sessionJoin(harness, 0).getAttribute("aria-pressed"), "true");
});

test("a replacement session stays up after the old viewer finishes leaving", async () => {
  const field = {
    id: "field-1",
    ownerId: "owner-1",
    ownerEmail: "field@example.com",
    location: "10 Marina Bay",
    sessionLabel: "Morning",
    status: "live",
    lastSeenAtMs: Date.now(),
    startedAtMs: Date.now() - 60_000,
  };
  const robot = {
    id: "robot-1",
    ownerId: "owner-2",
    ownerEmail: "robot@example.com",
    location: "Robotic control",
    sessionLabel: "Robotic control",
    status: "live",
    lastSeenAtMs: Date.now(),
    startedAtMs: Date.now() - 10_000,
  };
  const harness = createPageHarness({
    delayLeaveMs: 40,
    tunnels: [field, robot],
  });
  await harness.auth({ email: "yanguangchensp@gmail.com", uid: "admin-1" });
  await settle();
  assert.equal(harness.cloudCalls.joined[0].tunnelId, "robot-1");

  harness.emitTunnels([field]);
  await new Promise((resolve) => setTimeout(resolve, 90));
  await settle();

  assert.equal(harness.cloudCalls.joined.at(-1).tunnelId, "field-1");
  assert.match(harness.elements["live-tunnel-caption"].textContent, /10 Marina Bay/);
  assert.doesNotMatch(
    harness.elements["live-tunnel-placeholder"].textContent,
    /Choose a live recording/i,
  );
});

test("Leave deletes a viewer that finishes creating after disconnect", async () => {
  const harness = createPageHarness({
    delayJoinMs: 40,
    tunnels: [
      {
        id: "robot-1",
        ownerId: "owner-2",
        ownerEmail: "robot@example.com",
        location: "Robotic control",
        sessionLabel: "Robotic control",
        status: "live",
        lastSeenAtMs: Date.now(),
        startedAtMs: Date.now() - 10_000,
      },
    ],
  });
  await harness.auth({ email: "yanguangchensp@gmail.com", uid: "admin-1" });
  await settle();
  await harness.elements["live-tunnel-leave"].dispatch("click");
  await new Promise((resolve) => setTimeout(resolve, 80));
  await settle();

  assert.equal(harness.cloudCalls.left.length, 1);
  assert.equal(harness.cloudCalls.left[0].tunnelId, "robot-1");
  assert.match(
    harness.elements["live-tunnel-placeholder"].textContent,
    /Choose a live recording/i,
  );
});

test("a stage robot IP draft survives a live-list refresh", async () => {
  const harness = createPageHarness({
    storedRobotIps: { "live-1": "10.0.0.9" },
  });
  await harness.auth({ email: "yanguangchensp@gmail.com", uid: "admin-1" });
  await settle();
  assert.equal(harness.elements["live-tunnel-robot-ip"].value, "10.0.0.9");

  harness.elements["live-tunnel-robot-ip"].value = "192.168.1.50";
  harness.emitTunnels([
    {
      id: "live-1",
      ownerId: "owner-1",
      ownerEmail: "field@example.com",
      location: "10 Marina Bay",
      sessionLabel: "Morning",
      status: "live",
      lastSeenAtMs: Date.now(),
      startedAtMs: Date.now() - 60_000,
    },
  ]);
  await settle();
  assert.equal(harness.elements["live-tunnel-robot-ip"].value, "192.168.1.50");
  assert.equal(harness.elements["live-tunnel-robot-frame"].src, "");
});
