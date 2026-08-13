(function initializePhotoCloudData(globalScope) {
  "use strict";

  const UNKNOWN_LOCATION = "Unknown location";

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
    normalizeLocation,
    createLocationKey,
    createDateKey,
    createPhotoMetadata,
    isFlagged,
    groupPhotos,
  });

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  globalScope.StampNoteCloudData = api;
})(typeof window !== "undefined" ? window : globalThis);
