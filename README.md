# StampNote

StampNote is a browser-based image annotation toolkit for field photos, site visits, deliveries, inspections, and personal records. It watches through the device camera and photographs the scene on its own, stamping each image with its location and capture date/time. Photos can still be taken or picked by hand when that suits better.

## Autonomous capture

Press start once and the page takes over:

- The live camera runs in the page and a pose tracker watches every frame.
- **With a person in frame, a photo is taken every 30 seconds.**
- **With nobody in frame, a photo is taken every 120 seconds.**
- Every photo is stamped with the address and the date/time, then written straight to the device's own store. Nothing is uploaded.

The interval always counts from the last photo, not from the moment somebody appeared. So a person walking in 100 seconds into a quiet stretch is already overdue under the 30-second rule and is photographed at once, while a person arriving 5 seconds after a photo waits out the balance of the 30. The first photo is taken as soon as the camera opens, which is also the confirmation that the watch is running.

The badge over the video says who is in frame, which cadence is in force, and how long until the next photo. A rigged skeleton is drawn over the tracked pose — head, neck, shoulders, spine and hips in white, and the four limbs in the accent colour — so it is obvious what the page thinks it is looking at.

Vehicles are recognised and boxed in amber, labelled, and otherwise ignored: **a vehicle never changes the cadence.** A car in an empty frame is still an empty frame as far as the schedule is concerned, and a person who gets out of it starts the 30-second cadence just as they would anywhere else.

### How people and vehicles are found

Detection is MediaPipe Tasks Vision, committed under `vendor/` rather than pulled from a CDN, so the watch still runs with no network and nothing about its use leaves the device. Two models:

- **Pose landmarker (lite)** returns 33 body landmarks, which are mapped onto the joints the overlay draws. It knows the person's own left from their right — something a silhouette never can, since a silhouette only has the left and right of the picture.
- **Object detector (EfficientDet-Lite0)** names `car`, `truck`, `bus` and `motorcycle`. A vehicle is boxed and labelled and nothing more; **it never changes the cadence.**

The first run downloads about 9 MB — 3.3 MB of WebAssembly and a 5.5 MB pose model — and the browser caches it. The 4.4 MB vehicle model is fetched afterwards in the background, so the watch starts as soon as people can be tracked and begins labelling vehicles a moment later. Landmarks below half visibility are dropped rather than drawn, so an arm behind a person's back leaves a gap instead of a bone through thin air.

### When the model cannot be had

An old browser, a failed download or a device without WebAssembly falls back to StampNote's own detector, which says so on screen. It finds a person the way a person differs from a room:

- **The scene is learned and the subject is whatever fails to match it**, compared across all three colour channels. Brightness alone is not enough — a blue shirt can carry the same luma as a grey wall while sharing none of its colour. The model learns quickly where it agrees with the picture and barely at all where it does not, so furniture settles in seconds while somebody standing still takes minutes to fade into the wallpaper.
- **Camera drift is subtracted first.** Every camera hunts for its exposure, which lifts the whole picture at once and reads as the entire frame moving. The median shift across the scene is the camera changing its mind, and taking it out leaves only what actually moved.
- **Skin tone, silhouette shape and a head above the shoulders** then say whether the thing in front of the scene is a person.

Colour cannot decide what is foreground, and an earlier version of this let it: the chrominance band that finds a forearm across every skin tone also finds varnished floorboards, terracotta, beige carpet and any room lit by a warm bulb. That made the floor a permanent part of the silhouette and swallowed anyone standing on it — one blob the width of the room, no limbs to rig, and an empty room that still had something in it.

The fallback is rougher than the model at everything: it needs some visible skin, it cannot tell one person from another or count them, it reads the picture's left and right rather than the person's, and it assumes an upright body.

### Where the photos go

Captures are written to IndexedDB on the device and stay there, marked as a pending queue that no upload step drains yet. Where IndexedDB is unavailable — private browsing, older WebViews — captures still work for the session and say so on screen. The store keeps the most recent 240 photos within a 192 MB budget, dropping the oldest first and never the newest. Save writes them out as files; delete clears them.

The screen is held awake while the watch runs. A backgrounded tab has its camera suspended and its timers throttled by the browser, so tracking pauses when the page is hidden and picks the schedule back up on return — one photo is owed for the whole gap, not one per missed interval. **The page has to stay open and frontmost.**

## Manual capture

The camera and gallery controls are native HTML file inputs, so the browser keeps the selected photos on the user's device. They remain available for browsers with no live-camera access, and for stamping images that already exist.

## Run locally

Start the local server, then open `http://127.0.0.1:8080` in a modern browser:

```sh
npm start
```

Using localhost is important because browsers restrict precise geolocation and camera access to secure contexts. There is nothing to install: the one third-party component, MediaPipe, is committed under `vendor/` rather than fetched.

To try it from a phone, reach the page over HTTPS (a tunnel or the deployed URL). Safari refuses
geolocation on a plain `http://` LAN address and reports it as a permission failure.

iOS Safari only shows the location prompt for a request made during a tap, so the app asks for a
position from the "Use current location" button and never on its own — it auto-fills after an upload
only when permission was already granted. If location was denied earlier, Safari keeps denying it
silently; re-enable it with "aA" in the address bar → Website Settings → Location → Allow.

For the best camera experience, open the page on a mobile device. The autonomous watch asks for the rear camera and needs a secure page and a granted camera permission; the manual controls stay available where it cannot run. Browser camera behavior varies by device: supported mobile browsers open the rear camera for the manual control too, while desktop browsers generally show a file picker.

## Automated tests

Node.js 18 or newer is required. Run the suite with:

```sh
npm test
```

The suite checks the page foundation, camera and gallery input contracts, accessible label wiring, address lookup service, date/time stamp copy, responsive CSS, and reduced-motion support. It also covers the autonomous watch: the mapping from MediaPipe's landmarks onto the drawn rig, including occluded joints and which detected classes count as vehicles; the fallback detector against synthetic frames (a person, an empty room, a warm floor, a skin-toned slab, moving scenery); rigging a figure posed four ways (arms down, arms out, arms overhead, one arm hidden); telling cars of five paint colours from people and keeping them off the cadence; tracker hysteresis; both capture cadences and the switch between them; local storage with its pruning and fallbacks; and the controller driving a two-hour watch on a fake clock.

The models themselves are not tested here — a trained network cannot be exercised from Node, and it will not find a person in a synthetic test frame, correctly. What is tested is every seam around it. It uses Node's built-in test runner and has no third-party test dependencies.

## Workflow

1. Press start, and the watch photographs the scene on its own — every 30 seconds with a person in frame, every 120 seconds without.
2. The street address fills in automatically where the browser allows it; otherwise type it in, and later captures pick it up.
3. Photos are stamped and stored on the device as they are taken.
4. Save them out as files, or share a hand-picked image through the OS share sheet. Nothing is uploaded to a server.

## Project files

- `index.html` — page structure, live camera and controls
- `styles.css` — responsive visual design
- `address-service.js` — geolocation and reverse-geocoding functions
- `stamp.js` — canvas stamping of the address and date/time
- `pose-model.js` — loads the vendored MediaPipe models
- `pose-mapping.js` — turns MediaPipe's landmarks into the joints the overlay draws
- `pose-detector.js` — the fallback detector, used when the models cannot load
- `vendor/mediapipe/` — the committed MediaPipe runtime and models, with provenance and licence
- `capture-scheduler.js` — the 30-second and 120-second capture cadences
- `photo-store.js` — on-device capture store, with pruning and fallbacks
- `auto-capture.js` — the watch loop joining tracker, schedule and store
- `app.js` — interface behavior, camera lifecycle and session caching
- `server.js` — dependency-free local development server
- `tests/` — automated front-end and capture-stack tests
- `package.json` — test command and project metadata
- `README.md` — product scope and development notes

## Next milestone

Drain the pending queue: an upload step that takes the locally stored captures somewhere else and marks them synced, with the queue surviving a reload in between.

## Address data

On upload, the prototype sends the device's current coordinates to OpenStreetMap's public Nominatim reverse-geocoding service. The result is cached for the browser session and remains editable. The on-page OpenStreetMap
attribution was removed at the client's request; ODbL still requires attributing OSM wherever the
data is shown, so it should be restored — in the stamp, an about screen, or the share text — before
this goes public. This public endpoint is suitable for a moderate prototype under its usage policy; substantial production traffic should use a dedicated provider or hosted Nominatim instance.
