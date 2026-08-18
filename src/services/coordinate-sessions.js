(function initializeCoordinateSessions(globalScope) {
  "use strict";


  const MATCH_THRESHOLD_METERS = 25;
  const MAX_GPS_ACCURACY_METERS = 20;

  function photoTimeMs(photo) {
    return Number(photo?.capturedAtMs) || Date.parse(photo?.capturedAt) || 0;
  }

  function validDateKey(value, data, atMs) {
    const raw = String(value || "");
    return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : data.createDateKey(atMs);
  }

  function sessionDefinition(data, sessionId) {
    return (
      (data.SESSION_DEFINITIONS || []).find((entry) => entry.id === sessionId) || {
        id: sessionId,
        label: sessionId || "Unknown",
        fromHour: 0,
      }
    );
  }

  function gpsReadings(photos, data, sessionReadings = []) {
    const candidates = [
      ...(photos || []).map((photo) => ({
        gpsLocation: photo?.gpsLocation,
        capturedAt: photo?.capturedAt,
        capturedAtMs: photoTimeMs(photo),
        sourceId: String(photo?.id || "") || null,
        sourcePhotoId: String(photo?.id || "") || null,
        sourceType: "photo",
      })),
      ...(sessionReadings || []).map((reading) => ({
        gpsLocation: reading?.gpsLocation,
        capturedAt: reading?.capturedAt,
        capturedAtMs: Number(reading?.capturedAtMs) || 0,
        sourceId: String(reading?.sourceId || "") || null,
        sourcePhotoId: null,
        sourceType: "session_start",
      })),
    ];
    const readings = candidates
      .map((candidate, index) => {
        const gps = data.normalizeGpsLocation(candidate.gpsLocation);
        if (!gps) return null;
        const capturedAtMs =
          Number(candidate.capturedAtMs) || Date.parse(candidate.capturedAt) || 0;
        return {
          readingId: `${candidate.sourceType}:${candidate.sourceId || index}:${capturedAtMs || 0}`,
          longitude: gps.longitude,
          latitude: gps.latitude,
          accuracyMeters: gps.accuracyMeters,
          capturedAt: capturedAtMs > 0 ? new Date(capturedAtMs).toISOString() : null,
          capturedAtMs: capturedAtMs || null,
          sourceType: candidate.sourceType,
          sourceId: candidate.sourceId,
          sourcePhotoId: candidate.sourcePhotoId,
        };
      })
      .filter(Boolean)
      .sort(
        (left, right) =>
          (left.capturedAtMs || 0) - (right.capturedAtMs || 0) ||
          left.accuracyMeters - right.accuracyMeters ||
          left.readingId.localeCompare(right.readingId),
      );

    const reference = [...readings].sort(
      (left, right) =>
        left.accuracyMeters - right.accuracyMeters ||
        (right.capturedAtMs || 0) - (left.capturedAtMs || 0) ||
        left.readingId.localeCompare(right.readingId),
    )[0] || null;

    return readings.map((reading) => ({
      ...reading,
      reference: reading.readingId === reference?.readingId,
    }));
  }

  function buildCoordinateSessions(input = {}, data) {
    if (!data) return [];
    const photos = input.photos || [];
    const attendance = input.attendance || [];
    const savedSessions = input.savedSessions || [];
    const siteIndex = typeof data.createSiteIndex === "function"
      ? data.createSiteIndex(photos)
      : {
          siteFor(value) {
            const location = data.normalizeLocation(value);
            return {
              location,
              locationKey: data.createLocationKey(location),
              aliases: [],
              aliasKeys: [],
            };
          },
        };
    const sessions = new Map();

    function ensure(rawLocation, dateKey, sessionId) {
      const site = siteIndex.siteFor(rawLocation);
      const normalizedDateKey = /^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ""))
        ? String(dateKey)
        : "unknown-date";
      const definition = sessionDefinition(data, sessionId);
      const key = data.createSessionKey({
        locationKey: site.locationKey,
        dateKey: normalizedDateKey,
        sessionId: definition.id,
      });

      if (!sessions.has(key)) {
        sessions.set(key, {
          key,
          location: site.location,
          locationKey: site.locationKey,
          aliases: [...(site.aliases || [])],
          aliasKeys: [...(site.aliasKeys || [])],
          dateKey: normalizedDateKey,
          sessionId: definition.id,
          sessionLabel: definition.label,
          sessionFromHour: Number(definition.fromHour) || 0,
          photos: [],
          attendance: [],
          sessionGpsReadings: [],
          truckLocation: { x: null, y: null },
          weather: null,
          firstAtMs: null,
          lastAtMs: null,
        });
      }
      return sessions.get(key);
    }

    function addTime(session, atMs) {
      if (!Number.isFinite(atMs) || atMs <= 0) return;
      session.firstAtMs = session.firstAtMs === null ? atMs : Math.min(session.firstAtMs, atMs);
      session.lastAtMs = session.lastAtMs === null ? atMs : Math.max(session.lastAtMs, atMs);
    }

    photos.forEach((photo) => {
      const atMs = photoTimeMs(photo);
      const definition = data.sessionDefinitionFor(atMs);
      const session = ensure(
        photo?.location,
        validDateKey(photo?.dateKey, data, atMs),
        definition.id,
      );
      session.photos.push(photo);
      addTime(session, atMs);
    });

    attendance.forEach((entry) => {
      const atMs = Number(entry?.checkedInAtMs) || 0;
      const definition = data.sessionDefinitionFor(atMs);
      const session = ensure(
        entry?.location,
        validDateKey(entry?.dateKey, data, atMs),
        definition.id,
      );
      session.attendance.push(entry);
      addTime(session, atMs);
    });

    savedSessions.forEach((saved) => {
      const session = ensure(saved?.location, saved?.dateKey, saved?.sessionId);
      const normalized = data.cleanTruckLocation(saved?.truckLocation);
      session.sessionLabel = String(saved?.label || "").trim() || session.sessionLabel;
      session.truckLocation = normalized;
      session.weather = data.cleanSessionWeather(saved?.weather) || session.weather;
      session.savedSessionKey = String(saved?.key || "") || null;
      if (data.normalizeGpsLocation(saved?.gpsLocation)) {
        const capturedAtMs = Number(saved?.gpsCapturedAtMs) || 0;
        session.sessionGpsReadings.push({
          gpsLocation: saved.gpsLocation,
          capturedAtMs,
          sourceId: String(saved?.key || session.key),
        });
        addTime(session, capturedAtMs);
      }
    });

    return [...sessions.values()].map((session) => {
      const readings = gpsReadings(session.photos, data, session.sessionGpsReadings);
      return {
        ...session,
        photos: [...session.photos].sort((left, right) => photoTimeMs(left) - photoTimeMs(right)),
        attendance: [...session.attendance].sort(
          (left, right) => Number(left.checkedInAtMs) - Number(right.checkedInAtMs),
        ),
        readings,
        reference: readings.find((reading) => reading.reference) || null,
      };
    });
  }

  function sortCoordinateSessions(sessions, order = "newest") {
    const direction = order === "oldest" ? 1 : -1;
    return [...(sessions || [])].sort((left, right) => {
      const leftKnown = /^\d{4}-\d{2}-\d{2}$/.test(left.dateKey);
      const rightKnown = /^\d{4}-\d{2}-\d{2}$/.test(right.dateKey);
      if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
      const dateComparison = left.dateKey.localeCompare(right.dateKey);
      if (dateComparison !== 0) return dateComparison * direction;
      return (
        left.sessionFromHour - right.sessionFromHour ||
        (left.firstAtMs || 0) - (right.firstAtMs || 0) ||
        left.location.localeCompare(right.location)
      );
    });
  }

  function compareSessionToTruck(session, input, data) {
    const truckLocation = data.cleanTruckLocation(input);
    const hasX = truckLocation.x !== null;
    const hasY = truckLocation.y !== null;
    const reference = session?.reference || null;

    if (!hasX && !hasY) {
      return {
        status: "not_set",
        state: "idle",
        distanceMeters: null,
        flaggedForReview: false,
        reviewReason: null,
        truckLocation,
      };
    }
    if (!hasX || !hasY) {
      return {
        status: "incomplete",
        state: "error",
        distanceMeters: null,
        flaggedForReview: false,
        reviewReason: null,
        truckLocation,
      };
    }
    if (!reference) {
      return {
        status: "gps_unavailable",
        state: "error",
        distanceMeters: null,
        flaggedForReview: true,
        reviewReason: "gps_unavailable",
        truckLocation,
      };
    }

    const distanceMeters = Number(
      data.distanceBetweenCoordinates(reference, {
        longitude: truckLocation.x,
        latitude: truckLocation.y,
      }).toFixed(1),
    );
    if (reference.accuracyMeters > MAX_GPS_ACCURACY_METERS) {
      return {
        status: "insufficient_accuracy",
        state: "error",
        distanceMeters,
        flaggedForReview: true,
        reviewReason: "insufficient_gps_accuracy",
        truckLocation,
      };
    }
    const withinThreshold = distanceMeters <= MATCH_THRESHOLD_METERS;
    return {
      status: withinThreshold ? "within_threshold" : "outside_threshold",
      state: withinThreshold ? "success" : "error",
      distanceMeters,
      flaggedForReview: !withinThreshold,
      reviewReason: withinThreshold ? null : "distance_exceeds_threshold",
      truckLocation,
    };
  }

  function sessionRecord(session, data, truckInput = session?.truckLocation) {
    const comparison = compareSessionToTruck(session, truckInput, data);
    return {
      sessionKey: session.key,
      location: session.location,
      locationKey: session.locationKey,
      aliases: [...(session.aliases || [])],
      dateKey: session.dateKey,
      sessionId: session.sessionId,
      sessionLabel: session.sessionLabel,
      firstAtMs: session.firstAtMs,
      lastAtMs: session.lastAtMs,
      gpsReadings: session.readings.map((reading) => ({ ...reading })),
      reference: session.reference ? { ...session.reference } : null,
      truckLocation: { ...comparison.truckLocation },
      weather: session.weather ? { ...session.weather } : null,
      comparison: {
        status: comparison.status,
        distanceMeters: comparison.distanceMeters,
        flaggedForReview: comparison.flaggedForReview,
        reviewReason: comparison.reviewReason,
        distanceThresholdMeters: MATCH_THRESHOLD_METERS,
        maximumGpsAccuracyMeters: MAX_GPS_ACCURACY_METERS,
      },
    };
  }

  const api = Object.freeze({
    MATCH_THRESHOLD_METERS,
    MAX_GPS_ACCURACY_METERS,
    buildCoordinateSessions,
    compareSessionToTruck,
    gpsReadings,
    sessionRecord,
    sortCoordinateSessions,
  });

  globalScope.StampNoteCoordinates = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
