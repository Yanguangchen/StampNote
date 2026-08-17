// Service worker for StampNote offline and static asset caching.
// Bumping this name purges every earlier cache on activation, which is the
// only way a browser holding a stale copy of the app's code lets go of it.
const CACHE_NAME = "stampnote-onboarding-v2";

const ONBOARDING_STATIC_ASSETS = [
  "onboarding.html",
  "onboarding.css",
  "onboarding.js",
  "sidebar.css",
  "sidebar.js",
  "worker-face.js",
  "camera-facing.js",
  "frame-scaler.js",
  "face-identity.js",
  "pose-mapping.js",
  "firebase.js",
  "pose-model.js",
  "observability.js",
  "manifest.json",
  "icons/stampnote.svg",
  "vendor/fonts/outfit.css",
  "vendor/fonts/outfit-latin.woff2",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => {
        return Promise.allSettled(
          ONBOARDING_STATIC_ASSETS.map((asset) =>
            fetch(asset, { cache: "reload" }).then((response) => {
              if (response.ok) return cache.put(asset, response);
            }),
          ),
        );
      })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("stampnote-onboarding-") && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// The app's own code changes whenever StampNote ships; the fonts and vision
// models it loads never change under the same URL. So code is read from the
// network first and only falls back to the cache when the site is unreachable,
// while the heavy immutable assets are still served from the cache instantly.
const CODE_EXTENSIONS = [".js", ".css", ".html", ".json"];
const IMMUTABLE_EXTENSIONS = [".woff2", ".wasm", ".task", ".tflite", ".svg"];

function isCode(pathname) {
  return CODE_EXTENSIONS.some((extension) => pathname.endsWith(extension));
}

function isImmutableAsset(pathname) {
  return IMMUTABLE_EXTENSIONS.some((extension) => pathname.endsWith(extension)) || pathname.includes("shard");
}

function store(request, response) {
  if (!response || response.status !== 200) return response;
  const copy = response.clone();
  caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
  return response;
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  const navigating = event.request.mode === "navigate";
  if (!navigating && !isCode(url.pathname) && !isImmutableAsset(url.pathname)) return;

  if (isImmutableAsset(url.pathname)) {
    event.respondWith(
      caches
        .match(event.request)
        .then((cached) => cached || fetch(event.request).then((response) => store(event.request, response))),
    );
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => store(event.request, response))
      .catch(() =>
        caches
          .match(event.request)
          .then((cached) => cached || Promise.reject(new Error("StampNote is offline and this page is not cached."))),
      ),
  );
});
