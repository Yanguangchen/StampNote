const assert = require("node:assert/strict");
const { test } = require("node:test");

test("Gemini TTS receives clean answer text and returns a playable WAV", async () => {
  const {
    AI_SPEECH_MODEL,
    AI_SPEECH_SAMPLE_RATE,
    AI_SPEECH_VOICE,
    cleanSpeechText,
    synthesizeOperationsSpeech,
  } = await import("../api/_ai-speech.mjs");
  let requestUrl;
  let request;
  const pcm = Buffer.from([0, 1, 2, 3]);
  const result = await synthesizeOperationsSpeech(
    { text: "**Jane Tan** checked in. [S2]" },
    {
      apiKey: "gemini-test-key",
      async fetch(url, init) {
        requestUrl = url;
        request = init;
        return Response.json({
          status: "completed",
          steps: [
            {
              type: "model_output",
              content: [
                {
                  type: "audio",
                  data: pcm.toString("base64"),
                  mime_type: "audio/l16",
                  sample_rate: AI_SPEECH_SAMPLE_RATE,
                },
              ],
            },
          ],
        });
      },
    },
  );

  assert.equal(
    requestUrl,
    "https://generativelanguage.googleapis.com/v1beta/interactions",
  );
  assert.equal(request.method, "POST");
  assert.equal(request.headers["x-goog-api-key"], "gemini-test-key");
  const payload = JSON.parse(request.body);
  assert.equal(payload.model, "gemini-3.1-flash-tts-preview");
  assert.match(payload.input, /brisk, easy-to-understand pace/);
  assert.match(payload.input, /Transcript:\nJane Tan checked in\.$/);
  assert.deepEqual(payload.response_format, { type: "audio" });
  assert.deepEqual(payload.generation_config.speech_config, [{ voice: "Kore" }]);
  assert.equal(payload.store, false);
  assert.equal(cleanSpeechText("Result [G1, S2]"), "Result");
  assert.equal(result.model, AI_SPEECH_MODEL);
  assert.equal(result.voice, AI_SPEECH_VOICE);
  assert.equal(result.audio.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(result.audio.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(result.audio.readUInt32LE(24), AI_SPEECH_SAMPLE_RATE);
  assert.deepEqual(result.audio.subarray(44), pcm);
});

test("Gemini TTS streams sanitized PCM chunks before the full voice is generated", async () => {
  const { AI_SPEECH_SAMPLE_RATE, streamOperationsSpeech } = await import(
    "../api/_ai-speech.mjs"
  );
  const pcm = Buffer.from([0, 1, 2, 3]);
  let request;
  const providerEvents = [
    'event: interaction.created\ndata: {"event_type":"interaction.created"}\n\n',
    `event: step.delta\ndata: ${JSON.stringify({
      event_type: "step.delta",
      delta: {
        type: "audio",
        data: pcm.toString("base64"),
        mime_type: "audio/l16",
        sample_rate: AI_SPEECH_SAMPLE_RATE,
      },
    })}\n\n`,
    'event: interaction.completed\ndata: {"event_type":"interaction.completed","private":"do not proxy"}\n\n',
  ];
  const result = await streamOperationsSpeech(
    { text: "**Stream this answer.** [S1]" },
    {
      apiKey: "gemini-test-key",
      async fetch(url, init) {
        request = { url, init };
        return new Response(providerEvents.join(""), {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    },
  );
  const lines = (await new Response(result.stream).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.equal(request.url, "https://generativelanguage.googleapis.com/v1beta/interactions");
  assert.equal(request.init.headers.Accept, "text/event-stream");
  assert.equal(request.init.headers["Api-Revision"], "2026-05-20");
  const payload = JSON.parse(request.init.body);
  assert.equal(payload.model, "gemini-3.1-flash-tts-preview");
  assert.equal(payload.stream, true);
  assert.match(payload.input, /Transcript:\nStream this answer\.$/);
  assert.deepEqual(
    lines.map((line) => line.type),
    ["metadata", "audio", "done"],
  );
  assert.equal(lines[1].data, pcm.toString("base64"));
  assert.equal(lines[1].sampleRate, AI_SPEECH_SAMPLE_RATE);
  assert.doesNotMatch(JSON.stringify(lines), /do not proxy/);
});

test("Gemini TTS exposes quota failures without leaking the provider response", async () => {
  const { handleSpeechRequest, synthesizeOperationsSpeech } = await import(
    "../api/_ai-speech.mjs"
  );
  const token = "speech-token-1234567890";
  const response = await handleSpeechRequest(
    new Request("https://stampnote.test/api/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "Hello" }),
    }),
    {
      verifyToken: async () => ({ uid: "admin-1", role: "admin" }),
      synthesize(payload, options) {
        return synthesizeOperationsSpeech(payload, {
          ...options,
          apiKey: "gemini-test-key",
          fetch: async () =>
            Response.json(
              {
                error: {
                  code: 429,
                  status: "RESOURCE_EXHAUSTED",
                  message: "Quota exhausted for this project.",
                },
              },
              { status: 429 },
            ),
        });
      },
    },
  );

  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), {
    error: "Gemini voice is busy or out of quota. Try again shortly.",
  });
});

test("the speech endpoint returns an authenticated incremental audio stream", async () => {
  const { handleSpeechRequest } = await import("../api/_ai-speech.mjs");
  const token = "speech-token-1234567890";
  let streamedPayload;
  const response = await handleSpeechRequest(
    new Request("https://stampnote.test/api/speech", {
      method: "POST",
      headers: {
        Accept: "application/x-ndjson",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "Start speaking now." }),
    }),
    {
      verifyToken: async () => ({ uid: "admin-1", role: "admin" }),
      async streamSpeech(payload) {
        streamedPayload = payload;
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('{"type":"audio","data":"AAE="}\n'),
              );
              controller.enqueue(new TextEncoder().encode('{"type":"done"}\n'));
              controller.close();
            },
          }),
          model: "gemini-3.1-flash-tts-preview",
          voice: "Kore",
        };
      },
    },
  );

  assert.deepEqual(streamedPayload, { text: "Start speaking now." });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^application\/x-ndjson/);
  assert.equal(response.headers.get("cache-control"), "no-store, no-transform");
  assert.match(await response.text(), /"type":"audio"/);
});

test("the speech endpoint requires an authenticated administrator and returns audio", async () => {
  const { handleSpeechRequest } = await import("../api/_ai-speech.mjs");
  const get = await handleSpeechRequest(new Request("https://stampnote.test/api/speech"));
  assert.equal(get.status, 405);
  assert.deepEqual(await get.json(), { error: "Use POST for Gemini speech." });

  const missingAuth = await handleSpeechRequest(
    new Request("https://stampnote.test/api/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Hello" }),
    }),
  );
  assert.equal(missingAuth.status, 401);

  const token = "speech-token-1234567890";
  const worker = await handleSpeechRequest(
    new Request("https://stampnote.test/api/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "Hello" }),
    }),
    { verifyToken: async () => ({ uid: "worker-1", role: "worker" }) },
  );
  assert.equal(worker.status, 403);

  let synthesized;
  const audio = Buffer.from("RIFFtest-WAVE", "ascii");
  const response = await handleSpeechRequest(
    new Request("https://stampnote.test/api/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "A clear operations update." }),
    }),
    {
      verifyToken: async () => ({ uid: "admin-1", role: "admin" }),
      async synthesize(payload) {
        synthesized = payload;
        return {
          audio,
          model: "gemini-3.1-flash-tts-preview",
          voice: "Kore",
        };
      },
    },
  );

  assert.deepEqual(synthesized, { text: "A clear operations update." });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "audio/wav");
  assert.equal(response.headers.get("x-stampnote-ai-model"), "gemini-3.1-flash-tts-preview");
  assert.equal(response.headers.get("x-stampnote-ai-voice"), "Kore");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), audio);
});
