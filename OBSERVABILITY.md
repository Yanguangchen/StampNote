# StampNote observability

StampNote emits small, structured operational events to Vercel Runtime Logs. The purpose is to answer four questions without collecting photo or account content:

1. Is the deployed server configured and responding?
2. Are Gemini reviews completing, failing, or being rejected before the model call?
3. Are reviewed photos reaching Firestore?
4. Is the camera/tracker/dashboard healthy in the browser?

## Privacy contract

Telemetry may contain event names, anonymous per-page session IDs, short-lived trace IDs, counts, durations, HTTP status codes, booleans, fixed status values, and normalized error codes.

Telemetry must never contain:

- image bytes, data URLs, thumbnails, model output, or Gemini reasons;
- photo IDs, Firestore document paths, addresses, coordinates, filenames, or OCR text;
- names, email addresses, Firebase UIDs, OAuth tokens, API keys, or raw error messages;
- arbitrary browser strings or user-entered values.

The browser sanitizer drops every field that is not on its fixed allowlist. The server independently validates the same allowlist with a strict schema and rejects the entire batch if it contains an extra field. Request bodies are limited to 24 KiB and 20 events. Telemetry is best-effort and never blocks capture, review, or cloud sync.

## Signals

| Area | Success events | Failure events | Useful fields |
| --- | --- | --- | --- |
| HTTP functions | `http.request.completed` | status `4xx` or `5xx` | `route`, `statusCode`, `durationMs`, `requestId`, `traceId` |
| Gemini | `ai.review.completed` | `ai.review.failed` | `batchSize`, `reviewedCount`, `flaggedCount`, `category`, `errorCode`, `httpStatus` |
| Firestore sync | `cloud.sync.completed` | `cloud.sync.failed` | `uploadedCount`, `queuedCount`, `failedCount`, `durationMs`, `operationTraceId` |
| Google sign-in | `cloud.auth.state` | `cloud.auth.failed` | fixed `status`, `errorCode` |
| Camera and tracking | `capture.monitor.started`, `tracking.recovered` | `capture.monitor.failed`, `tracking.failed` | `errorCode`, `durationMs` |
| Dashboard | `dashboard.load.completed`, `health.checked` | `dashboard.load.failed`, `dashboard.image.failed` | `photoCount`, `durationMs`, `httpStatus`, `errorCode` |
| Browser performance | `web.vital`, `client.ready` | `client.error` | `metricName`, `metricValue`, `metricRating`, `online` |

Browser operation events may carry a `traceId`. The telemetry intake writes that value to Runtime Logs as `operationTraceId`, keeping it distinct from the telemetry batch's own request trace. Gemini requests send the operation ID as `X-StampNote-Trace-Id`, so one review can be followed from `ai.review.started` to the server-side Gemini result. Every function response includes `X-Request-Id`, `X-StampNote-Trace-Id`, and `Server-Timing`.

## Health check

```sh
curl -i https://stampnote-omega.vercel.app/api/health
```

An HTTP 200 with `"status":"ok"` means the function is running and the Gemini environment variable exists. HTTP 503 with `"status":"degraded"` means the function is running but `GOOGLE_GENERATIVE_AI_API_KEY` is absent. The `deployment.release` value is Vercel's unique deployment ID (or the commit when running outside a Vercel deployment), so an incident can be tied to the exact release. This is a configuration/readiness check; it intentionally does not spend Gemini credits or access Firestore.

The dashboard runs this check when it opens and shows **System online**, **System degraded**, or **System unavailable** in its header.

## Inspecting production

Use the current CLI so log filtering behavior matches the platform. The installed 51.3.0 release should be upgraded to the current 58.10.0 release before operating the project:

```sh
npm i -g vercel@latest
vercel whoami
vercel link
vercel logs --environment production --since 1h --expand
```

Useful filters:

```sh
vercel logs --environment production --since 1h --query 'ai.review.failed' --expand
vercel logs --environment production --since 1h --query 'cloud.sync.failed' --expand
vercel logs --environment production --since 1h --query 'tracking.failed' --expand
vercel logs --environment production --since 1h --level error --expand
```

Copy an `operationTraceId`, `traceId`, or `requestId` from a failure and use it as the query to isolate that operation. If StampNote remains on Vercel Hobby, Runtime Logs retain one hour of entries, so investigate promptly. Check [Vercel's Runtime Logs limits](https://vercel.com/docs/logs/runtime) before relying on a retention window; longer storage requires a plan/add-on with more retention or a compatible log drain.

## Failure runbooks

### Gemini review fails

1. Find the browser `ai.review.failed` entry and copy its `operationTraceId`.
2. Search that value to find the `/api/triage` entries whose `traceId` matches it, then inspect the corresponding `http.request.completed` event.
3. Use `category` and `statusCode`:
   - `invalid_payload` / 400: the browser batch did not match the API contract.
   - `quota_exhausted` / 429: inspect Google AI Studio quota or billing.
   - `invalid_api_key`, `permission_denied`, or `configuration_missing` / 503: repair `GOOGLE_GENERATIVE_AI_API_KEY` in Vercel and redeploy.
   - `model_unavailable` / 503: verify the configured Gemini model.
   - `request_aborted` or `upstream_failure` / 502: retry and check whether failures repeat across sessions.
4. Confirm `/api/health` returns 200. Unreviewed local originals remain untouched after any failure.

### Reviewed photos do not appear in Firestore

1. Look for `cloud.auth.state` with `signed_in`.
2. Find `cloud.sync.failed`; compare `failedCount` and `queuedCount`.
3. `online:false` indicates a client connectivity problem. Firebase codes such as `permission-denied`, `failed-precondition`, or `auth/...` identify rules, database setup, or Google sign-in failures.
4. Sign in again and let the idempotent local queue retry. Do not delete local captures while diagnosing.

### Tracking freezes or the camera will not start

1. Find `capture.monitor.failed` for permission, browser, or detector startup failures.
2. Find `tracking.failed`, then check whether `tracking.recovered` follows it.
3. A repeating failure without recovery indicates a persistent device/model issue. A single failure followed by recovery confirms the self-scheduling loop recovered.
4. Compare `web.vital` long-task duration; a large value indicates the main thread was heavily occupied.

### Dashboard is empty or images fail

1. Confirm the header health check is online.
2. Find `cloud.auth.state`; the dashboard only queries after `signed_in`.
3. Use `dashboard.load.failed` for Firestore query errors and `dashboard.image.failed` for image-byte decoding failures.
4. If health is good but Firestore fails, check Firebase Authentication authorized domains and deploy `firestore.rules` again.

## Local verification

```sh
npm test
npm run test:coverage
npm start
curl -i http://127.0.0.1:8080/api/health
```

A local POST to `/api/telemetry` should return 202 only when its JSON matches the strict schema. Tests cover browser field stripping, server rejection of private extra fields, bounded retries, request correlation, safe error classification, CORS/preflight behavior, healthy and degraded states, and all three Vercel route adapters. See the [Vercel logs CLI reference](https://vercel.com/docs/cli/logs) for current filtering options.
