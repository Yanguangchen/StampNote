(function initializePhotoCloudData(globalScope) {
  "use strict";

  const UNKNOWN_LOCATION = "Unknown location";
  const SESSION_DEFINITIONS = Object.freeze([
    Object.freeze({ id: "morning", label: "Morning", fromHour: 0, toHour: 12 }),
    Object.freeze({ id: "afternoon", label: "Afternoon", fromHour: 12, toHour: 17 }),
    Object.freeze({ id: "evening", label: "Evening", fromHour: 17, toHour: 24 }),
  ]);

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function normalizeLocation(value) {
    const normalized = String(value || "")
      .replace(/\s+/g, " ")
      .trim();

    return normalized ? normalized.slice(0, 240) : UNKNOWN_LOCATION;
  }

  // A short deterministic suffix prevents two addresses which produce the
  // same human-readable slug from sharing a dashboard group.
  function hashText(value) {
    let hash = 2166136261;

    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }

    return (hash >>> 0).toString(36).padStart(7, "0").slice(0, 7);
  }

  function createLocationKey(value) {
    const location = normalizeLocation(value);
    const slug = location
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "unknown-location";

    return `${slug}-${hashText(location)}`;
  }

  function sessionDefinitionFor(value) {
    const date = value instanceof Date ? value : new Date(value);
    const hour = Number.isNaN(date.getTime()) ? 0 : date.getHours();
    return (
      SESSION_DEFINITIONS.find(
        (session) => hour >= session.fromHour && hour < session.toHour,
      ) || SESSION_DEFINITIONS[0]
    );
  }

  function createSessionKey(value = {}) {
    const locationKey = String(
      value.locationKey || createLocationKey(value.location),
    ).trim();
    const dateKey = String(value.dateKey || "").trim();
    const sessionId = String(value.sessionId || "").trim();

    if (!/^[a-z0-9][a-z0-9-]{1,80}$/.test(locationKey)) {
      throw new Error("The session needs a valid location.");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) && dateKey !== "unknown-date") {
      throw new Error("The session needs a valid date.");
    }
    if (!SESSION_DEFINITIONS.some((session) => session.id === sessionId)) {
      throw new Error("The session needs a valid time period.");
    }

    return `${dateKey}--${locationKey}--${sessionId}`;
  }

  // Use the capture device's calendar date, not UTC, so midnight photographs
  // appear under the day the person holding the camera experienced.
  function createDateKey(value) {
    const date = value instanceof Date ? value : new Date(value);

    if (Number.isNaN(date.getTime())) {
      return "unknown-date";
    }

    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function safeSegment(value, fallback) {
    const segment = String(value || "")
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .replace(/^[._-]+|[._-]+$/g, "")
      .slice(0, 120);

    return segment || fallback;
  }

  function safeCount(value, maximum = 10_000) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(maximum, Math.floor(number))) : 0;
  }

  function optionalCount(value) {
    return value === undefined || value === null ? null : safeCount(value);
  }

  function optionalCoordinate(value) {
    if (value === undefined || value === null || value === "") {
      return null;
    }

    const coordinate = Number(value);
    return Number.isFinite(coordinate) ? coordinate : null;
  }

  function cleanTruckLocation(value = {}) {
    const x = optionalCoordinate(value?.x);
    const y = optionalCoordinate(value?.y);

    return {
      x: x !== null && x >= -180 && x <= 180 ? x : null,
      y: y !== null && y >= -90 && y <= 90 ? y : null,
    };
  }

  // Temporary aliases keep older clients and stored photo metadata readable.
  const cleanVehicleCoordinates = cleanTruckLocation;

  function normalizeGpsLocation(value) {
    const latitude = optionalCoordinate(value?.latitude);
    const longitude = optionalCoordinate(value?.longitude);
    const accuracyMeters = optionalCoordinate(value?.accuracyMeters ?? value?.accuracy);

    if (
      latitude === null ||
      latitude < -90 ||
      latitude > 90 ||
      longitude === null ||
      longitude < -180 ||
      longitude > 180 ||
      accuracyMeters === null ||
      accuracyMeters < 0
    ) {
      return null;
    }

    return { latitude, longitude, accuracyMeters };
  }

  function distanceBetweenCoordinates(left, right) {
    const toRadians = (degrees) => (degrees * Math.PI) / 180;
    const latitudeDelta = toRadians(right.latitude - left.latitude);
    const longitudeDelta = toRadians(right.longitude - left.longitude);
    const leftLatitude = toRadians(left.latitude);
    const rightLatitude = toRadians(right.latitude);
    const haversine =
      Math.sin(latitudeDelta / 2) ** 2 +
      Math.cos(leftLatitude) *
        Math.cos(rightLatitude) *
        Math.sin(longitudeDelta / 2) ** 2;

    const bounded = Math.min(1, Math.max(0, haversine));
    return 6_371_000 * 2 * Math.atan2(Math.sqrt(bounded), Math.sqrt(1 - bounded));
  }

  function compareTruckLocation(gpsLocation, input) {
    const truckLocation = cleanTruckLocation(input);
    const hasX = truckLocation.x !== null;
    const hasY = truckLocation.y !== null;
    const gps = normalizeGpsLocation(gpsLocation);

    if (!hasX && !hasY) {
      return {
        status: "not_set",
        flagged: false,
        distanceMeters: null,
        accuracyMeters: gps?.accuracyMeters ?? null,
      };
    }
    if (!hasX || !hasY) {
      return {
        status: "incomplete",
        flagged: false,
        distanceMeters: null,
        accuracyMeters: gps?.accuracyMeters ?? null,
      };
    }
    if (!gps) {
      return {
        status: "gps_unavailable",
        flagged: false,
        distanceMeters: null,
        accuracyMeters: null,
      };
    }

    const distanceMeters = distanceBetweenCoordinates(gps, {
      longitude: truckLocation.x,
      latitude: truckLocation.y,
    });
    const roundedDistance = Number(distanceMeters.toFixed(1));
    const flagged = distanceMeters > gps.accuracyMeters;

    return {
      status: flagged ? "flagged" : "within_accuracy",
      flagged,
      distanceMeters: roundedDistance,
      accuracyMeters: gps.accuracyMeters,
    };
  }

  const compareVehicleCoordinates = compareTruckLocation;

  function isCoordinateFlagged(photo) {
    return photo?.coordinateVerification?.flagged === true;
  }

  function cleanAiReview(aiReview) {
    if (!aiReview) {
      return null;
    }

    return {
      action: ["keep", "discard", "review"].includes(aiReview.action)
        ? aiReview.action
        : "review",
      recommendation: aiReview.recommendation === "discard" ? "discard" : "keep",
      discardBasis: String(aiReview.discardBasis || "not_applicable").slice(0, 40),
      relevance: Number(aiReview.relevance) || 0,
      informationGain: Number(aiReview.informationGain) || 0,
      quality: Number(aiReview.quality) || 0,
      confidence: Number(aiReview.confidence) || 0,
      duplicateOf:
        typeof aiReview.duplicateOf === "string" ? aiReview.duplicateOf.slice(0, 160) : null,
      reason: String(aiReview.reason || "").slice(0, 600),
      model: String(aiReview.model || "").slice(0, 120),
      reviewedAt: String(aiReview.reviewedAt || ""),
    };
  }

  function createPhotoMetadata(record, ownerId) {
    const capturedAtMs = Number(record?.capturedAtMs) || Date.parse(record?.capturedAt) || 0;
    const location = normalizeLocation(record?.address);

    return {
      id: safeSegment(record?.id, "unknown-photo"),
      ownerId: String(ownerId || ""),
      location,
      locationKey: createLocationKey(location),
      gpsLocation: normalizeGpsLocation(record?.gpsLocation),
      dateKey: createDateKey(record?.capturedAt || capturedAtMs),
      capturedAt: String(record?.capturedAt || new Date(capturedAtMs).toISOString()),
      capturedAtMs,
      name: String(record?.name || "stampnote.jpg").slice(0, 180),
      contentType: String(record?.type || "image/jpeg").slice(0, 80),
      originalBytes: Math.max(0, Number(record?.bytes) || Number(record?.blob?.size) || 0),
      trigger: record?.trigger === "gesture" ? "gesture" : "schedule",
      poseDetected: Boolean(record?.poseDetected),
      people: safeCount(record?.pose?.people),
      uniquePeopleSeen: optionalCount(
        record?.uniquePeopleSeen ?? record?.pose?.uniquePeopleSeen,
      ),
      aiReview: cleanAiReview(record?.aiReview),
    };
  }

  function isFlagged(photo) {
    return (
      photo?.aiReview?.action === "discard" ||
      (photo?.aiReview?.action === "review" &&
        photo?.aiReview?.recommendation === "discard")
    );
  }

  function groupPhotos(photos) {
    const locations = new Map();
    const ordered = [...(photos || [])].sort(
      (left, right) => (Number(right?.capturedAtMs) || 0) - (Number(left?.capturedAtMs) || 0),
    );

    ordered.forEach((photo) => {
      const location = normalizeLocation(photo?.location);
      const locationKey = photo?.locationKey || createLocationKey(location);
      const dateKey = photo?.dateKey || createDateKey(photo?.capturedAt || photo?.capturedAtMs);

      if (!locations.has(locationKey)) {
        locations.set(locationKey, {
          location,
          locationKey,
          latestAtMs: Number(photo?.capturedAtMs) || 0,
          dates: new Map(),
        });
      }

      const group = locations.get(locationKey);
      if (!group.dates.has(dateKey)) {
        group.dates.set(dateKey, []);
      }
      group.dates.get(dateKey).push(photo);
    });

    return [...locations.values()]
      .sort((left, right) => right.latestAtMs - left.latestAtMs)
      .map((location) => ({
        location: location.location,
        locationKey: location.locationKey,
        latestAtMs: location.latestAtMs,
        dates: [...location.dates.entries()]
          .sort(([left], [right]) => right.localeCompare(left))
          .map(([dateKey, groupedPhotos]) => ({ dateKey, photos: groupedPhotos })),
      }));
  }

  const api = Object.freeze({
    UNKNOWN_LOCATION,
    SESSION_DEFINITIONS,
    normalizeLocation,
    createLocationKey,
    createDateKey,
    createSessionKey,
    createPhotoMetadata,
    cleanTruckLocation,
    cleanVehicleCoordinates,
    normalizeGpsLocation,
    distanceBetweenCoordinates,
    compareTruckLocation,
    compareVehicleCoordinates,
    isCoordinateFlagged,
    isFlagged,
    groupPhotos,
    sessionDefinitionFor,
  });

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  globalScope.StampNoteCloudData = api;
})(typeof window !== "undefined" ? window : globalThis);
