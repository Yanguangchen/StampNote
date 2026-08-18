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
  const { AI_ASSISTANT_MODEL, AI_ASSISTANT_THINKING_LEVEL, answerOperationsQuestion } = await import(
    "../api/_ai-assistant.mjs"
  );
  let call;
  const result = await answerOperationsQuestion(validPayload(), {
    async generate(input) {
      call = input;
      return { text: "One session needs review [S2]." };
    },
  });

  assert.equal(AI_ASSISTANT_MODEL, "gemini-3.6-flash");
  assert.equal(AI_ASSISTANT_THINKING_LEVEL, "minimal");
  assert.equal(result.model, AI_ASSISTANT_MODEL);
  assert.equal(result.retrieved, 2);
  assert.equal(result.answer, "One session needs review [S2].");
  assert.equal("temperature" in call, false);
  assert.equal(call.providerOptions.google.thinkingConfig.thinkingLevel, "minimal");
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
  assert.match(call.instructions, /manual-entry review flag/);
  assert.match(call.instructions, /Do not describe it as face-matched attendance/);
  assert.match(call.instructions, /same definitions and daily ranges as the StampNote Metrics page/);
  assert.match(call.instructions, /Do not pad an answer with nearby facts/);
  assert.match(call.instructions, /No check-ins were recorded at Airport today/);
  assert.match(call.instructions, /current local date stated in the overview fact/);
  assert.match(call.instructions, /cannot be calculated, is unavailable, or that no records exist merely because one of the named house numbers has no session/);
  assert.match(call.instructions, /do not answer that no records exist or that the comparison is unavailable/);
  assert.match(call.instructions, /Lead with that distance in meters/);
  assert.match(call.instructions, /Question-named public address" is a Maps geocode case/);
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
  assert.equal(typeof call.tools.geocode_public_address.execute, "function");
  assert.equal(typeof call.tools.measure_public_distance.execute, "function");
  assert.equal(typeof call.stopWhen, "function");
  assert.deepEqual(call.providerOptions.google.retrievalConfig.latLng, {
    latitude: 1.3521,
    longitude: 103.8198,
  });
  assert.equal(call.providerOptions.google.thinkingConfig.thinkingLevel, "minimal");
  assert.deepEqual(JSON.parse(call.prompt.slice("PUBLIC GEOGRAPHY CASES\n".length)), [
    {
      case: "P1",
      intendedSite: "65 T1 Boulevard",
      staffGps: { latitude: 1.3644, longitude: 103.9915, accuracyMeters: 8 },
      truck: { latitude: 1.3, longitude: 103.8 },
    },
  ]);
  assert.match(call.instructions, /whether it matches the intended site/);
  assert.match(call.instructions, /Call them instead of guessing/);
  assert.match(call.instructions, /measure_public_distance/);
  assert.doesNotMatch(call.prompt, /worker|attendance|Ernest|2026|S2/i);
  assert.equal(result.provider, "Google Maps");
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
  const { assistantRequestSchema, MAX_RETRIEVED_FACTS, shouldVerifyPublicGeography } = await import(
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
  const namedAddress = validPayload();
  namedAddress.question = "is 24 Parbury within the GPS margin of error of 32";
  namedAddress.facts.push({
    ref: "S3",
    kind: "session",
    text:
      "Question-named public address for GPS accuracy-margin comparison: 24 Parbury Avenue. This is not a recorded StampNote session. Geocode this public address and report the Maps distance in meters. A missing field session at this house number does not make the distance unavailable.",
  });
  namedAddress.scope.retrieved = 3;
  namedAddress.publicSites = [{ ref: "S3", label: "24 Parbury Avenue" }];
  assert.equal(assistantRequestSchema.safeParse(namedAddress).success, true);
  assert.equal(shouldVerifyPublicGeography(namedAddress.question, namedAddress.publicSites), true);
  const inventedOverviewLabel = {
    ...namedAddress,
    publicSites: [{ ref: "S3", label: "99 Invented Road" }],
  };
  assert.equal(assistantRequestSchema.safeParse(inventedOverviewLabel).success, false);
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

test("GPS accuracy-margin answers include a measured meter map", async () => {
  const { answerOperationsQuestion, planarDistanceMeters } = await import(
    "../api/_ai-assistant.mjs"
  );
  const payload = validPayload();
  payload.question = "is 24 Parbury within the GPS margin of error of 32";
  payload.facts.push(
    {
      ref: "S3",
      kind: "session",
      text:
        "Question-named public address for GPS accuracy-margin comparison: 24 Parbury Avenue. This is not a recorded StampNote session. Geocode this public address and report the Maps distance in meters. A missing field session at this house number does not make the distance unavailable.",
    },
    {
      ref: "S4",
      kind: "session",
      text:
        "Question-named public address for GPS accuracy-margin comparison: 32 Parbury Avenue. This is not a recorded StampNote session. Geocode this public address and report the Maps distance in meters. A missing field session at this house number does not make the distance unavailable.",
    },
  );
  payload.scope.retrieved = 4;
  payload.publicSites = [
    { ref: "S3", label: "24 Parbury Avenue" },
    { ref: "S4", label: "32 Parbury Avenue" },
  ];
  const from = { label: "24 Parbury Avenue", latitude: 1.316895, longitude: 103.943633 };
  const to = { label: "32 Parbury Avenue", latitude: 1.316694, longitude: 103.944054 };
  let grounded;
  const result = await answerOperationsQuestion(payload, {
    async geocode(label) {
      if (String(label).includes("24")) return { ...from, label };
      if (String(label).includes("32")) return { ...to, label };
      return null;
    },
    async verifyGeography() {
      return {
        ref: "G1",
        provider: "Google Maps",
        text: "24 Parbury Avenue and 32 Parbury Avenue are neighbouring houses on Parbury Avenue.",
        sources: [{ title: "Parbury Avenue", url: "https://maps.google.com/?cid=1" }],
      };
    },
    async generate(input) {
      grounded = input;
      return { text: "They are 52 m apart, outside the ±20 m GPS accuracy. [G1]" };
    },
  });

  const expectedMeters = planarDistanceMeters(from, to);
  assert.equal(result.map.kind, "public-addresses");
  assert.equal(result.map.distanceMeters, expectedMeters);
  assert.equal(result.map.flaggedForReview, expectedMeters > 20);
  assert.match(result.geography.text, new RegExp(`${expectedMeters} m`));
  assert.match(grounded.messages.at(-1).content, new RegExp(`${expectedMeters} m`));
  assert.match(result.answer, /52 m apart/);
});

test("geography tools geocode supplied labels and keep G1 without Google source URLs", async () => {
  const { planarDistanceMeters, verifyPublicGeography } = await import("../api/_ai-assistant.mjs");
  const from = { label: "24 Parbury Avenue", latitude: 1.316895, longitude: 103.943633 };
  const to = { label: "32 Parbury Avenue", latitude: 1.316694, longitude: 103.944054 };
  let tools;
  const result = await verifyPublicGeography(
    [
      { ref: "S3", label: "24 Parbury Avenue" },
      { ref: "S4", label: "32 Parbury Avenue" },
    ],
    {
      async geocode(label) {
        if (String(label).includes("24")) return { ...from, label };
        if (String(label).includes("32")) return { ...to, label };
        return null;
      },
      async generate(input) {
        tools = input.tools;
        return { text: "24 Parbury Avenue is 52 m from 32 Parbury Avenue.", sources: [] };
      },
    },
  );

  assert.equal(result.provider, "Public geocode");
  assert.equal(result.sources.length, 0);
  assert.match(result.text, /52 m/);
  const measured = await tools.measure_public_distance.execute({
    fromLabel: "24 Parbury Avenue",
    toLabel: "32 Parbury Avenue",
    accuracyMeters: 20,
  });
  assert.equal(measured.distanceMeters, planarDistanceMeters(from, to));
  assert.equal(measured.insideAccuracy, false);
  const denied = await tools.geocode_public_address.execute({ label: "1 Infinite Loop" });
  assert.match(String(denied.error), /not one of the supplied public geography cases/);
});

test("geography text without Google URLs still grounds the private final call", async () => {
  const { answerOperationsQuestion } = await import("../api/_ai-assistant.mjs");
  let finalCall;
  const result = await answerOperationsQuestion(geographyPayload(), {
    async generateGeography() {
      return { text: "65 T1 Boulevard is at Changi Airport.", sources: [] };
    },
    async generate(input) {
      finalCall = input;
      return { text: "Yes. Five check-ins were recorded at the Changi site [G1, S2]." };
    },
  });

  assert.equal(Object.hasOwn(result, "geography"), false);
  assert.equal(Object.hasOwn(finalCall, "tools"), false);
  assert.match(finalCall.messages.at(-1).content, /\[G1\] \(Public geocode\).*Changi Airport/);
});

test("OneMap misses fall back to Nominatim for public geocoding", async () => {
  const { geocodePublicLabel } = await import("../api/_ai-assistant.mjs");
  const urls = [];
  const hit = await geocodePublicLabel("24 Parbury Avenue", {
    async fetchImplementation(url) {
      urls.push(String(url));
      if (String(url).includes("onemap.gov.sg")) {
        return { ok: false, json: async () => ({}) };
      }
      return {
        ok: true,
        json: async () => [{ lat: "1.316895", lon: "103.943633" }],
      };
    },
  });
  assert.deepEqual(hit, {
    label: "24 Parbury Avenue",
    latitude: 1.316895,
    longitude: 103.943633,
  });
  assert.equal(urls.some((url) => url.includes("onemap.gov.sg")), true);
  assert.equal(urls.some((url) => url.includes("nominatim.openstreetmap.org")), true);
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
