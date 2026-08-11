# StampNote

StampNote is a browser-based image annotation toolkit for field photos, site visits, deliveries, inspections, and personal records. It watches through the device camera and photographs the scene on its own, stamping each image with its location and capture date/time. Photos can still be taken or picked by hand when that suits better.

## Autonomous capture

Press start once and the page takes over:

- The live camera runs in the page and a pose tracker watches every frame.
- **With a person in frame, a photo is taken every 30 seconds.**
- **With nobody in frame, a photo is taken every 120 seconds.**
- Every photo is stamped with the address and the date/time, then written straight to the device's own store. Nothing is uploaded.

The interval always counts from the last photo, not from the moment somebody appeared. So a person walking in 100 seconds into a quiet stretch is already overdue under the 30-second rule and is photographed at once, while a person arriving 5 seconds after a photo waits out the balance of the 30. The first photo is taken as soon as the camera opens, which is also the confirmation that the watch is running.

The badge over the video says who is in frame, which cadence is in force, and how long until the next photo. A skeleton is drawn over the tracked pose so it is obvious what the page thinks it is looking at.

### How the pose tracking works, and where it falls down

StampNote takes no third-party dependencies, and a trained pose model means a runtime plus megabytes of weights. So a person is found the way a person differs from a room, by scoring several weak cues together:

- **Skin chrominance.** Exposed skin sits in a narrow Cb/Cr band. It is a hue test, not a brightness test, so it holds across skin tones.
- **Inter-frame motion.** Clothing has no skin tone; movement is what reveals the rest of a body. Both masks come out speckled, so they are closed up morphologically before the silhouette is labelled.
- **Silhouette shape.** A narrow head above broader shoulders, upright, occupying a plausible share of the frame. This one is a gate rather than a cue: skin tone, size and an upright aspect describe a cardboard box as happily as a person, and the head is what separates them.
- **Face boxes**, where the browser has the Shape Detection API (Chrome). Where it does not, the other cues carry the detection alone.

Readings are then smoothed: someone is only reported present after consecutive sightings, and only reported gone after four quiet seconds, so a person turning their head cannot flip the cadence.

What this will not do: it needs some visible skin, so a person fully covered or facing away in poor light can be missed; it cannot count people or tell one from another; and a warm-toned, head-shaped, moving object will fool it. It chooses a capture interval — it is not a security system, and it should not be relied on as one.

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

Using localhost is important because browsers restrict precise geolocation and camera access to secure contexts. No third-party packages are required.

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

The suite checks the page foundation, camera and gallery input contracts, accessible label wiring, address lookup service, date/time stamp copy, responsive CSS, and reduced-motion support. It also covers the autonomous watch: pose detection against synthetic frames (a person, an empty room, and the near misses — a skin-toned slab, a wall, moving scenery), tracker hysteresis, both capture cadences and the switch between them, local storage with its pruning and fallbacks, and the controller driving a two-hour watch on a fake clock. It uses Node's built-in test runner and has no third-party test dependencies.

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
- `pose-detector.js` — dependency-free human-pose detection and tracking
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
