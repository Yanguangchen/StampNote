const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");

const overlay = require("../src/components/pose-overlay.js");
const attendance = require("../src/services/capture-attendance.js");
const camera = require("../src/capture/camera-controller.js");
const operationsData = require("../src/services/operations-data.js");
const adminScope = require("../src/services/admin-scope.js");
const coordinates = require("../src/services/coordinate-sessions.js");
const data = require("../photo-cloud.js");

test("coveredFrame maps keypoints through the same object-fit cover crop as the video", () => {
  const frame = overlay.coveredFrame(200, 100, 400, 100);

  assert.equal(frame.width, 400);
  assert.equal(frame.height, 100);
  assert.equal(frame.left, -100);
  assert.equal(frame.top, 0);
  assert.equal(overlay.boneWidth(150), 2);
  assert.equal(overlay.boneWidth(300), 2);
  assert.equal(overlay.boneWidth(450), 3);
});

test("drawOverlay is a canvas side-effect and ignores empty detections", () => {
  const calls = [];
  const canvas = {
    clientWidth: 10,
    clientHeight: 10,
    width: 0,
    height: 0,
    getContext() {
      return {
        clearRect(...args) {
          calls.push(["clearRect", args]);
        },
      };
    },
  };

  overlay.drawOverlay(canvas, { present: false });
  assert.equal(canvas.width, 10);
  assert.equal(canvas.height, 10);
  assert.deepEqual(calls[0][0], "clearRect");
  overlay.drawOverlay(canvas, null);
  overlay.drawOverlay(null, { present: true });
});

test("attendance recorder waits for match votes and retries a failed save", async () => {
  const saved = [];
  const recorder = attendance.createAttendanceRecorder({
    requiredMatchVotes: 2,
    cloud: {
      async saveAttendance(entry) {
        saved.push(entry);
      },
    },
    getLocation: () => "10 Marina Bay",
  });

  recorder.rememberEnrollment("W001", "Jane Tan");
  recorder.saveVisible([{ workerId: "W001", faceMatched: true }]);
  assert.equal(saved.length, 0);
  recorder.saveVisible([{ workerId: "W001", faceMatched: true }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].workerId, "W001");
  assert.equal(saved[0].displayName, "Jane Tan");
  assert.equal(saved[0].location, "10 Marina Bay");
  assert.equal(saved[0].source, "face-match");
  assert.equal(saved[0].reviewStatus, "clear");
  assert.equal(attendance.attendanceDateKey(new Date("2026-08-18T04:00:00.000Z")).length, 10);
});

test("manual attendance accepts only an enrolled profile and requires review", async () => {
  const saved = [];
  const recorder = attendance.createAttendanceRecorder({
    cloud: {
      async saveAttendance(entry) {
        saved.push(entry);
      },
    },
  });
  recorder.rememberEnrollment("W009", "Bo Lim");

  assert.equal(recorder.saveManual({ workerId: "UNKNOWN" }), false);
  assert.equal(recorder.saveManual({ workerId: "W009", personLabel: "Wrong Name" }), true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(saved.length, 1);
  assert.equal(saved[0].displayName, "Bo Lim");
  assert.equal(saved[0].source, "manual");
  assert.equal(saved[0].reviewStatus, "flagged");
  assert.equal(saved[0].reviewReason, "manual-entry");
});

test("camera controller describes permission failures without exposing internals", () => {
  assert.match(
    camera.describeCameraError({ name: "NotAllowedError" }),
    /Camera permission was denied/,
  );
  assert.match(
    camera.describeCameraError(new Error("boom"), { isSecureContext: false }),
    /secure page/,
  );
  assert.deepEqual(camera.videoRequest(null, "user").audio, false);
  assert.equal(camera.videoRequest(null, "user").video.facingMode, "user");
});

test("operations data service walks photo pages and deduplicates by id", async () => {
  const service = operationsData.createOperationsDataService({
    async getPhotosPage({ after }) {
      if (!after) {
        return {
          photos: [
            { id: "a" },
            { id: "a" },
            { id: "b" },
          ],
          after: "cursor",
          hasMore: true,
        };
      }
      return { photos: [{ id: "c" }], after: null, hasMore: false };
    },
    async getAttendance({ pageSize }) {
      return { pageSize };
    },
    async getDashboardSessions() {
      return ["session"];
    },
  });

  assert.deepEqual(await service.loadAllPhotos(), [{ id: "a" }, { id: "b" }, { id: "c" }]);
  assert.deepEqual(await service.loadAttendance({ pageSize: 9 }), { pageSize: 9 });
  assert.deepEqual(await service.loadDashboardSessions(), ["session"]);
});

test("admin scope groups photos and attendance without touching the DOM", () => {
  const location = "10 Marina Bay";
  const capturedAtMs = Date.parse("2026-08-14T13:10:00.000Z");
  const photos = [
    {
      id: "photo-1",
      location,
      locationKey: data.createLocationKey(location),
      dateKey: "2026-08-14",
      capturedAtMs,
    },
  ];
  const attendanceRows = [
    {
      workerId: "W001",
      displayName: "Jane Tan",
      location,
      dateKey: "2026-08-14",
      checkedInAtMs: capturedAtMs,
    },
    {
      workerId: "W001",
      displayName: "Jane Tan",
      location,
      dateKey: "2026-08-14",
      checkedInAtMs: capturedAtMs + 1000,
      source: "manual",
      reviewStatus: "flagged",
    },
  ];
  const scope = adminScope.buildScope({
    photos,
    attendance: attendanceRows,
    data,
    dashboardSessions: new Map(),
  });
  const selection = { locationKey: scope[0].locationKey, dateKey: "2026-08-14", sessionId: "all" };
  const view = adminScope.resolveSelection(scope, selection);

  assert.equal(scope.length, 1);
  assert.equal(scope[0].location, location);
  assert.equal(adminScope.summarizeAttendance(attendanceRows).length, 1);
  assert.equal(adminScope.summarizeAttendance(attendanceRows)[0].flaggedCheckIns, 1);
  assert.equal(adminScope.scopedPhotos(view).length, 1);
  assert.equal(adminScope.isScopeChosen(view, selection.sessionId), true);
  assert.equal(
    adminScope.describeError({ code: "permission-denied" }).includes("Firebase denied access"),
    true,
  );
});

test("coordinate session comparison stays a pure function of GPS and truck input", () => {
  const location = "10 Marina Bay";
  const capturedAtMs = Date.parse("2026-08-14T13:10:00.000Z");
  const sessions = coordinates.buildCoordinateSessions(
    {
      photos: [
        {
          id: "photo-1",
          location,
          locationKey: data.createLocationKey(location),
          dateKey: "2026-08-14",
          capturedAt: new Date(capturedAtMs).toISOString(),
          capturedAtMs,
          gpsLocation: { latitude: 1.2868, longitude: 103.8545, accuracyMeters: 8 },
        },
      ],
    },
    data,
  );
  const comparison = coordinates.compareSessionToTruck(
    sessions[0],
    { x: 103.8545, y: 1.2868 },
    data,
  );

  assert.equal(sessions.length, 1);
  assert.equal(comparison.status, "within_threshold");
  assert.equal(comparison.flaggedForReview, false);
});

test("pages load the split modules from src/ and the local server exposes that folder", () => {
  const root = resolve(__dirname, "..");
  const capture = readFileSync(resolve(root, "index.html"), "utf8");
  const admin = readFileSync(resolve(root, "admin.html"), "utf8");
  const coordinatesPage = readFileSync(resolve(root, "coordinates.html"), "utf8");
  const operationsAi = readFileSync(resolve(root, "ai-dashboard.html"), "utf8");
  const server = readFileSync(resolve(root, "server.js"), "utf8");

  assert.match(capture, /src\/vision\/pose-detector\.js/);
  assert.match(capture, /src\/components\/pose-overlay\.js/);
  assert.match(capture, /src\/services\/capture-attendance\.js/);
  assert.match(capture, /src\/capture\/camera-controller\.js/);
  assert.match(admin, /src\/services\/admin-scope\.js/);
  assert.match(admin, /src\/services\/operations-data\.js/);
  assert.match(coordinatesPage, /src\/services\/coordinate-sessions\.js/);
  assert.match(coordinatesPage, /src\/components\/coordinates-workspace\.js/);
  assert.match(operationsAi, /src\/services\/ai-assistant\.js/);
  assert.match(operationsAi, /src\/components\/ai-dashboard-workspace\.js/);
  assert.match(server, /relativePath\.startsWith\("src\/"\)/);
});
