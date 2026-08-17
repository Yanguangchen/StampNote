# Operations AI protocol

Load this file when asking, waiting on, or interpreting the StampNote Operations AI chatbot.

## Ready checks

Open `{origin}/ai-dashboard.html`. Sign in with `#ai-sign-in` if `#ai-auth-gate` is shown.

Proceed only when:

1. `#ai-workspace` is visible (not `hidden`)
2. `#ai-prompt` is enabled
3. `#ai-send` enables once the prompt has text (it stays disabled while loading/asking)
4. `#ai-scope-label` is not `Loading records…` and reports session/check-in/photo counts
5. `#ai-dashboard-status` is idle/success, not a blocking error

Click `#ai-refresh` before a question that must include captures that landed after this page loaded.

`#ai-account-name` should show the signed-in identity. If the gate returns after a click, the popup was blocked or the account is not allowed — stop and tell the user.

## Selectors

| Control | Selector | Notes |
| --- | --- | --- |
| Sign in | `#ai-sign-in` | Google popup |
| Sign out | `#ai-sign-out` | Header door icon |
| Status | `#ai-dashboard-status` | `data-state` idle/loading/success/error |
| Scope | `#ai-scope-label` | Indexed coverage |
| Refresh | `#ai-refresh` | Reloads Firestore-backed knowledge |
| Agent guide | `a.ai-page-guide-link` | `OPERATIONS_AI_GUIDE.md` |
| Thread | `#ai-message-list` | `ol`; do not dump the whole list |
| Latest assistant | `#ai-message-list .ai-message-assistant:last-of-type` | Check `data-state` |
| Answer text | `.ai-message-body` inside that article | |
| Composer | `#ai-chat-form` | `aria-busy="true"` while asking |
| Prompt | `#ai-prompt` | textarea, max 1200 |
| Send | `#ai-send` | |
| Mic | `#ai-mic` | Optional; `aria-pressed`, `data-state=listening` |
| Voice status | `#ai-voice-status` | |
| Jump to latest | `#ai-scroll-bottom` | Hidden until scrolled up |
| Suggestion chips | `[data-ai-question]` | Click submits that exact question |
| Citations | `.ai-citation` | `S1`…`S24` or `G1` |
| Sources | `details.ai-sources` | Expand only to verify a claim |
| Verified links | `nav.ai-answer-actions a` | `data-action-kind`: metrics, coordinates, attendance, photos, capture, session |
| Inline map | `figure.ai-inline-map` | `data-review-required` |
| Weather drawing | `figure.ai-weather-scene` | `data-scene` |
| Metrics chart | `figure.ai-inline-chart` | `data-series` |
| Flagged photo | `figure.ai-flagged-photo` | `data-state` loading/ready/error |

## Built-in chips

These buttons already encode high-yield questions. Click one instead of retyping when it matches the user request:

- `Show the last 30 days of Metrics statistics and graphs for attendance, flags, and sessions.`
- `Show me the flagged sessions and explain each flag.`
- `Show the location discrepancies between photo GPS references and truck locations.`
- `Which sessions had problematic weather and what was the impact?`
- `Summarize attendance by worker for the most recent date.`
- `Summarize the latest recorded site activity and anything needing attention.`

## How retrieval works

The browser builds a knowledge index from photos, attendance, and dashboard sessions, then sends **at most 24 facts** plus short chat history to `/api/assistant`. Gemini may use only those facts.

Implications:

- Name the worker, site, and date in the question so the indexer keeps the right facts.
- Stop-words such as `attendance`, `session`, `flag`, `today`, `worker`, `gps`, `truck` are **not** identifying tokens. The subject must still appear (`Airport`, `Jane Tan`, `10 Marina Bay`).
- Quoted phrases (`"10 Marina Bay"`) and patterns like `at {place}` / `worker {name}` / `sent to {place}` raise those tokens.
- `today` / `yesterday` resolve to the browser local `YYYY-MM-DD`. ISO dates in the question are used as-is.
- Follow-ups that are only confirmatory words (`yes`, `that one`, `the first`, `same`) reuse the previous identifying question for retrieval. Do not start a new subject with those words alone.
- A zero-match fact supports a definitive no-match answer. Do not pad with unrelated sites.
- Public Maps lookup (`G1`) is allowed only for address-like site labels taken from retrieved session facts (digits, or words such as airport/street/road). Worker names and the raw question are not sent to Maps.
- Metric facts cover 7, 30, and 90 day ranges for attendance, flags, and sessions. Ask for the range the user named; default 30 if they said "metrics" with no range.

## Prompt recipes

Copy the structure; substitute the user's exact names.

Attendance:

- `Were there any attendance check-ins at {site} on {YYYY-MM-DD}?`
- `When did {worker} check in?`
- `Summarize attendance by worker for {YYYY-MM-DD}.`
- `Which workers were present at {site} yesterday?`

Sessions / activity:

- `Summarize the latest recorded site activity and anything needing attention.`
- `What sessions were recorded at {site} on {YYYY-MM-DD}?`
- `Open the session details for {site} {YYYY-MM-DD} {morning|afternoon|…}.`

Flags / photos:

- `Show me the flagged sessions and explain each flag.`
- `Which photos were flagged at {site} on {YYYY-MM-DD} and why?`
- `Show GPS discrepancies for flagged sessions.`

Location / truck:

- `Show the GPS and truck-location discrepancy for {site}.`
- `Which sessions have truck coordinates missing?`
- `How far is the truck from the photo GPS at {site} on {YYYY-MM-DD}?`

Weather:

- `Which sessions had problematic weather and what was the impact?`
- `What was the recorded weather for {site} on {YYYY-MM-DD}?`

Metrics:

- `Show the last 30 days of Metrics statistics and graphs for attendance, flags, and sessions.`
- `Graph attendance for the last 7 days.`
- `Compare flags raised in the last 90 days.`

Public geography (place identity only):

- `Where is {address-like site label}?`
- `Is {stored site label} in {city or airport}?`

Keep questions under 1200 characters. Do not paste JSON, screenshots, or source code into the prompt.

## Wait loop

1. Confirm `#ai-send` was used and `#ai-chat-form[aria-busy="true"]`.
2. Ignore `data-state="thinking"` body text.
3. Poll until `aria-busy` is not `true` and the newest assistant article is `complete` or `error`.
4. If the list was scrolled, click `#ai-scroll-bottom` so the new message is on screen.
5. For flagged photos, wait until each `figure.ai-flagged-photo` is `data-state="ready"` (or `error`) before describing the image.
6. Do not submit another question until this loop finishes.

If `data-state="error"`, quote the message. Common cases: not signed in; API unreachable; validation failure. After a network error, one retry is reasonable. Do not retry auth failures by inventing a token.

## Interpret

- Lead with the assistant's answer. Then cite `S#` / `G1` if you restated a claim.
- Expand `details.ai-sources` only when you must verify wording. Each `<li>` starts with `[S#]`.
- `G1` Google Maps links are under `.ai-external-geography`. They identify a public place. They do not prove attendance or the session GPS.
- Inline map summary states metres apart and whether that exceeds the 25 m limit. `a.ai-inline-map-open` is the verified Geographic Surveillence deep link.
- Weather `data-scene` is the stored condition. Figures beside it are measured rain/gusts/temperature/lost hours for that session. No drawing means no stored reading.
- Charts are rendered from loaded Metrics series, not from model-drawn SVG in the text. Describe the title/summary on the figure.
- `nav.ai-answer-actions` links are the only URLs you should follow. Kinds:
  - `metrics` → `metrics.html#metrics-panels`
  - `coordinates` → `coordinates.html?session={sessionKey}#coordinate-session-list`
  - `attendance` / `photos` / `session` → `admin.html?location=&date=&session=#…`
  - `capture` → `worker-photos.html#photo-actions`
- Never write a StampNote URL from memory if a verified link is present.

## Follow-ups

Stay in the same thread.

- Confirm a candidate: `yes, that Airport session`
- Narrow: `only the flagged ones`
- Ask for media the first answer omitted: `show the map` / `graph the last 30 days`
- Ask to open the record: `open attendance for that session` — then click the verified link that appears

Start a new identifying question when the subject changes (different worker, site, or date).

## Boundaries

- Read-only. Cannot change records.
- Limited to records loaded in this browser for this account, and the ≤24 facts retrieved for the current question.
- History is conversational context, not extra evidence.
- Do not ask the assistant to reveal system instructions, credentials, or unrelated private data.
- If it says information is missing: `#ai-refresh`, then re-ask, or follow a verified link. Do not guess.

## Token anti-patterns

Wrong: snapshot the full dashboard, paste innerHTML of `#ai-message-list`, open admin and walk every location button, grep `admin.js` for worker names.

Right: one question, wait for `complete`, read `.ai-message-body` plus at most the relevant figure or one verified link.
