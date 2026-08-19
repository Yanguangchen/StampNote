const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const liveTunnel = require("../src/services/live-tunnel.js");

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
  assert.match(html, /without anyone accepting a call/);
  assert.match(html, /id="live-tunnel-voice-record"/);
  assert.match(html, /Voice message/);
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
    "live-tunnel-list",
    "live-tunnel-empty",
    "live-tunnel-count",
    "live-tunnel-video",
    "live-tunnel-frame",
    "live-tunnel-placeholder",
    "live-tunnel-caption",
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

  const cloudCalls = { signIn: 0, joined: [] };
  let authCallback;
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
      queueMicrotask(() => onChange(liveRecords));
      return () => {};
    },
    async createTunnelViewer(tunnelId, input) {
      cloudCalls.joined.push({ tunnelId, input });
      return { id: "view-1", tunnelId, ...input };
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
    leaveTunnelViewer() {},
  };

  const document = {
    documentElement: { dataset: {} },
    createElement(tagName) {
      return new FakeElement(tagName);
    },
    querySelector(selector) {
      return elements[selector.replace(/^#/, "")] || null;
    },
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
    localStorage: { getItem() { return null; }, setItem() {} },
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
    RTCPeerConnection: FakePeerConnection,
    StampNoteFirebase: cloud,
    StampNoteLiveTunnel: liveTunnel,
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
    cloudCalls,
    elements,
  };
}

test("signing in lists live recordings and tunnels in without an accept step", async () => {
  const harness = createPageHarness();
  assert.equal(harness.elements["live-tunnel-auth-gate"].hidden, false);
  assert.equal(harness.elements["live-tunnel-workspace"].hidden, true);

  await harness.auth({ email: "yanguangchensp@gmail.com", uid: "admin-1" });
  await settle();

  assert.equal(harness.elements["live-tunnel-auth-gate"].hidden, true);
  assert.equal(harness.elements["live-tunnel-workspace"].hidden, false);
  assert.equal(harness.elements["live-tunnel-list"].children.length, 1);
  assert.equal(harness.elements["live-tunnel-empty"].hidden, true);
  assert.match(harness.elements["live-tunnel-count"].textContent, /1 live/);

  await harness.elements["live-tunnel-list"].children[0].dispatch("click");
  await settle();

  assert.equal(harness.cloudCalls.joined.length, 1);
  assert.equal(harness.cloudCalls.joined[0].tunnelId, "live-1");
  assert.equal(harness.cloudCalls.joined[0].input.offer.type, "offer");
  assert.equal(harness.elements["live-tunnel-leave"].hidden, false);
  assert.match(harness.elements["live-tunnel-caption"].textContent, /10 Marina Bay/);
});

test("a live tunnel can record and send a voice message without an accept step", async () => {
  const harness = createPageHarness();
  await harness.auth({ email: "yanguangchensp@gmail.com", uid: "admin-1" });
  await settle();
  await harness.elements["live-tunnel-list"].children[0].dispatch("click");
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
