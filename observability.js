(function initializeStampNoteObservability(globalScope) {
  "use strict";

  const SURFACE_LIST = Object.freeze([
    "capture",
    "dashboard",
    "ai-dashboard",
    "coordinates",
    "agent-coordinates",
    "metrics",
    "onboarding",
    "worker-photos",
  ]);
  const SURFACES = new Set(SURFACE_LIST);
  const EVENT_NAME_LIST = Object.freeze([
    "client.ready",
    "client.error",
    "web.vital",
    "health.checked",
    "capture.store.ready",
    "capture.monitor.started",
    "capture.monitor.failed",
    "capture.camera.facing",
    "capture.camera.facing.failed",
    "capture.saved",
    "capture.work.started",
    "face.match.completed",
    "face.match.failed",
    "face.match.skipped",
    "attendance.saved",
    "attendance.save.failed",
    "attendance.another.requested",
    "attendance.load.completed",
    "attendance.load.failed",
    "tracking.failed",
    "tracking.recovered",
    "session.gps.saved",
    "session.gps.save_failed",
    "ai.review.started",
    "ai.review.completed",
    "ai.review.failed",
    "ai.assistant.started",
    "ai.assistant.completed",
    "ai.assistant.failed",
    "ai.assistant.query.started",
    "ai.assistant.query.completed",
    "ai.assistant.query.failed",
    "ai.knowledge.loaded",
    "ai.knowledge.failed",
    "cloud.auth.state",
    "cloud.auth.failed",
    "cloud.sync.started",
    "cloud.sync.completed",
    "cloud.sync.failed",
    "dashboard.load.started",
    "dashboard.load.completed",
    "dashboard.load.failed",
    "dashboard.image.failed",
    "dashboard.weather.failed",
    "dashboard.weather.save_failed",
    "dashboard.sessions.failed",
    "dashboard.location.deleted",
    "dashboard.location.delete_failed",
    "dashboard.date.deleted",
    "dashboard.date.delete_failed",
    "dashboard.session.renamed",
    "dashboard.session.rename_failed",
    "dashboard.session.deleted",
    "dashboard.session.delete_failed",
    "dashboard.session.truck_location.updated",
    "dashboard.session.truck_location.failed",
    "dashboard.theme.changed",
    "metrics.loaded",
    "metrics.load.completed",
    "metrics.load.failed",
    "coordinates.load.started",
    "coordinates.load.completed",
    "coordinates.load.failed",
    "coordinates.truck_location.updated",
    "coordinates.truck_location.failed",
    "onboarding.scan.started",
    "onboarding.scan.completed",
    "onboarding.scan.failed",
    "onboarding.worker.saved",
    "onboarding.worker.save_failed",
    "onboarding.worker.deleted",
    "onboarding.worker.delete_failed",
    "worker.photo.staged",
    "worker.photo.gps.failed",
    "worker.photo.sent",
    "worker.photo.send_failed",
    "worker.photo.sync.completed",
    "worker.photo.sync.failed",
  ]);
  const EVENT_NAMES = new Set(EVENT_NAME_LIST);
  const NUMBER_FIELDS = new Set([
    "durationMs",
    "batchSize",
    "reviewedCount",
    "flaggedCount",
    "uploadedCount",
    "queuedCount",
    "failedCount",
    "photoCount",
    "metricValue",
    "httpStatus",
    "matchDistance",
    "matchVotes",
    "requiredVotes",
    "sampleCount",
    "checkInCount",
    "workerCount",
    "accuracyMeters",
    "attendanceCount",
    "sessionCount",
    "flaggedSessionCount",
    "factCount",
    "score",
  ]);
  const BOOLEAN_FIELDS = new Set(["automatic", "online", "persistent", "flagged"]);
  const ENUM_FIELDS = Object.freeze({
    status: new Set(["ok", "degraded", "success", "failed", "signed_in", "signed_out"]),
    trigger: new Set(["schedule", "gesture", "worker"]),
    facing: new Set(["environment", "user"]),
    theme: new Set(["light", "dark", "system"]),
    sessionId: new Set(["morning", "afternoon", "evening"]),
    metricName: new Set(["CLS", "INP", "LCP", "FCP", "TTFB", "long_tasks"]),
    metricRating: new Set(["good", "needs_improvement", "poor", "unknown"]),
    action: new Set(["save", "clear", "delete", "rename", "keep", "discard", "review"]),
    source: new Set(["camera", "library"]),
  });
  const MAX_QUEUE = 40;
  const FLUSH_DELAY = 1800;

  function safeErrorCode(error, fallback = "unknown_error") {
    const value = String(error?.code || error?.name || fallback)
      .toLowerCase()
      .replace(/[^a-z0-9_./:-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80);

    return value || fallback;
  }

  function sanitizeFields(fields = {}) {
    const safe = {};

    Object.entries(fields || {}).forEach(([key, value]) => {
      if (NUMBER_FIELDS.has(key) && Number.isFinite(value) && value >= 0) {
        safe[key] = Math.min(3_600_000, Number(value));
      } else if (BOOLEAN_FIELDS.has(key) && typeof value === "boolean") {
        safe[key] = value;
      } else if (ENUM_FIELDS[key]?.has(value)) {
        safe[key] = value;
      } else if (key === "errorCode") {
        safe.errorCode = safeErrorCode({ code: value });
      }
    });

    return safe;
  }

  function createId() {
    if (typeof globalScope.crypto?.randomUUID === "function") {
      return globalScope.crypto.randomUUID().replace(/-/g, "");
    }
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
  }

  const pureApi = {
    BOOLEAN_FIELDS: Object.freeze([...BOOLEAN_FIELDS]),
    ENUM_FIELDS,
    EVENT_NAMES: EVENT_NAME_LIST,
    NUMBER_FIELDS: Object.freeze([...NUMBER_FIELDS]),
    SURFACES: SURFACE_LIST,
    safeErrorCode,
    sanitizeFields,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = pureApi;
  }
  if (!globalScope.document || !globalScope.fetch) {
    return;
  }

  const startedAt = globalScope.performance?.now?.() || 0;
  const liveServer =
    ["127.0.0.1", "localhost"].includes(globalScope.location.hostname) &&
    globalScope.location.port === "5500";
  const endpoint = liveServer
    ? "https://stampnote-omega.vercel.app/api/telemetry"
    : "/api/telemetry";
  const sessionId = createId();
  const queue = [];
  const dedupe = new Map();
  const docSurface = globalScope.document.documentElement?.dataset?.surface;
  let surface = SURFACES.has(docSurface) ? docSurface : "capture";
  let flushTimer = null;
  let flushing = false;
  let lastLcp = null;
  let lastInp = null;
  let cumulativeLayoutShift = 0;
  let longTaskCount = 0;
  let longTaskDuration = 0;

  function createTraceId() {
    return createId();
  }

  function elapsedMs() {
    return Math.max(0, Math.min(86_400_000, Math.round((globalScope.performance?.now?.() || 0) - startedAt)));
  }

  function scheduleFlush(delay = FLUSH_DELAY) {
    if (flushTimer !== null || flushing) {
      return;
    }
    flushTimer = globalScope.setTimeout(() => {
      flushTimer = null;
      flush();
    }, delay);
  }

  function encodeBatch(events) {
    return JSON.stringify({ sessionId, surface, events });
  }

  function restoreBatch(events) {
    queue.unshift(...events);
    if (queue.length > MAX_QUEUE) {
      queue.splice(0, queue.length - MAX_QUEUE);
    }
  }

  function sendBeaconBatch(events) {
    // JSON sendBeacon is same-origin only. Live Server posts cross-origin to
    // production, and that path needs a CORS preflight sendBeacon cannot run.
    const BlobCtor = globalScope.Blob;
    if (
      endpoint.startsWith("http") ||
      typeof globalScope.navigator?.sendBeacon !== "function" ||
      typeof BlobCtor !== "function"
    ) {
      return false;
    }
    try {
      const body = new BlobCtor([encodeBatch(events)], { type: "application/json" });
      return Boolean(globalScope.navigator.sendBeacon(endpoint, body));
    } catch {
      return false;
    }
  }

  async function flush(options = {}) {
    if (flushing || queue.length === 0) {
      return false;
    }

    flushing = true;
    const events = queue.splice(0, 20);
    const traceId = createTraceId();

    try {
      if (options.beacon && sendBeaconBatch(events)) {
        return true;
      }

      const response = await globalScope.fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-StampNote-Trace-Id": traceId,
        },
        body: encodeBatch(events),
        credentials: "same-origin",
        keepalive: true,
      });

      if (!response.ok) {
        throw Object.assign(new Error("Telemetry was rejected."), {
          code: `http_${response.status}`,
        });
      }
      return true;
    } catch {
      // Observability must never break the feature it is observing. Keep one
      // bounded retry in memory and remain silent to avoid recursive errors.
      restoreBatch(events);
      if (globalScope.navigator.onLine !== false) {
        scheduleFlush(15000);
      }
      return false;
    } finally {
      flushing = false;
      if (queue.length > 0 && flushTimer === null) {
        scheduleFlush();
      }
    }
  }

  function event(name, fields = {}, options = {}) {
    if (!EVENT_NAMES.has(name)) {
      return false;
    }

    const safeFields = sanitizeFields(fields);
    const fingerprint = `${name}:${safeFields.errorCode || ""}`;
    const now = Date.now();
    const dedupeMs = Math.max(0, Number(options.dedupeMs) || 0);
    if (dedupeMs > 0 && now - (dedupe.get(fingerprint) || 0) < dedupeMs) {
      return false;
    }
    dedupe.set(fingerprint, now);

    const traceId = /^[A-Za-z0-9_-]{8,80}$/.test(String(options.traceId || ""))
      ? String(options.traceId)
      : undefined;
    queue.push({ name, atMs: elapsedMs(), ...(traceId ? { traceId } : {}), fields: safeFields });
    if (queue.length > MAX_QUEUE) {
      queue.shift();
    }

    if (options.immediate) {
      flush();
    } else {
      scheduleFlush();
    }
    return true;
  }

  function configure(options = {}) {
    if (SURFACES.has(options.surface)) {
      surface = options.surface;
    }
  }

  function metricRating(name, value) {
    const thresholds = {
      CLS: [0.1, 0.25],
      INP: [200, 500],
      LCP: [2500, 4000],
      FCP: [1800, 3000],
      TTFB: [800, 1800],
    }[name];

    if (!thresholds) {
      return "unknown";
    }
    return value <= thresholds[0]
      ? "good"
      : value <= thresholds[1]
        ? "needs_improvement"
        : "poor";
  }

  function reportMetric(metricName, metricValue) {
    if (!Number.isFinite(metricValue) || metricValue < 0) {
      return;
    }
    event("web.vital", {
      metricName,
      metricValue: Number(metricValue.toFixed(metricName === "CLS" ? 4 : 1)),
      metricRating: metricRating(metricName, metricValue),
    });
  }

  function observePerformance() {
    if (typeof globalScope.PerformanceObserver !== "function") {
      return;
    }

    try {
      const paint = new globalScope.PerformanceObserver((list) => {
        const first = list.getEntries().find((entry) => entry.name === "first-contentful-paint");
        if (first) {
          reportMetric("FCP", first.startTime);
          paint.disconnect();
        }
      });
      paint.observe({ type: "paint", buffered: true });
    } catch {}

    try {
      const lcp = new globalScope.PerformanceObserver((list) => {
        lastLcp = list.getEntries().at(-1)?.startTime ?? lastLcp;
      });
      lcp.observe({ type: "largest-contentful-paint", buffered: true });
    } catch {}

    try {
      const shifts = new globalScope.PerformanceObserver((list) => {
        list.getEntries().forEach((entry) => {
          if (!entry.hadRecentInput) {
            cumulativeLayoutShift += entry.value;
          }
        });
      });
      shifts.observe({ type: "layout-shift", buffered: true });
    } catch {}

    try {
      const longTasks = new globalScope.PerformanceObserver((list) => {
        list.getEntries().forEach((entry) => {
          longTaskCount += 1;
          longTaskDuration += entry.duration;
        });
      });
      longTasks.observe({ type: "longtask", buffered: true });
    } catch {}

    try {
      const interactions = new globalScope.PerformanceObserver((list) => {
        list.getEntries().forEach((entry) => {
          if (!entry.interactionId) return;
          lastInp = lastInp === null ? entry.duration : Math.max(lastInp, entry.duration);
        });
      });
      try {
        interactions.observe({ type: "event", buffered: true, durationThreshold: 16 });
      } catch {
        interactions.observe({ type: "event", buffered: true });
      }
    } catch {}
  }

  function reportFinalPerformance() {
    if (lastInp !== null) {
      reportMetric("INP", lastInp);
      lastInp = null;
    }
    if (lastLcp !== null) {
      reportMetric("LCP", lastLcp);
      lastLcp = null;
    }
    reportMetric("CLS", cumulativeLayoutShift);
    cumulativeLayoutShift = 0;
    if (longTaskCount > 0) {
      event("web.vital", {
        metricName: "long_tasks",
        metricValue: longTaskDuration,
        failedCount: longTaskCount,
        metricRating: "unknown",
      });
      longTaskCount = 0;
      longTaskDuration = 0;
    }
  }

  globalScope.addEventListener("error", (browserEvent) => {
    event(
      "client.error",
      { errorCode: safeErrorCode(browserEvent.error || { name: "window_error" }) },
      { immediate: true, dedupeMs: 60000 },
    );
  });
  globalScope.addEventListener("unhandledrejection", (browserEvent) => {
    event(
      "client.error",
      { errorCode: safeErrorCode(browserEvent.reason || { name: "unhandled_rejection" }) },
      { immediate: true, dedupeMs: 60000 },
    );
  });
  globalScope.addEventListener("online", () => scheduleFlush(0));
  globalScope.addEventListener("pagehide", () => {
    reportFinalPerformance();
    flush({ beacon: true });
  });
  globalScope.document.addEventListener("visibilitychange", () => {
    if (globalScope.document.hidden) {
      reportFinalPerformance();
      flush({ beacon: true });
    }
  });

  observePerformance();
  globalScope.addEventListener(
    "load",
    () => {
      const navigation = globalScope.performance?.getEntriesByType?.("navigation")?.[0];
      if (navigation) {
        reportMetric("TTFB", navigation.responseStart - navigation.requestStart);
      }
      event("client.ready", {
        durationMs: globalScope.performance?.now?.() || 0,
        online: globalScope.navigator.onLine !== false,
      });
    },
    { once: true },
  );

  globalScope.StampNoteObservability = Object.freeze({
    configure,
    createTraceId,
    event,
    flush,
    safeErrorCode,
    sanitizeFields,
  });
})(typeof window !== "undefined" ? window : globalThis);
