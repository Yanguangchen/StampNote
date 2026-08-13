const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const net = require("node:net");
const { resolve } = require("node:path");
const { test } = require("node:test");

const projectRoot = resolve(__dirname, "..");

function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

function waitUntilReady(child) {
  return new Promise((resolveReady, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error(`Local server did not start.\n${output}`)), 5000);

    function inspect(chunk) {
      output += chunk;
      if (output.includes("StampNote is running")) {
        clearTimeout(timeout);
        resolveReady();
      }
    }

    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Local server exited with ${code}.\n${output}`));
    });
  });
}

function stopServer(child) {
  return new Promise((resolveStop) => {
    if (child.exitCode !== null) {
      resolveStop();
      return;
    }
    child.once("exit", resolveStop);
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 1000).unref();
  });
}

test("the local server exposes public assets and every API boundary without exposing internals", async () => {
  const port = await availablePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      STAMPNOTE_PORT: String(port),
      GOOGLE_GENERATIVE_AI_API_KEY: "configured-for-health-test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitUntilReady(child);
    const origin = `http://127.0.0.1:${port}`;

    const home = await fetch(`${origin}/`);
    assert.equal(home.status, 200);
    assert.match(home.headers.get("content-type"), /^text\/html/);
    assert.match(await home.text(), /<title>StampNote<\/title>/);
    assert.equal(home.headers.get("cache-control"), "no-store");

    const dashboard = await fetch(`${origin}/admin.html`);
    assert.equal(dashboard.status, 200);
    assert.match(await dashboard.text(), /Authenticated cloud library/);

    const onboarding = await fetch(`${origin}/onboarding.html`);
    assert.equal(onboarding.status, 200);
    assert.match(await onboarding.text(), /Worker onboarding/);
    assert.equal((await fetch(`${origin}/onboarding.css`)).status, 200);
    assert.equal((await fetch(`${origin}/onboarding.js`)).status, 200);

    const manifest = await fetch(`${origin}/manifest.json`);
    assert.equal(manifest.status, 200);
    assert.match(manifest.headers.get("content-type"), /^application\/manifest\+json/);
    assert.equal((await manifest.json()).display, "fullscreen");
    const appIcon = await fetch(`${origin}/icons/stampnote-192.png`);
    assert.equal(appIcon.status, 200);
    assert.match(appIcon.headers.get("content-type"), /^image\/png/);

    const firebase = await fetch(`${origin}/firebase.js`);
    assert.equal(firebase.status, 200);
    assert.match(firebase.headers.get("content-type"), /^text\/javascript/);

    const faceIdentity = await fetch(`${origin}/face-identity.js`);
    assert.equal(faceIdentity.status, 200);
    assert.match(faceIdentity.headers.get("content-type"), /^text\/javascript/);
    const faceModel = await fetch(
      `${origin}/vendor/face-api/model/face_recognition_model-weights_manifest.json`,
    );
    assert.equal(faceModel.status, 200);
    assert.match(faceModel.headers.get("content-type"), /^application\/json/);

    const hidden = await fetch(`${origin}/.env.local`);
    assert.equal(hidden.status, 404);
    assert.equal(await hidden.text(), "Not found");
    assert.equal((await fetch(`${origin}/api/_ai-triage.mjs`)).status, 404);
    assert.equal((await fetch(`${origin}/package.json`)).status, 404);

    const triage = await fetch(`${origin}/api/triage`);
    assert.equal(triage.status, 405);
    assert.deepEqual(await triage.json(), { error: "Use POST for photo review." });
    assert.ok(triage.headers.get("x-request-id"));

    const health = await fetch(`${origin}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, "ok");

    const telemetry = await fetch(`${origin}/api/telemetry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "server_test_1234",
        surface: "capture",
        events: [{ name: "health.checked", atMs: 1, fields: { status: "ok" } }],
      }),
    });
    assert.equal(telemetry.status, 202);
    assert.equal((await telemetry.json()).accepted, 1);
  } finally {
    await stopServer(child);
  }
});
