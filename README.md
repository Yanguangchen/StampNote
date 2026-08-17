# StampNote

StampNote is a browser-based image annotation toolkit for field photos, site visits, deliveries, inspections, and personal records. It watches through the device camera and photographs the scene on its own, stamping each image with its location and capture date/time. Photos can still be taken or picked by hand when that suits better.

A left-hand page menu is shared by every surface and is grouped as:

- **Worker workspace:** Recording and Worker photos.
- **Admin workspace:** Worker onboarding, Geographic Surveillence, Operations AI, Photos & attendance, and Metrics.

Sign-out is a door-and-arrow icon on every signed-in header. The account name already sits beside it. Where one control both signs in and out, the sign-in wording stays visible until an account is connected; Recording keeps the one-word **Account** label and swaps the cloud glyph for the door.

## Autonomous capture

Press start once and the page takes over:

- The live camera runs in the page and a pose tracker watches every frame.
- Before the activity begins, one person moves close to the camera for three clear, centered face samples over roughly two seconds. The oval guide says whether to move closer, hold still, look straight, center up, or leave only one person in view. A continuous progress bar keeps the sample count out of the interface. Capture stays paused until all three HD-camera views agree on the same enrolled worker and clearly beat the next-nearest template; a missed or ambiguous match keeps scanning automatically, and **Continue without face matching** remains available.
- **With a person in frame, a photo is taken every 30 seconds.**
- **With nobody in frame, a photo is taken every 120 seconds.**
- Every photo is stamped with the address and the date/time, then written straight to the device's own store. After one explicit consent, Gemini automatically reviews complete groups of eight scheduled photos using reduced copies; those reviewed copies then sync to the authenticated Firestore workspace when a Google account is signed in.

The interval always counts from the last photo, not from the moment somebody appeared. So a person walking in 100 seconds into a quiet stretch is already overdue under the 30-second rule and is photographed at once, while a person arriving 5 seconds after a photo waits out the balance of the 30. On browsers with the trained face model, the first photo is taken immediately after face enrollment completes or is skipped; on the fallback detector it is taken as soon as the camera opens.

The badge over the video says who is in frame, which cadence is in force, and how long until the next photo. A rigged skeleton is drawn over the tracked pose — head, neck, shoulders, spine and hips in white, the four limbs in the accent colour, fingers on the ends of the arms and the face traced over the head — so it is obvious what the page thinks it is looking at.

**Raising both hands above your head takes a photograph.** It has to be held for the better part of a second, so a hand thrown up in conversation is not a shutter press, and it has to be let go of before it counts again, so one gesture is one photograph rather than a burst. It is the one pose nobody makes by accident in front of a camera that is already photographing them.

### The screen

Built for a phone held in landscape, which is how it gets used while recording:

- **The camera is the page.** It fills whatever shape the screen is, so turning the phone changes nothing about the layout, and nothing scrolls away underneath it.
- **The address sits across the top of the picture**, in the same uppercase it will be stamped in — what is on screen is what is being written onto the photograph, rather than a panel somewhere else on the page.
- **A toolbar along the bottom** holds everything that is not the picture, within a thumb's reach: the photographs taken so far and how many, a picker for stamping a photograph that already exists, which camera is watching, the record button, and the address. It thins to icons in landscape and pads itself clear of a phone's home indicator.
- **Photos form a compact strip below the camera** rather than a page-length gallery, so the live picture keeps the screen.

There is no second camera button. The page is already holding the camera open; a file input that opens the phone's camera app beside it was one camera too many.

#### Back or front

**Which lens watches is the device's to choose**, from the toolbar, at any time. A phone propped on a shelf watches the room through the camera on its back; the same phone held up to a face wants the one on its front; a laptop or a wall-mounted tablet only has the front one at all. So the recording page starts on the **back** camera and worker onboarding — normally somebody scanning their own face — starts on the **front** one, and either can be told otherwise.

The name beside the glyph is the camera **in use**, not the one a press would move to, so the bar answers "which camera is this?" without being touched; the whole sentence, including what a press does, is in the button's accessible name. The choice is remembered per page in `localStorage`, so a device set up once starts that way on every later visit. Blocked storage costs only the remembering — the switch still works for the visit.

Switching while the watch is running **swaps the video track instead of restarting**. The detector, the schedule, the photographs already taken and any attendance already recorded all read the same video element and carry on across the change. Because phones routinely refuse to hold both cameras open at once, the camera in hand is released before the other is asked for; if the other one refuses, the working camera is reopened and the toolbar goes back to naming it rather than leaving the watch blind. `facingMode` is asked for rather than demanded, so a device with a single camera returns that one instead of failing outright.

#### Attendance-taking confirmation

The recording page presents its initial facial check as **Attendance taking**. A successful check does not disappear in the same render that starts the activity. StampNote keeps a dedicated confirmation state over the camera for **1.8 seconds** so the worker can clearly see that attendance was recorded before the normal tracking interface returns.

The confirmation uses a full-camera dark green layer and a high-contrast card containing:

- a large animated green checkmark;
- the heading **Attendance recorded**;
- the worker's display name and a note that auto capture is starting; and
- the matched worker ID in oversized monospaced text.

The state has a compact two-column layout when a phone is held in landscape. Under `prefers-reduced-motion: reduce`, the same confirmation remains visible for the full interval without its scale and checkmark animations. The worker ID is announced through an assertive atomic live region, while the rest of the scan instructions retain their polite live updates.

This confirmation is presentation only. It does not change face descriptors, thresholds, roster selection, or the three-view agreement required by recognition; it makes an already-completed match apparent to the worker. Auto capture may initialize behind the confirmation, but the confirmation remains on top until its 1.8-second display interval ends. Skipped and still-retrying scans do not show the success state.

Vehicles are recognised and boxed in amber, labelled, and otherwise ignored: **a vehicle never changes the cadence.** A car in an empty frame is still an empty frame as far as the schedule is concerned, and a person who gets out of it starts the 30-second cadence just as they would anywhere else.

Matched people are labelled with their enrolled worker IDs, such as **WORKER-007**, in the live overlay and saved photos. A person who has not matched the roster is labelled **TRACKING WORKER**; the numeric session track ID remains internal. A local session tracker follows position, predicted motion, scale, coarse body proportions, a small gallery of clothing-colour samples, and facial re-identification. MediaPipe supplies the face and eye positions; StampNote aligns a temporary face crop and a local face-recognition network turns it into a unit-normalized 128-value embedding. A separate `onboarding.html` flow checks seven spaced, consistent samples over about six seconds and stores the seven representative templates plus their centroid in Firestore; the recording page's three-view opening scan compares against only the signed-in account's roster before capture begins. Both camera paths request 1920 × 1080 input, then fall back to the best resolution the device provides. The opening scan uses a focused face-only landmarker, so a face can fill the guide without requiring shoulders or hips to remain visible. Landmark geometry and lighting-normalized facial texture remain fallbacks while that model loads or when a face is too small to recognize reliably. A clear embedding mismatch or an insufficient lead over the runner-up declines the identity instead of selecting the nearest worker. Whole-frame assignment prevents a locally convenient match from swapping the remaining people, while enrollment templates remain immutable during a recording so uncertain live samples cannot cause identity drift. The badge says **face match on-device** only after the trained model has produced a usable, unambiguous live embedding.

Each saved JPEG burns in the matched worker ID and box outline before adding the location/date stamp; searchable photo metadata stores only aggregate counts. Face crops are cleared immediately after inference. Live embeddings, fallback signatures and clothing samples exist only in memory and are not sent to Gemini or telemetry. The explicit onboarding flow is the exception: it stores seven normalized 128-number templates and their normalized centroid—never a face photo—in Firestore until the worker is replaced or deleted. The gallery is flattened for Firestore storage and reconstructed after reading because Firestore does not permit nested arrays. Live and stored vectors are normalized identically before comparison. Matching requires repeated agreement and deliberately declines weak matches caused by tiny faces, motion, a person changing mid-scan, occlusion, extreme face angles or masks.

### How people and vehicles are found

Detection is MediaPipe Tasks Vision, committed under `vendor/` rather than pulled from a CDN, so the watch still runs with no network and nothing about its use leaves the device. Four models:

- **Pose landmarker (lite)** returns 33 body landmarks, which are mapped onto the joints the overlay draws. It knows the person's own left from their right — something a silhouette never can, since a silhouette only has the left and right of the picture.
- **Hand landmarker** returns 21 points per hand for both hands — the wrist, then four joints along every finger. The pose model stops at the wrist and reports three coarse hand points, so fingers come only from here.
- **Face landmarker** returns 478, drawn as the face oval, brows, eyes, irises and lips. The full mesh is 2,556 edges and reads as a grey smear at any size that fits on a phone; the outlines read as a face. Which point joins which comes from MediaPipe itself rather than indices written out by hand, because there is no eyeballing a wrong one among 478.
- **Object detector (EfficientDet-Lite0)** names `car`, `truck`, `bus` and `motorcycle`. A vehicle is boxed and labelled and nothing more; **it never changes the cadence.**

The checked-in MediaPipe assets occupy about 32 MB: an 11 MB WebAssembly runtime, the 5.5 MB pose model, and 3.6, 7.5 and 4.4 MB face, hand and vehicle models. The pose model is loaded first; the optional models follow in the background, so the watch can start before every annotation feature is ready. Anonymous face matching adds a lazy-loaded 6.1 MB recognition model and a 1.3 MB browser runtime. These assets are cached by the browser and run locally; none of the camera stream is sent to their publishers.

Landmarks below half visibility are dropped rather than drawn, so an arm behind a person's back leaves a gap instead of a bone through thin air.

### Keeping it moving

Inference is synchronous: every millisecond spent in a model is a millisecond the overlay cannot move. Three things keep it fluid.

**Drawing is not tied to detection.** Detection publishes a target and the screen eases towards it on every animation frame, which turns a row of stills into movement and damps the jitter a per-frame detector always has — at the cost of no extra inference at all. A joint that has just appeared is drawn where it is rather than sliding in from wherever the last one was.

**Models are asked only when their answer is worth having.** The object detector is by far the dearest and the slowest to change its mind — a parked car is still parked two seconds later — so it is asked every two seconds. A face and fingers mean nothing without a body, so on an empty scene neither is asked at all, which is what a watch spends most of its life looking at.

**The loop backs off to suit the device.** Each pass waits at least as long as the last one took, so a phone that gets through a frame in twenty milliseconds keeps the full rate while a slower one leaves half its time for drawing instead of queueing detections behind each other until nothing gets drawn at all.

### Being sure somebody is really there

Every model looks at each frame afresh rather than in video mode. Video mode detects once and then *tracks*, which is what makes it cheaper — but a pose it locked onto by mistake is handed back on every later frame, and a phone pointed at a ceiling kept a skeleton across the beams. Looking again each time puts the model's own detection confidence back in charge, and against a ceiling it then reports nothing at all. At four frames a second there is little tracking would have saved.

Landmarks existing is still not evidence that anybody is there, so presence is also earned on each frame:

- The trunk — the four joints reported most reliably and the last to be occluded — must be seen at **0.8** or better. A body properly in frame reports well over 0.9.
- Between 0.55 and 0.8 the reading needs a second opinion: a **face** where the head should be, or the **object detector** naming a person. That detector looks afresh at every frame instead of tracking, so it cannot inherit the mistake.
- A landmark carrying no score at all counts as nothing. Reading a missing number as full confidence is how a phantom gets waved through at maximum certainty.

A pose that does not convince is not drawn either, so the picture never shows a skeleton the schedule is ignoring. Vehicles are held to 0.6, and a box covering nearly the whole frame is discarded as the detector shrugging rather than a lorry parked against the lens.

### When the model cannot be had

An old browser, a failed download or a device without WebAssembly falls back to StampNote's own detector, which says so on screen. It finds a person the way a person differs from a room:

- **The scene is learned and the subject is whatever fails to match it**, compared across all three colour channels. Brightness alone is not enough — a blue shirt can carry the same luma as a grey wall while sharing none of its colour. The model learns quickly where it agrees with the picture and barely at all where it does not, so furniture settles in seconds while somebody standing still takes minutes to fade into the wallpaper.
- **Camera drift is subtracted first.** Every camera hunts for its exposure, which lifts the whole picture at once and reads as the entire frame moving. The median shift across the scene is the camera changing its mind, and taking it out leaves only what actually moved.
- **Skin tone, silhouette shape and a head above the shoulders** then say whether the thing in front of the scene is a person.

Colour cannot decide what is foreground, and an earlier version of this let it: the chrominance band that finds a forearm across every skin tone also finds varnished floorboards, terracotta, beige carpet and any room lit by a warm bulb. That made the floor a permanent part of the silhouette and swallowed anyone standing on it — one blob the width of the room, no limbs to rig, and an empty room that still had something in it.

The fallback is rougher than the model at everything: it needs some visible skin, it cannot tell one person from another or count them, it reads the picture's left and right rather than the person's, and it assumes an upright body.

### Where the photos go

Captures first go to IndexedDB on the device. After Gemini reviews a batch, each reviewed photo is saved directly in Cloud Firestore as a compact 512-pixel JPEG together with its searchable metadata. A failed or signed-out upload stays in the local queue and retries after Google sign-in; the same deterministic photo document ID is used on every attempt, so a retry cannot create a duplicate. Where IndexedDB is unavailable — private browsing, older WebViews — captures still work for the session and say so on screen.

Photo documents remain under `users/{uid}/photos/{photoId}`, worker templates live under `users/{uid}/workers/{workerId}`, and matched check-ins live under `attendanceDays/{date}/entries/{eventId}`. A recording session writes one attendance event per recognized worker: the opening worker is recorded after the three-view check, and additional enrolled workers are recorded after three unambiguous live face matches while capture continues. The same worker is never duplicated within one camera session. Firestore restricts photos and face templates to their signed-in owner; operational sessions and attendance remain available to authenticated team members. Owned templates in the legacy top-level `workers` collection remain readable during the transition, while another account's templates never enter matching. Anonymous visitors remain blocked. No public image URL exists: the authenticated dashboard turns Firestore bytes into a temporary in-browser image URL.

Open **Photos & attendance** (`admin.html`) to browse photos alongside recent attendance grouped by location and then date. Open **Worker onboarding** (`onboarding.html`) to enroll, replace, or delete worker templates; the worker ID is issued from the typed name rather than entered by hand. **Worker photos** (`worker-photos.html`) is the field path that does not start the watch: take one photo or pick several, stamp a fresh GPS fix and the day's weather, run Gemini sanitization, then save locally and sync when signed in. **Metrics** (`metrics.html`) plots three independent daily series — attendance taken, flags raised, and sessions created — over the last 7 or 30 days. **Operations AI** (`ai-dashboard.html`) answers questions about those loaded records.

The intended RPA truck-coordinate workflow matches the active session to the nearest truck by GPS
proximity; it does not infer the session address from the truck coordinate. The conservative match,
ambiguity, customer-language, and audit requirements are specified in
[`LOCATION_MATCHING.md`](LOCATION_MATCHING.md). On the dashboard, selecting a location, date, and
specific time session still supports manual truck placement. The dedicated Geographic Surveillence
page at `coordinates.html` lists every GPS reading beside its date/time session, orders dates and sessions for direct
comparison, and puts the truck X/Y inputs on the same session card. Stable `data-*` fields and a
page-level JSON index expose the same records to browser automation. Recording start also writes its
automatic GPS fix directly to the dashboard session, so the page does not have to wait for a photo
batch to finish AI review and cloud upload. Each session conceals its GPS and truck coordinate area
behind a Show coordinates button, and a truck point more than 25 m from the GPS reference is
explicitly flagged for review in both the UI and automation JSON. Compare on map opens both positions,
their straight-line difference, and the GPS uncertainty area on an attributed OpenStreetMap view.
Automatic nearest-truck resolution is not yet implemented.

`firebase.js` loads Firebase JavaScript SDK 12.17.1 modules directly from Google's CDN: App, Authentication, Cloud Firestore and optional Analytics. The checked-in browser configuration—including the API key and `storageBucket` name—identifies the Firebase project; it is not an authorization secret. StampNote does not load the Firebase Storage SDK or write photos to Cloud Storage. It stores compact JPEG bytes in authenticated-team Firestore documents.

The 512-pixel representation is deliberate. [Firestore documents are limited to 1 MiB](https://firebase.google.com/docs/firestore/quotas), while [Cloud Storage for Firebase requires the Blaze plan](https://firebase.google.com/docs/storage/faqs-storage-changes-announced-sept-2024). Keeping the compact bytes in Firestore lets this project use Firestore's no-cost quota without depending on Cloud Storage. Full-resolution originals remain in the device's IndexedDB and can still be saved out as files.

The local store keeps the most recent 240 photos within a 192 MB budget, dropping AI-flagged and low-scoring photos first while never dropping the newest. Save writes kept photos out as files; delete clears them.

### Optional Gemini review

The first time auto capture starts, StampNote explains exactly what leaves the device and asks for consent. Once allowed, every complete group of eight scheduled captures gets a semantic review automatically. A prominent cyan-and-violet AI throbber covers the screen while Gemini is actively processing and reports which batch is being analyzed; it does not stop the camera or block the controls beneath it. StampNote scales each candidate to at most 512 pixels, compresses it as JPEG, and sends the group with tightly validated capture metadata to **Gemini 3.1 Flash-Lite** through a server-only Google AI Studio API connection. The sparkle button remains available to review a leftover group smaller than eight or retry sooner after a failure. The app does not send a separate address or user-controlled purpose field, although an address stamped visibly into a photo remains part of that reduced image. Gemini sees only the reduced review copies. After its decisions are saved, a 512-pixel copy of every reviewed image—including recoverable flags—syncs to the authenticated Firestore workspace; hands-up captures remain outside the automatic Gemini batch.

Gemini compares each batch against a fixed, server-owned field-evidence policy and returns structured relevance, information-gain, quality, confidence, discard-basis and duplicate fields. The prompt treats pixels, OCR, signs, documents, QR codes and all metadata as untrusted evidence, never as instructions. The server derives the user-visible reason instead of displaying model-authored text. Every Gemini discard recommendation leaves the main gallery for the recoverable AI review bin. Recommendations with **80% confidence or higher** that pass the deterministic irrelevance, redundancy or unusable-quality checks are shown as AI rejects; uncertain or inconsistent recommendations are shown in amber in the same bin. A photo explicitly requested with the hands-up gesture is protected regardless of the model response.

The AI review bin is recoverable: open any flagged photo to read the policy-derived reason, restore it, or delete it. Restores sync the updated decision back to Firestore; permanent local deletion removes an already-synced Firestore copy first. If the model or network fails, unreviewed originals remain untouched.

The screen is held awake while the watch runs. A backgrounded tab has its camera suspended and its timers throttled by the browser, so tracking pauses when the page is hidden and picks the schedule back up on return — one photo is owed for the whole gap, not one per missed interval. **The page has to stay open and frontmost.**

## Stamping a photo you already have

The gallery picker on Recording is a native HTML file input, so the browser keeps the chosen photos on the device. It stamps images that already exist, and it is what remains where a live camera cannot be opened at all. Worker photos is the dedicated field page for the same job: two buttons, a stamp, Gemini sanitization, then Send.

## Operations AI

Operations AI is a read-only assistant for the signed-in workspace. The browser loads sessions, attendance, weather, GPS/truck comparisons, and Metrics series from Firestore, selects up to 24 retrieved facts for the current question, and POSTs them to `/api/assistant` with a Firebase ID token. Gemini **3.1 Flash-Lite** may use only those facts. It cites them as `[S1]`…`[S24]`, must not invent workers, dates, counts, URLs, or causes, and must not change data. Verified links, coordinate maps, and Metrics graphs are rendered by the page from the loaded records, not from model-authored markup.

A local Live Server origin (`http://127.0.0.1:5500` or `http://localhost:5500`) is allowed to call the deployed assistant. Same-site requests use `/api/assistant` on the current host. The endpoint rejects missing or invalid auth, oversized bodies, extra fields, and cross-site POSTs.

## Run locally

Node.js 24 is required. Install the dependencies and create the local environment file:

```sh
npm install
cp .env.example .env.local
```

Paste the Google AI Studio key into `GOOGLE_GENERATIVE_AI_API_KEY` in `.env.local`. No Gemini key belongs in browser code.

Start the dependency-light local server and open `http://127.0.0.1:8080`:

```sh
npm start
```

It serves the public files and the same four API handlers exposed on Vercel: `/api/triage`, `/api/assistant`, `/api/telemetry`, and `/api/health`. It deliberately refuses `.env.local`, package metadata, and internal API modules.

To use the Vercel development environment instead, first update the CLI—the currently installed 51.3.0 release is behind the current 58.11.0 release—then link and pull the project configuration:

```sh
npm i -g vercel@latest
vercel whoami
vercel link
vercel env pull
npm run dev
```

For production, add the server-only key to the linked project and redeploy:

```sh
vercel env add GOOGLE_GENERATIVE_AI_API_KEY production
```

Repeat with `preview` if preview deployments should call Gemini. Vercel environment names are positional arguments.

### Firebase setup

The Firebase browser configuration is public by design and already points at `stampnote-eedcd`; authorization comes from Firebase Authentication and the checked-in security rules, not from hiding that configuration. The project setup consists of:

1. Check the OAuth brand name and support email under `auth.providers.googleSignIn` in `firebase.json`.
2. Add `stampnote-omega.vercel.app`, `localhost`, and `127.0.0.1` in **Authentication → Settings → Authorized domains**.
3. Create the default **Cloud Firestore** database.
4. If Realtime Database will be used, create its default instance in the Firebase console. Sign the Firebase CLI into an account with access to `stampnote-eedcd`, then deploy the checked-in Google provider, Firestore rules, and Realtime Database rules:

   ```sh
   npx firebase-tools login
   npx firebase-tools deploy --only auth,firestore:rules,firestore:indexes,database --project stampnote-eedcd
   ```

5. Open Recording, sign in, review a photo batch, and confirm that Photos & attendance shows the compact copies for the same account. Operations AI and Metrics read the same signed-in workspace.

The Firestore and Realtime Database rules allow any authenticated project user to read and write project data; anonymous requests are denied. The checked-in Firestore index enables the dashboard's cross-date attendance query. Realtime Database is configured but the current application still stores photos, attendance, and worker templates in Firestore. The Google sign-in allowlist is therefore the security boundary. Analytics initialization is best-effort: a blocker may disable it without breaking Authentication or Firestore.

Use the same Google account on the capture page and `/admin.html`. Each account sees only its own uploaded photos. See the [Firebase CLI reference](https://firebase.google.com/docs/cli) and [Google provider configuration guide](https://firebase.google.com/docs/auth/configure-providers-cli) for the upstream command contract.

Before exposing the app publicly, configure Google API quotas or billing alerts and add Vercel Firewall rate-limit rules for `POST /api/triage` and `POST /api/assistant`. Photo review still relies on same-site checks and request validation rather than Firebase identity, so the firewall remains the cost boundary for direct scripted triage traffic. Operations questions require a verified Firebase ID token in addition to those checks.

Using localhost is important because browsers restrict precise geolocation and camera access to secure contexts. MediaPipe remains committed under `vendor/`; the installed server dependencies provide the AI SDK, structured-output validation and local environment loading.

To try it from a phone, reach the page over HTTPS (a tunnel or the deployed URL). Safari refuses
geolocation on a plain `http://` LAN address and reports it as a permission failure.

iOS Safari may require the location request to begin during a tap. StampNote attempts location after the first gallery upload where the browser permits it; the **Place** and **Start auto capture** controls provide a user gesture when it does not. If location was denied earlier, Safari keeps denying it silently; re-enable it with "aA" in the address bar → Website Settings → Location → Allow.

For the best camera experience, open the page on a mobile device. The autonomous watch asks for the rear camera and needs a secure page and a granted camera permission; the manual controls stay available where it cannot run. Browser camera behavior varies by device: supported mobile browsers open the rear camera for the manual control too, while desktop browsers generally show a file picker.

### Install as a full-screen app

`manifest.json` requests the `fullscreen` display mode with `standalone` as the compatibility fallback. From the deployed HTTPS site—or from `localhost`/`127.0.0.1` during development—use the browser's **Install app** or **Add to Home Screen** action, then launch StampNote from the installed icon. Opening the ordinary URL in a browser tab still shows browser chrome; the manifest display mode applies to the installed app window.

Chromium receives 192 px and 512 px maskable PNG icons. iOS receives a 180 px Apple touch icon plus the standalone and translucent-status-bar metadata, so a Home Screen launch omits Safari's URL and toolbar controls. Worker onboarding registers `sw.js` to cache its static assets for a later visit. Recording still does not promise a fresh offline launch: camera capture and the on-device store continue to work with assets already loaded.

## Automated tests

Run the suite or the built-in coverage report with:

```sh
npm test
npm run test:coverage
```

The suite contains more than 400 focused tests. It runs the browser entrypoints in controlled VM environments, starts the actual local HTTP server for boundary checks, and covers Firebase initialization/authentication/Firestore behavior, IndexedDB CRUD and fallbacks, the authenticated dashboard, Geographic Surveillence, Metrics, Operations AI, Worker photos, observability and health endpoints, Gemini review and assistant validation, cloud synchronization, manual stamping/share, AI review, and camera start/stop behavior.

The capture stack has focused tests for landmark mapping, anonymous session identity, aligned face embeddings, occluded joints, vehicle classification, synthetic fallback-detection scenes, tracker hysteresis, both capture cadences, gesture captures, local triage, storage pruning, and the controller driving a two-hour watch on a fake clock.

The MediaPipe and face-recognition weight files themselves are not inference-tested in Node. The adapter, mapping and identity layers around them are. The Gemini suite injects deterministic generation results instead of spending credits or sending images over the network.

`npm run test:coverage` prints the current line, branch and function report using Node's built-in coverage collector. Every first-party runtime entrypoint has an executable test. `server.js` runs in a child process for its HTTP integration test, so Node's parent-process coverage table does not merge it. Vendored runtimes and trained model assets are intentionally outside the report.

## Observability

The capture page and dashboard emit privacy-safe operational events for camera startup, tracking recovery, Gemini review, Operations AI questions, Google sign-in, Firestore sync, dashboard loading, browser errors, and basic performance. The Vercel functions add structured request logs and correlation headers, while `/api/health` reports whether the server and Gemini configuration are ready. Telemetry is limited to event names, anonymous per-page session and trace IDs, counts, durations, fixed states, and normalized error codes; it never includes image data, photo IDs, addresses, account identity, model reasons, or raw error messages.

See [OBSERVABILITY.md](OBSERVABILITY.md) for the event catalog, production log commands, privacy contract, health check, and failure runbooks.

## Workflow

1. Open the page menu and go to Worker onboarding. Sign in with Google, enter the worker name — the ID is issued from it — then hold close for seven clear face views over about six seconds. Repeat for the worker roster.
2. Return to Recording and press record. The opening scan matches the face against Firestore before the activity begins; continue without a worker ID remains available.
3. The watch photographs the scene on its own — every 30 seconds with a person in frame, every 120 seconds without. Public boxes state the enrolled worker ID, or `TRACKING WORKER` until a roster match is available. Raise both hands above your head to take one there and then.
4. The street address fills in automatically where the browser allows it; otherwise type it in, and later captures pick it up.
5. Photos are stamped and stored on the device as they are taken. Allow Gemini review; every eight scheduled photos are then reviewed automatically and all eight compact copies sync to Firestore. Upload failures stay queued locally.
6. For a site photo without starting the watch, open Worker photos, take or pick images, then Send.
7. Open Photos & attendance to browse photos by location and date, filter the recoverable AI review bin, and review attendance grouped by location and date beside the photos. Geographic Surveillence compares GPS readings with truck X/Y. Metrics shows the 7- or 30-day counts. Operations AI answers questions from the records already loaded for the signed-in account.

## Project files

- `index.html` — page structure, live camera and controls
- `styles.css` — responsive visual design
- `address-service.js` — geolocation and reverse-geocoding functions
- `stamp.js` — canvas stamping of the address and date/time
- `pose-model.js` — loads the vendored MediaPipe models
- `pose-mapping.js` — turns MediaPipe's landmarks into the joints the overlay draws
- `pose-detector.js` — the fallback detector, used when the models cannot load
- `vendor/mediapipe/` — the committed MediaPipe runtime and models, with provenance and licence
- `vendor/face-api/` — the committed face-recognition runtime and weights, with provenance and licence
- `vendor/fonts/` — the committed type, so an offline load still gets Outfit and, on Geographic Surveillence, JetBrains Mono
- `capture-scheduler.js` — the 30-second and 120-second capture cadences
- `photo-store.js` — on-device capture store, with pruning and fallbacks
- `photo-cloud.js` — deterministic cloud paths, safe metadata and location/date grouping
- `photo-triage.js` — local blur, near-duplicate, novelty and importance checks
- `worker-face.js` — worker ID validation, template averaging and strict embedding matching
- `face-identity.js` — aligned 128-value face embeddings and enrolled-worker scan voting with no retained crops
- `person-tracker.js` — stable internal tracking with enrolled worker IDs on public boxes
- `api/_ai-triage.mjs` — validates batches, calls Gemini through Google AI Studio, and applies the conservative discard threshold
- `api/triage.mjs` — Vercel Function exposing the server-only AI review endpoint
- `api/_ai-assistant.mjs` — validates grounded operations questions, verifies the Firebase ID token, and calls Gemini through Google AI Studio
- `api/assistant.mjs` — Vercel Function exposing the server-only Operations AI endpoint
- `api/_observability.mjs` — correlation IDs, safe structured logs and response timing
- `api/_telemetry.mjs`, `api/telemetry.mjs` — strict privacy-safe browser event intake
- `api/_health.mjs`, `api/health.mjs` — deployment and Gemini configuration health check
- `observability.js` — bounded browser telemetry, error capture and performance signals
- `auto-capture.js` — the watch loop joining tracker, schedule and store
- `firebase.js` — Google Authentication plus Firestore photo, attendance, and worker-template access
- `sidebar.js`, `sidebar.css` — shared page menu mounted on every surface
- `admin.html`, `admin.css`, `admin.js` — combined authenticated photo and attendance dashboard
- `coordinates.html`, `coordinates.css`, `coordinates.js` — Geographic Surveillence GPS comparison and truck-coordinate entry workspace
- `ai-dashboard.html`, `ai-dashboard.css`, `ai-dashboard.js` — Operations AI conversation over loaded workspace records
- `metrics.html`, `metrics.css`, `metrics.js` — 7- and 30-day attendance, flag and session counts
- `onboarding.html`, `onboarding.css`, `onboarding.js` — signed-in worker face enrollment and roster management
- `worker-photos.html`, `worker-photos.css`, `worker-photos.js` — stamped field photos with Gemini sanitization and optional cloud sync
- `firebase.json`, `.firebaserc` — Firebase provider/rules deployment configuration and project alias
- `firestore.rules` — owner-scoped photo/face-template access with authenticated team operations
- `database.rules.json` — authenticated-team-wide Realtime Database access policy and attendance indexes
- `app.js` — interface behavior, camera lifecycle, cloud queue and session caching
- `server.js` — local static and AI-function development server
- `vercel.json` — Vercel static output and clean-URL configuration
- `sw.js` — caches Worker onboarding's static assets
- `manifest.json`, `icons/` — full-screen PWA launch metadata and install icons
- `tests/` — automated front-end, capture-stack and AI-boundary tests
- `package.json` — commands, runtime requirement and dependencies
- `package-lock.json` — pinned dependency graph
- `.env.example` — safe placeholders for the server-only Google AI Studio key and local port
- `OBSERVABILITY.md` — operational event catalog, privacy contract and incident runbooks
- `LOCATION_MATCHING.md` — conservative session-to-truck GPS proximity and ambiguity policy
- `README.md` — product scope and development notes

## Address data

When location is requested, the prototype sends the device's current coordinates to OpenStreetMap's public Nominatim reverse-geocoding service. The result is cached for the browser session and remains editable. The on-page OpenStreetMap
attribution was removed at the client's request; ODbL still requires attributing OSM wherever the
data is shown, so it should be restored — in the stamp, an about screen, or the share text — before
this goes public. This public endpoint is suitable for a moderate prototype under its usage policy; substantial production traffic should use a dedicated provider or hosted Nominatim instance.
