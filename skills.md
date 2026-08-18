---
name: stampnote-platform
description: "Navigate the StampNote field-operations web platform in a browser. Prefer the Operations AI chatbot for attendance, sessions, flags, weather, GPS/truck discrepancies, photos, and metrics so lookups stay cheap. Sign in with Google/Gmail first if the private-workspace gate is shown. Live site: https://stampnote-omega.vercel.app/ — Operations AI shortcut: https://stampnote-omega.vercel.app/ai-dashboard. Use when operating StampNote, answering operational questions, inspecting Photos & attendance, Geographic Surveillence, Coordinate entry, Metrics, Recording, Worker photos, or Worker onboarding, entering truck X/Y, or following verified in-app links."
---

# StampNote platform

StampNote is a signed-in field-operations app. Recording captures stamped site photos; admin pages review attendance, photos, GPS/truck positions, and metrics.

**Live site:** [https://stampnote-omega.vercel.app/](https://stampnote-omega.vercel.app/)  
**Operations AI shortcut:** [https://stampnote-omega.vercel.app/ai-dashboard](https://stampnote-omega.vercel.app/ai-dashboard)

**Default lookup path is Operations AI**, not page scraping, HTML dumps, screenshots of galleries, Firestore, or reading application source to reconstruct records. The chatbot already indexes the signed-in workspace in the browser and returns cited answers plus verified links. That is the cheap, correct way to find information.

## Sign in (Google / Gmail)

Every admin and Operations AI surface is behind a private-workspace gate. If the agent is not already signed in, it **must** sign in with Google (Gmail) before asking questions or reading records.

Signing in with any current StampNote Gmail is enough. **Every current user is a superadmin** and can open Operations AI and the rest of the admin workspace. The app treats a signed-in account as admin unless Firebase explicitly marks it `stampnoteRole: "worker"` (none of the current accounts are field staff).

1. Open [https://stampnote-omega.vercel.app/ai-dashboard](https://stampnote-omega.vercel.app/ai-dashboard) (or any other StampNote page).
2. If a gate is visible — heading like **Sign in to ask about your operations** / **Continue with Google** — click that button (`#ai-sign-in` on Operations AI; other pages have their own sign-in ids below).
3. Complete the Google account popup with a StampNote Gmail. Do not scrape cookies, invent tokens, or bypass the gate.
4. Wait until the workspace is visible and the prompt/controls are enabled. If the popup is blocked or the account is not allowed, stop and tell the user.
5. Use the **same** Google account on every StampNote page. Anonymous visitors are blocked.

Sign-out is the door-and-arrow header control. Do not sign out unless the user asked.

### `Missing or insufficient permissions`

That exact Firebase string means Firestore refused the request. For current users this is **not** “the wrong Gmail / not an admin”. All current accounts are superadmins. `yanguangchensp@gmail.com` is the capture / superadmin Gmail. Treat the error as a stale token, blocked popup, or undeployed Firestore rules (live rules historically denied `collectionGroup("photos")`).

Also stop and recover for:

- `Missing or insufficient permissions.`
- `Firebase denied access…` / `permission-denied` / `Check that this is the capture account.`
- `This page is for administrators`
- `Operations AI is available to administrators only.`

What to do:

1. Do **not** hunt for a different “admin mailbox”, scrape other pages, or invent records.
2. Click sign-out (`#ai-sign-out` or the door icon).
3. Click **Continue with Google** and pick the **same** StampNote Gmail again (`prompt: select_account` is already set).
4. Reload [https://stampnote-omega.vercel.app/ai-dashboard](https://stampnote-omega.vercel.app/ai-dashboard).
5. Wait until `#ai-scope-label` shows session/check-in/photo counts. Only then ask a question.

If it still fails after a fresh sign-in, report that Firestore rules may not be deployed (`stampnoteRole != worker` is the signed-in superadmin check). Agents cannot deploy rules from the browser.

## Token doctrine

Treat browser pixels and DOM as expensive. Treat Operations AI answers as cheap.

Do:

- Open the Operations AI shortcut once, sign in with a StampNote Gmail if needed, wait until records are ready, then ask.
- Ask **one focused question** with the exact worker name, site label, and date.
- Read the completed assistant message, its citation chips, source disclosure, and verified "Go to record" links.
- Follow a verified link only when the task needs the underlying photo, map, form, or edit control.
- Reuse the same chat for follow-ups (`yes that one`, `show the map for that session`).

Do not:

- Dump `#ai-message-list`, `#coordinate-data`, `#agent-data`, or admin galleries into context "just in case".
- Screenshot long lists or photo grids when a question would answer the request.
- Open Photos & attendance and click Street → Address → Date → Session to hunt a fact the chatbot can retrieve.
- Read `admin.js`, `ai-dashboard.js`, or Firestore paths to answer "who checked in today".
- Invent URLs, worker IDs, dates, counts, or truck coordinates.
- Submit a second question while `.ai-chat-form` has `aria-busy="true"`.

## Origins and pages

| Origin | URL |
| --- | --- |
| Production | [https://stampnote-omega.vercel.app/](https://stampnote-omega.vercel.app/) |
| Operations AI (use this first) | [https://stampnote-omega.vercel.app/ai-dashboard](https://stampnote-omega.vercel.app/ai-dashboard) |
| Local | `http://127.0.0.1:8080` after `npm start` |

Clean URLs work (`/ai-dashboard` as well as `/ai-dashboard.html`). Prefer the production shortcut unless the user asked to use a local server.

Shared chrome: `#sidebar-toggle` opens `#app-sidebar`. Groups are **Worker workspace** (Recording, Worker photos) and **Admin workspace** (Worker onboarding, Geographic Surveillence, Coordinate entry, Operations AI, Photos & attendance, Metrics). Appearance/theme lives in the drawer when the page has `#theme-toggle`.

| Page | Path on production | Role | Writes data? |
| --- | --- | --- | --- |
| Operations AI | [/ai-dashboard](https://stampnote-omega.vercel.app/ai-dashboard) | Read-only Q&A over loaded records | No |
| Photos & attendance | [/admin](https://stampnote-omega.vercel.app/admin) | Session rail, attendance, photos, weather, truck tile | Rename/delete session; truck X/Y |
| Geographic Surveillence | [/coordinates](https://stampnote-omega.vercel.app/coordinates) | GPS vs truck list, map compare, RPA JSON | Truck X/Y |
| Coordinate entry | [/agent-coordinates](https://stampnote-omega.vercel.app/agent-coordinates) | Agent search, filters, batch JSON, truck X/Y | Truck X/Y |
| Metrics | [/metrics](https://stampnote-omega.vercel.app/metrics) | 7/30/90-day attendance, flags, sessions | No |
| Recording | [/](https://stampnote-omega.vercel.app/) | Camera watch, attendance scan, auto capture | Photos, attendance |
| Worker photos | [/worker-photos](https://stampnote-omega.vercel.app/worker-photos) | Take/pick stamped photos without the watch | Photos |
| Worker onboarding | [/onboarding](https://stampnote-omega.vercel.app/onboarding) | Enroll/replace/delete face templates | Worker roster |

`html[data-surface]` names the page: `ai-dashboard`, `dashboard`, `coordinates`, `agent-coordinates`, `metrics`, `capture`, `worker-photos`, `onboarding`.

## Default workflow

```
Task Progress:
- [ ] Open https://stampnote-omega.vercel.app/ai-dashboard
- [ ] If #ai-auth-gate is visible, click Continue with Google and finish Gmail sign-in
- [ ] Wait until #ai-workspace is visible, #ai-prompt is enabled, #ai-scope-label is not "Loading records…"
- [ ] Click #ai-refresh if captures just landed
- [ ] Ask one question in #ai-prompt (or a [data-ai-question] chip)
- [ ] Wait until form aria-busy is false and the newest .ai-message-assistant is data-state="complete"
- [ ] Read .ai-message-body, .ai-sources, maps/charts/weather, and .ai-answer-actions
- [ ] Follow a verified link only if the remaining work cannot be done in chat
```

### Open and sign in

1. Navigate to [https://stampnote-omega.vercel.app/ai-dashboard](https://stampnote-omega.vercel.app/ai-dashboard).
2. If `#ai-auth-gate` is visible, click `#ai-sign-in` (**Continue with Google**). Complete the Gmail/Google popup with the authorized account.
3. Ready means all of:
   - `#ai-workspace` is not `hidden`
   - `#ai-prompt` is enabled
   - `#ai-scope-label` looks like `N sessions · N check-ins · N photos`
   - `#ai-dashboard-status` is not a loading/error state blocking the composer
4. If status shows an error, report it. Do not guess from other pages.

The page loads private operational records into the signed-in browser. Copy record details only to the destination the user asked for.

### Ask

Type in `#ai-prompt` (max 1200 characters) and submit `#ai-send` or form `#ai-chat-form`.

Good questions name the subject and time:

- `Were there any attendance check-ins at Airport today?`
- `When did Jane Tan check in?`
- `Show the flagged sessions and explain each flag.`
- `Graph attendance for the last 30 days.`
- `Show the GPS and truck-location discrepancy for 10 Marina Bay.`

Rules:

- Use the **exact** worker name, site name, or address shown in StampNote when known. Quote it if it contains stop-words (`"T1 Boulevard"` is useful).
- `today` and `yesterday` use the **browser's local date**. Prefer `YYYY-MM-DD` when the user named a calendar day.
- One question per submit. Do not combine unrelated lookups.
- Suggested chips under `.ai-prompt-suggestions` are valid starters; each has `data-ai-question`.
- A short confirmation (`yes that one`, `the first one`) keeps the previous subject. Do not treat it as a new lookup.

### Wait

After submit:

- `.ai-chat-form` has `aria-busy="true"`
- Newest `.ai-message-assistant` has `data-state="thinking"`
- Body may show `Reviewing the relevant records…` — that is **not** the answer

Wait until `aria-busy` is gone and the assistant article is `data-state="complete"` **or** `data-state="error"`. Then:

- `complete`: read `.ai-message-body`. Chat auto-scrolls; a chime may play; `#ai-scroll-bottom` jumps to the latest message if history was scrolled.
- `error`: report the visible error. Do not retry in a tight loop.

Typical wait is several seconds. Poll the two conditions; do not screenshot every frame.

### Read the answer

| Element | Meaning |
| --- | --- |
| `.ai-message-body` | The answer. Lead with this in your reply to the user. |
| `.ai-citation` chips (`S1`…`S24`) | Retrieved operational facts. Open `.ai-sources` if a claim must be checked. |
| `.ai-external-geography` / `G1` | Google Maps place identity only. Never use it as an attendance count or GPS position. |
| `figure.ai-inline-map` | Photo GPS vs truck. `data-review-required="true"` means >25 m. |
| `figure.ai-weather-scene` | Recorded sky for one session (`data-scene`: storm, rain, drizzle, snow, fog, overcast, partly, clear). Not a forecast. |
| `figure.ai-inline-chart` | Metrics series from loaded records (`data-series`: attendance, flags, sessions). |
| `.ai-flagged-photo-gallery` | Authenticated flagged JPEGs cited by photo ID. Wait until `data-state="ready"` before describing pixels. |
| `nav.ai-answer-actions` | Verified in-app links (max 3). Use these instead of constructing URLs. |

A direct no-match sentence means the constrained lookup found no indexed record matching the terms used. Treat it as conclusive only when the user supplied the exact stored worker, address, or site label. A landmark or facility name may not match its stored street address; follow the location-inference workflow below before concluding that no session existed.

The assistant is **read-only**. It cannot edit, rename, delete, capture, upload, approve, or set truck coordinates. If the user asked to change data, finish the lookup in chat, then open the write surface.

## Route after the answer

Stay in Operations AI when the user wants a summary, count, who/when/where, flags, weather impact, GPS discrepancy explanation, metrics trend, or a yes/no about loaded records.

Leave chat only for the matching job:

| Remaining job | Open | Why chat is not enough |
| --- | --- | --- |
| See or restore a photo | Verified "Open session photos" or `/admin` | Chat can cite and sometimes show a flagged thumbnail; the gallery is the source of truth for browsing |
| Review manually added attendance | Ask Operations AI first, then open its verified attendance link | Chat indexes the manual-entry review flag; Photos & attendance is the review surface |
| Edit truck X/Y | Coordinate entry first; Geographic Surveillence for the OSM map | Chat cannot write coordinates |
| Confirm map against OSM | Geographic Surveillence "Compare on map" | Inline AI map is schematic, not Leaflet/OSM |
| Enroll or delete a worker | Worker onboarding | Roster writes |
| Start the camera / take attendance | Recording | Live capture |
| Stamp photos without the watch | Worker photos | Capture path |
| Delete a location/day/session | Photos & attendance rail (user must confirm) | Destructive; never do this unless explicitly asked |
| Read raw JSON for many sessions | `#agent-data` or `#coordinate-data` after filtering | Chat returns at most 24 facts |

## Operations AI protocol

### Ready checks

Open [https://stampnote-omega.vercel.app/ai-dashboard](https://stampnote-omega.vercel.app/ai-dashboard). Sign in with `#ai-sign-in` (**Continue with Google** / Gmail) if `#ai-auth-gate` is shown.

Proceed only when:

1. `#ai-workspace` is visible (not `hidden`)
2. `#ai-prompt` is enabled
3. `#ai-send` enables once the prompt has text (it stays disabled while loading/asking)
4. `#ai-scope-label` is not `Loading records…` and reports session/check-in/photo counts
5. `#ai-dashboard-status` is idle/success, not a blocking error

Click `#ai-refresh` before a question that must include captures that landed after this page loaded.

`#ai-account-name` should show the signed-in identity. If the gate returns after a click, the popup was blocked or the Gmail account is not allowed — stop and tell the user.

### Selectors

| Control | Selector | Notes |
| --- | --- | --- |
| Sign in | `#ai-sign-in` | Google / Gmail popup |
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

### Built-in chips

Click one instead of retyping when it matches the user request:

- `Show the last 30 days of Metrics statistics and graphs for attendance, flags, and sessions.`
- `Show me the flagged sessions and explain each flag.`
- `Show the location discrepancies between photo GPS references and truck locations.`
- `Which sessions had problematic weather and what was the impact?`
- `Summarize attendance by worker for the most recent date.`
- `Summarize the latest recorded site activity and anything needing attention.`

### How retrieval works

The browser builds a knowledge index from photos, attendance, and dashboard sessions, then sends **at most 24 facts** plus short chat history to `/api/assistant`. Gemini may use only those facts.

- Name the worker, site, and date in the question so the indexer keeps the right facts.
- Stop-words such as `attendance`, `session`, `flag`, `today`, `worker`, `gps`, `truck` are **not** identifying tokens. The subject must still appear (`Airport`, `Jane Tan`, `10 Marina Bay`).
- Quoted phrases (`"10 Marina Bay"`) and patterns like `at {place}` / `worker {name}` / `sent to {place}` raise those tokens.
- `today` / `yesterday` resolve to the browser local `YYYY-MM-DD`. ISO dates in the question are used as-is.
- Follow-ups that are only confirmatory words (`yes`, `that one`, `the first`, `same`) reuse the previous identifying question for retrieval.
- A zero-match fact proves that no indexed label matched the query. Use it as a definitive operational no-match only for an exact stored label. For a landmark, airport, terminal, district, building, or colloquial site name, treat it as an unresolved alias and follow the workflow below.
- Public Maps lookup (`G1`) is allowed only for address-like site labels taken from retrieved session facts. Worker names and the raw question are not sent to Maps.
- Metric facts cover 7, 30, and 90 day ranges for attendance, flags, and sessions. Default 30 if the user said "metrics" with no range.
- Attendance facts include worker, date, time, location, and session. A manual entry is indexed as a flagged attendance fact that explicitly says it was added manually and needs review. Its session also counts as flagged. Open the verified Photos & attendance link to inspect the review row.

### Location-label limitation and inference

Treat Operations AI as a literal-first record index, not a complete place-alias or landmark database. It indexes the location label saved on each record. It may lack the context needed to know that a stored street address belongs to a facility named by the user.

Example: if a session is stored as **65 T1 Boulevard** and the user asks, **“Is there any session at Changi Airport?”**, the first lookup may say none because `Changi Airport` does not occur in the stored location. That result means **no exact indexed label matched Changi Airport**; it does not by itself prove that no airport session occurred.

Use this recovery workflow:

1. Ask the user's exact question once and read the cited result.
2. If it returns zero and the requested place is a landmark, airport, terminal, district, building, or informal name, do not relay “none” as the final business conclusion.
3. Retrieve candidate stored locations for the same date or time range, for example: `List the stored session locations on {YYYY-MM-DD}.` If no date was supplied, ask for one or use the explicitly requested recent range.
4. Inspect any reasoning candidates Operations AI provides. A candidate is not yet a confirmed match.
5. For an address-like candidate such as `65 T1 Boulevard`, ask: `Is 65 T1 Boulevard in Changi Airport?` Use the returned `G1` Google Maps evidence only to establish place identity; use the session's `S#` fact to establish that StampNote recorded the session.
6. Make the relationship explicit as an inference or verified geographic relationship: `A session was stored as 65 T1 Boulevard, which Maps identifies as part of Changi Airport [S#, G1].` Say `likely` or `appears to be` when the evidence is suggestive but not conclusive.
7. If no candidate or geographic verification is available, report the limitation: `No session is stored under “Changi Airport”; sessions may be recorded under street-address labels, and no verified matching address was available.`

Never silently convert a broad place name into an address, invent an alias, or cite `G1` alone as proof of attendance or a session. The agent performs the cross-label reasoning; Operations AI supplies the bounded session facts and optional public-place evidence.

### Prompt recipes

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
- `List the stored session locations on {YYYY-MM-DD}.` then `Is {candidate stored address} in {landmark or facility}?`

Keep questions under 1200 characters. Do not paste JSON, screenshots, or source code into the prompt.

### Wait loop

1. Confirm `#ai-send` was used and `#ai-chat-form[aria-busy="true"]`.
2. Ignore `data-state="thinking"` body text.
3. Poll until `aria-busy` is not `true` and the newest assistant article is `complete` or `error`.
4. If the list was scrolled, click `#ai-scroll-bottom` so the new message is on screen.
5. For flagged photos, wait until each `figure.ai-flagged-photo` is `data-state="ready"` (or `error`) before describing the image.
6. Do not submit another question until this loop finishes.

If `data-state="error"`, quote the message. Common cases: not signed in; API unreachable; validation failure. After a network error, one retry is reasonable. Do not retry auth failures by inventing a token.

### Interpret

- Lead with the assistant's answer. Then cite `S#` / `G1` if you restated a claim.
- Expand `details.ai-sources` only when you must verify wording. Each `<li>` starts with `[S#]`.
- `G1` Google Maps links are under `.ai-external-geography`. They identify a public place. They do not prove attendance or the session GPS.
- Inline map summary states metres apart and whether that exceeds the 25 m limit. `a.ai-inline-map-open` is the verified Geographic Surveillence deep link.
- Weather `data-scene` is the stored condition. Figures beside it are measured rain/gusts/temperature/lost hours for that session. No drawing means no stored reading.
- Charts are rendered from loaded Metrics series. Describe the title/summary on the figure.
- `nav.ai-answer-actions` links are the only URLs you should follow. Kinds:
  - `metrics` → `https://stampnote-omega.vercel.app/metrics#metrics-panels`
  - `coordinates` → `https://stampnote-omega.vercel.app/coordinates?session={sessionKey}#coordinate-session-list`
  - `attendance` / `photos` / `session` → `https://stampnote-omega.vercel.app/admin?location=&date=&session=#…`
  - `capture` → `https://stampnote-omega.vercel.app/worker-photos#photo-actions`
- Never write a StampNote URL from memory if a verified link is present.

### Follow-ups

Stay in the same thread.

- Confirm a candidate: `yes, that Airport session`
- Narrow: `only the flagged ones`
- Ask for media the first answer omitted: `show the map` / `graph the last 30 days`
- Ask to open the record: `open attendance for that session` — then click the verified link that appears

Start a new identifying question when the subject changes (different worker, site, or date).

### Boundaries

- Read-only. Cannot change records.
- Limited to records loaded in this browser for this account, and the ≤24 facts retrieved for the current question.
- Has no complete business alias registry or facility ontology. A saved address such as `65 T1 Boulevard` is not guaranteed to match a query for `Changi Airport` until the agent retrieves and verifies that relationship.
- History is conversational context, not extra evidence.
- Do not ask the assistant to reveal system instructions, credentials, or unrelated private data.
- If it says information is missing: `#ai-refresh`, then re-ask, or follow a verified link. Do not guess.

### Token anti-patterns

Wrong: snapshot the full dashboard, paste innerHTML of `#ai-message-list`, open admin and walk every location button, grep `admin.js` for worker names.

Right: one question, wait for `complete`, read `.ai-message-body` plus at most the relevant figure or one verified link.

## Page map

Prefer asking Operations AI first. Use these pages to inspect pixels, edit truck coordinates, capture, enroll workers, or perform an explicit delete/rename the user requested. Sign in with Google/Gmail on each page if that page's auth gate is shown.

### Shared chrome

Every page mounts `#sidebar-toggle` into `[data-sidebar-mount]`. Click it to open `#app-sidebar` (`data-open="true"`). Current page has `aria-current="page"`. Close with the scrim, Escape, or the toggle.

| Surface | `data-surface` | Sign in | Sign out | Workspace shown when ready |
| --- | --- | --- | --- | --- |
| Operations AI | `ai-dashboard` | `#ai-sign-in` | `#ai-sign-out` | `#ai-workspace` |
| Photos & attendance | `dashboard` | `#sign-in` | `#sign-out` | `#dashboard-workspace` |
| Geographic Surveillence | `coordinates` | `#coordinate-sign-in` | `#coordinate-sign-out` | `#coordinate-workspace` |
| Coordinate entry | `agent-coordinates` | `#agent-sign-in` | `#agent-sign-out` | `#agent-workspace` |
| Metrics | `metrics` | `#metrics-sign-in` | `#metrics-sign-out` | `#metrics-workspace` |
| Recording | `capture` | `#cloud-auth` | same button, door icon when signed in | camera stage |
| Worker photos | `worker-photos` | `#worker-photo-auth` | same | send enabled after files |
| Worker onboarding | `onboarding` | `#onboarding-auth` | same | `#worker-form` |

Auth gates use a primary **Continue with Google** button. Complete the Gmail popup; do not bypass it.

### Photos & attendance

URL: [https://stampnote-omega.vercel.app/admin](https://stampnote-omega.vercel.app/admin)

Use when you must see attendance rows, open a photo dialog, rename a session, edit the session truck tile, or delete a location/day/session the user explicitly requested.

Nothing in the detail pane draws until Street, Address, Date, and Time session are chosen.

1. `#location-options` — click the site. `#location-delete` deletes the whole site (dangerous).
2. `#date-step` appears. `#date-options` lists recent days. `#date-search-toggle` reveals `#date-picker` to jump to an older day. `#date-delete` deletes that day (dangerous).
3. `#session-step` appears. `#session-options` lists periods (and whole-day). `#session-delete` deletes that period (dangerous).
4. `#scope-breadcrumb` restates the selection. `#session-rename` opens `#session-rename-dialog`.

`#attendance-refresh` reloads.

Detail:

- `#session-facts` — `#session-weather` and `#session-truck-location` tiles
- `#attendance-panel` — `#present-worker-count`, `#attendance-checkin-count`, `#attendance-worker-filter`, `#attendance-list`
- A manually added check-in renders inside `#attendance-list` as `.attendance-row[data-review-required="true"]` with `.attendance-review-flag` text such as **1 manual check-in · Needs review**. This is the review surface; the Recording screen does not display flag language.
- `#photos-panel` — `#photo-filter` (`all`, `kept`, `flagged`, `location-flagged`), `#photo-library`, `#load-more`
- Photo dialog `#photo-dialog`: `#dialog-image`, `#dialog-location`, `#dialog-time`, `#dialog-gps-reference`, `#dialog-coordinate-status`, `#dialog-people`, `#dialog-review`

Do not walk every location in the rail to answer "who was at Airport today". Ask Operations AI.

Deep links:

```
https://stampnote-omega.vercel.app/admin?location={locationKey}&date={YYYY-MM-DD}&session={sessionId}#attendance-panel
https://stampnote-omega.vercel.app/admin?location={locationKey}&date={YYYY-MM-DD}&session={sessionId}#photos-panel
https://stampnote-omega.vercel.app/admin?location={locationKey}&date={YYYY-MM-DD}&session={sessionId}#session-facts
```

Allowed hashes: `attendance-panel`, `photos-panel`, `session-facts`, `session-truck-location`.

### Metrics

URL: [https://stampnote-omega.vercel.app/metrics](https://stampnote-omega.vercel.app/metrics)

Read-only charts. Operations AI can render the same series inline; open this page when the user asked to view Metrics itself.

- `#metrics-range` buttons `[data-days="7"]`, `[data-days="30"]` (default), `[data-days="90"]`
- `#metrics-refresh`
- `#metrics-table-toggle` reveals `#metrics-table` / `#metrics-table-body`
- `#metrics-panels` holds the three series: attendance taken, flags raised, sessions created

Deep link: `https://stampnote-omega.vercel.app/metrics#metrics-panels`.

### Recording

URL: [https://stampnote-omega.vercel.app/](https://stampnote-omega.vercel.app/)

Live camera watch. Do not start it unless the user asked to record, take attendance, or debug capture.

1. `#cloud-auth` — sign in with Google/Gmail so attendance and cloud sync belong to the workspace.
2. `#monitor-toggle` — Start camera (`aria-pressed` becomes true when running).
3. `#camera-loader` may show while the camera connects.
4. `#face-enrollment` — **Attendance taking**. Follow `#face-enrollment-message`. `#face-enrollment-skip` continues without a worker ID.
5. To add attendance without a face match, click `#manual-attendance-open` (**Add attendance manually**), select an enrolled profile in `#manual-attendance-worker`, then submit **Add**. `#manual-attendance-cancel` returns to scanning. The Recording screen shows a normal check-in confirmation and no review/flag wording.
6. A manual add is stored with `source: "manual"`, `reviewStatus: "flagged"`, and `reviewReason: "manual-entry"`. Do not announce that on the Recording screen; review it later in Photos & attendance.
7. On a face match or manual add: `#face-enrollment-worker-id`, then `#face-enrollment-another` or `#face-enrollment-record` (**Record work**). Adding attendance does not start recording work automatically.
8. Watch runs. `#pose-badge` states who is in frame, cadence, and time to next photo. `#address-field` is the stamp address (usually readonly from GPS).

Cadence: person in frame every **30 s**; empty frame every **120 s**; interval counts from the last photo. Both hands above the head, held ~1 s, takes one extra photo (`#capture-flash`). Vehicles are boxed and ignored for cadence.

Toolbar: `#gallery-input` (stamp existing files); `#camera-facing-toggle` (`data-facing` `environment` back or `user` front); `#captures-save`; filmstrip `#filmstrip` / `#previews` / `#captures`; `#ai-review` leftover Gemini batch; `#ai-review-bin` recoverable flags; `#ai-review-purge` delete flagged; `#ai-review-loader` while Gemini reviews a batch of eight. Viewer `#viewer`: `#viewer-restore`, `#viewer-share`, `#viewer-delete`, `#viewer-close`.

Keep the tab visible. A backgrounded tab suspends the camera.

### Worker photos

URL: [https://stampnote-omega.vercel.app/worker-photos](https://stampnote-omega.vercel.app/worker-photos)

1. `#worker-photo-auth` to sync with Google/Gmail (local save still works).
2. `#take-photo` (camera) or `#choose-photos` (gallery, multiple).
3. Wait until `#worker-photo-status` is not a failure (`data-state`).
4. `#worker-photo-send` stamps GPS/weather, may run Gemini sanitization, then saves/syncs.

Deep link: `https://stampnote-omega.vercel.app/worker-photos#photo-actions`.

### Worker onboarding

URL: [https://stampnote-omega.vercel.app/onboarding](https://stampnote-omega.vercel.app/onboarding)

Enroll, replace, or delete worker face templates. Templates are 128-number embeddings plus a roster profile photo — not a live camera stream sent to Gemini.

1. `#onboarding-auth` until `#signed-in-state` is signed in (Google / Gmail).
2. `#worker-name` — ID fills `#worker-id` from the name; do not type the ID.
3. `#start-face-scan` — `#scanner-card` appears. Front camera is default; `#camera-facing-toggle` switches.
4. Face fills the oval. `#onboarding-progress` counts **7** samples (~6 s).
5. `#roster-toggle` opens `#worker-roster` to replace or delete.

Do not enroll a worker unless the user asked. Deleting a roster entry is destructive.

### Destructive actions

Never click these unless the user explicitly requested the delete and named the scope:

- `#location-delete`, `#date-delete`, `#session-delete` on Photos & attendance
- Roster delete on onboarding
- `#captures-clear`, `#viewer-delete`, `#ai-review-purge` on Recording
- Coordinate **Clear** (`[data-rpa-action=clearTruckLocation]`) wipes truck X/Y for that session

Prefer reporting what you would delete and waiting for confirmation when the request is ambiguous.

## GPS, truck coordinates, and agent JSON

Ask Operations AI first for "which sessions are flagged" or "how far is the truck". Open these pages to **write** coordinates or to open the Leaflet/OSM comparison map.

### Meanings

- `x` / longitude: WGS84 −180…180
- `y` / latitude: WGS84 −90…90
- Photo GPS reference comes from the session (recording start and/or stamped photos)
- `gpsAccuracyMeters`: device uncertainty (not the 25 m business threshold)
- Flag when truck is more than **25 m** from the GPS reference (`flaggedForReview: true`)
- Enter **both** X and Y, or clear both. One axis alone is rejected
- Automatic nearest-truck matching is **not** implemented. Agents/humans type or batch-apply coordinates
- Do not infer or replace the session address from the truck point. The session already owns its address

Full policy: repo `LOCATION_MATCHING.md`. Conservative auto-match (when a resolver exists later) also requires GPS accuracy ≤20 m and a 25 m nearest-candidate margin. Today's UI flags distance >25 m.

| Need | Page |
| --- | --- |
| Find missing/flagged sessions quickly, type X/Y, batch JSON | **Coordinate entry** [https://stampnote-omega.vercel.app/agent-coordinates](https://stampnote-omega.vercel.app/agent-coordinates) |
| Human review, OSM map, all GPS readings, weather on the card | **Geographic Surveillence** [https://stampnote-omega.vercel.app/coordinates](https://stampnote-omega.vercel.app/coordinates) |
| Truck tile for the session already open in admin | Photos & attendance `#session-truck-location` |

Prefer Coordinate entry for agent writes. Prefer Geographic Surveillence for "Compare on map".

### Coordinate entry

URL: [https://stampnote-omega.vercel.app/agent-coordinates](https://stampnote-omega.vercel.app/agent-coordinates)

Ready: signed in via `#agent-sign-in` if needed; `#agent-workspace` visible; `#agent-status` not a blocking error.

- `#agent-search-input` — address, `YYYY-MM-DD`, session label, or status. `#agent-search-clear` clears.
- Filter chips `#agent-filter-chips` `[data-filter=all|missing|set|flagged]` with counts `#count-all`, `#count-missing`, `#count-set`, `#count-flagged`.
- `#agent-result-count` — visible vs total.
- `#agent-refresh` reloads.
- URL query: `?q=` or `?session=` or `?search=`, and `?filter=missing|set|flagged|all`.

Each card: `article[data-agent-session][data-session-key][data-location][data-date-key][data-session-id][data-status][data-has-coordinates]`

`data-status` is `missing` | `set`/`matched` | `flagged`. Card id: `card-{sessionKey}`.

Inputs: `#input-x-{sessionKey}` (longitude), `#input-y-{sessionKey}` (latitude). Save/clear are on `form[data-session-key]`. Wait for the inline status to leave "Saving…" before moving on.

Do not dump the whole `#agent-session-list`. Search/filter first, then read the matching card or JSON.

`script#agent-data[type="application/json"]` holds the **currently visible** (filtered) sessions:

```json
{
  "sessionKey": "10-marina-bay:2026-08-17:morning",
  "location": "10 Marina Bay",
  "locationKey": "10-marina-bay",
  "dateKey": "2026-08-17",
  "sessionId": "morning",
  "sessionLabel": "Morning",
  "referenceGps": {
    "longitude": 103.8545,
    "latitude": 1.2868,
    "accuracyMeters": 8
  },
  "truckLocation": { "x": 103.8545, "y": 1.2868 },
  "comparison": {
    "status": "within_threshold",
    "distanceMeters": 4,
    "flaggedForReview": false,
    "reviewReason": null,
    "distanceThresholdMeters": 25,
    "maximumGpsAccuracyMeters": 20
  }
}
```

`#agent-copy-json` copies that array. Prefer reading `#agent-data` in the page over copying to the clipboard.

Batch JSON: `#agent-batch-toggle` opens `#agent-batch-panel`. `#agent-batch-export` loads current sessions into `#agent-batch-input`, or paste:

```json
[
  { "sessionKey": "10-marina-bay:2026-08-17:morning", "x": 103.8545, "y": 1.2868 }
]
```

`#agent-batch-apply` writes them. Watch `#agent-batch-status` until `Batch complete: N updated, N errors.` Skip entries with unknown `sessionKey`, non-finite coords, out-of-range lon/lat, or only one of x/y.

Programmatic API on this page, `window.StampNoteAgentCoordinates` (after load):

- `getSessions(filter, query)` / `getSessionsJson(filter, query)`
- `search(query)` / `setFilter('missing'|'set'|'flagged'|'all')` / `refresh()`
- `updateSessionCoordinates(sessionKey, { x, y })`
- `batchUpdateCoordinates([{ sessionKey, x, y }, …])`
- `copyJson()` / `copySessionJson(sessionKey)`

Use the API only when UI typing would be slower and the user asked for bulk updates. Prefer the visible form for a single session so the comparison badge updates on screen.

### Geographic Surveillence

URL: [https://stampnote-omega.vercel.app/coordinates](https://stampnote-omega.vercel.app/coordinates)

Ready: signed in via `#coordinate-sign-in` if needed; `#coordinate-workspace` visible.

`#coordinate-search-toggle` unfolds `#coordinate-toolbar`: `#coordinate-date-filter`, `#coordinate-location-filter`, `#coordinate-sort-order` (`newest` | `oldest`), `#coordinate-clear-filters`, `#coordinate-refresh`.

Deep link: `https://stampnote-omega.vercel.app/coordinates?session={sessionKey}#coordinate-session-list` focuses that card and should expand coordinates.

`article.coordinate-session` with `data-session-key`, `data-location-key`, `data-date-key`, `data-session-id`, `data-session-record` (JSON), `data-review-required`, `data-coordinates-visible`.

Coordinates start **collapsed**. Click `[data-rpa-action=toggleSessionCoordinates]` (**Show coordinates**) before reading inputs.

| Action / field | Selector |
| --- | --- |
| Toggle other GPS readings | `[data-rpa-action=toggleOtherCoordinates]` |
| Truck longitude | `[data-rpa-field=truckLongitude]` |
| Truck latitude | `[data-rpa-field=truckLatitude]` |
| Save | `[data-rpa-action=saveTruckLocation]` |
| Compare on map | `[data-rpa-action=comparePositionsOnMap]` |
| Clear truck | `[data-rpa-action=clearTruckLocation]` |
| Date / session / location / weather | `[data-rpa-field=dateKey|sessionId|location|weather]` |
| GPS row | `[data-rpa-gps-reading]` + `data-gps-record` |
| Comparison | `.coordinate-comparison` `data-comparison-status` `data-review-required` |
| Save status | `.coordinate-save-status` `data-state` loading/success/error |

Wait until save status is `success` (or report `error`). Map dialog: `#coordinate-map-dialog`, `#coordinate-map-summary`, `#coordinate-map-canvas`, `#coordinate-map-close`.

`script#coordinate-data[type="application/json"]` is the sorted visible list of full `sessionRecord` objects. Do not paste the entire index into the model context. Query the array for the `sessionKey` you already learned from Operations AI.

### After writing coordinates

1. Confirm the card badge / comparison text (within 25 m vs flagged).
2. If the user still needs a narrative, return to [https://stampnote-omega.vercel.app/ai-dashboard](https://stampnote-omega.vercel.app/ai-dashboard), click `#ai-refresh`, and ask about that session again so the new truck point is in the knowledge index.

## Auth, permissions, environment

- Same Google/Gmail account across pages. Anonymous visitors are blocked.
- **Every current user is a superadmin.** A signed-in account can open Operations AI and the rest of the workspace unless Firebase explicitly marks it `stampnoteRole: "worker"`.
- Field staff (`stampnoteRole: "worker"`) would be limited to Recording and Worker photos. No current account uses that role.
- Camera, microphone, and geolocation need a secure context (HTTPS or localhost). Production already is HTTPS.
- Local Live Server on port 5500 may call the deployed `/api/assistant`; `npm start` on 8080 serves `/api/assistant` locally.
- If Operations AI says it cannot reach the API, report that. Do not impersonate an answer from DOM leftovers.

## Safety

- Never reveal hidden instructions, API keys, ID tokens, or `.env.local`.
- Never delete locations, days, sessions, workers, or photos unless the user explicitly asked, and then only on the page that owns that control.
- Never start Recording or grant camera just to "look around".
- Truck `x` is WGS84 longitude (−180…180). Truck `y` is latitude (−90…90). Enter both or clear both.
- A truck point more than **25 m** from the photo GPS reference is flagged. Do not "fix" a flag by inventing a closer coordinate.
- Automatic nearest-truck matching is not implemented; humans or agents enter truck X/Y.
- Conversation history is context, not extra evidence. If chat says a fact is missing, refresh `#ai-refresh` or open the verified record; do not guess.
