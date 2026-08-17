# GPS, truck coordinates, and agent JSON

Load this file when comparing photo GPS to truck position, entering truck X/Y, or reading machine-readable session indexes.

Ask Operations AI first for "which sessions are flagged" or "how far is the truck". Open these pages to **write** coordinates or to open the Leaflet/OSM comparison map.

## Meanings

- `x` / longitude: WGS84 −180…180
- `y` / latitude: WGS84 −90…90
- Photo GPS reference comes from the session (recording start and/or stamped photos)
- `gpsAccuracyMeters`: device uncertainty (not the 25 m business threshold)
- Flag when truck is more than **25 m** from the GPS reference (`flaggedForReview: true`)
- Enter **both** X and Y, or clear both. One axis alone is rejected
- Automatic nearest-truck matching is **not** implemented. Agents/humans type or batch-apply coordinates
- Do not infer or replace the session address from the truck point. The session already owns its address

Full policy: repo `LOCATION_MATCHING.md`. Conservative auto-match (when a resolver exists later) also requires GPS accuracy ≤20 m and a 25 m nearest-candidate margin. Today's UI flags distance >25 m.

## Which page

| Need | Page |
| --- | --- |
| Find missing/flagged sessions quickly, type X/Y, batch JSON | **Coordinate entry** `agent-coordinates.html` |
| Human review, OSM map, all GPS readings, weather on the card | **Geographic Surveillence** `coordinates.html` |
| Truck tile for the session already open in admin | Photos & attendance `#session-truck-location` |

Prefer Coordinate entry for agent writes. Prefer Geographic Surveillence for "Compare on map".

## Coordinate entry (`agent-coordinates.html`)

Ready: `#agent-workspace` visible, `#agent-status` not a blocking error.

### Find

- `#agent-search-input` — address, `YYYY-MM-DD`, session label, or status. `#agent-search-clear` clears.
- Filter chips `#agent-filter-chips` `[data-filter=all|missing|set|flagged]` with counts `#count-all`, `#count-missing`, `#count-set`, `#count-flagged`.
- `#agent-result-count` — visible vs total.
- `#agent-refresh` reloads.
- URL: `?q=` or `?session=` or `?search=`, and `?filter=missing|set|flagged|all`.

### Cards

Each card: `article[data-agent-session][data-session-key][data-location][data-date-key][data-session-id][data-status][data-has-coordinates]`

`data-status` is `missing` | `set`/`matched` | `flagged`. Card id: `card-{sessionKey}`.

Inputs:

- `#input-x-{sessionKey}` — longitude
- `#input-y-{sessionKey}` — latitude

Save/clear are on the card form (`form[data-session-key]`). Wait for the inline status to leave "Saving…" before moving on.

Do not dump the whole `#agent-session-list`. Search/filter first, then read the matching card or JSON.

### JSON index

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

### Batch JSON

`#agent-batch-toggle` opens `#agent-batch-panel`.

1. `#agent-batch-export` loads current sessions into `#agent-batch-input`, or paste:

```json
[
  { "sessionKey": "10-marina-bay:2026-08-17:morning", "x": 103.8545, "y": 1.2868 }
]
```

2. `#agent-batch-apply` writes them. Watch `#agent-batch-status` until `Batch complete: N updated, N errors.`
3. `#agent-batch-copy` copies the textarea.

Skip entries with unknown `sessionKey`, non-finite coords, out-of-range lon/lat, or only one of x/y.

### Programmatic API

On this page, `window.StampNoteAgentCoordinates` (after load):

- `getSessions(filter, query)` / `getSessionsJson(filter, query)`
- `search(query)` / `setFilter('missing'|'set'|'flagged'|'all')` / `refresh()`
- `updateSessionCoordinates(sessionKey, { x, y })`
- `batchUpdateCoordinates([{ sessionKey, x, y }, …])`
- `copyJson()` / `copySessionJson(sessionKey)`

Use the API from a page JS console only when UI typing would be slower and the user asked for bulk updates. Prefer the visible form for a single session so the comparison badge updates on screen.

## Geographic Surveillence (`coordinates.html`)

Ready: `#coordinate-workspace` visible.

### Filters

`#coordinate-search-toggle` unfolds `#coordinate-toolbar`:

- `#coordinate-date-filter`
- `#coordinate-location-filter`
- `#coordinate-sort-order` `newest` | `oldest`
- `#coordinate-clear-filters` / `#coordinate-refresh`

`#coordinate-result-count` and `#coordinate-empty` describe the list.

Deep link: `coordinates.html?session={sessionKey}#coordinate-session-list` focuses that card and should expand coordinates.

### Cards

`article.coordinate-session` with `data-session-key`, `data-location-key`, `data-date-key`, `data-session-id`, `data-session-record` (JSON), `data-review-required`, `data-coordinates-visible`.

Coordinates start **collapsed**. Click `[data-rpa-action=toggleSessionCoordinates]` (**Show coordinates**) before reading inputs.

RPA fields:

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

Wait until save status is `success` (or report `error`). Map dialog: `#coordinate-map-dialog`, `#coordinate-map-summary`, `#coordinate-map-canvas` (`data-reference-latitude`, `data-truck-longitude`, `data-distance-meters`, …), `#coordinate-map-close`.

### JSON index

`script#coordinate-data[type="application/json"]` is the sorted visible list of full `sessionRecord` objects (includes `gpsReadings`, `aliases`, `weather`, `comparison`). Read this after filtering rather than scraping every card.

Do not paste the entire index into the model context. Query the array for the `sessionKey` you already learned from Operations AI.

## After writing coordinates

1. Confirm the card badge / comparison text (within 25 m vs flagged).
2. If the user still needs a narrative, return to Operations AI, click `#ai-refresh`, and ask about that session again so the new truck point is in the knowledge index.
