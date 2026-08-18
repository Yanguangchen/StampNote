import { z } from "zod";

import { verifyFirebaseIdToken } from "./_ai-assistant.mjs";
import {
  createRequestContext,
  logEvent,
  logRequestCompleted,
  logRequestStarted,
  responseHeaders as observabilityHeaders,
  safeErrorCode,
} from "./_observability.mjs";

export const AI_SPEECH_MODEL = "gemini-3.1-flash-tts-preview";
export const AI_SPEECH_VOICE = "Kore";
export const AI_SPEECH_SAMPLE_RATE = 24_000;
export const MAX_SPEECH_REQUEST_BYTES = 16 * 1024;
export const MAX_SPEECH_AUDIO_BYTES = 8 * 1024 * 1024;

const GEMINI_INTERACTIONS_URL =
  "https://generativelanguage.googleapis.com/v1beta/interactions";
const SPEECH_STREAM_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";

const LOCAL_SPEECH_ORIGINS = new Set([
  "http://127.0.0.1:5500",
  "http://localhost:5500",
]);

const speechRequestSchema = z
  .object({
    text: z.string().trim().min(1).max(2_400),
  })
  .strict();

function isAllowedLocalOrigin(request) {
  return LOCAL_SPEECH_ORIGINS.has(request.headers.get("origin") || "");
}

function responseHeaders(request, context, extra = {}) {
  const headers = observabilityHeaders(context, extra);
  if (isAllowedLocalOrigin(request)) {
    headers["Access-Control-Allow-Origin"] = request.headers.get("origin");
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] =
      "Authorization, Content-Type, X-StampNote-Trace-Id";
    headers.Vary = "Origin";
  }
  return headers;
}

function jsonResponse(body, status, request, context) {
  return Response.json(body, { status, headers: responseHeaders(request, context) });
}

function bearerToken(request) {
  const match = /^Bearer\s+([^\s]{20,4096})$/i.exec(
    request.headers.get("authorization") || "",
  );
  return match?.[1] || null;
}

export function cleanSpeechText(value) {
  return String(value || "")
    .replace(/\[((?:S|G)\d+(?:\s*,\s*(?:S|G)\d+)*)\]/gi, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeBase64Audio(value) {
  const normalized = String(value || "").replace(/\s+/g, "");
  if (
    !normalized ||
    normalized.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
  ) {
    const error = new Error("Gemini speech returned invalid base64 audio.");
    error.code = "invalid_audio_encoding";
    error.statusCode = 502;
    throw error;
  }
  return Buffer.from(normalized, "base64");
}

function speechPrompt(text) {
  return (
    "Read in a clear, natural professional voice at a brisk, easy-to-understand pace. " +
    "Begin immediately and recite only the transcript below.\n\nTranscript:\n" +
    text
  );
}

function interactionRequest(speechText, stream = false) {
  return {
    model: AI_SPEECH_MODEL,
    input: speechPrompt(speechText),
    response_format: { type: "audio" },
    generation_config: {
      speech_config: [{ voice: AI_SPEECH_VOICE }],
    },
    ...(stream ? { stream: true } : {}),
    store: false,
  };
}

function wavFromPcm(pcm, sampleRate = AI_SPEECH_SAMPLE_RATE, channels = 1) {
  const header = Buffer.alloc(44);
  const bitsPerSample = 16;
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function generatedAudio(body) {
  const candidates = [];
  if (body?.output_audio && typeof body.output_audio === "object") {
    candidates.push(body.output_audio);
  }
  for (const candidate of Array.isArray(body?.candidates) ? body.candidates : []) {
    for (const part of Array.isArray(candidate?.content?.parts)
      ? candidate.content.parts
      : []) {
      if (part?.inlineData && typeof part.inlineData === "object") {
        candidates.push(part.inlineData);
      }
      if (part?.inline_data && typeof part.inline_data === "object") {
        candidates.push(part.inline_data);
      }
    }
  }
  for (const step of Array.isArray(body?.steps) ? body.steps : []) {
    for (const content of Array.isArray(step?.content) ? step.content : []) {
      if (content?.type === "audio") {
        candidates.push(content);
      }
    }
  }
  return candidates.find((candidate) => typeof candidate?.data === "string") || null;
}

function upstreamSpeechError(response, body) {
  const providerError = body?.error || body;
  const error = new Error(
    String(providerError?.message || `Gemini speech returned HTTP ${response.status}.`),
  );
  error.statusCode = response.status;
  error.code = String(providerError?.status || providerError?.code || "upstream_error");
  error.providerStatus = String(providerError?.status || "");
  return error;
}

export async function synthesizeOperationsSpeech(input, options = {}) {
  const parsed = speechRequestSchema.parse(input);
  const speechText = cleanSpeechText(parsed.text);
  if (!speechText) {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["text"],
        message: "The operations answer has no speakable text.",
      },
    ]);
  }

  const apiKey = String(
    options.apiKey || process.env.GOOGLE_GENERATIVE_AI_API_KEY || "",
  ).trim();
  if (!apiKey) {
    const error = new Error("The Gemini API key is not configured.");
    error.code = "configuration_missing";
    throw error;
  }

  const runFetch = options.fetch || fetch;
  const response = await runFetch(GEMINI_INTERACTIONS_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(interactionRequest(speechText)),
    signal: options.abortSignal,
  });

  const responseText = await response.text();
  let body;
  try {
    body = responseText ? JSON.parse(responseText) : {};
  } catch {
    body = {};
  }
  if (!response.ok) {
    throw upstreamSpeechError(response, body);
  }

  const audioPart = generatedAudio(body);
  if (!audioPart) {
    const error = new Error("Gemini speech returned no audio content.");
    error.statusCode = 502;
    error.code = "missing_audio_content";
    throw error;
  }
  const decodedAudio = decodeBase64Audio(audioPart.data);
  const mimeType = String(audioPart.mime_type || audioPart.mimeType || "audio/l16")
    .split(";")[0]
    .toLowerCase();
  const hasWavHeader =
    decodedAudio.subarray(0, 4).toString("ascii") === "RIFF" &&
    decodedAudio.subarray(8, 12).toString("ascii") === "WAVE";
  let audio;
  if (hasWavHeader) {
    audio = decodedAudio;
  } else if (mimeType === "audio/l16" || mimeType === "audio/wav") {
    const sampleRate = Number(audioPart.sample_rate || audioPart.sampleRate);
    const channels = Number(audioPart.channels);
    audio = wavFromPcm(
      decodedAudio,
      Number.isInteger(sampleRate) && sampleRate > 0
        ? sampleRate
        : AI_SPEECH_SAMPLE_RATE,
      Number.isInteger(channels) && channels > 0 ? channels : 1,
    );
  } else {
    const error = new Error(`Gemini speech returned unsupported audio type ${mimeType}.`);
    error.statusCode = 502;
    error.code = "unsupported_audio_type";
    throw error;
  }
  if (!audio.length || audio.length > MAX_SPEECH_AUDIO_BYTES) {
    const error = new Error("Gemini speech returned an invalid audio size.");
    error.statusCode = 502;
    error.code = "invalid_audio_size";
    throw error;
  }
  return {
    audio,
    model: AI_SPEECH_MODEL,
    voice: AI_SPEECH_VOICE,
  };
}

function sseData(block) {
  return String(block || "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
}

function streamedAudio(event) {
  const delta = event?.event_type === "step.delta" ? event.delta : null;
  return delta?.type === "audio" && typeof delta.data === "string" ? delta : null;
}

function decodedBase64Bytes(value) {
  const normalized = String(value || "").replace(/\s+/g, "");
  if (
    !normalized ||
    normalized.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
  ) {
    const error = new Error("Gemini speech returned invalid streaming audio.");
    error.code = "invalid_audio_encoding";
    error.statusCode = 502;
    throw error;
  }
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return {
    data: normalized,
    bytes: Math.floor((normalized.length * 3) / 4) - padding,
  };
}

function sanitizedSpeechStream(upstreamBody, callbacks = {}) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = upstreamBody.getReader();
  let cancelled = false;
  let audioBytes = 0;

  return new ReadableStream({
    async start(controller) {
      controller.enqueue(
        encoder.encode(
          `${JSON.stringify({
            type: "metadata",
            model: AI_SPEECH_MODEL,
            voice: AI_SPEECH_VOICE,
            sampleRate: AI_SPEECH_SAMPLE_RATE,
            channels: 1,
          })}\n`,
        ),
      );
      let pending = "";
      let receivedAudio = false;

      function emit(block) {
        const data = sseData(block);
        if (!data || data === "[DONE]") return;
        let event;
        try {
          event = JSON.parse(data);
        } catch {
          return;
        }
        const audio = streamedAudio(event);
        if (!audio) return;
        const decoded = decodedBase64Bytes(audio.data);
        audioBytes += decoded.bytes;
        if (audioBytes > MAX_SPEECH_AUDIO_BYTES) {
          const error = new Error("Gemini speech returned too much streaming audio.");
          error.code = "invalid_audio_size";
          error.statusCode = 502;
          throw error;
        }
        receivedAudio = true;
        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({
              type: "audio",
              data: decoded.data,
              mimeType: String(audio.mime_type || audio.mimeType || "audio/l16"),
              sampleRate:
                Number(audio.sample_rate || audio.sampleRate) || AI_SPEECH_SAMPLE_RATE,
              channels: Number(audio.channels) || 1,
            })}\n`,
          ),
        );
      }

      try {
        while (!cancelled) {
          const { value, done } = await reader.read();
          pending += decoder.decode(value || new Uint8Array(), { stream: !done });
          const blocks = pending.split(/\r?\n\r?\n/);
          pending = blocks.pop() || "";
          blocks.forEach(emit);
          if (done) break;
        }
        if (cancelled) return;
        if (pending.trim()) emit(pending);
        if (!receivedAudio) {
          const error = new Error("Gemini speech returned no streaming audio.");
          error.code = "missing_audio_content";
          error.statusCode = 502;
          throw error;
        }
        controller.enqueue(encoder.encode(`${JSON.stringify({ type: "done" })}\n`));
        controller.close();
        callbacks.onComplete?.(audioBytes);
      } catch (error) {
        if (cancelled) return;
        callbacks.onError?.(error);
        controller.error(error);
      }
    },
    cancel(reason) {
      cancelled = true;
      return reader.cancel(reason);
    },
  });
}

export async function streamOperationsSpeech(input, options = {}) {
  const parsed = speechRequestSchema.parse(input);
  const speechText = cleanSpeechText(parsed.text);
  if (!speechText) {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["text"],
        message: "The operations answer has no speakable text.",
      },
    ]);
  }
  const apiKey = String(
    options.apiKey || process.env.GOOGLE_GENERATIVE_AI_API_KEY || "",
  ).trim();
  if (!apiKey) {
    const error = new Error("The Gemini API key is not configured.");
    error.code = "configuration_missing";
    throw error;
  }

  const runFetch = options.fetch || fetch;
  const response = await runFetch(GEMINI_INTERACTIONS_URL, {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      "Api-Revision": "2026-05-20",
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(interactionRequest(speechText, true)),
    signal: options.abortSignal,
  });
  if (!response.ok) {
    const responseText = await response.text();
    let body;
    try {
      body = responseText ? JSON.parse(responseText) : {};
    } catch {
      body = {};
    }
    throw upstreamSpeechError(response, body);
  }
  if (!response.body?.getReader) {
    const error = new Error("Gemini speech streaming is unavailable.");
    error.code = "missing_audio_stream";
    error.statusCode = 502;
    throw error;
  }
  return {
    stream: sanitizedSpeechStream(response.body, options),
    model: AI_SPEECH_MODEL,
    voice: AI_SPEECH_VOICE,
  };
}

function safeSpeechError(error) {
  const statusCode = Number(error?.statusCode) || 0;
  const message = String(error?.message || "");
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return {
      status: 400,
      category: "invalid_payload",
      message:
        error instanceof z.ZodError
          ? error.issues[0]?.message || "The speech request is invalid."
          : "The speech request is not valid JSON.",
    };
  }
  if (statusCode === 429 || /quota|rate.?limit|resource.?exhausted/i.test(message)) {
    return {
      status: 429,
      category: "quota_exhausted",
      message: "Gemini voice is busy or out of quota. Try again shortly.",
    };
  }
  if (statusCode === 404 || /model.*(?:not found|unavailable)/i.test(message)) {
    return {
      status: 503,
      category: "model_unavailable",
      message: `The configured Gemini voice model (${AI_SPEECH_MODEL}) is unavailable for this API key.`,
    };
  }
  if (
    error?.code === "configuration_missing" ||
    statusCode === 401 ||
    statusCode === 403 ||
    /api.?key|credential|permission.?denied|forbidden/i.test(message)
  ) {
    return {
      status: 503,
      category: "configuration",
      message: "Gemini voice is not configured for this deployment.",
    };
  }
  return {
    status: 502,
    category: error?.name === "AbortError" ? "request_aborted" : "upstream_failure",
    message: "Gemini could not generate the voice response. Try again.",
  };
}

export async function handleSpeechRequest(request, options = {}) {
  const context = createRequestContext(request, "/api/speech");
  const verifyToken = options.verifyToken || verifyFirebaseIdToken;
  const synthesize = options.synthesize || synthesizeOperationsSpeech;
  const streamSpeech = options.streamSpeech || streamOperationsSpeech;
  logRequestStarted(context, request);

  function respond(body, status, outcome, fields = {}) {
    logRequestCompleted(context, status, { outcome, ...fields });
    return jsonResponse(body, status, request, context);
  }

  if (request.method === "OPTIONS" && isAllowedLocalOrigin(request)) {
    logRequestCompleted(context, 204, { outcome: "preflight" });
    return new Response(null, { status: 204, headers: responseHeaders(request, context) });
  }
  if (request.method !== "POST") {
    return respond({ error: "Use POST for Gemini speech." }, 405, "rejected", {
      reason: "method",
    });
  }
  const declaredBytes = Number(request.headers.get("content-length")) || 0;
  if (declaredBytes > MAX_SPEECH_REQUEST_BYTES) {
    return respond({ error: "The speech request is too large." }, 413, "rejected", {
      reason: "too_large",
      requestBytes: declaredBytes,
    });
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (
    fetchSite &&
    !["same-origin", "same-site", "none"].includes(fetchSite) &&
    !isAllowedLocalOrigin(request)
  ) {
    return respond({ error: "Cross-site speech requests are not allowed." }, 403, "rejected", {
      reason: "cross_site",
    });
  }
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "")) {
    return respond({ error: "Gemini speech expects JSON." }, 415, "rejected", {
      reason: "content_type",
    });
  }

  try {
    const token = bearerToken(request);
    if (!token) {
      return respond({ error: "Sign in before using Gemini voice." }, 401, "rejected", {
        reason: "missing_auth",
      });
    }
    const verified = await verifyToken(token, { abortSignal: request.signal });
    if (!verified) {
      return respond({ error: "Your sign-in could not be verified. Sign in again." }, 401, "rejected", {
        reason: "invalid_auth",
      });
    }
    if (verified.role !== "admin") {
      return respond({ error: "Gemini voice is available to administrators only." }, 403, "rejected", {
        reason: "forbidden_role",
      });
    }

    const text = await request.text();
    const requestBytes = Buffer.byteLength(text);
    if (requestBytes > MAX_SPEECH_REQUEST_BYTES) {
      return respond({ error: "The speech request is too large." }, 413, "rejected", {
        reason: "too_large",
        requestBytes,
      });
    }
    const payload = JSON.parse(text);
    const wantsStream = /\bapplication\/x-ndjson\b/i.test(
      request.headers.get("accept") || "",
    );
    logEvent(context, "info", "ai.speech.started", {
      model: AI_SPEECH_MODEL,
      voice: AI_SPEECH_VOICE,
      textLength: String(payload?.text || "").length,
      requestBytes,
    });
    if (wantsStream) {
      const result = await streamSpeech(payload, {
        abortSignal: request.signal,
        onComplete(audioBytes) {
          logEvent(context, "info", "ai.speech.completed", {
            model: AI_SPEECH_MODEL,
            voice: AI_SPEECH_VOICE,
            audioBytes,
            streamed: true,
            durationMs: Date.now() - context.startedAt,
          });
        },
        onError(streamError) {
          logEvent(context, "error", "ai.speech.failed", {
            category: "stream_failure",
            errorCode: safeErrorCode(streamError),
            streamed: true,
          });
        },
      });
      logEvent(context, "info", "ai.speech.stream_ready", {
        model: result.model,
        voice: result.voice,
        durationMs: Date.now() - context.startedAt,
      });
      logRequestCompleted(context, 200, {
        outcome: "streaming",
        model: result.model,
        voice: result.voice,
      });
      return new Response(result.stream, {
        status: 200,
        headers: responseHeaders(request, context, {
          "Cache-Control": "no-store, no-transform",
          "Content-Type": SPEECH_STREAM_CONTENT_TYPE,
          "X-StampNote-AI-Model": result.model,
          "X-StampNote-AI-Voice": result.voice,
        }),
      });
    }

    const result = await synthesize(payload, { abortSignal: request.signal });
    logEvent(context, "info", "ai.speech.completed", {
      model: result.model,
      voice: result.voice,
      audioBytes: result.audio.length,
      durationMs: Date.now() - context.startedAt,
    });
    logRequestCompleted(context, 200, {
      outcome: "generated",
      model: result.model,
      voice: result.voice,
      audioBytes: result.audio.length,
    });
    return new Response(result.audio, {
      status: 200,
      headers: responseHeaders(request, context, {
        "Content-Type": "audio/wav",
        "Content-Length": String(result.audio.length),
        "X-StampNote-AI-Model": result.model,
        "X-StampNote-AI-Voice": result.voice,
      }),
    });
  } catch (error) {
    const safe = safeSpeechError(error);
    const upstreamStatus = Number(error?.statusCode) || undefined;
    const providerStatus = error?.providerStatus
      ? safeErrorCode({ code: error.providerStatus })
      : undefined;
    logEvent(context, safe.status >= 500 ? "error" : "warning", "ai.speech.failed", {
      category: safe.category,
      errorCode: safeErrorCode(error),
      upstreamStatus,
      providerStatus,
    });
    return respond({ error: safe.message }, safe.status, "failed", {
      category: safe.category,
    });
  }
}
