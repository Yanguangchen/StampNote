// Service worker for StampNote offline and static asset caching.
const CACHE_NAME = "stampnote-onboarding-v1";

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

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) return cachedResponse;

      return fetch(event.request).then((networkResponse) => {
        if (
          networkResponse &&
          networkResponse.status === 200 &&
          (url.pathname.endsWith(".js") ||
            url.pathname.endsWith(".css") ||
            url.pathname.endsWith(".html") ||
            url.pathname.endsWith(".svg") ||
            url.pathname.endsWith(".woff2") ||
            url.pathname.endsWith(".json") ||
            url.pathname.endsWith(".wasm") ||
            url.pathname.endsWith(".task") ||
            url.pathname.endsWith(".tflite") ||
            url.pathname.includes("shard"))
        ) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
        }
        return networkResponse;
      });
    }),
  );
});
