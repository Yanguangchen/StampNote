# StampNote page map

Load this file when operating a surface other than Operations AI, or when following a verified in-app link.

Prefer asking Operations AI first. Use these pages to inspect pixels, edit truck coordinates, capture, enroll workers, or perform an explicit delete/rename the user requested.

## Shared chrome

Every page mounts `#sidebar-toggle` into `[data-sidebar-mount]`. Click it to open `#app-sidebar` (`data-open="true"`). Current page has `aria-current="page"`. Close with the scrim, Escape, or the toggle.

Sidebar labels and files:

- Recording → `index.html`
- Worker photos → `worker-photos.html`
- Worker onboarding → `onboarding.html`
- Geographic Surveillence → `coordinates.html` (spelling is intentional in the UI)
- Coordinate entry → `agent-coordinates.html`
- Operations AI → `ai-dashboard.html`
- Photos & attendance → `admin.html`
- Metrics → `metrics.html`

Sign-in/out control IDs differ per page (table below). Do not click Sign out unless the user asked.

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

Auth gates use a primary **Continue with Google** button. Complete the Google popup; do not bypass it.

## Photos & attendance (`admin.html`)

Use when you must see attendance rows, open a photo dialog, rename a session, edit the session truck tile, or delete a location/day/session the user explicitly requested.

### Scope rail

Nothing in the detail pane draws until Location, Date, and Time session are chosen.

1. `#location-options` — click the site. `#location-delete` deletes the whole site (dangerous).
2. `#date-step` appears. `#date-options` lists recent days. `#date-search-toggle` reveals `#date-picker` to jump to an older day. `#date-delete` deletes that day (dangerous).
3. `#session-step` appears. `#session-options` lists periods (and whole-day). `#session-delete` deletes that period (dangerous).
4. `#scope-breadcrumb` restates the selection. `#session-rename` opens `#session-rename-dialog`.

`#attendance-refresh` reloads.

### Detail

- `#session-facts` — `#session-weather` and `#session-truck-location` tiles
- `#attendance-panel` — `#present-worker-count`, `#attendance-checkin-count`, `#attendance-worker-filter`, `#attendance-list`
- `#photos-panel` — `#photo-filter` (`all`, `kept`, `flagged`, `location-flagged`), `#photo-library`, `#load-more`
- Photo dialog `#photo-dialog`: `#dialog-image`, `#dialog-location`, `#dialog-time`, `#dialog-gps-reference`, `#dialog-coordinate-status`, `#dialog-people`, `#dialog-review`

Do not walk every location in the rail to answer "who was at Airport today". Ask Operations AI.

### Deep links (from verified chat actions)

```
admin.html?location={locationKey}&date={YYYY-MM-DD}&session={sessionId}#attendance-panel
admin.html?location={locationKey}&date={YYYY-MM-DD}&session={sessionId}#photos-panel
admin.html?location={locationKey}&date={YYYY-MM-DD}&session={sessionId}#session-facts
```

Allowed hashes: `attendance-panel`, `photos-panel`, `session-facts`, `session-truck-location`.

## Metrics (`metrics.html`)

Read-only charts. Operations AI can render the same series inline; open this page when the user asked to view Metrics itself.

- `#metrics-range` buttons `[data-days="7"]`, `[data-days="30"]` (default), `[data-days="90"]`
- `#metrics-refresh`
- `#metrics-table-toggle` reveals `#metrics-table` / `#metrics-table-body`
- `#metrics-panels` holds the three series: attendance taken, flags raised, sessions created

Deep link: `metrics.html#metrics-panels`.

## Recording (`index.html`)

Live camera watch. Do not start it unless the user asked to record, take attendance, or debug capture.

### Start

1. `#cloud-auth` — sign in so attendance and cloud sync belong to the workspace.
2. `#monitor-toggle` — Start camera (`aria-pressed` becomes true when running).
3. `#camera-loader` may show while the camera connects.
4. `#face-enrollment` — **Attendance taking**. Follow `#face-enrollment-message`. `#face-enrollment-skip` continues without a worker ID.
5. On match: `#face-enrollment-worker-id`, then `#face-enrollment-another` or `#face-enrollment-record` (**Record work**). Success confirmation stays on screen about 1.8 s.
6. Watch runs. `#pose-badge` states who is in frame, cadence, and time to next photo. `#address-field` is the stamp address (usually readonly from GPS).

### Cadence and gesture

- Person in frame: photo every **30 s**
- Empty frame: every **120 s**
- Interval counts from the last photo
- Both hands above the head, held ~1 s, takes one extra photo (`#capture-flash`)
- Vehicles are boxed and ignored for cadence

### Toolbar

- `#gallery-input` / Gallery — stamp existing files
- `#camera-facing-toggle` — `data-facing` `environment` (back) or `user` (front); `#camera-facing-name` is the lens in use
- `#captures-save` — write kept photos out as files
- Filmstrip `#filmstrip` / `#previews` / `#captures`
- `#ai-review` — leftover Gemini batch; `#ai-review-bin` — recoverable flags; `#ai-review-purge` — delete flagged
- `#ai-review-loader` covers the screen while Gemini reviews a batch of eight; camera keeps running
- Viewer `#viewer`: `#viewer-restore`, `#viewer-share`, `#viewer-delete`, `#viewer-close`

Keep the tab visible. A backgrounded tab suspends the camera.

## Worker photos (`worker-photos.html`)

Field photos without starting the watch.

1. `#worker-photo-auth` to sync (local save still works).
2. `#take-photo` (camera) or `#choose-photos` (gallery, multiple).
3. Wait until `#worker-photo-status` is not a failure (`data-state`).
4. `#worker-photo-send` stamps GPS/weather, may run Gemini sanitization, then saves/syncs.

Deep link from chat: `worker-photos.html#photo-actions`.

## Worker onboarding (`onboarding.html`)

Enroll, replace, or delete worker face templates. Templates are 128-number embeddings plus a roster profile photo — not a live camera stream sent to Gemini.

1. `#onboarding-auth` until `#signed-in-state` is signed in.
2. `#worker-name` — ID fills `#worker-id` from the name; do not type the ID.
3. `#start-face-scan` — `#scanner-card` appears. Front camera is default; `#camera-facing-toggle` switches.
4. Face fills the oval. `#onboarding-progress` counts **7** samples (~6 s).
5. `#roster-toggle` opens `#worker-roster` to replace or delete.

Do not enroll a worker unless the user asked. Deleting a roster entry is destructive.

## Coordinate pages

See [coordinates.md](coordinates.md) for Geographic Surveillence, Coordinate entry, JSON, and the 25 m rule.

## Destructive actions

Never click these unless the user explicitly requested the delete and named the scope:

- `#location-delete`, `#date-delete`, `#session-delete` on Photos & attendance
- Roster delete on onboarding
- `#captures-clear`, `#viewer-delete`, `#ai-review-purge` on Recording
- Coordinate **Clear** (`[data-rpa-action=clearTruckLocation]`) wipes truck X/Y for that session

Prefer reporting what you would delete and waiting for confirmation when the request is ambiguous.
