const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");

const workerPhotos = require("../worker-photos.js");
const root = resolve(__dirname, "..");
const html = readFileSync(resolve(root, "worker-photos.html"), "utf8");
const css = readFileSync(resolve(root, "worker-photos.css"), "utf8");
const source = readFileSync(resolve(root, "worker-photos.js"), "utf8");

test("the worker page offers separate camera and multi-photo library inputs", () => {
  assert.match(html, /id="take-photo"[\s\S]*capture="environment"/);
  assert.match(html, /id="choose-photos"[\s\S]*multiple/);
  assert.match(html, /No recording needed/);
  assert.match(html, /current GPS,[\s\S]*weather/);
  assert.match(html, /id="worker-photo-send"[^>]*disabled>Send<\/button>/);
  assert.doesNotMatch(html, /Recent worker photos|Latest photo details|worker-photo-grid/);
  assert.doesNotMatch(html, /Ready\. Location access is requested/);
});

test("every selected batch gets a fresh GPS fix and weather before it becomes sendable", () => {
  assert.match(source, /maximumAge:\s*0/);
  assert.match(source, /fetchDayWeather/);
  assert.match(source, /reverseGeocode/);
  assert.match(source, /await readCaptureContext\(date\)/);
  assert.match(source, /createCaptureRecord\(\{[\s\S]*gpsLocation:[\s\S]*weather:/);
  assert.match(source, /trigger:\s*"worker"/);
  assert.match(source, /source,/);
});

test("Send runs Gemini sanitization before local persistence or cloud upload", () => {
  const sendStart = source.indexOf("async function sendStagedPhotos");
  const sendEnd = source.indexOf('takeInput.addEventListener("change"', sendStart);
  const sendFlow = source.slice(sendStart, sendEnd);
  assert.ok(sendStart > 0);
  assert.ok(sendFlow.indexOf("requestGeminiSanitization(staged)") < sendFlow.indexOf("store.save({"));
  assert.ok(sendFlow.indexOf("store.applyAiReviews") < sendFlow.indexOf("uploadRecord(record)"));
  assert.match(source, /!storage\.isAiFlagged\(record\)/);
  assert.match(source, /sendButton\.addEventListener\("click", sendStagedPhotos\)/);
});

test("a weather outage is recorded rather than blocking field photos", () => {
  const weather = workerPhotos.unavailableWeather(1234);
  assert.equal(weather.severity, "unknown");
  assert.equal(weather.condition, "Weather unavailable");
  assert.equal(weather.recordedAtMs, 1234);
  assert.equal(workerPhotos.describeWeather(weather), "Weather unavailable");
});

test("coordinates provide a stable address fallback and the page supports dark mode", () => {
  assert.equal(
    workerPhotos.fallbackAddress({ latitude: 1.2868, longitude: 103.8545 }),
    "1.28680, 103.85450",
  );
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  assert.match(html, /theme-color[^>]*prefers-color-scheme: dark/);
});
