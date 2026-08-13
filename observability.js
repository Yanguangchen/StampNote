(function initializeStampNoteObservability(globalScope) {
  "use strict";

  const EVENT_NAMES = new Set([
    "client.ready",
    "client.error",
    "web.vital",
    "capture.store.ready",
    "capture.monitor.started",
    "capture.monitor.failed",
    "capture.saved",
    "face.match.completed",
    "face.match.failed",
    "face.match.skipped",
    "attendance.saved",
    "attendance.save.failed",
    "tracking.failed",
    "tracking.recovered",
    "ai.review.started",
    "ai.review.completed",
    "ai.review.failed",
    "cloud.auth.state",
    "cloud.auth.failed",
    "cloud.sync.started",
    "cloud.sync.completed",
    "cloud.sync.failed",
    "dashboard.load.started",
    "dashboard.load.completed",
    "dashboard.load.failed",
    "dashboard.image.failed",
    "attendance.load.completed",
    "attendance.load.failed",
    "health.checked",
  ]);
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
  ]);
  const BOOLEAN_FIELDS = new Set(["automatic", "online", "persistent"]);
  const ENUM_FIELDS = Object.freeze({
    status: new Set(["ok", "degraded", "success", "failed", "signed_in", "signed_out"]),
    trigger: new Set(["schedule", "gesture"]),
    metricName: new Set(["CLS", "INP", "LCP", "FCP", "TTFB", "long_tasks"]),
    metricRating: new Set(["good", "needs_improvement", "poor", "unknown"]),
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

  const pureApi = { safeErrorCode, sanitizeFields };
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
  let surface = globalScope.document.documentElement.dataset.surface || "capture";
  let flushTimer = null;
  let flushing = false;
  let lastLcp = null;
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

  async function flush() {
    if (flushing || queue.length === 0) {
      return false;
    }

    flushing = true;
    const events = queue.splice(0, 20);
    const traceId = createTraceId();

    try {
      const response = await globalScope.fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-StampNote-Trace-Id": traceId,
        },
        body: JSON.stringify({ sessionId, surface, events }),
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
      queue.unshift(...events);
      if (queue.length > MAX_QUEUE) {
        queue.splice(0, queue.length - MAX_QUEUE);
      }
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
    if (["capture", "dashboard"].includes(options.surface)) {
      surface = options.surface;
    }
  }

  function metricRating(name, value) {
    const thresholds = {
      CLS: [0.1, 0.25],
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
  }

  function reportFinalPerformance() {
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
    flush();
  });
  globalScope.document.addEventListener("visibilitychange", () => {
    if (globalScope.document.hidden) {
      reportFinalPerformance();
      flush();
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
