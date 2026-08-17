const assert = require("node:assert/strict");
const { test } = require("node:test");

async function captureLogs(run) {
  const original = { log: console.log, warn: console.warn, error: console.error };
  const entries = [];
  const collect = (encoded) => entries.push(JSON.parse(encoded));
  console.log = collect;
  console.warn = collect;
  console.error = collect;

  try {
    const value = await run();
    return { value, entries };
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
}

function telemetryPayload(overrides = {}) {
  return {
    sessionId: "session_1234",
    surface: "capture",
    events: [
      {
        name: "client.ready",
        atMs: 25,
        fields: { online: true, persistent: true },
      },
      {
        name: "cloud.sync.failed",
        atMs: 50,
        fields: { failedCount: 1, errorCode: "network_error" },
      },
      {
        name: "face.match.failed",
        atMs: 75,
        fields: {
          matchDistance: 0.71,
          matchVotes: 3,
          requiredVotes: 4,
          sampleCount: 5,
          errorCode: "insufficient_consensus",
          status: "failed",
        },
      },
    ],
    ...overrides,
  };
}

test("request observability accepts safe correlation IDs and sanitizes error codes", async () => {
  const {
    createRequestContext,
    deploymentInfo,
    jsonResponse,
    logEvent,
    responseHeaders,
    safeErrorCode,
  } = await import("../api/_observability.mjs");
  const request = new Request("https://example.com/api/test", {
    headers: {
      "X-Vercel-Id": "sin1::valid-request",
      "X-StampNote-Trace-Id": "trace.valid-1234",
    },
  });
  const context = createRequestContext(request, "/api/test");

  assert.equal(context.requestId, "sin1::valid-request");
  assert.equal(context.traceId, "trace.valid-1234");
  assert.deepEqual(responseHeaders(context, { Vary: "Origin" }).Vary, "Origin");
  assert.equal(responseHeaders(context)["X-Request-Id"], context.requestId);
  assert.match(responseHeaders(context)["Server-Timing"], /^app;dur=\d+$/);

  const response = jsonResponse(context, { ok: true }, 201, { "X-Test": "yes" });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.get("x-test"), "yes");

  const logged = await captureLogs(() => {
    logEvent(context, "warning", "test.warning", { count: 2 });
    logEvent(context, "fatal", "test.fatal");
    logEvent(context, "info", "test.info");
  });
  assert.deepEqual(logged.entries.map((entry) => entry.event), [
    "test.warning",
    "test.fatal",
    "test.info",
  ]);
  assert.ok(logged.entries.every((entry) => entry.service === "stampnote"));
  assert.equal(safeErrorCode({ code: "Auth Popup Blocked!" }), "auth_popup_blocked");
  assert.equal(safeErrorCode({}, "fallback"), "fallback");

  const invalidIds = createRequestContext(
    new Request("https://example.com", {
      headers: { "X-Vercel-Id": "bad id", "X-StampNote-Trace-Id": "x" },
    }),
    "/api/test",
  );
  assert.match(invalidIds.requestId, /^[0-9a-f-]{36}$/);
  assert.match(invalidIds.traceId, /^[0-9a-f-]{36}$/);

  const previous = {
    environment: process.env.VERCEL_ENV,
    region: process.env.VERCEL_REGION,
    release: process.env.VERCEL_GIT_COMMIT_SHA,
    deploymentId: process.env.VERCEL_DEPLOYMENT_ID,
  };
  process.env.VERCEL_ENV = "preview";
  process.env.VERCEL_REGION = "sin1";
  process.env.VERCEL_GIT_COMMIT_SHA = "1234567890abcdef";
  delete process.env.VERCEL_DEPLOYMENT_ID;
  assert.deepEqual(deploymentInfo(), {
    environment: "preview",
    region: "sin1",
    release: "1234567890ab",
  });
  process.env.VERCEL_DEPLOYMENT_ID = "dpl_unique-release";
  assert.equal(deploymentInfo().release, "dpl_unique-release");
  for (const [name, value] of Object.entries({
    VERCEL_ENV: previous.environment,
    VERCEL_REGION: previous.region,
    VERCEL_GIT_COMMIT_SHA: previous.release,
    VERCEL_DEPLOYMENT_ID: previous.deploymentId,
  })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("health reports configured, degraded, CORS, HEAD, and rejected-method states", async () => {
  const { handleHealthRequest } = await import("../api/_health.mjs");
  const originalKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;

  try {
    const checked = await captureLogs(async () => {
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = "configured";
      const healthy = await handleHealthRequest(
        new Request("https://example.com/api/health", {
          headers: { "X-StampNote-Trace-Id": "health-trace-123" },
        }),
      );
      const body = await healthy.json();
      assert.equal(healthy.status, 200);
      assert.equal(body.status, "ok");
      assert.equal(body.checks.geminiConfiguration, "ok");
      assert.equal(body.requestId, healthy.headers.get("x-request-id"));
      assert.equal(healthy.headers.get("x-stampnote-trace-id"), "health-trace-123");
      assert.ok(!Number.isNaN(Date.parse(body.timestamp)));

      const preflight = await handleHealthRequest(
        new Request("https://example.com/api/health", {
          method: "OPTIONS",
          headers: { Origin: "http://localhost:5500" },
        }),
      );
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get("access-control-allow-origin"), "http://localhost:5500");
      assert.match(preflight.headers.get("access-control-allow-methods"), /GET/);

      const head = await handleHealthRequest(
        new Request("https://example.com/api/health", {
          method: "HEAD",
          headers: { Origin: "http://127.0.0.1:5500" },
        }),
      );
      assert.equal(head.status, 200);
      assert.equal(await head.text(), "");
      assert.equal(head.headers.get("access-control-allow-origin"), "http://127.0.0.1:5500");

      const rejected = await handleHealthRequest(
        new Request("https://example.com/api/health", { method: "POST" }),
      );
      assert.equal(rejected.status, 405);
      assert.deepEqual(await rejected.json(), { error: "Use GET for health checks." });

      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      const degraded = await handleHealthRequest(new Request("https://example.com/api/health"));
      assert.equal(degraded.status, 503);
      assert.equal((await degraded.json()).checks.geminiConfiguration, "missing");
    });

    const completions = checked.entries.filter(
      (entry) => entry.event === "http.request.completed",
    );
    assert.deepEqual(completions.map((entry) => entry.statusCode), [200, 204, 200, 405, 503]);
  } finally {
    if (originalKey === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    else process.env.GOOGLE_GENERATIVE_AI_API_KEY = originalKey;
  }
});

test("telemetry accepts allowlisted events and emits correlated structured logs", async () => {
  const { handleTelemetryRequest } = await import("../api/_telemetry.mjs");
  const origin = "http://127.0.0.1:8080";
  const traced = await captureLogs(async () =>
    handleTelemetryRequest(
      new Request("https://example.com/api/telemetry", {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Origin: origin,
          "X-StampNote-Trace-Id": "client-trace-1234",
        },
        body: JSON.stringify(telemetryPayload()),
      }),
    ),
  );
  const response = traced.value;
  const body = await response.json();

  assert.equal(response.status, 202);
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
  assert.equal(response.headers.get("x-stampnote-trace-id"), "client-trace-1234");
  assert.equal(body.accepted, 3);
  assert.equal(body.traceId, "client-trace-1234");
  assert.equal(body.requestId, response.headers.get("x-request-id"));
  assert.deepEqual(traced.entries.map((entry) => entry.event), [
    "http.request.started",
    "client.ready",
    "cloud.sync.failed",
    "face.match.failed",
    "http.request.completed",
  ]);
  assert.equal(traced.entries[1].surface, "capture");
  assert.equal(traced.entries[1].sessionId, "session_1234");
  assert.equal(traced.entries[2].level, "error");
  assert.equal(traced.entries[3].matchVotes, 3);
  assert.equal(traced.entries[3].level, "error");
  assert.equal(traced.entries[4].eventCount, 3);
});

test("telemetry rejects unsafe methods, origins, types, sizes, and payloads", async () => {
  const { handleTelemetryRequest, MAX_TELEMETRY_REQUEST_BYTES, telemetryRequestSchema } =
    await import("../api/_telemetry.mjs");

  const result = await captureLogs(async () => {
    const preflight = await handleTelemetryRequest(
      new Request("https://example.com/api/telemetry", {
        method: "OPTIONS",
        headers: { Origin: "http://localhost:5500" },
      }),
    );
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get("access-control-allow-headers"), /X-StampNote-Trace-Id/);

    const method = await handleTelemetryRequest(new Request("https://example.com/api/telemetry"));
    assert.equal(method.status, 405);

    const crossSite = await handleTelemetryRequest(
      new Request("https://example.com/api/telemetry", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://untrusted.example",
          "Sec-Fetch-Site": "cross-site",
        },
        body: "{}",
      }),
    );
    assert.equal(crossSite.status, 403);
    assert.equal(crossSite.headers.get("access-control-allow-origin"), null);

    const wrongType = await handleTelemetryRequest(
      new Request("https://example.com/api/telemetry", { method: "POST", body: "{}" }),
    );
    assert.equal(wrongType.status, 415);

    const declaredLarge = await handleTelemetryRequest(
      new Request("https://example.com/api/telemetry", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(MAX_TELEMETRY_REQUEST_BYTES + 1),
        },
        body: "{}",
      }),
    );
    assert.equal(declaredLarge.status, 413);

    const actualLarge = await handleTelemetryRequest(
      new Request("https://example.com/api/telemetry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: " ".repeat(MAX_TELEMETRY_REQUEST_BYTES + 1),
      }),
    );
    assert.equal(actualLarge.status, 413);

    const malformed = await handleTelemetryRequest(
      new Request("https://example.com/api/telemetry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      }),
    );
    assert.equal(malformed.status, 400);

    const unknownEvent = telemetryRequestSchema.safeParse(
      telemetryPayload({ events: [{ name: "secret.event", atMs: 0, fields: {} }] }),
    );
    assert.equal(unknownEvent.success, false);

    const extraField = await handleTelemetryRequest(
      new Request("https://example.com/api/telemetry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          telemetryPayload({
            events: [{ name: "client.ready", atMs: 0, fields: { email: "private@example.com" } }],
          }),
        ),
      }),
    );
    assert.equal(extraField.status, 400);
  });

  const rejections = result.entries.filter(
    (entry) => entry.event === "telemetry.request.rejected",
  );
  assert.deepEqual(rejections.map((entry) => entry.reason), [
    "method",
    "cross_site",
    "content_type",
    "too_large",
    "too_large",
    "invalid_payload",
    "invalid_payload",
  ]);
});

test("telemetry returns a safe 500 when reading the request unexpectedly fails", async () => {
  const { handleTelemetryRequest } = await import("../api/_telemetry.mjs");
  const result = await captureLogs(() =>
    handleTelemetryRequest({
      method: "POST",
      headers: new Headers({ "Content-Type": "application/json" }),
      async text() {
        throw Object.assign(new Error("socket exposed private details"), { name: "NetworkFailure" });
      },
    }),
  );

  assert.equal(result.value.status, 500);
  assert.deepEqual(await result.value.json(), { error: "Telemetry could not be recorded." });
  const failed = result.entries.find((entry) => entry.event === "telemetry.request.failed");
  assert.equal(failed.errorCode, "NetworkFailure");
  assert.equal(JSON.stringify(result.entries).includes("private details"), false);
});

test("health and telemetry Vercel routes delegate to their shared handlers", async () => {
  const healthRoute = (await import("../api/health.mjs")).default;
  const telemetryRoute = (await import("../api/telemetry.mjs")).default;
  const originalKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;

  try {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "configured";
    const result = await captureLogs(async () => {
      const health = await healthRoute.fetch(new Request("https://example.com/api/health"));
      const telemetry = await telemetryRoute.fetch(new Request("https://example.com/api/telemetry"));
      assert.equal(health.status, 200);
      assert.equal(telemetry.status, 405);
    });
    assert.ok(result.entries.some((entry) => entry.route === "/api/health"));
    assert.ok(result.entries.some((entry) => entry.route === "/api/telemetry"));
  } finally {
    if (originalKey === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    else process.env.GOOGLE_GENERATIVE_AI_API_KEY = originalKey;
  }
});

test("telemetry accepts payloads from all 7 surfaces and validates new operational events", async () => {
  const { handleTelemetryRequest } = await import("../api/_telemetry.mjs");
  const surfaces = [
    "capture",
    "dashboard",
    "ai-dashboard",
    "coordinates",
    "metrics",
    "onboarding",
    "worker-photos",
  ];

  for (const surface of surfaces) {
    const payload = {
      sessionId: "session_valid_123",
      surface,
      events: [
        {
          name: "client.ready",
          atMs: 10,
          fields: { online: true },
        },
      ],
    };
    const response = await handleTelemetryRequest(
      new Request("https://example.com/api/telemetry", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:5500",
        },
        body: JSON.stringify(payload),
      }),
    );
    assert.equal(response.status, 202, `Failed for surface: ${surface}`);
  }

  const comprehensivePayload = {
    sessionId: "session_full_123",
    surface: "ai-dashboard",
    events: [
      {
        name: "ai.assistant.query.completed",
        atMs: 120,
        fields: { factCount: 4, durationMs: 450, status: "success" },
      },
      {
        name: "coordinates.truck_location.updated",
        atMs: 200,
        fields: { action: "save", status: "success" },
      },
      {
        name: "onboarding.worker.saved",
        atMs: 300,
        fields: { sampleCount: 7, status: "success" },
      },
      {
        name: "worker.photo.sent",
        atMs: 400,
        fields: { photoCount: 2, uploadedCount: 2, failedCount: 0, status: "success" },
      },
      {
        name: "metrics.load.completed",
        atMs: 500,
        fields: { checkInCount: 15, photoCount: 40, status: "success" },
      },
    ],
  };

  const traced = await captureLogs(async () =>
    handleTelemetryRequest(
      new Request("https://example.com/api/telemetry", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:5500",
          "X-StampNote-Trace-Id": "ai-trace-555",
        },
        body: JSON.stringify(comprehensivePayload),
      }),
    ),
  );

  assert.equal(traced.value.status, 202);
  const result = await traced.value.json();
  assert.equal(result.accepted, 5);
  assert.equal(result.traceId, "ai-trace-555");
});
