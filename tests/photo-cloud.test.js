const assert = require("node:assert/strict");
const { test } = require("node:test");

const cloud = require("../photo-cloud.js");

function record(overrides = {}) {
  const date = overrides.date || new Date(2026, 7, 13, 23, 45, 12);
  return {
    id: "1786635912000-photo123",
    capturedAt: date.toISOString(),
    capturedAtMs: date.getTime(),
    address: "10 Marina Bay, Singapore",
    gpsLocation: { latitude: 1.2868, longitude: 103.8545, accuracyMeters: 12.5 },
    poseDetected: true,
    pose: { people: 2 },
    uniquePeopleSeen: 5,
    trigger: "schedule",
    bytes: 2048,
    type: "image/jpeg",
    name: "stampnote.jpg",
    aiReview: {
      action: "keep",
      recommendation: "keep",
      confidence: 0.94,
      reason: "Useful field evidence.",
      reviewedAt: "2026-08-13T16:00:00.000Z",
      model: "gemini-3.1-flash-lite-preview",
    },
    ...overrides,
  };
}

test("cloud metadata keys are deterministic and use the capture device's local date", () => {
  const photo = record();
  const first = cloud.createPhotoMetadata(photo, "google-user-1");
  const second = cloud.createPhotoMetadata(photo, "google-user-1");

  assert.deepEqual(first, second);
  assert.equal(first.id, "1786635912000-photo123");
  assert.match(first.locationKey, /^10-marina-bay-singapore-[a-z0-9]{7}$/);
  assert.equal(cloud.createDateKey(photo.capturedAt), "2026-08-13");
});

test("cloud metadata contains the dashboard fields but never the Blob", () => {
  const photo = record({ blob: new Blob(["image"], { type: "image/jpeg" }) });
  const metadata = cloud.createPhotoMetadata(photo, "user-1");

  assert.equal(metadata.ownerId, "user-1");
  assert.equal(metadata.location, "10 Marina Bay, Singapore");
  assert.equal(Object.hasOwn(metadata, "vehicleCoordinates"), false);
  assert.equal(Object.hasOwn(metadata, "truckLocation"), false);
  assert.deepEqual(metadata.gpsLocation, {
    latitude: 1.2868,
    longitude: 103.8545,
    accuracyMeters: 12.5,
  });
  assert.equal(metadata.dateKey, "2026-08-13");
  assert.equal(metadata.people, 2);
  assert.equal(metadata.uniquePeopleSeen, 5);
  assert.equal(metadata.originalBytes, 2048);
  assert.equal(metadata.aiReview.confidence, 0.94);
  assert.equal(Object.hasOwn(metadata, "blob"), false);
});

test("missing locations get a stable dashboard group", () => {
  assert.equal(cloud.normalizeLocation("   "), "Unknown location");
  assert.equal(cloud.createLocationKey(""), cloud.createLocationKey("Unknown location"));
});

test("Truck location coordinates remain optional finite dashboard values", () => {
  assert.deepEqual(cloud.cleanTruckLocation({ x: "0", y: "-3.5" }), { x: 0, y: -3.5 });
  assert.deepEqual(cloud.cleanTruckLocation({ x: "", y: Number.POSITIVE_INFINITY }), {
    x: null,
    y: null,
  });
});

test("RPA coordinates are compared with automatic GPS using its metre accuracy threshold", () => {
  const gps = { latitude: 1.2868, longitude: 103.8545, accuracyMeters: 15 };
  const within = cloud.compareTruckLocation(gps, { x: 103.8545, y: 1.2868 });
  assert.deepEqual(within, {
    status: "within_accuracy",
    flagged: false,
    distanceMeters: 0,
    accuracyMeters: 15,
  });

  const discrepant = cloud.compareTruckLocation(gps, { x: 103.8555, y: 1.2868 });
  assert.equal(discrepant.status, "flagged");
  assert.equal(discrepant.flagged, true);
  assert.ok(discrepant.distanceMeters > discrepant.accuracyMeters);
  assert.equal(cloud.isCoordinateFlagged({ coordinateVerification: discrepant }), true);

  assert.equal(cloud.compareTruckLocation(null, { x: 103.8, y: 1.2 }).status, "gps_unavailable");
  assert.equal(cloud.compareTruckLocation(gps, { x: 103.8, y: null }).status, "incomplete");
  assert.equal(cloud.compareTruckLocation(gps, {}).status, "not_set");
});

test("dashboard session keys and time periods are deterministic", () => {
  const locationKey = cloud.createLocationKey("10 Marina Bay");

  assert.equal(cloud.sessionDefinitionFor(new Date(2026, 7, 14, 11, 59)).id, "morning");
  assert.equal(cloud.sessionDefinitionFor(new Date(2026, 7, 14, 12, 0)).id, "afternoon");
  assert.equal(cloud.sessionDefinitionFor(new Date(2026, 7, 14, 17, 0)).id, "evening");
  assert.equal(
    cloud.createSessionKey({ locationKey, dateKey: "2026-08-14", sessionId: "afternoon" }),
    `2026-08-14--${locationKey}--afternoon`,
  );
  assert.throws(
    () => cloud.createSessionKey({ locationKey, dateKey: "14-08-2026", sessionId: "afternoon" }),
    /valid date/,
  );
  assert.throws(
    () => cloud.createSessionKey({ locationKey, dateKey: "2026-08-14", sessionId: "overnight" }),
    /valid time period/,
  );
});

test("dashboard groups by location first, date second, newest first", () => {
  const marinaOlder = record({
    id: "marina-older",
    date: new Date(2026, 7, 12, 10),
    capturedAt: new Date(2026, 7, 12, 10).toISOString(),
    capturedAtMs: new Date(2026, 7, 12, 10).getTime(),
  });
  const marinaNewer = record({
    id: "marina-newer",
    date: new Date(2026, 7, 13, 10),
    capturedAt: new Date(2026, 7, 13, 10).toISOString(),
    capturedAtMs: new Date(2026, 7, 13, 10).getTime(),
  });
  const orchard = record({
    id: "orchard",
    address: "Orchard Road",
    location: "Orchard Road",
    locationKey: cloud.createLocationKey("Orchard Road"),
    dateKey: "2026-08-11",
    capturedAt: new Date(2026, 7, 11, 10).toISOString(),
    capturedAtMs: new Date(2026, 7, 11, 10).getTime(),
  });
  const photos = [
    cloud.createPhotoMetadata(marinaOlder, "u"),
    cloud.createPhotoMetadata(marinaNewer, "u"),
    orchard,
  ];

  const groups = cloud.groupPhotos(photos);
  assert.deepEqual(groups.map((group) => group.location), [
    "10 Marina Bay, Singapore",
    "Orchard Road",
  ]);
  assert.deepEqual(groups[0].dates.map((group) => group.dateKey), [
    "2026-08-13",
    "2026-08-12",
  ]);
  assert.equal(groups[0].dates[0].photos[0].id, "marina-newer");
});

test("both hard and uncertain Gemini discard recommendations are flagged", () => {
  assert.equal(
    cloud.isFlagged({ aiReview: { action: "discard", recommendation: "discard" } }),
    true,
  );
  assert.equal(
    cloud.isFlagged({ aiReview: { action: "review", recommendation: "discard" } }),
    true,
  );
  assert.equal(cloud.isFlagged({ aiReview: { action: "keep" } }), false);
});

test("cloud metadata sanitizes identifiers, review fields, and numeric fallbacks", () => {
  const metadata = cloud.createPhotoMetadata(
    record({
      id: " ../unsafe photo id ",
      name: "x".repeat(220),
      type: "image/" + "x".repeat(100),
      bytes: 0,
      blob: new Blob(["fallback-size"]),
      trigger: "unexpected",
      pose: { people: -4 },
      uniquePeopleSeen: Number.POSITIVE_INFINITY,
      aiReview: {
        action: "invented",
        recommendation: "invented",
        discardBasis: "x".repeat(80),
        relevance: "0.4",
        informationGain: Number.NaN,
        quality: null,
        confidence: 0.7,
        duplicateOf: "d".repeat(200),
        reason: "r".repeat(800),
        model: "m".repeat(180),
        reviewedAt: 123,
      },
    }),
    123,
  );

  assert.equal(metadata.id, "unsafe-photo-id");
  assert.equal(metadata.ownerId, "123");
  assert.equal(metadata.name.length, 180);
  assert.equal(metadata.contentType.length, 80);
  assert.equal(metadata.originalBytes, new Blob(["fallback-size"]).size);
  assert.equal(metadata.trigger, "schedule");
  assert.equal(metadata.people, 0);
  assert.equal(metadata.uniquePeopleSeen, 0);
  assert.equal(metadata.aiReview.action, "review");
  assert.equal(metadata.aiReview.recommendation, "keep");
  assert.equal(metadata.aiReview.discardBasis.length, 40);
  assert.equal(metadata.aiReview.relevance, 0.4);
  assert.equal(metadata.aiReview.informationGain, 0);
  assert.equal(metadata.aiReview.duplicateOf.length, 160);
  assert.equal(metadata.aiReview.reason.length, 600);
  assert.equal(metadata.aiReview.model.length, 120);
  assert.equal(metadata.aiReview.reviewedAt, "123");
});

test("location and date fallbacks are stable for malformed legacy records", () => {
  assert.equal(cloud.createDateKey("not-a-date"), "unknown-date");
  assert.equal(cloud.normalizeLocation("  10   Marina\nBay  "), "10 Marina Bay");
  assert.equal(cloud.normalizeLocation("x".repeat(300)).length, 240);
  assert.notEqual(cloud.createLocationKey("Café Road"), cloud.createLocationKey("Cafe Road"));
  assert.equal(cloud.isFlagged(null), false);
  assert.deepEqual(cloud.groupPhotos(null), []);

  const grouped = cloud.groupPhotos([
    {
      id: "legacy",
      location: "",
      capturedAt: "invalid",
      capturedAtMs: 0,
    },
  ]);
  assert.equal(grouped[0].location, cloud.UNKNOWN_LOCATION);
  assert.equal(grouped[0].dates[0].dateKey, "unknown-date");

  const withoutReview = cloud.createPhotoMetadata(record({ aiReview: null }), "u");
  assert.equal(withoutReview.aiReview, null);

  const legacy = cloud.createPhotoMetadata(
    record({ uniquePeopleSeen: undefined, pose: { people: 1 } }),
    "u",
  );
  assert.equal(legacy.uniquePeopleSeen, null);
});
