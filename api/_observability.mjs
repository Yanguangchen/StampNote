import { randomUUID } from "node:crypto";

const SAFE_ID = /^[A-Za-z0-9_.:-]{8,160}$/;

function safeId(value) {
  const candidate = String(value || "").trim();
  return SAFE_ID.test(candidate) ? candidate : null;
}

export function createRequestContext(request, route) {
  return {
    route,
    startedAt: Date.now(),
    requestId: safeId(request.headers.get("x-vercel-id")) || randomUUID(),
    traceId: safeId(request.headers.get("x-stampnote-trace-id")) || randomUUID(),
  };
}

export function responseHeaders(context, extra = {}) {
  return {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Request-Id": context.requestId,
    "X-StampNote-Trace-Id": context.traceId,
    "Server-Timing": `app;dur=${Math.max(0, Date.now() - context.startedAt)}`,
    ...extra,
  };
}

export function jsonResponse(context, body, status = 200, extraHeaders = {}) {
  return Response.json(body, {
    status,
    headers: responseHeaders(context, extraHeaders),
  });
}

export function logEvent(context, level, event, fields = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    service: "stampnote",
    level,
    event,
    route: context.route,
    requestId: context.requestId,
    traceId: context.traceId,
    ...fields,
  };
  const encoded = JSON.stringify(entry);

  if (level === "error" || level === "fatal") {
    console.error(encoded);
  } else if (level === "warning") {
    console.warn(encoded);
  } else {
    console.log(encoded);
  }

  return entry;
}

export function logRequestStarted(context, request) {
  return logEvent(context, "info", "http.request.started", {
    method: request.method,
    requestBytes: Number(request.headers.get("content-length")) || null,
  });
}

export function logRequestCompleted(context, statusCode, fields = {}) {
  return logEvent(
    context,
    statusCode >= 500 ? "error" : statusCode >= 400 ? "warning" : "info",
    "http.request.completed",
    {
      statusCode,
      durationMs: Date.now() - context.startedAt,
      ...fields,
    },
  );
}

export function safeErrorCode(error, fallback = "unknown_error") {
  const value = String(error?.code || error?.name || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9_./:-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);

  return value || fallback;
}

export function deploymentInfo() {
  const deploymentId = String(process.env.VERCEL_DEPLOYMENT_ID || "").trim() || null;
  return {
    environment: process.env.VERCEL_ENV || "local",
    region: process.env.VERCEL_REGION || null,
    release: deploymentId || String(process.env.VERCEL_GIT_COMMIT_SHA || "local").slice(0, 12),
  };
}
