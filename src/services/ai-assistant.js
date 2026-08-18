(function initializeAiAssistant(globalScope) {
  "use strict";


  const MAX_RETRIEVED_FACTS = 24;
  const MAX_PUBLIC_SITE_CANDIDATES = 6;
  const MATCHED_TOKEN_SCORE = 4;
  const METRIC_RANGE_DAYS = Object.freeze([7, 30, 90]);
  const ROAD_WORDS = new Map([
    ["ave", "avenue"],
    ["avenue", "avenue"],
    ["blvd", "boulevard"],
    ["boulevard", "boulevard"],
    ["dr", "drive"],
    ["drive", "drive"],
    ["ln", "lane"],
    ["lane", "lane"],
    ["rd", "road"],
    ["road", "road"],
    ["st", "street"],
    ["street", "street"],
  ]);
  const QUERY_FILTER_STOP_WORDS = new Set([
    "a", "about", "activity", "activities", "all", "also", "am", "an", "and", "any",
    "anybody", "anyone", "anything", "are", "at", "attendance", "attend", "attended",
    "attending", "attention", "be", "been", "being", "between", "by", "can", "check",
    "check-in", "check-ins", "checked", "checking", "coordinate", "coordinates", "current",
    "data", "delay", "delays", "did", "discrepancies", "discrepancy", "do", "does", "during", "each",
    "everybody", "everything", "explain", "flag", "flagged", "flagging", "flags", "for",
    "from", "go", "gps", "graph", "graphs", "gust", "gusts", "had", "happen", "happened",
    "happening", "has", "have", "hour", "hours", "how", "i", "impact", "in", "is", "it", "latest",
    "location", "locations", "map", "me", "metric", "metrics", "most", "newest", "no",
    "of", "on", "open", "operations", "or", "photo", "photos", "please", "present",
    "lost", "missing", "need", "needed", "needing", "needs", "not", "overview", "problematic",
    "rain", "recent", "record", "recorded", "records", "reference", "references", "review",
    "session", "sessions", "show", "site", "sites", "someone", "statistics", "stats", "storm",
    "summarize", "summary", "tell", "team", "sent", "my", "want", "know",
    "than", "that", "the", "their", "then", "there", "these", "this", "those", "to", "today",
    "truck", "was", "weather", "were", "what", "when", "where", "which", "who", "whom",
    "whose", "why", "wind", "with", "work", "worked", "worker", "workers", "working", "wet",
    "yesterday",
  ]);

  function photoTimeMs(photo) {
    return Number(photo?.capturedAtMs) || Date.parse(photo?.capturedAt) || 0;
  }

  function normalizeSearchText(value) {
    return String(value || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function queryTokens(value) {
    return [...new Set(normalizeSearchText(value).split(" ").filter((token) => token.length > 1))];
  }

  function localDateKey(atMs = Date.now()) {
    const date = new Date(Number(atMs));
    if (!Number.isFinite(date.getTime())) return "";
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function shiftDateKey(dateKey, days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return "";
    const date = new Date(`${dateKey}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  function questionDateKeys(question, currentDate) {
    const normalized = normalizeSearchText(question);
    const dates = question.match(/\b\d{4}-\d{2}-\d{2}\b/g) || [];
    if (/\btoday\b/.test(normalized) && currentDate) dates.push(currentDate);
    if (/\byesterday\b/.test(normalized) && currentDate) dates.push(shiftDateKey(currentDate, -1));
    return [...new Set(dates.filter(Boolean))];
  }

  function identifyingQueryTokens(question, asksMetrics) {
    return queryTokens(question).filter((token) => {
      if (QUERY_FILTER_STOP_WORDS.has(token)) return false;
      if (/^\d{4}-\d{2}-\d{2}$/.test(token)) return false;
      if (asksMetrics && /^\d+$/.test(token)) return false;
      return true;
    });
  }

  function explicitlyScopedQueryTokens(question, asksMetrics) {
    const normalized = normalizeSearchText(question);
    const fragments = [];
    for (const match of String(question || "").matchAll(/["“]([^"”]+)["”]/g)) {
      fragments.push(match[1]);
    }
    const scoped = normalized.match(
      /\b(?:at|for|from|site|worker)\s+(?:the\s+)?(.+?)(?=\b(?:today|yesterday|on|during|session|sessions|check|checked|attendance|worker|workers)\b|$)/,
    );
    if (scoped?.[1]) fragments.push(scoped[1]);
    if (!/\b(?:is|are)\s+.{1,120}\s+(?:in|near|within)\b/.test(normalized)) {
      const geographicScope = normalized.match(
        /\b(?:in|near|around|within)\s+(?:the\s+)?(.+?)(?=\b(?:today|yesterday|on|during|session|sessions|check|checked|attendance|worker|workers)\b|$)/,
      );
      if (geographicScope?.[1]) fragments.push(geographicScope[1]);
    }
    const sentTo = String(question || "").match(/\bsent\b.{0,48}?\bto\s+([^,?.]+)/i);
    if (sentTo?.[1]) fragments.push(sentTo[1]);
    return identifyingQueryTokens(fragments.join(" "), asksMetrics);
  }

  function questionRequestsIntendedSiteComparison(question) {
    const normalized = normalizeSearchText(question);
    const asksForMismatch =
      /\b(discrep\w*|mismatch\w*|compare|comparison|different|difference|wrong location|off site|offsite)\b/.test(
        normalized,
      );
    const namesIntendedPlace =
      /\b(intended|assigned|planned|expected|supposed|destination|site|address)\b/.test(normalized);
    const namesObservedPlace =
      /\b(staff|worker|workers|team|crew|photo gps|gps|truck|vehicle)\b/.test(normalized);
    const asksThreeWay =
      /\b(?:staff|worker|workers|team|crew)\b.{0,80}\b(?:truck|vehicle)\b/.test(normalized) ||
      /\b(?:truck|vehicle)\b.{0,80}\b(?:staff|worker|workers|team|crew)\b/.test(normalized);
    return (
      (asksForMismatch && namesObservedPlace) ||
      (namesIntendedPlace && namesObservedPlace && (asksForMismatch || asksThreeWay))
    );
  }

  function questionRequestsPublicGeography(question, unmatchedSiteLookup = false) {
    const normalized = normalizeSearchText(question);
    if (questionRequestsIntendedSiteComparison(question)) return true;
    if (questionRequestsGpsAccuracyMargin(question)) return true;
    const asksForRelationship =
      /\b(where is|where are|located|is in|are in|belongs to|part of|locality|district|neighborhood|neighbourhood|region|city|country|public address)\b/.test(
        normalized,
      ) || /\b(?:is|are)\s+.{1,120}\s+(?:in|near|within)\b/.test(normalized);
    if (asksForRelationship) return true;
    return (
      unmatchedSiteLookup &&
      /\b(?:at|in|near|around|within)\s+[a-z0-9]/.test(normalized)
    );
  }

  function questionRequestsGpsAccuracyMargin(question) {
    const normalized = normalizeSearchText(question);
    if (
      /\b(margin of error|gps (?:error|accuracy|uncertainty)|accuracy radius|within (?:the )?(?:margin|accuracy|error|gps)|how far|end(?:ed)? up|sent .{0,80} to)\b/.test(
        normalized,
      )
    ) {
      return true;
    }
    const labels = extractPublicAddressLabels(question);
    const roads = new Set(labels.map((label) => publicAddressRoadKey(label)).filter(Boolean));
    return (
      labels.length >= 2 &&
      roads.size === 1 &&
      /\b(within|near|nearby|close|distance|apart|accuracy|margin|error|gps|far|difference|discrepancy|sent|ended|end)\b/.test(
        normalized,
      )
    );
  }

  const ADDRESS_STREET_STOP = new Set([
    "accuracy",
    "apart",
    "compare",
    "comparison",
    "difference",
    "discrepancy",
    "distance",
    "error",
    "gps",
    "location",
    "margin",
    "metres",
    "meters",
    "mismatch",
    "near",
    "radius",
    "uncertainty",
    "versus",
    "vs",
    "within",
  ]);

  function titleCaseAddressToken(token) {
    if (/^t[1-4]$/i.test(token)) return token.toUpperCase();
    return token.charAt(0).toUpperCase() + token.slice(1);
  }

  function publicAddressRoadKey(label) {
    const tokens = normalizeSearchText(label).split(" ").filter(Boolean);
    const withoutNumber = /^\d+[a-z]?$/.test(tokens[0] || "") ? tokens.slice(1) : tokens;
    return withoutNumber.filter((token) => !ROAD_WORDS.has(token)).join(" ");
  }

  function extractPublicAddressLabels(text) {
    const tokens = normalizeSearchText(text).split(" ").filter(Boolean);
    const labels = [];
    const seen = new Set();

    function add(label) {
      const normalized = normalizeSearchText(label);
      if (!normalized || seen.has(normalized) || !isPublicSiteLabel(label)) return;
      seen.add(normalized);
      labels.push(label);
    }

    for (let index = 0; index < tokens.length; index += 1) {
      if (!/^\d+[a-z]?$/.test(tokens[index])) continue;
      const street = [];
      for (let cursor = index + 1; cursor < tokens.length && street.length < 4; cursor += 1) {
        const token = tokens[cursor];
        if (/^\d+[a-z]?$/.test(token) || ADDRESS_STREET_STOP.has(token)) break;
        if (QUERY_FILTER_STOP_WORDS.has(token) && !ROAD_WORDS.has(token)) break;
        street.push(token);
        if (ROAD_WORDS.has(token)) break;
      }
      const words = [tokens[index], ...street].map((token) =>
        ROAD_WORDS.has(token) ? titleCaseAddressToken(ROAD_WORDS.get(token)) : titleCaseAddressToken(token),
      );
      add(words.join(" "));
    }
    return labels;
  }

  function completePublicAddressLabels(labels, knowledge) {
    const withStreet = labels.map((label) => {
      const tokens = normalizeSearchText(label).split(" ").filter(Boolean);
      if (tokens.length > 1 || !/^\d+[a-z]?$/.test(tokens[0] || "")) return label;
      const donor = labels.find((entry) => publicAddressRoadKey(entry));
      const roadTokens = donor ? publicAddressRoadKey(donor).split(" ").filter(Boolean) : [];
      if (roadTokens.length === 0) return label;
      return [tokens[0], ...roadTokens.map(titleCaseAddressToken)].join(" ");
    });
    const locations = (knowledge?.sessions || [])
      .map((session) => String(session.location || "").trim())
      .filter((location) => isPublicSiteLabel(location));
    return [...new Set(withStreet.map((label) => {
      const road = publicAddressRoadKey(label);
      const number = normalizeSearchText(label).split(" ")[0];
      if (!road || !/^\d+[a-z]?$/.test(number || "")) return label;
      const canonical = locations.find((location) => publicAddressRoadKey(location) === road);
      if (!canonical) return label;
      const suffix = String(canonical).replace(/^\d+[a-z]?\s+/i, "").trim();
      return suffix ? `${number} ${suffix}` : label;
    }))];
  }

  function gpsAccuracyMarginSuggestion(question, knowledge) {
    const labels = completePublicAddressLabels(extractPublicAddressLabels(question), knowledge);
    const roads = new Set(labels.map((label) => publicAddressRoadKey(label)).filter(Boolean));
    if (labels.length < 2 || roads.size !== 1) return null;
    const from = labels[0];
    const to = labels[1];
    const suggested =
      `I sent the team to ${from}. They ended up at ${to}. How far is that difference, and is it within GPS margin of error?`;
    if (normalizeSearchText(question) === normalizeSearchText(suggested)) return null;
    return {
      label: `How far is ${from} from ${to}?`,
      question: suggested,
    };
  }

  function isPublicSiteLabel(value) {
    const label = String(value || "").trim();
    if (
      label.length < 2 ||
      label.length > 160 ||
      /[\r\n<>]/.test(label) ||
      /https?:\/\//i.test(label) ||
      /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(label)
    ) {
      return false;
    }
    const normalized = normalizeSearchText(label);
    return (
      /\d/.test(normalized) ||
      /\b(?:airport|terminal|avenue|ave|boulevard|blvd|drive|lane|road|street)\b/.test(normalized)
    );
  }

  function semanticSiteFeatures(value) {
    const features = new Set();
    queryTokens(value).forEach((token) => {
      const road = ROAD_WORDS.get(token);
      if (road) {
        features.add(`road:${road}`);
        return;
      }
      if (/^\d+$/.test(token)) {
        features.add(`number:${token}`);
        return;
      }
      const terminal = /^t([1-4])$/.exec(token) || /^terminal-?([1-4])$/.exec(token);
      if (terminal) {
        features.add("facility:airport");
        features.add("facility:terminal");
        features.add(`terminal:${terminal[1]}`);
        return;
      }
      if (token === "airport") {
        features.add("facility:airport");
        return;
      }
      if (token === "terminal") {
        features.add("facility:airport");
        features.add("facility:terminal");
        return;
      }
      if (!QUERY_FILTER_STOP_WORDS.has(token)) features.add(`term:${token}`);
    });
    return features;
  }

  function siteReasoningScore(queryText, siteText, options = {}) {
    const queryFeatures = semanticSiteFeatures(queryText);
    const siteFeatures = semanticSiteFeatures(siteText);
    const queryNumbers = [...queryFeatures]
      .filter((feature) => feature.startsWith("number:"))
      .map((feature) => Number(feature.slice(7)));
    const siteNumbers = [...siteFeatures]
      .filter((feature) => feature.startsWith("number:"))
      .map((feature) => Number(feature.slice(7)));
    const sharedMeaning = [...queryFeatures].filter(
      (feature) =>
        (feature.startsWith("term:") || feature.startsWith("facility:")) &&
        siteFeatures.has(feature),
    );
    if (sharedMeaning.length === 0) return 0;

    if (
      !options.allowDistantStreetNumbers &&
      queryNumbers.length > 0 &&
      siteNumbers.length > 0 &&
      !queryNumbers.some((queryNumber) =>
        siteNumbers.some((siteNumber) => Math.abs(queryNumber - siteNumber) <= 2),
      )
    ) {
      return 0;
    }

    let score = sharedMeaning.length;
    score += [...queryFeatures].filter(
      (feature) => feature.startsWith("road:") && siteFeatures.has(feature),
    ).length * 0.25;
    if (
      queryNumbers.some((queryNumber) =>
        siteNumbers.some((siteNumber) => queryNumber === siteNumber),
      )
    ) {
      score += 1;
    } else if (
      queryNumbers.some((queryNumber) =>
        siteNumbers.some((siteNumber) => Math.abs(queryNumber - siteNumber) <= 2),
      )
    ) {
      score += 0.35;
    }
    return score;
  }

  function citedReferences(answer) {
    return new Set(
      [...String(answer || "").matchAll(/\bS(?:[1-9]|1\d|2[0-4])\b/g)].map(
        (match) => match[0],
      ),
    );
  }

  function photoFlagsMentionedInAnswer(answer, sources = []) {
    const cited = citedReferences(answer);
    return sources.filter((source) => source.photoFlag && cited.has(source.ref));
  }

  function sessionTime(atMs) {
    if (!Number.isFinite(atMs) || atMs <= 0) return "time unavailable";
    return new Date(atMs).toISOString().slice(11, 16) + " UTC";
  }

  function weatherDescription(weather) {
    if (!weather) return "not recorded";
    const pieces = [weather.condition || weather.severity];
    if (Number.isFinite(weather.precipitationMm)) pieces.push(`${weather.precipitationMm} mm rain`);
    if (Number.isFinite(weather.maxGustKph)) pieces.push(`gusts ${weather.maxGustKph} km/h`);
    if (Number.isFinite(weather.impactPercent)) pieces.push(`${weather.impactPercent}% estimated impact`);
    if (Number.isFinite(weather.lostHours)) pieces.push(`${weather.lostHours} estimated lost hours`);
    if (weather.provisional) pieces.push("provisional");
    return pieces.join(", ");
  }

  function comparisonDescription(comparison) {
    switch (comparison?.status) {
      case "within_threshold":
        return `within the ${comparison.distanceThresholdMeters} m limit (${comparison.distanceMeters} m)`;
      case "outside_threshold":
        return `flagged: ${comparison.distanceMeters} m from the GPS reference, over the ${comparison.distanceThresholdMeters} m limit`;
      case "insufficient_accuracy":
        return "flagged: photo and truck location discrepancy; GPS accuracy is insufficient";
      case "gps_unavailable":
        return "flagged: truck coordinates exist but no GPS reference is available";
      case "incomplete":
        return "truck coordinates are incomplete";
      default:
        return "truck coordinates are not set";
    }
  }

  function sessionMetadata(record) {
    if (!record) return null;
    return {
      sessionKey: String(record.sessionKey || ""),
      location: String(record.location || ""),
      locationKey: String(record.locationKey || ""),
      dateKey: String(record.dateKey || ""),
      sessionId: String(record.sessionId || ""),
      sessionLabel: String(record.sessionLabel || ""),
    };
  }

  function mapSnapshot(record) {
    const reference = record?.reference;
    const truck = record?.truckLocation;
    if (
      !Number.isFinite(reference?.latitude) ||
      !Number.isFinite(reference?.longitude) ||
      !Number.isFinite(truck?.y) ||
      !Number.isFinite(truck?.x)
    ) {
      return null;
    }
    return {
      session: sessionMetadata(record),
      reference: {
        latitude: Number(reference.latitude),
        longitude: Number(reference.longitude),
        accuracyMeters: Number(reference.accuracyMeters) || 0,
        sourcePhotoId: String(reference.sourcePhotoId || ""),
      },
      truck: {
        latitude: Number(truck.y),
        longitude: Number(truck.x),
      },
      distanceMeters: Number(record.comparison?.distanceMeters) || 0,
      thresholdMeters: Number(record.comparison?.distanceThresholdMeters) || 25,
      flaggedForReview: record.comparison?.flaggedForReview === true,
    };
  }

  // The intended site is the session's stored location label. Staff position
  // comes from the best recorded session-start or photo GPS reading; an
  // attendance event does not create a separate staff coordinate.
  function intendedSiteSnapshot(record) {
    const label = String(record?.location || "").trim();
    if (!label) return null;
    const reference = record?.reference;
    const truck = record?.truckLocation;
    const staffGps =
      Number.isFinite(reference?.latitude) && Number.isFinite(reference?.longitude)
        ? {
            latitude: Number(reference.latitude),
            longitude: Number(reference.longitude),
            accuracyMeters: Math.max(0, Number(reference.accuracyMeters) || 0),
          }
        : null;
    const truckPosition =
      Number.isFinite(truck?.y) && Number.isFinite(truck?.x)
        ? { latitude: Number(truck.y), longitude: Number(truck.x) }
        : null;
    return {
      sessionKey: String(record.sessionKey || ""),
      label,
      staffGps,
      truck: truckPosition,
    };
  }

  function intendedLocationDescription(record) {
    const snapshot = intendedSiteSnapshot(record);
    if (!snapshot) return "Intended site is not recorded.";
    const staff = snapshot.staffGps
      ? `staff/session GPS reference ${snapshot.staffGps.latitude.toFixed(6)}, ${snapshot.staffGps.longitude.toFixed(6)} with ±${snapshot.staffGps.accuracyMeters} m recorded accuracy`
      : "staff/session GPS reference not recorded";
    const truck = snapshot.truck
      ? `truck position ${snapshot.truck.latitude.toFixed(6)}, ${snapshot.truck.longitude.toFixed(6)}`
      : "truck position not recorded";
    return `Three-way location evidence: intended site ${snapshot.label}; ${staff}; ${truck}`;
  }

  function buildMetricSeries(input, metricsApi) {
    if (typeof metricsApi?.buildDailyMetrics !== "function") return {};
    return Object.fromEntries(
      METRIC_RANGE_DAYS.map((days) => [
        days,
        metricsApi.buildDailyMetrics({
          attendance: input.attendance || [],
          photos: input.photos || [],
          days,
          now: input.now,
        }),
      ]),
    );
  }

  function metricRangeForQuestion(question) {
    const normalized = normalizeSearchText(question);
    if (/\b(7 days?|seven days?|week|weekly)\b/.test(normalized)) return 7;
    if (/\b(90 days?|ninety days?|3 months?|three months?|quarter|quarterly)\b/.test(normalized)) return 90;
    return 30;
  }

  function metricIdsForQuestion(question) {
    const normalized = normalizeSearchText(question);
    const ids = [];
    if (/\b(attendance|attend|present|worker|check in|checked in)\b/.test(normalized)) ids.push("attendance");
    if (/\b(flag|flags|flagged|flagging|reviewed photo|discarded photo)\b/.test(normalized)) ids.push("flags");
    if (/\b(session|sessions)\b/.test(normalized)) ids.push("sessions");
    return ids;
  }

  function questionRequestsMetricAnalysis(question) {
    const normalized = normalizeSearchText(question);
    if (/\bflagged sessions?\b/.test(normalized)) return false;
    const asksForAnalysis =
      /\b(metrics?|statistics?|stats?|graphs?|charts?|trends?|daily|by day|over time|time series|how many|counts?|totals?|rates?|averages?|compare|comparison)\b/.test(
        normalized,
      ) || /\blast \d+ days?\b/.test(normalized);
    if (!asksForAnalysis) return false;
    if (metricIdsForQuestion(question).length > 0) return true;
    if (/\b(weather|rain|storm|gps|truck|coordinate|location|photos?|images?)\b/.test(normalized)) {
      return false;
    }
    return /\b(metrics?|statistics?|stats?|operations?|activity|overview|graphs?|charts?)\b/.test(
      normalized,
    );
  }

  function metricChartsForQuestion(question, knowledge) {
    if (!questionRequestsMetricAnalysis(question)) return [];
    const rangeDays = metricRangeForQuestion(question);
    const series = knowledge?.metricSeries?.[rangeDays] || [];
    const requestedIds = metricIdsForQuestion(question);
    const selected = requestedIds.length
      ? series.filter((entry) => requestedIds.includes(entry.id))
      : series;
    return selected.map((entry) => ({ ...entry, rangeDays }));
  }

  function buildKnowledgeBase(input = {}, data, coordinates, metricsApi = globalScope.StampNoteMetrics) {
    if (!data || !coordinates) {
      return {
        sessions: [],
        facts: [],
        metricSeries: {},
        currentDate: localDateKey(input.now),
        metrics: {
          sessionCount: 0,
          flaggedSessionCount: 0,
          weatherIssueCount: 0,
          attendanceCheckIns: 0,
          workerCount: 0,
          photoCount: 0,
        },
      };
    }

    const photos = input.photos || [];
    const attendance = input.attendance || [];
    const currentDate = localDateKey(input.now);
    const metricSeries = buildMetricSeries(input, metricsApi);
    const sessions = coordinates.buildCoordinateSessions(
      { photos, attendance, savedSessions: input.savedSessions || [] },
      data,
    );
    const workerIds = new Set(attendance.map((entry) => entry?.workerId).filter(Boolean));
    const attendanceNeedsReview = (entry) =>
      entry?.source === "manual" ||
      entry?.reviewStatus === "flagged" ||
      entry?.reviewReason === "manual-entry";
    const records = sessions.map((session) => {
      const coordinateRecord = coordinates.sessionRecord(session, data);
      const flaggedPhotos = session.photos.filter((photo) => data.isFlagged(photo));
      const coordinateFlaggedPhotos = session.photos.filter(
        (photo) => data.isCoordinateFlagged?.(photo) === true,
      );
      const flaggedAttendance = session.attendance.filter(attendanceNeedsReview);
      const attendees = [
        ...new Map(
          session.attendance.map((entry) => [
            entry.workerId || entry.displayName,
            { workerId: entry.workerId, displayName: entry.displayName },
          ]),
        ).values(),
      ];
      const weather = coordinateRecord.weather;
      const weatherIssue = Boolean(
        weather &&
          (["storm", "wet"].includes(weather.severity) || Number(weather.impactPercent) >= 25),
      );
      const flaggedForReview = Boolean(
        coordinateRecord.comparison.flaggedForReview ||
          flaggedPhotos.length > 0 ||
          coordinateFlaggedPhotos.length > 0 ||
          flaggedAttendance.length > 0,
      );
      const reasons = [];
      if (coordinateRecord.comparison.flaggedForReview) {
        reasons.push(coordinateRecord.comparison.reviewReason || coordinateRecord.comparison.status);
      }
      if (flaggedPhotos.length > 0) reasons.push(`${flaggedPhotos.length} AI-reviewed photo flag(s)`);
      if (coordinateFlaggedPhotos.length > 0) {
        reasons.push(`${coordinateFlaggedPhotos.length} photo location flag(s)`);
      }
      if (flaggedAttendance.length > 0) {
        reasons.push(
          `${flaggedAttendance.length} manual attendance check-in${
            flaggedAttendance.length === 1 ? "" : "s"
          } need${flaggedAttendance.length === 1 ? "s" : ""} review`,
        );
      }
      return {
        ...coordinateRecord,
        photos: session.photos,
        flaggedPhotos,
        coordinateFlaggedPhotos,
        flaggedAttendance,
        attendance: session.attendance,
        photoCount: session.photos.length,
        flaggedPhotoCount: flaggedPhotos.length,
        coordinateFlaggedPhotoCount: coordinateFlaggedPhotos.length,
        flaggedAttendanceCount: flaggedAttendance.length,
        attendanceCount: session.attendance.length,
        attendees,
        weatherIssue,
        flaggedForReview,
        flagReasons: reasons,
      };
    });

    const metrics = {
      sessionCount: records.length,
      flaggedSessionCount: records.filter((record) => record.flaggedForReview).length,
      weatherIssueCount: records.filter((record) => record.weatherIssue).length,
      attendanceCheckIns: attendance.length,
      workerCount: workerIds.size,
      photoCount: photos.length,
    };
    const knownDates = records
      .map((record) => record.dateKey)
      .filter((dateKey) => /^\d{4}-\d{2}-\d{2}$/.test(dateKey))
      .sort();
    const facts = [];

    function addFact(kind, text, metadata = {}) {
      facts.push({
        id: `${kind}:${facts.length + 1}`,
        kind,
        text: String(text).slice(0, 2_000),
        dateKey: metadata.dateKey || "",
        flagged: metadata.flagged === true,
        weatherIssue: metadata.weatherIssue === true,
        hasAttendance: metadata.hasAttendance === true,
        session: metadata.session || null,
        map: metadata.map || null,
        intendedSite: metadata.intendedSite || null,
        photoFlag: metadata.photoFlag || null,
        metricId: metadata.metricId || "",
        rangeDays: Number(metadata.rangeDays) || 0,
        priority: Number(metadata.priority) || 0,
        searchText: normalizeSearchText(`${text} ${metadata.keywords || ""}`),
        siteSearchText: normalizeSearchText(metadata.siteKeywords || ""),
      });
    }

    addFact(
      "overview",
      `Loaded scope: ${metrics.sessionCount} sessions, ${metrics.flaggedSessionCount} flagged sessions, ` +
        `${metrics.weatherIssueCount} sessions with problematic weather, ${metrics.attendanceCheckIns} attendance ` +
        `check-ins across ${metrics.workerCount} workers, and ${metrics.photoCount} photos. ` +
        `Date coverage: ${knownDates[0] || "unavailable"} through ${knownDates.at(-1) || "unavailable"}. ` +
        `Current local date: ${currentDate || "unavailable"}.`,
      { priority: 100 },
    );

    Object.entries(metricSeries).forEach(([days, entries]) => {
      entries.forEach((entry) => {
        const dailySeries = entry.keys
          .map((dateKey, index) => `${dateKey}:${entry.values[index]}`)
          .join(", ");
        addFact(
          "metric",
          `Metrics page — ${entry.title}, last ${days} days: ${entry.total} ` +
            `${entry.unit}${entry.total === 1 ? "" : "s"} total. ` +
            `Daily series from oldest to newest, including zero days: ${dailySeries}. ` +
            `Definition: ${entry.description}`,
          {
            metricId: entry.id,
            rangeDays: Number(days),
            priority: 6,
            keywords: `metrics statistics graph chart trend daily ${entry.title} ${entry.id}`,
          },
        );
      });
    });

    records.forEach((record) => {
      const linkedSession = sessionMetadata(record);
      const linkedMap = mapSnapshot(record);
      const linkedIntendedSite = intendedSiteSnapshot(record);
      const attendeeText = record.attendees.length
        ? record.attendees.map((entry) => `${entry.displayName} (${entry.workerId})`).join(", ")
        : "none recorded";
      const flagText = record.flaggedForReview
        ? `Flagged for review: ${record.flagReasons.join("; ") || "review required"}.`
        : "Not flagged for review.";
      const siteAliases = (record.aliases || []).filter(
        (alias) => normalizeSearchText(alias) !== normalizeSearchText(record.location),
      );
      const aliasText = siteAliases.length
        ? ` GPS-clustered address alias${siteAliases.length === 1 ? "" : "es"} for this same operational site: ${siteAliases.join(", ")}.`
        : "";
      const siteKeywords = `${record.location} ${siteAliases.join(" ")}`;
      addFact(
        "session",
        `Session ${record.sessionKey}. ${record.dateKey}, ${record.location}, ${record.sessionLabel}. ` +
          `${record.photoCount} photos (${record.flaggedPhotoCount} AI flags, ${record.coordinateFlaggedPhotoCount} photo location flags). ` +
          `${record.attendanceCount} attendance check-ins; workers: ${attendeeText}. ` +
          `Weather: ${weatherDescription(record.weather)}.${aliasText} ` +
          `${intendedLocationDescription(record)}. ` +
          `GPS/truck comparison: ${comparisonDescription(record.comparison)}. ${flagText}`,
        {
          dateKey: record.dateKey,
          flagged: record.flaggedForReview,
          weatherIssue: record.weatherIssue,
          hasAttendance: record.attendanceCount > 0,
          session: linkedSession,
          map: linkedMap,
          intendedSite: linkedIntendedSite,
          priority: record.flaggedForReview ? 12 : record.weatherIssue ? 9 : 4,
          keywords: `${siteKeywords} ${record.sessionLabel} ${record.attendees
            .map((entry) => `${entry.displayName} ${entry.workerId}`)
            .join(" ")}`,
          siteKeywords,
        },
      );

      const specificallyFlaggedPhotos = [
        ...new Map(
          [...record.flaggedPhotos, ...record.coordinateFlaggedPhotos].map((photo) => [
            String(photo?.id || photo?.documentId || ""),
            photo,
          ]),
        ).values(),
      ].filter((photo) => photo?.id || photo?.documentId);
      specificallyFlaggedPhotos.forEach((photo) => {
        const photoId = String(photo.id || photo.documentId);
        const flagDetails = [];
        if (data.isFlagged(photo)) {
          const reason = String(photo.aiReview?.reason || "").trim();
          flagDetails.push(
            `AI review recommended discard${reason ? ` because ${reason}` : ""}`,
          );
        }
        if (data.isCoordinateFlagged?.(photo)) {
          const distance = Number(photo.coordinateVerification?.distanceMeters);
          const accuracy = Number(photo.coordinateVerification?.accuracyMeters);
          flagDetails.push(
            Number.isFinite(distance) && Number.isFinite(accuracy)
              ? `photo GPS was ${distance} m from the truck location, beyond its ${accuracy} m accuracy`
              : "photo and truck coordinates were outside the accepted GPS accuracy",
          );
        }
        const detail = flagDetails.join("; ") || "review required";
        addFact(
          "flag",
          `Specific photo flag ${photoId}: captured on ${record.dateKey} at ${record.location}, ` +
            `${record.sessionLabel} session; ${detail}.`,
          {
            dateKey: record.dateKey,
            flagged: true,
            session: linkedSession,
            map: linkedMap,
            intendedSite: linkedIntendedSite,
            priority: 22,
            keywords: `${siteKeywords} ${photoId} photo image ${detail}`,
            siteKeywords,
            photoFlag: {
              photo,
              photoId,
              detail,
              location: record.location,
              dateKey: record.dateKey,
              sessionLabel: record.sessionLabel,
            },
          },
        );
      });

      if (record.flaggedForReview) {
        addFact(
          "flag",
          `Flagged session ${record.sessionKey}: ${record.dateKey}, ${record.location}, ${record.sessionLabel}. ` +
            `${record.flagReasons.join("; ") || comparisonDescription(record.comparison)}.`,
          {
            dateKey: record.dateKey,
            flagged: true,
            session: linkedSession,
            map: linkedMap,
            intendedSite: linkedIntendedSite,
            priority: 18,
            keywords: siteKeywords,
            siteKeywords,
          },
        );
      }
      if (record.weatherIssue) {
        addFact(
          "weather",
          `Problematic weather for session ${record.sessionKey}: ${record.dateKey}, ${record.location}, ` +
            `${record.sessionLabel}; ${weatherDescription(record.weather)}.`,
          {
            dateKey: record.dateKey,
            weatherIssue: true,
            session: linkedSession,
            map: linkedMap,
            priority: 16,
            keywords: siteKeywords,
            siteKeywords,
          },
        );
      }
    });

    attendance.forEach((entry) => {
      const atMs = Number(entry?.checkedInAtMs) || 0;
      const period = data.sessionDefinitionFor(atMs);
      const location = entry.location || data.UNKNOWN_LOCATION;
      const attendanceSession = {
        sessionKey: data.createSessionKey({
          locationKey: data.createLocationKey(location),
          dateKey: entry.dateKey,
          sessionId: period.id,
        }),
        location,
        locationKey: data.createLocationKey(location),
        dateKey: entry.dateKey,
        sessionId: period.id,
        sessionLabel: period.label,
      };
      const manualReview = attendanceNeedsReview(entry);
      addFact(
        "attendance",
        `Attendance: ${entry.displayName} (${entry.workerId}) checked in on ${entry.dateKey} at ` +
          `${sessionTime(atMs)}, location ${entry.location || data.UNKNOWN_LOCATION}, ${period.label} session.` +
          (manualReview ? " This attendance was added manually and needs review." : ""),
        {
          dateKey: entry.dateKey,
          flagged: manualReview,
          hasAttendance: true,
          session: attendanceSession,
          priority: manualReview ? 15 : 7,
          keywords: `${entry.displayName} ${entry.workerId} ${entry.location || ""} ${
            period.label
          } ${manualReview ? "manual attendance review flag needs review" : ""}`,
          siteKeywords: entry.location || "",
        },
      );
    });

    return { sessions: records, facts, metrics, metricSeries, currentDate };
  }

  function rankKnowledge(question, knowledge, limit = MAX_RETRIEVED_FACTS) {
    const normalized = normalizeSearchText(question);
    const tokens = queryTokens(question);
    const asksFlags = /\b(flag|flags|flagged|flagging|review|gps|truck|map|coordinate|location mismatch|discrep\w*)\b/.test(normalized);
    const asksWeather = /\b(weather|rain|storm|wet|wind|gust|delay|lost hour|impact)\b/.test(normalized);
    const asksAttendance = /\b(attendance|attend|present|worker|who|check in|checked in)\b/.test(normalized);
    const asksRecent = /\b(latest|recent|today|newest|last)\b/.test(normalized);
    const asksMetrics = questionRequestsMetricAnalysis(question);
    const candidateIdentifyingTokens = identifyingQueryTokens(question, asksMetrics);
    const requestedMetricIds = metricIdsForQuestion(question);
    const requestedMetricRange = metricRangeForQuestion(question);
    const requestedDates = questionDateKeys(question, knowledge.currentDate);
    const overview = knowledge.facts.find((fact) => fact.kind === "overview");
    const ranked = knowledge.facts
      .filter((fact) => fact !== overview)
      .map((fact) => {
        let score = fact.priority;
        tokens.forEach((token) => {
          if (fact.searchText.includes(token)) score += MATCHED_TOKEN_SCORE;
        });
        requestedDates.forEach((dateKey) => {
          if (fact.dateKey === dateKey) score += 24;
        });
        if (asksFlags && fact.flagged) score += 28;
        if (asksFlags && fact.kind === "flag") score += 18;
        if (asksWeather && fact.weatherIssue) score += 28;
        if (asksWeather && fact.kind === "weather") score += 18;
        if (asksAttendance && fact.hasAttendance) score += 22;
        if (asksAttendance && fact.kind === "attendance") score += 12;
        if (asksMetrics && fact.kind === "metric") score += 34;
        if (asksMetrics && fact.kind === "metric" && fact.rangeDays === requestedMetricRange) score += 26;
        if (
          asksMetrics &&
          fact.kind === "metric" &&
          (requestedMetricIds.length === 0 || requestedMetricIds.includes(fact.metricId))
        ) {
          score += 24;
        }
        if (!asksMetrics && fact.kind === "metric") score -= 15;
        if (asksRecent && /^\d{4}-\d{2}-\d{2}$/.test(fact.dateKey)) {
          score += Number(fact.dateKey.replaceAll("-", "")) / 10_000_000;
        }
        return { fact, score };
      })
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.fact.dateKey.localeCompare(left.fact.dateKey) ||
          left.fact.id.localeCompare(right.fact.id),
      );

    const matchedIdentifyingTokens = candidateIdentifyingTokens.filter((token) =>
      ranked.some(({ fact }) => fact.searchText.includes(token)),
    );
    const scopedIdentifyingTokens = explicitlyScopedQueryTokens(question, asksMetrics);
    let identifyingTokens = scopedIdentifyingTokens.length > 0
      ? scopedIdentifyingTokens
      : matchedIdentifyingTokens;
    const allowDistantStreetNumbers = questionRequestsGpsAccuracyMargin(question);
    if (allowDistantStreetNumbers) {
      const roadTokens = [...new Set(
        extractPublicAddressLabels(question)
          .map((label) => publicAddressRoadKey(label))
          .join(" ")
          .split(" ")
          .filter((token) => token.length > 1 && !QUERY_FILTER_STOP_WORDS.has(token)),
      )];
      const matchedRoadTokens = roadTokens.filter((token) =>
        ranked.some(({ fact }) => fact.searchText.includes(token)),
      );
      if (matchedRoadTokens.length > 0) identifyingTokens = matchedRoadTokens;
    }

    const filtered = ranked.filter(({ fact }) => {
      if (
        identifyingTokens.length > 0 &&
        !identifyingTokens.every((token) => fact.searchText.includes(token))
      ) {
        return false;
      }
      if (
        requestedDates.length > 0 &&
        fact.kind !== "metric" &&
        !requestedDates.includes(fact.dateKey)
      ) {
        return false;
      }
      return true;
    });
    const lookupWasConstrained = identifyingTokens.length > 0 || requestedDates.length > 0;
    const geographyLookupSuggested = questionRequestsPublicGeography(
      question,
      lookupWasConstrained && filtered.length === 0,
    );
    const reasoningQuery = scopedIdentifyingTokens.length > 0
      ? scopedIdentifyingTokens.join(" ")
      : candidateIdentifyingTokens.join(" ");
    const reasoningCandidates = lookupWasConstrained && filtered.length === 0
      ? ranked
          .filter(({ fact }) => fact.kind === "session" && fact.siteSearchText)
          .filter(
            ({ fact }) =>
              requestedDates.length === 0 || requestedDates.includes(fact.dateKey),
          )
          .map((entry) => ({
            ...entry,
            reasoningScore: siteReasoningScore(reasoningQuery, entry.fact.siteSearchText, {
              allowDistantStreetNumbers,
            }),
          }))
          .filter((entry) => entry.reasoningScore >= 1)
          .sort(
            (left, right) =>
              right.reasoningScore - left.reasoningScore ||
              right.score - left.score ||
              right.fact.dateKey.localeCompare(left.fact.dateKey),
          )
          .slice(0, Math.max(1, Math.min(6, limit - 2)))
      : [];
    const reasoningNotice = reasoningCandidates.length > 0
      ? {
          id: "overview:reasoning-candidates",
          kind: "overview",
          text: allowDistantStreetNumbers
            ? `The question compares public house numbers on the same street. ${reasoningCandidates.length} nearby recorded session(s) follow only for GPS accuracyMeters. Do not say the distance is unavailable because a named house number has no session.`
            : `No exact stored label matched ${identifyingTokens.join(" ")}. ` +
              `${reasoningCandidates.length} plausible site session candidate(s) follow because their address or facility concepts are related. ` +
              `These candidates require inference and are not confirmed aliases unless a session fact explicitly says they were GPS-clustered as the same operational site.`,
          dateKey: requestedDates[0] || "",
          flagged: false,
          weatherIssue: false,
          hasAttendance: false,
          session: null,
          map: null,
          metricId: "",
          rangeDays: 0,
          priority: 98,
          searchText: normalizeSearchText(reasoningQuery),
          siteSearchText: "",
        }
      : null;
    const geographyCandidatePool =
      geographyLookupSuggested &&
      filtered.length === 0 &&
      reasoningCandidates.length === 0 &&
      requestedDates.length > 0
        ? ranked.filter(
            ({ fact }) =>
              fact.kind === "session" &&
              fact.session?.location &&
              requestedDates.includes(fact.dateKey) &&
              isPublicSiteLabel(fact.session.location),
          )
        : [];
    const geographySiteLabels = [
      ...new Set(
        geographyCandidatePool.map(({ fact }) => normalizeSearchText(fact.session.location)),
      ),
    ].slice(0, MAX_PUBLIC_SITE_CANDIDATES);
    const geographyCandidates = geographyCandidatePool
      .filter(({ fact }) => geographySiteLabels.includes(normalizeSearchText(fact.session.location)))
      .slice(0, Math.max(0, limit - 2));
    const geographyNotice = geographyCandidates.length > 0
      ? {
          id: "overview:geography-candidates",
          kind: "overview",
          text:
            `No exact stored site label matched ${identifyingTokens.join(" ")}. ` +
            `${geographySiteLabels.length} same-date public site candidate(s) follow so Google Maps can verify whether an address belongs to the requested locality. ` +
            `Do not treat the public geographic relationship as proof of attendance or other operational details without the corresponding session facts.`,
          dateKey: requestedDates[0] || "",
          flagged: false,
          weatherIssue: false,
          hasAttendance: false,
          session: null,
          map: null,
          intendedSite: null,
          metricId: "",
          rangeDays: 0,
          priority: 98,
          searchText: normalizeSearchText(reasoningQuery),
          siteSearchText: "",
        }
      : null;
    const zeroMatchFact =
      !allowDistantStreetNumbers &&
      lookupWasConstrained &&
      filtered.length === 0 &&
      !reasoningNotice &&
      !geographyNotice
      ? {
          id: "overview:query-zero-match",
          kind: "overview",
          text:
            `Complete lookup across all ${knowledge.facts.length} loaded operational facts found 0 records` +
            `${identifyingTokens.length ? ` matching identifying term(s): ${identifyingTokens.join(", ")}` : ""}` +
            `${requestedDates.length ? ` on ${requestedDates.join(" or ")}` : ""}.`,
          dateKey: requestedDates[0] || "",
          flagged: false,
          weatherIssue: false,
          hasAttendance: false,
          session: null,
          map: null,
          metricId: "",
          rangeDays: 0,
          priority: 99,
          searchText: normalizeSearchText(`${identifyingTokens.join(" ")} ${requestedDates.join(" ")}`),
        }
      : null;
    const relevantFacts = reasoningNotice
      ? [reasoningNotice, ...reasoningCandidates.map((entry) => entry.fact)]
      : geographyNotice
      ? [geographyNotice, ...geographyCandidates.map((entry) => entry.fact)]
      : zeroMatchFact
      ? [zeroMatchFact]
      : filtered.slice(0, Math.max(0, limit - 1)).map((entry) => entry.fact);
    const selected = [overview, ...relevantFacts]
      .filter(Boolean)
      .slice(0, limit)
      .map((fact, index) => ({ ...fact, ref: `S${index + 1}` }));
    return {
      facts: selected,
      retrieved: selected.length,
      totalFacts: knowledge.facts.length,
      geographyLookupSuggested,
    };
  }

  function gpsAccuracyMarginAddressFact(label, index) {
    return {
      id: `session:public-address:${index}`,
      kind: "session",
      text:
        `Question-named public address for GPS accuracy-margin comparison: ${label}. ` +
        "This is not a recorded StampNote session. Geocode this public address and report the Maps distance in meters. A missing field session at this house number does not make the distance unavailable.",
      dateKey: "",
      flagged: false,
      weatherIssue: false,
      hasAttendance: false,
      session: null,
      map: null,
      intendedSite: { sessionKey: "", label, staffGps: null, truck: null },
      metricId: "",
      rangeDays: 0,
      priority: 97,
      searchText: normalizeSearchText(label),
      siteSearchText: normalizeSearchText(label),
    };
  }

  function factTextContainsLabel(fact, label) {
    return normalizeSearchText(fact?.text).includes(normalizeSearchText(label));
  }

  function createAssistantPayload(question, history, knowledge) {
    const retrieval = rankKnowledge(question, knowledge);
    const metrics = knowledge.metrics;
    const comparesIntendedSite = questionRequestsIntendedSiteComparison(question);
    const comparesGpsMargin = questionRequestsGpsAccuracyMargin(question);
    const historyText = (history || []).map((message) => String(message.content || "")).join(" ");
    const compareLabels = comparesGpsMargin
      ? completePublicAddressLabels(
          extractPublicAddressLabels(`${question} ${historyText}`),
          knowledge,
        )
      : [];
    const namedAddressFacts = compareLabels.length >= 2
      ? compareLabels.map((label, index) => gpsAccuracyMarginAddressFact(label, index))
      : [];
    const overviewFacts = retrieval.facts[0]?.kind === "overview" ? [retrieval.facts[0]] : [];
    const remainingFacts = retrieval.facts[0]?.kind === "overview"
      ? retrieval.facts.slice(1)
      : retrieval.facts;
    const selectedFacts = namedAddressFacts.length > 0
      ? [...overviewFacts, ...namedAddressFacts, ...remainingFacts]
          .slice(0, MAX_RETRIEVED_FACTS)
          .map((fact, index) => ({ ...fact, ref: `S${index + 1}` }))
      : retrieval.facts;
    const includeStaffGps = comparesIntendedSite || comparesGpsMargin;
    const compareRoads = new Set(compareLabels.map((label) => publicAddressRoadKey(label)).filter(Boolean));
    const seenPublicSites = new Set();
    const publicSites = [];

    function addPublicSite(fact, label, extras = {}, extraKey = "") {
      const keys = [fact?.ref, extraKey].filter(Boolean);
      if (
        !fact ||
        publicSites.length >= MAX_PUBLIC_SITE_CANDIDATES ||
        keys.some((key) => seenPublicSites.has(key)) ||
        !isPublicSiteLabel(label) ||
        !factTextContainsLabel(fact, label)
      ) {
        return;
      }
      keys.forEach((key) => seenPublicSites.add(key));
      publicSites.push({ ref: fact.ref, label, ...extras });
    }

    compareLabels.forEach((label) => {
      const recorded = selectedFacts.find(
        (fact) =>
          (fact.kind === "session" || fact.kind === "flag") &&
          fact.session &&
          fact.intendedSite &&
          normalizeSearchText(fact.intendedSite.label) === normalizeSearchText(label),
      );
      const named = selectedFacts.find(
        (fact) =>
          factTextContainsLabel(fact, label) &&
          normalizeSearchText(fact.text).includes("question-named public address"),
      );
      const fact = recorded || named;
      addPublicSite(
        fact,
        recorded?.intendedSite?.label || label,
        includeStaffGps && recorded?.intendedSite?.staffGps
          ? { staffGps: recorded.intendedSite.staffGps }
          : {},
        normalizeSearchText(label),
      );
    });

    if (retrieval.geographyLookupSuggested || comparesGpsMargin) {
      selectedFacts
        .filter(
          (fact) =>
            (fact.kind === "session" || fact.kind === "flag") &&
            fact.intendedSite &&
            isPublicSiteLabel(fact.intendedSite.label),
        )
        .sort((left, right) => Number(right.kind === "session") - Number(left.kind === "session"))
        .forEach((fact) => {
          const label = fact.intendedSite.label;
          const sameRoad = compareRoads.has(publicAddressRoadKey(label));
          if (comparesGpsMargin && compareLabels.length >= 2 && !sameRoad) return;
          const extraKey = comparesIntendedSite
            ? fact.intendedSite.sessionKey || fact.ref
            : normalizeSearchText(label);
          addPublicSite(
            fact,
            label,
            {
              ...(includeStaffGps && fact.intendedSite.staffGps
                ? { staffGps: fact.intendedSite.staffGps }
                : {}),
              ...(comparesIntendedSite && fact.intendedSite.truck
                ? { truck: fact.intendedSite.truck }
                : {}),
            },
            extraKey,
          );
        });
    }

    return {
      payload: {
        question: String(question || "").trim(),
        history: (history || []).slice(-8).map((message) => ({
          role: message.role,
          content: String(message.content || "").slice(0, 2_400),
        })),
        publicSites,
        facts: selectedFacts.map((fact) => ({ ref: fact.ref, kind: fact.kind, text: fact.text })),
        scope: {
          sessions: metrics.sessionCount,
          flaggedSessions: metrics.flaggedSessionCount,
          weatherIssues: metrics.weatherIssueCount,
          attendanceCheckIns: metrics.attendanceCheckIns,
          workers: metrics.workerCount,
          photos: metrics.photoCount,
          retrieved: selectedFacts.length,
          totalFacts: retrieval.totalFacts,
        },
      },
      sources: selectedFacts,
    };
  }

  function sessionQuery(session, section) {
    if (!session?.locationKey || !session?.dateKey || !session?.sessionId) return "";
    const query = new URLSearchParams({
      location: session.locationKey,
      date: session.dateKey,
      session: session.sessionId,
    });
    return `admin.html?${query.toString()}#${section}`;
  }

  function coordinateQuery(session) {
    if (!session?.sessionKey) return "coordinates.html#coordinate-session-list";
    return `coordinates.html?session=${encodeURIComponent(session.sessionKey)}#coordinate-session-list`;
  }

  function navigationActions(question, sources = []) {
    const normalized = normalizeSearchText(question);
    const sourceKinds = new Set(sources.map((source) => source.kind));
    const session = sources.find((source) => source.session)?.session || null;
    const actions = [];

    function add(label, href, kind) {
      if (!href || actions.some((action) => action.href === href)) return;
      actions.push({ label, href, kind });
    }

    if (questionRequestsMetricAnalysis(question) || sourceKinds.has("metric")) {
      add("Open metrics", "metrics.html#metrics-panels", "metrics");
    }

    if (/\b(map|gps|truck|coordinate|flag|flags|flagged|flagging|location mismatch|discrep\w*)\b/.test(normalized)) {
      add("Open coordinate session", coordinateQuery(session), "coordinates");
    }
    if (/\b(attendance|attend|present|worker|check in|checked in)\b/.test(normalized) || sourceKinds.has("attendance")) {
      add("Open attendance", sessionQuery(session, "attendance-panel") || "admin.html#attendance-panel", "attendance");
    }
    if (/\b(photo|photos|image|images)\b/.test(normalized)) {
      add("Open session photos", sessionQuery(session, "photos-panel") || "admin.html#photos-panel", "photos");
    }
    if (/\b(add|take|capture|upload)\b.*\b(photo|image)\b/.test(normalized)) {
      add("Add a site photo", "worker-photos.html#photo-actions", "capture");
    }
    if (
      actions.length === 0 &&
      (/\b(open|go|jump|navigate|show|view|inspect|session|weather|activity)\b/.test(normalized) ||
        sourceKinds.has("session") ||
        sourceKinds.has("weather"))
    ) {
      add("Open session details", sessionQuery(session, "session-facts") || "admin.html#dashboard-workspace", "session");
    }
    return actions.slice(0, 3);
  }

  function shortMapLabel(label) {
    return String(label || "")
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .join(" ")
      .slice(0, 22) || "Site";
  }

  function publicAddressMapSnapshot(publicMap, sources = []) {
    const from = publicMap?.from;
    const to = publicMap?.to;
    if (
      publicMap?.kind !== "public-addresses" ||
      !Number.isFinite(from?.latitude) ||
      !Number.isFinite(from?.longitude) ||
      !Number.isFinite(to?.latitude) ||
      !Number.isFinite(to?.longitude)
    ) {
      return null;
    }
    const distanceMeters = Number(publicMap.distanceMeters);
    const thresholdMeters = Number(publicMap.thresholdMeters || publicMap.accuracyMeters) || 20;
    const session =
      sources.find((source) => source.ref === publicMap.sessionRef)?.session ||
      sources.find((source) => source.session)?.session ||
      {
        location: from.label,
        sessionLabel: to.label,
        sessionKey: "",
      };
    const flaggedForReview = publicMap.flaggedForReview === true || distanceMeters > thresholdMeters;
    return {
      kind: "public-addresses",
      session,
      reference: {
        latitude: Number(from.latitude),
        longitude: Number(from.longitude),
        accuracyMeters: Number(publicMap.accuracyMeters) || thresholdMeters,
        sourcePhotoId: "",
      },
      truck: {
        latitude: Number(to.latitude),
        longitude: Number(to.longitude),
      },
      distanceMeters,
      thresholdMeters,
      flaggedForReview,
      markerLabels: {
        reference: shortMapLabel(from.label),
        comparison: shortMapLabel(to.label),
      },
      fromLabel: String(from.label || "").trim(),
      toLabel: String(to.label || "").trim(),
      eyebrow: "GPS accuracy margin",
      summary: Number.isFinite(distanceMeters)
        ? flaggedForReview
          ? `${distanceMeters} m apart · outside the ±${thresholdMeters} m GPS accuracy`
          : `${distanceMeters} m apart · within the ±${thresholdMeters} m GPS accuracy`
        : "Distance unavailable",
    };
  }

  function inlineMapForQuestion(question, sources = [], publicMap = null) {
    const addressMap = publicAddressMapSnapshot(publicMap, sources);
    if (addressMap) return addressMap;
    if (questionRequestsGpsAccuracyMargin(question)) return null;
    const normalized = normalizeSearchText(question);
    const asksFlags = /\b(flag|flags|flagged|flagging|review|discrepancy|discrepancies)\b/.test(normalized);
    const asksLocation = /\b(map|gps|truck|coordinate|distance|location|discrep\w*)\b/.test(normalized);
    if (!asksFlags && !asksLocation) return null;
    if (asksFlags) {
      return (
        sources.find(
          (source) => source.map?.flaggedForReview && source.map.reference?.sourcePhotoId,
        )?.map ||
        sources.find((source) => source.map?.flaggedForReview)?.map ||
        null
      );
    }
    return (
      sources.find((source) => source.map?.reference?.sourcePhotoId)?.map ||
      sources.find((source) => source.map)?.map ||
      null
    );
  }

  function comparisonMapGeometry(snapshot, width = 600, height = 250) {
    const reference = snapshot?.reference;
    const truck = snapshot?.truck;
    if (
      !Number.isFinite(reference?.latitude) ||
      !Number.isFinite(reference?.longitude) ||
      !Number.isFinite(truck?.latitude) ||
      !Number.isFinite(truck?.longitude)
    ) {
      return null;
    }
    const meanLatitude = ((reference.latitude + truck.latitude) / 2) * (Math.PI / 180);
    const dx = (truck.longitude - reference.longitude) * 111_320 * Math.cos(meanLatitude);
    const dy = (truck.latitude - reference.latitude) * 110_540;
    const paddingX = 92;
    const paddingY = 54;
    const scaleX = Math.abs(dx) > 0.01 ? (width - paddingX * 2) / Math.abs(dx) : Infinity;
    const scaleY = Math.abs(dy) > 0.01 ? (height - paddingY * 2) / Math.abs(dy) : Infinity;
    const finiteScales = [scaleX, scaleY].filter(Number.isFinite);
    const scale = finiteScales.length ? Math.min(...finiteScales) : 1;
    const coincident = Math.abs(dx) <= 0.01 && Math.abs(dy) <= 0.01;
    const renderedDx = coincident ? 54 : dx * scale;
    const renderedDy = coincident ? 0 : dy * scale;
    const center = { x: width / 2, y: height / 2 };
    return {
      width,
      height,
      reference: { x: center.x - renderedDx / 2, y: center.y + renderedDy / 2 },
      truck: { x: center.x + renderedDx / 2, y: center.y - renderedDy / 2 },
      midpoint: { x: center.x, y: center.y },
      accuracyRadius: Math.max(9, Math.min(46, (Number(reference.accuracyMeters) || 0) * scale)),
    };
  }

  function resolveAssistantEndpoint(location = {}) {
    const hostname = String(location.hostname || "");
    const port = String(location.port || "");
    const isLiveServer = ["127.0.0.1", "localhost"].includes(hostname) && port === "5500";
    return isLiveServer
      ? "https://stampnote-omega.vercel.app/api/assistant"
      : "/api/assistant";
  }

  function describeAssistantError(error, endpoint = "") {
    if (error?.code === "auth-required") return "Sign in before asking about operations data.";
    if (error?.code === "admin-required") {
      return "Operations AI is available to administrators only. Sign out and sign in with the administrator Google account.";
    }
    if (
      error?.code === "permission-denied" ||
      /insufficient permissions/i.test(String(error?.message || ""))
    ) {
      return "Firebase denied this Google account. Every current StampNote account is a superadmin. Sign out, sign in again with the same Gmail, and reload so the ID token refreshes.";
    }
    if (error instanceof TypeError && /fetch|network|load/i.test(String(error.message || ""))) {
      return endpoint.startsWith("https://stampnote-omega.vercel.app")
        ? "The Operations AI API is not deployed or could not be reached."
        : "The Operations AI server could not be reached. Refresh the page and try again.";
    }
    return error?.message || "The operations assistant could not answer. Try again.";
  }

  // The assistant answers in a small, predictable subset of Markdown: bold,
  // bullets, numbers, short code spans, [S3, S4] operational markers, and [G1]
  // verified public geography. It is rendered by building nodes — never by
  // assigning HTML — because this text comes from a model and must never be
  // able to introduce markup of its own.
  const INLINE_PATTERN = /(\*\*[^*]+\*\*|`[^`]+`|\[(?:S|G)\d+(?:\s*,\s*(?:S|G)\d+)*\])/g;

  function renderInline(parent, text) {
    const owner = parent.ownerDocument;
    String(text)
      .split(INLINE_PATTERN)
      .forEach((part) => {
        if (!part) return;

        if (/^\*\*[\s\S]+\*\*$/.test(part)) {
          const strong = owner.createElement("strong");
          strong.textContent = part.slice(2, -2);
          parent.append(strong);
          return;
        }

        if (/^`[^`]+`$/.test(part)) {
          const code = owner.createElement("code");
          code.textContent = part.slice(1, -1);
          parent.append(code);
          return;
        }

        // The markers become chips keyed to the retrieved facts, so a claim and
        // its evidence stay visibly attached without a bracket in the prose.
        if (/^\[(?:S|G)\d/.test(part)) {
          const group = owner.createElement("span");
          group.className = "ai-citations";
          part
            .slice(1, -1)
            .split(",")
            .map((reference) => reference.trim())
            .filter(Boolean)
            .forEach((reference) => {
              const chip = owner.createElement("span");
              chip.className = "ai-citation";
              chip.textContent = reference;
              group.append(chip);
            });
          parent.append(group);
          return;
        }

        parent.append(owner.createTextNode(part));
      });
  }

  function renderAnswer(container, text) {
    const owner = container.ownerDocument;
    container.replaceChildren();
    const blocks = String(text || "")
      .replace(/\r\n/g, "\n")
      .split(/\n{2,}/);

    blocks.forEach((block) => {
      const lines = block.split("\n").filter((line) => line.trim());
      if (lines.length === 0) return;

      const bulleted = lines.every((line) => /^\s*[*-]\s+/.test(line));
      const numbered = lines.every((line) => /^\s*\d+[.)]\s+/.test(line));
      if (bulleted || numbered) {
        const list = owner.createElement(numbered ? "ol" : "ul");
        lines.forEach((line) => {
          const item = owner.createElement("li");
          renderInline(item, line.replace(/^\s*(?:[*-]|\d+[.)])\s+/, ""));
          list.append(item);
        });
        container.append(list);
        return;
      }

      const heading = /^(#{1,4})\s+(.*)$/.exec(lines[0]);
      if (heading && lines.length === 1) {
        const title = owner.createElement("p");
        title.className = "ai-answer-heading";
        renderInline(title, heading[2]);
        container.append(title);
        return;
      }

      const paragraph = owner.createElement("p");
      // A wrapped sentence is one sentence: a single break inside a block is
      // the model's line width, not the reader's paragraph.
      renderInline(paragraph, lines.join(" "));
      container.append(paragraph);
    });

    if (container.childElementCount === 0) container.textContent = String(text || "");
  }


  function externalGeographyDisclosure(geography, owner = globalScope.document) {
    if (
      geography?.ref !== "G1" ||
      geography?.provider !== "Google Maps" ||
      !String(geography.text || "").trim() ||
      !Array.isArray(geography.sources) ||
      geography.sources.length === 0
    ) {
      return null;
    }

    const section = owner.createElement("section");
    const heading = owner.createElement("strong");
    const evidence = owner.createElement("p");
    const links = owner.createElement("ul");
    const provider = owner.createElement("span");
    section.className = "ai-external-geography";
    section.setAttribute("aria-label", "Verified public geography sources");
    provider.textContent = "Google Maps";
    provider.setAttribute("translate", "no");
    heading.append("Verified with ", provider);
    renderInline(evidence, `[${geography.ref}] ${String(geography.text).trim()}`);

    geography.sources.slice(0, 8).forEach((source) => {
      try {
        const url = new URL(String(source.url || ""));
        const hostname = url.hostname.toLowerCase();
        if (
          url.protocol !== "https:" ||
          !(hostname === "google.com" || hostname.endsWith(".google.com"))
        ) {
          return;
        }
        const item = owner.createElement("li");
        const link = owner.createElement("a");
        link.href = url.href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = String(source.title || "Google Maps place").slice(0, 160);
        item.append(link);
        links.append(item);
      } catch {
        // The API already filters these URLs; the browser checks once more.
      }
    });
    if (links.childElementCount === 0) return null;
    section.append(heading, evidence, links);
    return section;
  }

  const api = Object.freeze({
    MAX_RETRIEVED_FACTS,
    buildKnowledgeBase,
    createAssistantPayload,
    comparisonMapGeometry,
    coordinateQuery,
    describeAssistantError,
    externalGeographyDisclosure,
    gpsAccuracyMarginSuggestion,
    publicAddressMapSnapshot,
    inlineMapForQuestion,
    isPublicSiteLabel,
    metricChartsForQuestion,
    navigationActions,
    normalizeSearchText,
    photoFlagsMentionedInAnswer,
    questionRequestsGpsAccuracyMargin,
    questionRequestsIntendedSiteComparison,
    questionRequestsPublicGeography,
    rankKnowledge,
    renderAnswer,
    resolveAssistantEndpoint,
  });
  globalScope.StampNoteAiDashboard = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
