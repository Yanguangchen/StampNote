import {
  createRequestContext,
  deploymentInfo,
  jsonResponse,
  logRequestCompleted,
  logRequestStarted,
  responseHeaders,
} from "./_observability.mjs";

const LOCAL_ORIGINS = new Set([
  "http://127.0.0.1:5500",
  "http://localhost:5500",
]);

function corsHeaders(request) {
  const origin = request.headers.get("origin") || "";
  if (!LOCAL_ORIGINS.has(origin)) {
    return {};
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "X-StampNote-Trace-Id",
    Vary: "Origin",
  };
}

export async function handleHealthRequest(request) {
  const context = createRequestContext(request, "/api/health");
  logRequestStarted(context, request);

  if (request.method === "OPTIONS" && LOCAL_ORIGINS.has(request.headers.get("origin") || "")) {
    logRequestCompleted(context, 204, { outcome: "preflight" });
    return new Response(null, {
      status: 204,
      headers: responseHeaders(context, corsHeaders(request)),
    });
  }

  if (request.method === "HEAD") {
    logRequestCompleted(context, 200, { outcome: "healthy" });
    return new Response(null, {
      status: 200,
      headers: responseHeaders(context, corsHeaders(request)),
    });
  }
  if (request.method !== "GET") {
    logRequestCompleted(context, 405, { outcome: "rejected", reason: "method" });
    return jsonResponse(
      context,
      { error: "Use GET for health checks." },
      405,
      corsHeaders(request),
    );
  }

  const geminiConfigured = Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY);
  const status = geminiConfigured ? "ok" : "degraded";
  const statusCode = geminiConfigured ? 200 : 503;
  logRequestCompleted(context, statusCode, {
    outcome: status,
    geminiConfigured,
  });

  return jsonResponse(
    context,
    {
      service: "stampnote",
      status,
      checks: {
        server: "ok",
        geminiConfiguration: geminiConfigured ? "ok" : "missing",
      },
      deployment: deploymentInfo(),
      timestamp: new Date().toISOString(),
      requestId: context.requestId,
    },
    statusCode,
    corsHeaders(request),
  );
}
