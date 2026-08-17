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

function geographyPayload() {
  const payload = validPayload();
  payload.question = "Is 65 T1 Boulevard in Changi?";
  payload.facts[1] = {
    ref: "S2",
    kind: "session",
    text: "Session 2026-08-17--65-t1-boulevard--evening. 2026-08-17, 65 T1 Boulevard, Evening session. 5 attendance check-ins.",
  };
  payload.publicSites = [{ ref: "S2", label: "65 T1 Boulevard" }];
  return payload;
}

function intendedSitePayload() {
  const payload = geographyPayload();
  payload.question =
    "Compare my intended location with the staff GPS and truck at 65 T1 Boulevard.";
  payload.facts[1].text +=
    " Three-way location evidence: intended site 65 T1 Boulevard; staff/session GPS reference 1.364400, 103.991500 with ±8 m recorded accuracy; truck position 1.300000, 103.800000. GPS/truck comparison: outside threshold (23837 m).";
  payload.publicSites[0] = {
    ref: "S2",
    label: "65 T1 Boulevard",
    staffGps: { latitude: 1.3644, longitude: 103.9915, accuracyMeters: 8 },
    truck: { latitude: 1.3, longitude: 103.8 },
  };
  return payload;
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
  assert.match(call.instructions, /Reason across the retrieved facts/);
  assert.match(call.instructions, /GPS-clustered alias is strong evidence/);
  assert.match(call.instructions, /Do not answer "no records" merely because the stored label differs/);
  assert.match(call.instructions, /Report all three pairwise results/);
  assert.match(call.instructions, /attendance event itself supplied GPS/);
  assert.match(call.instructions, /If the user confirms a previously offered candidate/);
  assert.match(call.instructions, /name its photo ID and cite that photo's specific flag fact/);
  assert.match(call.instructions, /display the authenticated photo inside the same chat answer/);
  assert.match(call.instructions, /same definitions and daily ranges as the StampNote Metrics page/);
  assert.match(call.instructions, /Do not pad an answer with nearby facts/);
  assert.match(call.instructions, /No check-ins were recorded at Airport today/);
  assert.match(call.instructions, /current local date stated in the overview fact/);
  assert.match(call.messages.at(-1).content, /\[S2\] \(flag\)/);
  assert.match(call.messages.at(-1).content, /Which sessions are flagged/);
});

test("public geography is verified separately and supplied as bounded G1 evidence", async () => {
  const { answerOperationsQuestion } = await import("../api/_ai-assistant.mjs");
  const geography = {
    ref: "G1",
    provider: "Google Maps",
    text: "65 T1 Boulevard is at Singapore Changi Airport in Changi, Singapore.",
    sources: [
      {
        title: "Singapore Changi Airport Terminal 1",
        url: "https://maps.google.com/?cid=123",
      },
    ],
  };
  let verifiedSites;
  let finalCall;
  const result = await answerOperationsQuestion(geographyPayload(), {
    async verifyGeography(sites) {
      verifiedSites = sites;
      return geography;
    },
    async generate(input) {
      finalCall = input;
      return { text: "Yes. Five check-ins were recorded at the Changi site [G1, S2]." };
    },
  });

  assert.deepEqual(verifiedSites, [{ ref: "S2", label: "65 T1 Boulevard" }]);
  assert.deepEqual(result.geography, geography);
  assert.equal(Object.hasOwn(finalCall, "tools"), false, "the private final call cannot browse");
  assert.match(finalCall.instructions, /Never use external geography to support attendance/);
  assert.match(finalCall.instructions, /\[G1, S2\]/);
  assert.match(finalCall.messages.at(-1).content, /EXTERNAL GEOGRAPHY/);
  assert.match(finalCall.messages.at(-1).content, /\[G1\] \(Google Maps\).*Changi/);
});

test("the Maps call receives only public location cases and requires safe Google sources", async () => {
  const { verifyPublicGeography } = await import("../api/_ai-assistant.mjs");
  let call;
  const result = await verifyPublicGeography(
    intendedSitePayload().publicSites,
    {
      async generate(input) {
        call = input;
        return {
          text: "65 T1 Boulevard is in Changi. [S99] https://untrusted.example/detail",
          sources: [
            {
              sourceType: "url",
              title: "Terminal 1",
              url: "https://maps.google.com/?cid=123",
            },
            {
              sourceType: "url",
              title: "Untrusted",
              url: "https://untrusted.example/place",
            },
          ],
        };
      },
    },
  );

  assert.equal(call.tools.google_maps.type, "provider");
  assert.equal(call.tools.google_maps.id, "google.google_maps");
  assert.deepEqual(JSON.parse(call.prompt.slice("PUBLIC GEOGRAPHY CASES\n".length)), [
    {
      case: "P1",
      intendedSite: "65 T1 Boulevard",
      staffGps: { latitude: 1.3644, longitude: 103.9915, accuracyMeters: 8 },
      truck: { latitude: 1.3, longitude: 103.8 },
    },
  ]);
  assert.match(call.instructions, /whether it matches the intended site/);
  assert.doesNotMatch(call.prompt, /worker|attendance|Ernest|2026|S2/i);
  assert.equal(result.text, "65 T1 Boulevard is in Changi.");
  assert.deepEqual(result.sources, [
    { title: "Terminal 1", url: "https://maps.google.com/?cid=123" },
  ]);
});

test("intended-site comparisons activate Maps and remain separate from the tool-free final answer", async () => {
  const { answerOperationsQuestion } = await import("../api/_ai-assistant.mjs");
  const payload = intendedSitePayload();
  let verifiedSites;
  let finalCall;
  const result = await answerOperationsQuestion(payload, {
    async verifyGeography(sites) {
      verifiedSites = sites;
      return {
        ref: "G1",
        provider: "Google Maps",
        text:
          "65 T1 Boulevard matches the staff GPS at Terminal 1; the truck coordinate does not match the intended site.",
        sources: [{ title: "Terminal 1", url: "https://maps.google.com/?cid=123" }],
      };
    },
    async generate(input) {
      finalCall = input;
      return {
        text:
          "Staff GPS matches the intended site, but the truck does not [G1, S2]. Staff and truck are also outside the local threshold [S2].",
      };
    },
  });

  assert.deepEqual(verifiedSites, payload.publicSites);
  assert.match(result.answer, /truck does not/);
  assert.equal(Object.hasOwn(finalCall, "tools"), false);
  assert.match(finalCall.instructions, /intended site versus staff\/session GPS/);
  assert.match(finalCall.instructions, /staff\/session GPS versus truck/);
  assert.match(finalCall.messages.at(-1).content, /matches the staff GPS/);
});

test("the server independently rejects unnecessary Maps activation", async () => {
  const { answerOperationsQuestion } = await import("../api/_ai-assistant.mjs");
  const payload = geographyPayload();
  payload.question = "Summarize the flagged sessions.";
  let mapsCalls = 0;
  const result = await answerOperationsQuestion(payload, {
    async verifyGeography() {
      mapsCalls += 1;
      throw new Error("should not run");
    },
    async generate() {
      return { text: "One session needs review [S2]." };
    },
  });

  assert.equal(mapsCalls, 0);
  assert.equal(Object.hasOwn(result, "geography"), false);
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
  assert.equal(assistantRequestSchema.safeParse(geographyPayload()).success, true);
  const unrelatedPublicSite = geographyPayload();
  unrelatedPublicSite.publicSites[0] = { ref: "S1", label: "65 T1 Boulevard" };
  assert.equal(assistantRequestSchema.safeParse(unrelatedPublicSite).success, false);
  const inventedPublicSite = geographyPayload();
  inventedPublicSite.publicSites[0].label = "99 Invented Road";
  assert.equal(assistantRequestSchema.safeParse(inventedPublicSite).success, false);
  assert.equal(assistantRequestSchema.safeParse(intendedSitePayload()).success, true);
  const invalidCoordinate = intendedSitePayload();
  invalidCoordinate.publicSites[0].truck.latitude = 91;
  assert.equal(assistantRequestSchema.safeParse(invalidCoordinate).success, false);
  const duplicatePublicRef = intendedSitePayload();
  duplicatePublicRef.publicSites.push({ ref: "S2", label: "65 T1 Boulevard" });
  assert.equal(assistantRequestSchema.safeParse(duplicatePublicRef).success, false);
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
        return { uid: "owner-1", email: "owner@example.com", role: "admin" };
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
  assert.deepEqual(verified, { uid: "owner-1", email: "a@b.c", role: "worker" });
  assert.match(request.url, /identitytoolkit\.googleapis\.com\/v1\/accounts:lookup\?key=/);
  assert.deepEqual(JSON.parse(request.options.body), { idToken: "token-value" });
});

test("signed-in ID tokens without a worker claim are superadmins", async () => {
  const { roleFromIdToken } = await import("../api/_ai-assistant.mjs");
  function tokenWithClaims(claims) {
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `header.${payload}.sig`;
  }
  assert.equal(roleFromIdToken(tokenWithClaims({})), "admin");
  assert.equal(roleFromIdToken(tokenWithClaims({ stampnoteRole: "admin" })), "admin");
  assert.equal(roleFromIdToken(tokenWithClaims({ stampnoteRole: "superadmin" })), "admin");
  assert.equal(roleFromIdToken(tokenWithClaims({ stampnoteRole: "worker" })), "worker");
});

test("field staff tokens cannot ask Operations AI questions", async () => {
  const { handleAssistantRequest } = await import("../api/_ai-assistant.mjs");
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
      async verifyToken() {
        return { uid: "worker-1", email: "field@example.com", role: "worker" };
      },
      async answer() {
        throw new Error("field staff must not reach Gemini");
      },
    },
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: "Operations AI is available to administrators only.",
  });
});

test("the Vercel route delegates to the shared assistant handler", async () => {
  const route = (await import("../api/assistant.mjs")).default;
  const response = await route.fetch(new Request("https://example.com/api/assistant"));
  assert.equal(response.status, 405);
  assert.deepEqual(await response.json(), { error: "Use POST for operations questions." });
});
