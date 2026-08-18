# Session-to-truck GPS proximity matching

## Purpose

StampNote uses GPS proximity to associate the active recording session with the nearest available
truck coordinates. The session already owns its address, date, and time period. The automation
must not infer or replace that address from the truck coordinates; it only decides whether a truck
position is sufficiently close to the session's GPS position.

This is a proximity assessment, not proof that the device and truck occupied the same exact place.
There is a low but non-zero chance that two sites are near one another. The matching policy is
therefore deliberately conservative and sends uncertain cases for confirmation.

## Coordinate and accuracy meanings

- `x` is WGS84 longitude, from -180 to 180.
- `y` is WGS84 latitude, from -90 to 90.
- `gpsAccuracyMeters` is the uncertainty radius reported by the device. In the browser Geolocation
  API it represents a 95% confidence level in metres; it describes the quality of the reading and
  is not the business matching threshold.
- `distanceThresholdMeters` is StampNote's configured maximum proximity distance.
- All distances between coordinates are calculated in metres with the Haversine formula.

See the [W3C Geolocation specification](https://www.w3.org/TR/geolocation/#coordinates_interface)
for the browser accuracy definition.

## Conservative default policy

Use these initial defaults until real site measurements justify a site-specific value:

| Setting | Default | Meaning |
| --- | ---: | --- |
| Match threshold | 25 m | Maximum distance for an automatic proximity match |
| Maximum GPS accuracy | 20 m | Readings with a larger uncertainty are not auto-matched |
| Nearest-candidate margin | 25 m | The nearest candidate must beat the second nearest by at least this distance |

The threshold may be configured per site. Closely neighbouring sites should remain within a
15–25 m range. A larger boundary should be introduced only for a measured operational reason, such
as a large compound, and must not silently weaken the ambiguity checks.

An automatic match is allowed only when all of the following are true:

1. The session GPS reading has an accuracy of 20 m or better.
2. The nearest truck coordinate is no more than 25 m from the session GPS coordinate.
3. Exactly one truck candidate is inside the 25 m threshold.
4. When a second candidate exists, it is at least 25 m farther away than the nearest candidate.

In pseudocode:

```js
const candidatesWithinThreshold = candidates.filter(
  (candidate) => candidate.distanceMeters <= distanceThresholdMeters,
);

const autoMatch =
  gpsAccuracyMeters <= maximumGpsAccuracyMeters &&
  nearest.distanceMeters <= distanceThresholdMeters &&
  candidatesWithinThreshold.length === 1 &&
  (!secondNearest ||
    secondNearest.distanceMeters - nearest.distanceMeters >= nearestCandidateMarginMeters);
```

Where candidate timestamps are available, the automation should first restrict them to the active
session's relevant time window and only then rank the remaining candidates by distance.

## Outcomes

The resolver returns one of these outcomes:

- `matched`: one candidate satisfies every automatic-match rule;
- `ambiguous`: multiple nearby candidates exist or the nearest-candidate margin is too small;
- `outside_threshold`: no candidate is within the configured boundary;
- `insufficient_accuracy`: the GPS uncertainty is too large for automatic matching; or
- `gps_unavailable`: the active session has no usable GPS coordinate.

Every outcome except `matched` requires a retry or human confirmation. The automation must never
select the nearest candidate merely because one candidate is numerically closest.

The Geographic Surveillence workspace represents these non-matches explicitly. A truck coordinate more than
25 m from the highlighted reference carries `flaggedForReview: true` and
`reviewReason: "distance_exceeds_threshold"` in its machine record. Unusable GPS quality and a
missing GPS reference are also flagged rather than treated as matches.

## Customer-facing language

Successful matches must be described as proximity matches:

```text
Matched by GPS proximity
Site: 10 Marina Bay
Distance: 14 m
GPS accuracy: ±9 m
```

Ambiguous matches must identify the limitation and ask for confirmation:

```text
Confirmation required
Multiple sites are near this GPS position. Select the correct site.
```

Do not use “verified location”, “confirmed at site”, or similar wording. GPS proximity is evidence
of closeness, not proof of presence at a particular site.

## Data to retain

The stored result should preserve enough information to explain and audit the decision:

```text
sessionGps: latitude, longitude, accuracyMeters, capturedAt
truckLocation: x, y, sourceId, capturedAt
proximityMatch: status, distanceMeters, distanceThresholdMeters,
                nearestCandidateMarginMeters, matchedAt
```

The address remains metadata of the current session and is not derived by the matching operation.

## Current implementation status

The platform captures browser GPS coordinates and accuracy and stores the opening fix directly on
the active dashboard session as soon as recording starts. This makes the current session coordinate
available before the first photo batch completes AI review and cloud upload. Later photo GPS fixes
remain separate readings rather than replacing the session-start fix. The platform also stores one
manually entered truck coordinate pair on a dashboard session, calculates Haversine distance, and
displays the comparison. The authenticated Geographic Surveillence page at `coordinates.html` groups every GPS reading
under its location, date, and time session. Dates default to newest first, while Morning, Afternoon,
and Evening remain chronological within each date. Every reading is visible with its source, capture
time, longitude, latitude, and accuracy. The lowest-uncertainty reading is highlighted as the
comparison reference; a tie prefers the latest reading.

The Photos & attendance dashboard uses a separate navigation hierarchy: street, recorded address,
date, then time session. GPS-near address variants inherit one street parent but remain separately
inspectable at the address level.

Each session card places the truck X/Y inputs beside its GPS readings and previews the 25 m distance
rule separately from the 20 m GPS-quality limit. Saving uses the authenticated session update
already used by the admin dashboard. For browser automation, every session and GPS-reading row has
stable `data-*` identifiers and JSON records. The page-level `#coordinate-data` element contains the
complete sorted session index, so an RPA does not have to inspect photo cards or parse presentation
text. Each session's coordinate area is concealed by default behind its own Show coordinates button;
the same button hides the area again. This affects visual disclosure only and does not remove the
RPA JSON record. A Compare on map button opens an in-page map with labelled GPS-reference and truck
markers, the GPS uncertainty radius, and a straight comparison line fitted into view. The map repeats
the measured distance and review outcome. Truck coordinates beyond 25 m are visibly flagged for
review.

The following work is still required to implement this policy completely:

- ingest the available truck-coordinate candidates and their timestamps;
- choose the nearest and second-nearest candidates;
- store configurable proximity and GPS-quality thresholds separately from GPS accuracy;
- return the explicit outcomes above and retain the audit fields; and
- expose a direct authenticated automation API so an RPA can submit candidates without operating
  the dedicated page's coordinate forms.

The current comparison uses the individual photo's `accuracyMeters` value as its distance
threshold. That behavior does not implement this policy and must be replaced when automatic
session-to-truck matching is introduced.
