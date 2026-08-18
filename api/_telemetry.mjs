import { Buffer } from "node:buffer";
import { z } from "zod";

import {
  createRequestContext,
  jsonResponse,
  logEvent,
  logRequestCompleted,
  logRequestStarted,
  responseHeaders,
} from "./_observability.mjs";

export const MAX_TELEMETRY_REQUEST_BYTES = 24 * 1024;
export const MAX_TELEMETRY_EVENTS = 20;

const LOCAL_ORIGINS = new Set([
  "http://127.0.0.1:5500",
  "http://localhost:5500",
  "http://127.0.0.1:8080",
  "http://localhost:8080",
]);

const eventNames = [
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
];

const telemetryFieldsSchema = z
  .object({
    durationMs: z.number().min(0).max(3_600_000).optional(),
    batchSize: z.number().int().min(0).max(20).optional(),
    reviewedCount: z.number().int().min(0).max(10_000).optional(),
    flaggedCount: z.number().int().min(0).max(10_000).optional(),
    uploadedCount: z.number().int().min(0).max(10_000).optional(),
    queuedCount: z.number().int().min(0).max(10_000).optional(),
    failedCount: z.number().int().min(0).max(10_000).optional(),
    photoCount: z.number().int().min(0).max(10_000).optional(),
    matchDistance: z.number().min(0).max(2).optional(),
    matchVotes: z.number().int().min(0).max(20).optional(),
    requiredVotes: z.number().int().min(0).max(20).optional(),
    sampleCount: z.number().int().min(0).max(20).optional(),
    checkInCount: z.number().int().min(0).max(10_000).optional(),
    workerCount: z.number().int().min(0).max(10_000).optional(),
    accuracyMeters: z.number().min(0).max(10_000).optional(),
    attendanceCount: z.number().int().min(0).max(10_000).optional(),
    sessionCount: z.number().int().min(0).max(10_000).optional(),
    flaggedSessionCount: z.number().int().min(0).max(10_000).optional(),
    factCount: z.number().int().min(0).max(10_000).optional(),
    score: z.number().min(0).max(1).optional(),
    automatic: z.boolean().optional(),
    online: z.boolean().optional(),
    persistent: z.boolean().optional(),
    flagged: z.boolean().optional(),
    status: z
      .enum(["ok", "degraded", "success", "failed", "signed_in", "signed_out"])
      .optional(),
    trigger: z.enum(["schedule", "gesture", "worker"]).optional(),
    facing: z.enum(["environment", "user"]).optional(),
    theme: z.enum(["light", "dark", "system"]).optional(),
    sessionId: z.enum(["morning", "afternoon", "evening"]).optional(),
    errorCode: z.string().regex(/^[A-Za-z0-9_./:-]{1,80}$/).optional(),
    metricName: z.enum(["CLS", "INP", "LCP", "FCP", "TTFB", "long_tasks"]).optional(),
    metricValue: z.number().min(0).max(3_600_000).optional(),
    metricRating: z.enum(["good", "needs_improvement", "poor", "unknown"]).optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
    action: z.enum(["save", "clear", "delete", "rename", "keep", "discard", "review"]).optional(),
    source: z.enum(["camera", "library"]).optional(),
  })
  .strict();

export const telemetryRequestSchema = z
  .object({
    sessionId: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/),
    surface: z.enum([
      "capture",
      "dashboard",
      "ai-dashboard",
      "coordinates",
      "agent-coordinates",
      "metrics",
      "onboarding",
      "worker-photos",
    ]),
    events: z
      .array(
        z
          .object({
            name: z.enum(eventNames),
            atMs: z.number().int().min(0).max(86_400_000),
            traceId: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/).optional(),
            fields: telemetryFieldsSchema,
          })
          .strict(),
      )
      .min(1)
      .max(MAX_TELEMETRY_EVENTS),
  })
  .strict();

function isAllowedLocalOrigin(request) {
  return LOCAL_ORIGINS.has(request.headers.get("origin") || "");
}

function corsHeaders(request) {
  if (!isAllowedLocalOrigin(request)) {
    return {};
  }

  return {
    "Access-Control-Allow-Origin": request.headers.get("origin"),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-StampNote-Trace-Id",
    Vary: "Origin",
  };
}

function reject(context, request, status, reason, message) {
  logEvent(context, "warning", "telemetry.request.rejected", {
    statusCode: status,
    reason,
  });
  logRequestCompleted(context, status, { outcome: "rejected", reason });
  return jsonResponse(context, { error: message }, status, corsHeaders(request));
}

export async function handleTelemetryRequest(request) {
  const context = createRequestContext(request, "/api/telemetry");
  logRequestStarted(context, request);

  if (request.method === "OPTIONS" && isAllowedLocalOrigin(request)) {
    logRequestCompleted(context, 204, { outcome: "preflight" });
    return new Response(null, {
      status: 204,
      headers: responseHeaders(context, corsHeaders(request)),
    });
  }
  if (request.method !== "POST") {
    return reject(context, request, 405, "method", "Use POST for client telemetry.");
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  if (
    fetchSite &&
    !["same-origin", "same-site", "none"].includes(fetchSite) &&
    !isAllowedLocalOrigin(request)
  ) {
    return reject(context, request, 403, "cross_site", "Cross-site telemetry is not allowed.");
  }
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "")) {
    return reject(context, request, 415, "content_type", "Client telemetry expects JSON.");
  }

  const declaredBytes = Number(request.headers.get("content-length")) || 0;
  if (declaredBytes > MAX_TELEMETRY_REQUEST_BYTES) {
    return reject(context, request, 413, "too_large", "The telemetry batch is too large.");
  }

  try {
    const text = await request.text();
    const requestBytes = Buffer.byteLength(text);
    if (requestBytes > MAX_TELEMETRY_REQUEST_BYTES) {
      return reject(context, request, 413, "too_large", "The telemetry batch is too large.");
    }

    const parsed = telemetryRequestSchema.parse(JSON.parse(text));
    parsed.events.forEach((event) => {
      logEvent(context, event.name.endsWith("failed") || event.name === "client.error" ? "error" : "info", event.name, {
        surface: parsed.surface,
        sessionId: parsed.sessionId,
        operationTraceId: event.traceId || null,
        clientElapsedMs: event.atMs,
        ...event.fields,
      });
    });
    logRequestCompleted(context, 202, {
      outcome: "accepted",
      eventCount: parsed.events.length,
      requestBytes,
      surface: parsed.surface,
    });

    return jsonResponse(
      context,
      { accepted: parsed.events.length, requestId: context.requestId, traceId: context.traceId },
      202,
      corsHeaders(request),
    );
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      return reject(context, request, 400, "invalid_payload", "The telemetry batch is invalid.");
    }

    logEvent(context, "error", "telemetry.request.failed", {
      errorCode: String(error?.name || "unknown_error").slice(0, 80),
    });
    logRequestCompleted(context, 500, { outcome: "failed" });
    return jsonResponse(
      context,
      { error: "Telemetry could not be recorded." },
      500,
      corsHeaders(request),
    );
  }
}
