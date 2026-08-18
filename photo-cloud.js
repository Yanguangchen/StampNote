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

  // Reverse geocoders can move a fix from one house number to the next while
  // still naming the same road. The dashboard therefore gives every recorded
  // address a stable road-level parent. Keep Singapore-style names such as
  // "Jalan Besar" intact, while trimming only an address number and a terminal
  // road type: "32 Parbury Avenue" becomes "Parbury".
  function streetNameForLocation(value) {
    const location = normalizeLocation(value);
    if (location === UNKNOWN_LOCATION) return UNKNOWN_LOCATION;

    const withoutNumber = location
      .replace(/^(?:(?:blk|block)\s+)?#?\d+[a-z]?(?:\s*[-/]\s*\d+[a-z]?)?\s+/i, "")
      .trim();
    const withoutRoadType = withoutNumber
      .replace(
        /\s+(?:avenue|ave|boulevard|blvd|circle|close|court|crescent|drive|dr|gardens?|grove|highway|hwy|lane|ln|link|loop|parkway|pkwy|place|plaza|quay|rise|road|rd|street|st|terrace|vale|view|walk|way)\.?$/i,
        "",
      )
      .trim();

    return withoutRoadType || withoutNumber || location;
  }

  function createStreetKey(value) {
    return createLocationKey(streetNameForLocation(value));
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

  const WEATHER_SEVERITIES = Object.freeze(["storm", "wet", "damp", "dry", "unknown"]);

  function optionalRounded(value, places = 1) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    const factor = 10 ** places;
    return Math.round(number * factor) / factor;
  }

  // What is kept about a session's weather. Only the reading and the judgement
  // are stored — never a forecast for hours that had not happened yet without
  // saying so, which is what `provisional` is for.
  function cleanSessionWeather(value) {
    if (!value) return null;
    const severity = String(value.severity || "").trim();
    if (!WEATHER_SEVERITIES.includes(severity)) return null;

    return {
      severity,
      condition: String(value.condition || "").trim().slice(0, 60),
      precipitationMm: optionalRounded(value.precipitationMm, 1),
      maxGustKph: optionalRounded(value.maxGustKph, 0),
      temperatureC: optionalRounded(value.temperatureC, 0),
      wetHours: Math.max(0, Math.min(24, Math.floor(Number(value.wetHours) || 0))),
      hours: Math.max(0, Math.min(24, Math.floor(Number(value.hours) || 0))),
      // What the weather cost the session, kept with the reading that justifies
      // it so the figure never has to be recomputed from thresholds that may
      // since have changed.
      lostHours: optionalRounded(value.lostHours, 1),
      impactPercent: optionalRounded(value.impactPercent, 0),
      // A session read while it was still being worked was partly forecast, so
      // it is re-read once the day is over rather than standing as the record.
      provisional: value.provisional === true,
      recordedAtMs: Number.isFinite(Number(value.recordedAtMs))
        ? Math.floor(Number(value.recordedAtMs))
        : null,
    };
  }

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

  // A fix good to fifty metres can land on the house across the road, and the
  // reverse geocoder answers honestly: one site becomes "32 Parbury Avenue" on
  // Monday and "34 Parbury Avenue" on Tuesday. Addresses whose fixes sit within
  // this of each other are read as one site. It is wider than the accuracy the
  // capture screen accepts, and narrower than a city block.
  const SITE_MERGE_RADIUS_M = 75;

  // Where each address was actually photographed: the mean of its own fixes, so
  // one wild reading among twenty does not drag the address off its street.
  function summarizeAddressFixes(records) {
    const summaries = new Map();

    (records || []).forEach((record) => {
      const location = normalizeLocation(record?.location);
      if (location === UNKNOWN_LOCATION) return;

      if (!summaries.has(location)) {
        summaries.set(location, { location, count: 0, fixes: 0, latitude: 0, longitude: 0 });
      }
      const summary = summaries.get(location);
      summary.count += 1;

      const gps = normalizeGpsLocation(record?.gpsLocation);
      if (!gps) return;
      summary.fixes += 1;
      summary.latitude += gps.latitude;
      summary.longitude += gps.longitude;
    });

    return [...summaries.values()]
      .map((summary) => ({
        location: summary.location,
        count: summary.count,
        point:
          summary.fixes > 0
            ? {
                latitude: summary.latitude / summary.fixes,
                longitude: summary.longitude / summary.fixes,
              }
            : null,
      }))
      // The best-evidenced address goes first, so it is the one that names the
      // site and the thinner spellings collapse into it.
      .sort(
        (left, right) =>
          right.count - left.count || left.location.localeCompare(right.location),
      );
  }

  // Reads a set of located records as a set of sites. Nothing is written: the
  // records keep the address they were captured with, and this only decides
  // which of them are the same place.
  function createSiteIndex(records, options = {}) {
    const radiusMeters = Number.isFinite(options.radiusMeters)
      ? Math.max(0, options.radiusMeters)
      : SITE_MERGE_RADIUS_M;
    const clusters = [];
    const sites = new Map();

    summarizeAddressFixes(records).forEach((summary) => {
      // An address nobody has a fix for cannot be placed, so it stands alone
      // rather than being guessed into a neighbour.
      const cluster = summary.point
        ? clusters.find(
            (entry) =>
              entry.point &&
              distanceBetweenCoordinates(entry.point, summary.point) <= radiusMeters,
          )
        : null;

      if (!cluster) {
        clusters.push({
          location: summary.location,
          point: summary.point,
          weight: summary.point ? summary.count : 0,
          aliases: [],
        });
        return;
      }

      cluster.aliases.push(summary.location);
      // The centre follows the evidence, so a cluster is anchored by the
      // address it was mostly photographed at.
      const weight = cluster.weight + summary.count;
      cluster.point = {
        latitude:
          (cluster.point.latitude * cluster.weight + summary.point.latitude * summary.count) /
          weight,
        longitude:
          (cluster.point.longitude * cluster.weight + summary.point.longitude * summary.count) /
          weight,
      };
      cluster.weight = weight;
    });

    clusters.forEach((cluster) => {
      const aliases = [...cluster.aliases].sort((left, right) => left.localeCompare(right));
      const addresses = [cluster.location, ...aliases];
      const streetName = streetNameForLocation(cluster.location);
      const site = Object.freeze({
        location: cluster.location,
        locationKey: createLocationKey(cluster.location),
        streetName,
        streetKey: createStreetKey(streetName),
        // Where the site actually is, averaged over everything photographed
        // there. Anything that needs to ask the world about this place — the
        // weather, most of all — asks about this point.
        point: cluster.point
          ? Object.freeze({ latitude: cluster.point.latitude, longitude: cluster.point.longitude })
          : null,
        aliases: Object.freeze(aliases),
        // Every reverse-geocoded address remains available to the address step,
        // even though the GPS cluster gives all of them one street parent.
        addresses: Object.freeze(addresses),
        // The keys this site's older records were filed under, so a session
        // saved before the merge is still found.
        aliasKeys: Object.freeze(aliases.map((alias) => createLocationKey(alias))),
      });
      sites.set(cluster.location, site);
      aliases.forEach((alias) => sites.set(alias, site));
    });

    // An address this index never saw is simply itself.
    function siteFor(value) {
      const location = normalizeLocation(value);
      return (
        sites.get(location) || {
          location,
          locationKey: createLocationKey(location),
          streetName: streetNameForLocation(location),
          streetKey: createStreetKey(location),
          point: null,
          aliases: [],
          addresses: [location],
          aliasKeys: [],
        }
      );
    }

    return { radiusMeters, siteFor };
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
    const weather = cleanSessionWeather(record?.weather);

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
      trigger: ["gesture", "worker"].includes(record?.trigger) ? record.trigger : "schedule",
      source: ["camera", "library"].includes(record?.source) ? record.source : null,
      weather,
      weatherStatus:
        record?.weatherStatus === "unavailable" ? "unavailable" : weather ? "recorded" : null,
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
    SITE_MERGE_RADIUS_M,
    createSiteIndex,
    normalizeLocation,
    createLocationKey,
    streetNameForLocation,
    createStreetKey,
    createDateKey,
    createSessionKey,
    createPhotoMetadata,
    cleanTruckLocation,
    cleanSessionWeather,
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
