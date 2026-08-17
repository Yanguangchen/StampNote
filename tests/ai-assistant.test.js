const assert = require("node:assert/strict");
const { test } = require("node:test");

function validPayload() {
  return {
    question: "Which sessions are flagged?",
    history: [{ role: "assistant", content: "Ask me about the loaded records." }],
    facts: [
      {
        ref: "S1",
        kind: "overview",
        text: "Loaded scope: 2 sessions and 1 flagged session.",
      },
      {
        ref: "S2",
        kind: "flag",
        text: "Flagged session 2026-08-14--site--afternoon: truck location differs from GPS.",
      },
    ],
    scope: {
      sessions: 2,
      flaggedSessions: 1,
      weatherIssues: 0,
      attendanceCheckIns: 3,
      workers: 2,
      photos: 5,
      retrieved: 2,
      totalFacts: 8,
    },
  };
}

test("Gemini receives a grounded, read-only operations question", async () => {
  const { AI_ASSISTANT_MODEL, answerOperationsQuestion } = await import(
    "../api/_ai-assistant.mjs"
  );
  let call;
  const result = await answerOperationsQuestion(validPayload(), {
    async generate(input) {
      call = input;
      return { text: "One session needs review [S2]." };
    },
  });

  assert.equal(result.model, AI_ASSISTANT_MODEL);
  assert.equal(result.retrieved, 2);
  assert.equal(result.answer, "One session needs review [S2].");
  assert.equal(call.temperature, 0.1);
  assert.equal(call.maxOutputTokens, 1_400);
  assert.match(call.instructions, /read-only assistant/);
  assert.match(call.instructions, /Never invent a worker, session, date, location, count/);
  assert.match(call.instructions, /same definitions and daily ranges as the StampNote Metrics page/);
  assert.match(call.messages.at(-1).content, /\[S2\] \(flag\)/);
  assert.match(call.messages.at(-1).content, /Which sessions are flagged/);
});

test("the request schema bounds history, facts, references, and declared scope", async () => {
  const { assistantRequestSchema, MAX_RETRIEVED_FACTS } = await import(
    "../api/_ai-assistant.mjs"
  );
  assert.equal(assistantRequestSchema.safeParse(validPayload()).success, true);
  const metric = validPayload();
  metric.facts[1] = {
    ref: "S2",
    kind: "metric",
    text: "Metrics page — Attendance taken, last 30 days: 3 check-ins total.",
  };
  assert.equal(assistantRequestSchema.safeParse(metric).success, true);
  const duplicate = validPayload();
  duplicate.facts[1].ref = "S1";
  assert.equal(assistantRequestSchema.safeParse(duplicate).success, false);
  const mismatched = validPayload();
  mismatched.scope.retrieved = 1;
  assert.equal(assistantRequestSchema.safeParse(mismatched).success, false);
  const excessive = validPayload();
  excessive.facts = Array.from({ length: MAX_RETRIEVED_FACTS + 1 }, (_, index) => ({
    ref: `S${index + 1}`,
    kind: "session",
    text: "Session fact",
  }));
  excessive.scope.retrieved = excessive.facts.length;
  assert.equal(assistantRequestSchema.safeParse(excessive).success, false);
});

test("the assistant endpoint requires Firebase auth and rejects unsafe requests", async () => {
  const { handleAssistantRequest, MAX_ASSISTANT_REQUEST_BYTES } = await import(
    "../api/_ai-assistant.mjs"
  );
  const method = await handleAssistantRequest(new Request("http://localhost/api/assistant"));
  assert.equal(method.status, 405);

  const preflight = await handleAssistantRequest(
    new Request("https://stampnote-omega.vercel.app/api/assistant", {
      method: "OPTIONS",
      headers: {
        Origin: "http://127.0.0.1:5500",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    }),
  );
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "http://127.0.0.1:5500");

  const unauthorized = await handleAssistantRequest(
    new Request("http://localhost/api/assistant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validPayload()),
    }),
  );
  assert.equal(unauthorized.status, 401);

  const crossSite = await handleAssistantRequest(
    new Request("https://stampnote.example/api/assistant", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${"t".repeat(24)}`,
        "Content-Type": "application/json",
        Origin: "https://untrusted.example",
        "Sec-Fetch-Site": "cross-site",
      },
      body: JSON.stringify(validPayload()),
    }),
  );
  assert.equal(crossSite.status, 403);

  const tooLarge = await handleAssistantRequest(
    new Request("http://localhost/api/assistant", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${"t".repeat(24)}`,
        "Content-Type": "application/json",
        "Content-Length": String(MAX_ASSISTANT_REQUEST_BYTES + 1),
      },
      body: "{}",
    }),
  );
  assert.equal(tooLarge.status, 413);
});

test("a verified request returns only the generated answer contract", async () => {
  const { handleAssistantRequest } = await import("../api/_ai-assistant.mjs");
  let verifiedToken;
  let receivedPayload;
  const response = await handleAssistantRequest(
    new Request("http://localhost/api/assistant", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${"valid-token".repeat(3)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validPayload()),
    }),
    {
      async verifyToken(token) {
        verifiedToken = token;
        return { uid: "owner-1", email: "owner@example.com" };
      },
      async answer(payload) {
        receivedPayload = payload;
        return { answer: "One session is flagged [S2].", model: "gemini-test", retrieved: 2 };
      },
    },
  );
  assert.equal(response.status, 200);
  assert.equal(verifiedToken, "valid-token".repeat(3));
  assert.deepEqual(receivedPayload, validPayload());
  assert.deepEqual(await response.json(), {
    answer: "One session is flagged [S2].",
    model: "gemini-test",
    retrieved: 2,
  });
  assert.ok(response.headers.get("x-request-id"));
});

test("Firebase ID tokens are checked with the configured Firebase project", async () => {
  const { verifyFirebaseIdToken } = await import("../api/_ai-assistant.mjs");
  let request;
  const verified = await verifyFirebaseIdToken("token-value", {
    async fetchImplementation(url, options) {
      request = { url, options };
      return { ok: true, json: async () => ({ users: [{ localId: "owner-1", email: "a@b.c" }] }) };
    },
  });
  assert.deepEqual(verified, { uid: "owner-1", email: "a@b.c" });
  assert.match(request.url, /identitytoolkit\.googleapis\.com\/v1\/accounts:lookup\?key=/);
  assert.deepEqual(JSON.parse(request.options.body), { idToken: "token-value" });
});

test("the Vercel route delegates to the shared assistant handler", async () => {
  const route = (await import("../api/assistant.mjs")).default;
  const response = await route.fetch(new Request("https://example.com/api/assistant"));
  assert.equal(response.status, 405);
  assert.deepEqual(await response.json(), { error: "Use POST for operations questions." });
});
