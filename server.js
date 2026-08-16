const { createReadStream, existsSync, statSync } = require("node:fs");
const { createServer } = require("node:http");
const { extname, resolve, sep } = require("node:path");
const { config } = require("dotenv");

const root = resolve(__dirname);
const host = "127.0.0.1";
const port = Number(process.env.STAMPNOTE_PORT) || 8080;
const maxApiBytes = 7 * 1024 * 1024;
const publicFiles = new Set([
  "index.html",
  "styles.css",
  "address-service.js",
  "stamp.js",
  "pose-detector.js",
  "capture-scheduler.js",
  "photo-store.js",
  "photo-triage.js",
  "worker-face.js",
  "camera-facing.js",
  "frame-scaler.js",
  "face-identity.js",
  "person-tracker.js",
  "auto-capture.js",
  "pose-mapping.js",
  "pose-model.js",
  "observability.js",
  "photo-cloud.js",
  "firebase.js",
  "app.js",
  "admin.html",
  "admin.css",
  "admin.js",
  "coordinates.html",
  "coordinates.css",
  "coordinates.js",
  "onboarding.html",
  "onboarding.css",
  "onboarding.js",
  "worker-photos.html",
  "worker-photos.css",
  "worker-photos.js",
  "sidebar.css",
  "sidebar.js",
  "weather-service.js",
  "manifest.json",
  "icons/stampnote.svg",
  "icons/stampnote-180.png",
  "icons/stampnote-192.png",
  "icons/stampnote-512.png",
]);
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  // Served as application/wasm so the browser can compile it as it downloads
  // rather than waiting for all eleven megabytes to arrive first.
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".task": "application/octet-stream",
  ".tflite": "application/octet-stream",
};

// `vercel env pull` writes the short-lived local OIDC token here. Loading it
// keeps `npm start` useful as well as `vercel dev`; the file is gitignored and
// never sent to the browser.
config({ path: resolve(root, ".env.local"), quiet: true });

function readBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let bytes = 0;

    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxApiBytes) {
        rejectBody(
          Object.assign(new Error("Request body is too large."), { statusCode: 413 }),
        );
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolveBody(Buffer.concat(chunks)));
    request.on("error", rejectBody);
  });
}

async function serveApi(request, response, modulePath, handlerName) {
  const headers = new Headers();
  Object.entries(request.headers).forEach(([name, value]) => {
    if (Array.isArray(value)) {
      value.forEach((entry) => headers.append(name, entry));
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  });

  const body =
    request.method === "GET" || request.method === "HEAD" ? undefined : await readBody(request);
  const requestOptions = {
    method: request.method,
    headers,
    body,
    ...(body ? { duplex: "half" } : {}),
  };
  const webRequest = new Request(`http://${host}:${port}${request.url}`, requestOptions);
  const module = await import(modulePath);
  const result = await module[handlerName](webRequest);
  const resultHeaders = {};

  result.headers.forEach((value, name) => {
    resultHeaders[name] = value;
  });

  response.writeHead(result.status, resultHeaders);
  response.end(Buffer.from(await result.arrayBuffer()));
}

function serveStatic(pathname, response) {
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = resolve(root, relativePath);
  const isPublic = publicFiles.has(relativePath) || relativePath.startsWith("vendor/");

  if (
    !isPublic ||
    !filePath.startsWith(`${root}${sep}`) ||
    !existsSync(filePath) ||
    !statSync(filePath).isFile()
  ) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  response.writeHead(200, {
    "Content-Type":
      relativePath === "manifest.json"
        ? "application/manifest+json; charset=utf-8"
        : contentTypes[extname(filePath)] || "application/octet-stream",
    "Cache-Control": "no-store",
  });
  createReadStream(filePath).pipe(response);
}

createServer((request, response) => {
  const pathname = new URL(request.url, `http://${host}:${port}`).pathname;

  const apiRoutes = {
    "/api/triage": ["./api/_ai-triage.mjs", "handleTriageRequest"],
    "/api/telemetry": ["./api/_telemetry.mjs", "handleTelemetryRequest"],
    "/api/health": ["./api/_health.mjs", "handleHealthRequest"],
  };

  if (apiRoutes[pathname]) {
    serveApi(request, response, ...apiRoutes[pathname]).catch((error) => {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }

      response.writeHead(error?.statusCode || 500, {
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify({ error: "The local API request failed." }));
    });
    return;
  }

  serveStatic(pathname, response);
}).listen(port, host, () => {
  console.log(`StampNote is running at http://${host}:${port}`);
});
