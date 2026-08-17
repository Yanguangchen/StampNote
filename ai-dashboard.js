(function initializeAiOperationsDashboard(globalScope) {
  "use strict";

  const MAX_RETRIEVED_FACTS = 24;
  const MATCHED_TOKEN_SCORE = 4;
  const METRIC_RANGE_DAYS = Object.freeze([7, 30, 90]);

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
    const metricSeries = buildMetricSeries(input, metricsApi);
    const sessions = coordinates.buildCoordinateSessions(
      { photos, attendance, savedSessions: input.savedSessions || [] },
      data,
    );
    const workerIds = new Set(attendance.map((entry) => entry?.workerId).filter(Boolean));
    const records = sessions.map((session) => {
      const coordinateRecord = coordinates.sessionRecord(session, data);
      const flaggedPhotos = session.photos.filter((photo) => data.isFlagged(photo));
      const coordinateFlaggedPhotos = session.photos.filter(
        (photo) => data.isCoordinateFlagged?.(photo) === true,
      );
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
          coordinateFlaggedPhotos.length > 0,
      );
      const reasons = [];
      if (coordinateRecord.comparison.flaggedForReview) {
        reasons.push(coordinateRecord.comparison.reviewReason || coordinateRecord.comparison.status);
      }
      if (flaggedPhotos.length > 0) reasons.push(`${flaggedPhotos.length} AI-reviewed photo flag(s)`);
      if (coordinateFlaggedPhotos.length > 0) {
        reasons.push(`${coordinateFlaggedPhotos.length} photo location flag(s)`);
      }
      return {
        ...coordinateRecord,
        photos: session.photos,
        attendance: session.attendance,
        photoCount: session.photos.length,
        flaggedPhotoCount: flaggedPhotos.length,
        coordinateFlaggedPhotoCount: coordinateFlaggedPhotos.length,
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
        metricId: metadata.metricId || "",
        rangeDays: Number(metadata.rangeDays) || 0,
        priority: Number(metadata.priority) || 0,
        searchText: normalizeSearchText(`${text} ${metadata.keywords || ""}`),
      });
    }

    addFact(
      "overview",
      `Loaded scope: ${metrics.sessionCount} sessions, ${metrics.flaggedSessionCount} flagged sessions, ` +
        `${metrics.weatherIssueCount} sessions with problematic weather, ${metrics.attendanceCheckIns} attendance ` +
        `check-ins across ${metrics.workerCount} workers, and ${metrics.photoCount} photos. ` +
        `Date coverage: ${knownDates[0] || "unavailable"} through ${knownDates.at(-1) || "unavailable"}.`,
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
      const attendeeText = record.attendees.length
        ? record.attendees.map((entry) => `${entry.displayName} (${entry.workerId})`).join(", ")
        : "none recorded";
      const flagText = record.flaggedForReview
        ? `Flagged for review: ${record.flagReasons.join("; ") || "review required"}.`
        : "Not flagged for review.";
      addFact(
        "session",
        `Session ${record.sessionKey}. ${record.dateKey}, ${record.location}, ${record.sessionLabel}. ` +
          `${record.photoCount} photos (${record.flaggedPhotoCount} AI flags, ${record.coordinateFlaggedPhotoCount} photo location flags). ` +
          `${record.attendanceCount} attendance check-ins; workers: ${attendeeText}. ` +
          `Weather: ${weatherDescription(record.weather)}. ` +
          `GPS/truck comparison: ${comparisonDescription(record.comparison)}. ${flagText}`,
        {
          dateKey: record.dateKey,
          flagged: record.flaggedForReview,
          weatherIssue: record.weatherIssue,
          hasAttendance: record.attendanceCount > 0,
          session: linkedSession,
          map: linkedMap,
          priority: record.flaggedForReview ? 12 : record.weatherIssue ? 9 : 4,
          keywords: `${record.location} ${record.sessionLabel} ${record.attendees
            .map((entry) => `${entry.displayName} ${entry.workerId}`)
            .join(" ")}`,
        },
      );

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
            priority: 18,
            keywords: record.location,
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
            keywords: record.location,
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
      addFact(
        "attendance",
        `Attendance: ${entry.displayName} (${entry.workerId}) checked in on ${entry.dateKey} at ` +
          `${sessionTime(atMs)}, location ${entry.location || data.UNKNOWN_LOCATION}, ${period.label} session.`,
        {
          dateKey: entry.dateKey,
          hasAttendance: true,
          session: attendanceSession,
          priority: 7,
          keywords: `${entry.displayName} ${entry.workerId} ${entry.location || ""} ${period.label}`,
        },
      );
    });

    return { sessions: records, facts, metrics, metricSeries };
  }

  function rankKnowledge(question, knowledge, limit = MAX_RETRIEVED_FACTS) {
    const normalized = normalizeSearchText(question);
    const tokens = queryTokens(question);
    const asksFlags = /\b(flag|flags|flagged|flagging|review|gps|truck|map|coordinate|location mismatch|discrep\w*)\b/.test(normalized);
    const asksWeather = /\b(weather|rain|storm|wet|wind|gust|delay|lost hour|impact)\b/.test(normalized);
    const asksAttendance = /\b(attendance|attend|present|worker|who|check in|checked in)\b/.test(normalized);
    const asksRecent = /\b(latest|recent|today|newest|last)\b/.test(normalized);
    const asksMetrics = questionRequestsMetricAnalysis(question);
    const requestedMetricIds = metricIdsForQuestion(question);
    const requestedMetricRange = metricRangeForQuestion(question);
    const exactDates = question.match(/\b\d{4}-\d{2}-\d{2}\b/g) || [];
    const overview = knowledge.facts.find((fact) => fact.kind === "overview");
    const ranked = knowledge.facts
      .filter((fact) => fact !== overview)
      .map((fact) => {
        let score = fact.priority;
        tokens.forEach((token) => {
          if (fact.searchText.includes(token)) score += MATCHED_TOKEN_SCORE;
        });
        exactDates.forEach((dateKey) => {
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
    const selected = [overview, ...ranked.slice(0, Math.max(0, limit - 1)).map((entry) => entry.fact)]
      .filter(Boolean)
      .slice(0, limit)
      .map((fact, index) => ({ ...fact, ref: `S${index + 1}` }));
    return {
      facts: selected,
      retrieved: selected.length,
      totalFacts: knowledge.facts.length,
    };
  }

  function createAssistantPayload(question, history, knowledge) {
    const retrieval = rankKnowledge(question, knowledge);
    const metrics = knowledge.metrics;
    return {
      payload: {
        question: String(question || "").trim(),
        history: (history || []).slice(-8).map((message) => ({
          role: message.role,
          content: String(message.content || "").slice(0, 2_400),
        })),
        facts: retrieval.facts.map((fact) => ({ ref: fact.ref, kind: fact.kind, text: fact.text })),
        scope: {
          sessions: metrics.sessionCount,
          flaggedSessions: metrics.flaggedSessionCount,
          weatherIssues: metrics.weatherIssueCount,
          attendanceCheckIns: metrics.attendanceCheckIns,
          workers: metrics.workerCount,
          photos: metrics.photoCount,
          retrieved: retrieval.retrieved,
          totalFacts: retrieval.totalFacts,
        },
      },
      sources: retrieval.facts,
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

  function inlineMapForQuestion(question, sources = []) {
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
    if (error instanceof TypeError && /fetch|network|load/i.test(String(error.message || ""))) {
      return endpoint.startsWith("https://stampnote-omega.vercel.app")
        ? "The Operations AI API is not deployed or could not be reached."
        : "The Operations AI server could not be reached. Refresh the page and try again.";
    }
    return error?.message || "The operations assistant could not answer. Try again.";
  }

  // The assistant answers in a small, predictable subset of Markdown: bold,
  // bullets, numbers, short code spans, and the [S3, S4] markers that point at
  // the retrieved facts below. It is rendered by building nodes — never by
  // assigning HTML — because this text comes from a model and must never be
  // able to introduce markup of its own.
  const INLINE_PATTERN = /(\*\*[^*]+\*\*|`[^`]+`|\[S\d+(?:\s*,\s*S\d+)*\])/g;

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
        if (/^\[S\d/.test(part)) {
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

  const api = Object.freeze({
    MAX_RETRIEVED_FACTS,
    buildKnowledgeBase,
    createAssistantPayload,
    comparisonMapGeometry,
    describeAssistantError,
    inlineMapForQuestion,
    metricChartsForQuestion,
    navigationActions,
    normalizeSearchText,
    rankKnowledge,
    renderAnswer,
    resolveAssistantEndpoint,
  });
  globalScope.StampNoteAiDashboard = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;

  const document = globalScope.document;
  if (!document?.querySelector("#ai-chat-form")) return;

  const cloud = globalScope.StampNoteFirebase;
  const data = globalScope.StampNoteCloudData;
  const coordinates = globalScope.StampNoteCoordinates;
  const metricsApi = globalScope.StampNoteMetrics;
  const telemetry = globalScope.StampNoteObservability;
  const signInButton = document.querySelector("#ai-sign-in");
  const signOutButton = document.querySelector("#ai-sign-out");
  const authGate = document.querySelector("#ai-auth-gate");
  const workspace = document.querySelector("#ai-workspace");
  const accountName = document.querySelector("#ai-account-name");
  const status = document.querySelector("#ai-dashboard-status");
  const scopeLabel = document.querySelector("#ai-scope-label");
  const refreshButton = document.querySelector("#ai-refresh");
  const messageList = document.querySelector("#ai-message-list");
  const form = document.querySelector("#ai-chat-form");
  const prompt = document.querySelector("#ai-prompt");
  const sendButton = document.querySelector("#ai-send");
  const micButton = document.querySelector("#ai-mic");
  const voiceStatus = document.querySelector("#ai-voice-status");
  const themeToggle = document.querySelector("#theme-toggle");
  const themeIcon = document.querySelector("#theme-toggle-icon");
  const themeLabel = document.querySelector("#theme-toggle-label");
  const assistantEndpoint = resolveAssistantEndpoint(globalScope.location);

  telemetry?.configure({ surface: "ai-dashboard" });

  let signedInUser = null;
  let knowledge = null;
  let loading = false;
  let asking = false;
  let recognition = null;
  const history = [];

  function setStatus(message, state = "idle") {
    status.textContent = message;
    status.dataset.state = state;
    status.hidden = !message;
  }

  function setBusy() {
    const disabled = loading || asking || !knowledge;
    sendButton.disabled = disabled || !prompt.value.trim();
    refreshButton.disabled = loading || asking;
    micButton.disabled = asking || !recognition;
    document.querySelectorAll("[data-ai-question]").forEach((button) => {
      button.disabled = disabled;
    });
    form.setAttribute("aria-busy", String(asking));
  }

  function metricValue(id, value) {
    const element = document.querySelector(id);
    if (element) element.textContent = String(value);
  }

  function renderMetrics(metrics) {
    metricValue("#ai-metric-sessions", metrics.sessionCount);
    metricValue("#ai-metric-flags", metrics.flaggedSessionCount);
    metricValue("#ai-metric-weather", metrics.weatherIssueCount);
    metricValue("#ai-metric-attendance", metrics.attendanceCheckIns);
  }

  function sourceDisclosure(sources) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    const list = document.createElement("ul");
    details.className = "ai-sources";
    summary.textContent = `${sources.length} retrieved facts`;
    sources.forEach((source) => {
      const item = document.createElement("li");
      const reference = document.createElement("strong");
      reference.textContent = `[${source.ref}]`;
      item.append(reference, ` ${source.text}`);
      list.append(item);
    });
    details.append(summary, list);
    return details;
  }

  function navigationLinks(actions) {
    const navigation = document.createElement("nav");
    const label = document.createElement("span");
    navigation.className = "ai-answer-actions";
    navigation.setAttribute("aria-label", "Open relevant StampNote sections");
    label.className = "ai-answer-actions-label";
    label.textContent = "Go to record";
    navigation.append(label);
    actions.forEach((action) => {
      const link = document.createElement("a");
      const arrow = document.createElement("span");
      link.href = action.href;
      link.dataset.actionKind = action.kind;
      link.textContent = action.label;
      arrow.setAttribute("aria-hidden", "true");
      arrow.textContent = "↗";
      link.append(arrow);
      navigation.append(link);
    });
    return navigation;
  }

  function svgNode(name, attributes = {}) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
    return node;
  }

  function createInlineLocationMap(snapshot) {
    const geometry = comparisonMapGeometry(snapshot);
    if (!geometry) return null;
    const figure = document.createElement("figure");
    const heading = document.createElement("figcaption");
    const headingText = document.createElement("div");
    const eyebrow = document.createElement("span");
    const title = document.createElement("strong");
    const summary = document.createElement("p");
    const svg = svgNode("svg", {
      viewBox: `0 0 ${geometry.width} ${geometry.height}`,
      role: "img",
      "aria-label": "Relative map comparing the photo GPS reference with the truck location",
    });
    const grid = svgNode("g", { class: "ai-inline-map-grid", "aria-hidden": "true" });
    const connection = svgNode("line", {
      class: "ai-inline-map-connection",
      x1: geometry.reference.x,
      y1: geometry.reference.y,
      x2: geometry.truck.x,
      y2: geometry.truck.y,
    });
    const accuracy = svgNode("circle", {
      class: "ai-inline-map-accuracy",
      cx: geometry.reference.x,
      cy: geometry.reference.y,
      r: geometry.accuracyRadius,
    });

    figure.className = "ai-inline-map";
    figure.dataset.reviewRequired = String(snapshot.flaggedForReview);
    eyebrow.textContent = "Location comparison";
    title.textContent = [snapshot.session?.location, snapshot.session?.sessionLabel]
      .filter(Boolean)
      .join(" · ") || "Photo and truck";
    summary.textContent = snapshot.flaggedForReview
      ? `${snapshot.distanceMeters} m apart · over the ${snapshot.thresholdMeters} m limit`
      : `${snapshot.distanceMeters} m apart · within the ${snapshot.thresholdMeters} m limit`;
    headingText.append(eyebrow, title);
    heading.append(headingText, summary);

    for (let x = 0; x <= geometry.width; x += 50) {
      grid.append(svgNode("line", { x1: x, y1: 0, x2: x, y2: geometry.height }));
    }
    for (let y = 0; y <= geometry.height; y += 50) {
      grid.append(svgNode("line", { x1: 0, y1: y, x2: geometry.width, y2: y }));
    }
    svg.append(grid, connection, accuracy);

    [
      { key: "reference", point: geometry.reference, label: snapshot.reference.sourcePhotoId ? "Photo GPS" : "GPS reference" },
      { key: "truck", point: geometry.truck, label: "Truck" },
    ].forEach((marker) => {
      const group = svgNode("g", { class: `ai-inline-map-marker ai-inline-map-marker-${marker.key}` });
      const dot = svgNode("circle", { cx: marker.point.x, cy: marker.point.y, r: 8 });
      const label = svgNode("text", {
        x: marker.point.x,
        y: marker.point.y < 38 ? marker.point.y + 28 : marker.point.y - 16,
        "text-anchor": "middle",
      });
      label.textContent = marker.label;
      group.append(dot, label);
      svg.append(group);
    });

    const distanceLabel = svgNode("g", { class: "ai-inline-map-distance" });
    const labelWidth = 78;
    distanceLabel.append(
      svgNode("rect", {
        x: geometry.midpoint.x - labelWidth / 2,
        y: geometry.midpoint.y - 13,
        width: labelWidth,
        height: 26,
        rx: 9,
      }),
    );
    const distanceText = svgNode("text", {
      x: geometry.midpoint.x,
      y: geometry.midpoint.y + 4,
      "text-anchor": "middle",
    });
    distanceText.textContent = `${snapshot.distanceMeters} m`;
    distanceLabel.append(distanceText);
    svg.append(distanceLabel);

    const details = document.createElement("div");
    details.className = "ai-inline-map-details";
    [
      `Photo GPS ${snapshot.reference.latitude.toFixed(6)}, ${snapshot.reference.longitude.toFixed(6)}`,
      `Truck ${snapshot.truck.latitude.toFixed(6)}, ${snapshot.truck.longitude.toFixed(6)}`,
      `GPS uncertainty ±${snapshot.reference.accuracyMeters} m`,
    ].forEach((value) => {
      const item = document.createElement("span");
      item.textContent = value;
      details.append(item);
    });
    const fullMap = document.createElement("a");
    fullMap.className = "ai-inline-map-open";
    fullMap.href = coordinateQuery(snapshot.session);
    fullMap.textContent = "Open full coordinate session ↗";
    figure.append(heading, svg, details, fullMap);
    return figure;
  }

  function formatMetricDay(dateKey, options = { day: "numeric", month: "short" }) {
    const date = new Date(`${dateKey}T00:00:00`);
    return Number.isNaN(date.getTime()) ? dateKey : date.toLocaleDateString(undefined, options);
  }

  function niceMetricCeiling(value) {
    if (value <= 4) return Math.max(1, value);
    const magnitude = 10 ** Math.floor(Math.log10(value));
    return Math.ceil(value / (magnitude / 2)) * (magnitude / 2);
  }

  function createInlineMetricChart(entry) {
    if (!entry?.keys?.length || entry.keys.length !== entry.values?.length) return null;
    const figure = document.createElement("figure");
    const caption = document.createElement("figcaption");
    const heading = document.createElement("div");
    const eyebrow = document.createElement("span");
    const title = document.createElement("strong");
    const summary = document.createElement("p");
    const plot = document.createElement("div");
    const width = 640;
    const height = 226;
    const left = 38;
    const right = 12;
    const top = 24;
    const bottom = 32;
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;
    const baseline = top + plotHeight;
    const ceiling = niceMetricCeiling(Math.max(...entry.values, 0));
    const band = plotWidth / entry.values.length;
    const barWidth = Math.max(2, Math.min(22, band - 2));
    const peak = Math.max(...entry.values, 0);
    const peakIndex = entry.values.indexOf(peak);
    const unit = `${entry.unit}${entry.total === 1 ? "" : "s"}`;
    const svg = svgNode("svg", {
      viewBox: `0 0 ${width} ${height}`,
      role: "img",
      "aria-label": `${entry.title}: ${entry.total} ${unit} over the last ${entry.rangeDays} days.`,
    });

    figure.className = "ai-inline-chart";
    figure.dataset.series = entry.id;
    eyebrow.textContent = `Metrics · ${entry.rangeDays} days`;
    title.textContent = entry.title;
    summary.textContent = `${entry.total.toLocaleString()} ${unit} · peak ${peak} on ${formatMetricDay(
      entry.keys[Math.max(0, peakIndex)],
    )}`;
    heading.append(eyebrow, title);
    caption.append(heading, summary);
    plot.className = "ai-inline-chart-plot";

    [0, 0.5, 1].forEach((fraction) => {
      const y = top + plotHeight * (1 - fraction);
      svg.append(
        svgNode("line", {
          class: fraction === 0 ? "ai-stat-axis" : "ai-stat-grid",
          x1: left,
          x2: width - right,
          y1: y,
          y2: y,
        }),
      );
      const tick = svgNode("text", {
        class: "ai-stat-tick",
        x: left - 7,
        y: y + 4,
        "text-anchor": "end",
      });
      tick.textContent = String(Math.round(ceiling * fraction));
      svg.append(tick);
    });

    entry.values.forEach((value, index) => {
      const x = left + band * index + (band - barWidth) / 2;
      const barHeight = ceiling > 0 ? (value / ceiling) * plotHeight : 0;
      if (barHeight > 0) {
        const bar = svgNode("rect", {
          class: "ai-stat-bar",
          x,
          y: baseline - barHeight,
          width: barWidth,
          height: barHeight,
          rx: Math.min(4, barWidth / 2, barHeight / 2),
        });
        const barTitle = svgNode("title");
        barTitle.textContent = `${formatMetricDay(entry.keys[index], {
          weekday: "short",
          day: "numeric",
          month: "short",
          year: "numeric",
        })}: ${value} ${entry.unit}${value === 1 ? "" : "s"}`;
        bar.append(barTitle);
        svg.append(bar);
      }
      if (entry.values.length <= 12 && value > 0) {
        const valueLabel = svgNode("text", {
          class: "ai-stat-value",
          x: x + barWidth / 2,
          y: Math.max(13, baseline - barHeight - 6),
          "text-anchor": "middle",
        });
        valueLabel.textContent = String(value);
        svg.append(valueLabel);
      }
    });

    [...new Set([0, Math.floor(entry.keys.length / 2), entry.keys.length - 1])].forEach(
      (index, position, indexes) => {
        const label = svgNode("text", {
          class: "ai-stat-tick",
          x: left + band * (index + 0.5),
          y: height - 8,
          "text-anchor": position === 0 ? "start" : position === indexes.length - 1 ? "end" : "middle",
        });
        label.textContent = formatMetricDay(entry.keys[index]);
        svg.append(label);
      },
    );
    plot.append(svg);

    const dataDetails = document.createElement("details");
    const dataSummary = document.createElement("summary");
    const tableWrap = document.createElement("div");
    const table = document.createElement("table");
    const tableCaption = document.createElement("caption");
    const body = document.createElement("tbody");
    dataDetails.className = "ai-inline-chart-data";
    dataSummary.textContent = "View daily values";
    tableWrap.className = "ai-inline-chart-table-wrap";
    tableCaption.textContent = `${entry.title}, last ${entry.rangeDays} days`;
    entry.keys.forEach((dateKey, index) => {
      const row = document.createElement("tr");
      const date = document.createElement("th");
      const value = document.createElement("td");
      date.scope = "row";
      date.textContent = formatMetricDay(dateKey, {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
      });
      value.textContent = `${entry.values[index]} ${entry.unit}${entry.values[index] === 1 ? "" : "s"}`;
      row.append(date, value);
      body.append(row);
    });
    table.append(tableCaption, body);
    tableWrap.append(table);
    dataDetails.append(dataSummary, tableWrap);
    figure.append(caption, plot, dataDetails);
    return figure;
  }

  function speakAnswer(text) {
    if (!globalScope.speechSynthesis || !globalScope.SpeechSynthesisUtterance) return;
    globalScope.speechSynthesis.cancel();
    const utterance = new globalScope.SpeechSynthesisUtterance(text);
    utterance.lang = globalScope.navigator?.language || "en-SG";
    globalScope.speechSynthesis.speak(utterance);
  }

  function addMessage(role, content, options = {}) {
    const item = document.createElement("li");
    const article = document.createElement("article");
    const label = document.createElement("span");
    const body = document.createElement("div");
    item.className = `ai-message-row ai-message-row-${role}`;
    article.className = `ai-message ai-message-${role}`;
    label.className = "ai-message-label";
    label.textContent = role === "assistant" ? "Operations AI" : "You";
    body.className = "ai-message-body";
    if (role === "assistant") renderAnswer(body, content);
    else body.textContent = content;
    article.append(label, body);
    if (role === "assistant" && content && globalScope.speechSynthesis) {
      const listen = document.createElement("button");
      listen.className = "ai-listen";
      listen.type = "button";
      listen.textContent = "Listen";
      listen.addEventListener("click", () => speakAnswer(body.textContent));
      article.append(listen);
    }
    if (options.map) {
      const inlineMap = createInlineLocationMap(options.map);
      if (inlineMap) article.append(inlineMap);
    }
    if (options.actions?.length) article.append(navigationLinks(options.actions));
    if (options.sources?.length) article.append(sourceDisclosure(options.sources));
    item.append(article);
    messageList.append(item);
    messageList.scrollTop = messageList.scrollHeight;
    return { item, article, body };
  }

  function describeError(error) {
    return describeAssistantError(error, assistantEndpoint);
  }

  async function loadAllPhotos() {
    const loaded = [];
    let after = null;
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      const page = await cloud.getPhotosPage({ pageSize: 100, after });
      loaded.push(...(page.photos || []));
      if (!page.hasMore || !page.after) break;
      after = page.after;
    }
    return [...new Map(loaded.map((photo) => [photo.id, photo])).values()];
  }

  async function loadKnowledge() {
    if (!signedInUser || loading) return;
    loading = true;
    const now = () => (typeof performance !== "undefined" && performance?.now ? performance.now() : Date.now());
    const startedAt = now();
    const traceId = telemetry?.createTraceId?.();
    knowledge = null;
    setBusy();
    setStatus("Building the operations knowledge index…", "loading");
    try {
      const [photos, attendance, savedSessions] = await Promise.all([
        loadAllPhotos(),
        cloud.getAttendance({ pageSize: 500 }),
        cloud.getDashboardSessions(),
      ]);
      knowledge = buildKnowledgeBase({ photos, attendance, savedSessions }, data, coordinates, metricsApi);
      renderMetrics(knowledge.metrics);
      scopeLabel.textContent =
        `${knowledge.metrics.sessionCount} sessions · ${knowledge.metrics.attendanceCheckIns} check-ins · ` +
        `${knowledge.metrics.photoCount} photos`;
      setStatus(
        `Ready · ${knowledge.facts.length} searchable operational facts indexed in this browser.`,
        "success",
      );
      telemetry?.event?.(
        "ai.knowledge.loaded",
        {
          durationMs: now() - startedAt,
          sessionCount: knowledge.metrics.sessionCount,
          factCount: knowledge.facts.length,
          status: "success",
        },
        { traceId },
      );
    } catch (error) {
      setStatus(describeError(error), "error");
      telemetry?.event?.(
        "ai.knowledge.failed",
        {
          durationMs: now() - startedAt,
          errorCode: telemetry?.safeErrorCode?.(error, "knowledge_build_failed"),
          status: "failed",
        },
        { traceId, immediate: true, dedupeMs: 60000 },
      );
    } finally {
      loading = false;
      setBusy();
    }
  }

  async function askQuestion(question) {
    const cleaned = String(question || "").trim();
    if (!cleaned || !knowledge || asking || !signedInUser) return;
    const now = () => (typeof performance !== "undefined" && performance?.now ? performance.now() : Date.now());
    const startedAt = now();
    const traceId = telemetry?.createTraceId?.();
    const request = createAssistantPayload(cleaned, history, knowledge);
    addMessage("user", cleaned);
    const pending = addMessage("assistant", "Reviewing the relevant records…");
    pending.article.dataset.state = "thinking";
    asking = true;
    prompt.value = "";
    setBusy();
    telemetry?.event?.(
      "ai.assistant.query.started",
      { factCount: request.sources.length },
      { traceId },
    );
    try {
      const token = await signedInUser.getIdToken();
      const response = await globalScope.fetch(assistantEndpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-StampNote-Trace-Id": traceId,
        },
        body: JSON.stringify(request.payload),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `The assistant returned HTTP ${response.status}.`);
      renderAnswer(pending.body, result.answer);
      pending.article.dataset.state = "complete";
      metricChartsForQuestion(cleaned, knowledge).forEach((entry) => {
        const chart = createInlineMetricChart(entry);
        if (chart) pending.article.append(chart);
      });
      const inlineMap = createInlineLocationMap(inlineMapForQuestion(cleaned, request.sources));
      if (inlineMap) pending.article.append(inlineMap);
      const actions = navigationActions(cleaned, request.sources);
      if (actions.length) pending.article.append(navigationLinks(actions));
      pending.article.append(sourceDisclosure(request.sources));
      if (globalScope.speechSynthesis) {
        const listen = document.createElement("button");
        listen.className = "ai-listen";
        listen.type = "button";
        listen.textContent = "Listen";
        listen.addEventListener("click", () => speakAnswer(result.answer));
        pending.article.append(listen);
      }
      history.push(
        { role: "user", content: cleaned },
        { role: "assistant", content: String(result.answer).slice(0, 2_400) },
      );
      if (history.length > 8) history.splice(0, history.length - 8);
      telemetry?.event?.(
        "ai.assistant.query.completed",
        {
          durationMs: now() - startedAt,
          factCount: request.sources.length,
          status: "success",
        },
        { traceId },
      );
    } catch (error) {
      pending.body.textContent = describeError(error);
      pending.article.dataset.state = "error";
      telemetry?.event?.(
        "ai.assistant.query.failed",
        {
          durationMs: now() - startedAt,
          errorCode: telemetry?.safeErrorCode?.(error, "assistant_query_failed"),
          status: "failed",
        },
        { traceId, immediate: true, dedupeMs: 60000 },
      );
    } finally {
      asking = false;
      setBusy();
      prompt.focus?.();
      messageList.scrollTop = messageList.scrollHeight;
    }
  }

  function systemPrefersDark() {
    return globalScope.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
  }

  function storedTheme() {
    try {
      const saved = globalScope.localStorage?.getItem("stampnote-theme");
      return saved === "light" || saved === "dark" ? saved : null;
    } catch {
      return null;
    }
  }

  function applyTheme(theme) {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    const dark = theme ? theme === "dark" : systemPrefersDark();
    themeToggle?.setAttribute("aria-pressed", String(dark));
    themeToggle?.setAttribute("title", dark ? "Switch to light theme" : "Switch to dark theme");
    if (themeIcon) themeIcon.textContent = dark ? "☀" : "☾";
    if (themeLabel) themeLabel.textContent = dark ? "Light" : "Dark";
  }

  function toggleTheme() {
    const next = (storedTheme() || (systemPrefersDark() ? "dark" : "light")) === "dark"
      ? "light"
      : "dark";
    try {
      globalScope.localStorage?.setItem("stampnote-theme", next);
    } catch {
      /* The selected theme still applies for this visit. */
    }
    applyTheme(next);
    telemetry?.event("dashboard.theme.changed", { theme: next });
  }

  const Recognition = globalScope.SpeechRecognition || globalScope.webkitSpeechRecognition;
  if (Recognition) {
    recognition = new Recognition();
    recognition.lang = globalScope.navigator?.language || "en-SG";
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.addEventListener("start", () => {
      micButton.dataset.state = "listening";
      micButton.setAttribute("aria-pressed", "true");
      voiceStatus.textContent = "Listening…";
    });
    recognition.addEventListener("result", (event) => {
      const transcript = [...event.results].map((result) => result[0]?.transcript || "").join(" ").trim();
      if (transcript) {
        prompt.value = transcript;
        setBusy();
      }
      voiceStatus.textContent = event.results[event.results.length - 1]?.isFinal
        ? "Voice captured. Review it, then send."
        : "Listening…";
    });
    recognition.addEventListener("error", (event) => {
      voiceStatus.textContent = event.error === "not-allowed"
        ? "Microphone access was not allowed."
        : "Voice input stopped. You can still type your question.";
    });
    recognition.addEventListener("end", () => {
      micButton.dataset.state = "idle";
      micButton.setAttribute("aria-pressed", "false");
    });
  } else {
    micButton.title = "Voice input is not supported by this browser";
    voiceStatus.textContent = "Voice input is unavailable in this browser; typing still works.";
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    askQuestion(prompt.value);
  });
  prompt.addEventListener("input", setBusy);
  prompt.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      askQuestion(prompt.value);
    }
  });
  micButton.addEventListener("click", () => {
    if (!recognition) return;
    if (micButton.dataset.state === "listening") recognition.stop();
    else recognition.start();
  });
  refreshButton.addEventListener("click", loadKnowledge);
  signInButton.addEventListener("click", () =>
    cloud
      .signIn()
      .catch((error) => {
        setStatus(describeError(error), "error");
        telemetry?.event(
          "cloud.auth.failed",
          { errorCode: telemetry?.safeErrorCode(error, "auth_failed"), status: "failed" },
          { immediate: true, dedupeMs: 60000 },
        );
      }),
  );
  signOutButton.addEventListener("click", () =>
    cloud
      .signOut()
      .catch((error) => {
        setStatus(describeError(error), "error");
        telemetry?.event(
          "cloud.auth.failed",
          { errorCode: telemetry?.safeErrorCode(error, "auth_failed"), status: "failed" },
          { immediate: true, dedupeMs: 60000 },
        );
      }),
  );
  themeToggle?.addEventListener("click", toggleTheme);
  document.querySelectorAll("[data-ai-question]").forEach((button) => {
    button.addEventListener("click", () => {
      prompt.value = button.dataset.aiQuestion;
      setBusy();
      askQuestion(prompt.value);
    });
  });

  applyTheme(storedTheme());
  globalScope.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => applyTheme(storedTheme()));
  setBusy();

  if (!cloud || !data || !coordinates) {
    signInButton.disabled = true;
    setStatus("The operations data client could not initialize.", "error");
    telemetry?.event(
      "client.error",
      { errorCode: "cloud_dependencies_missing" },
      { immediate: true },
    );
    return;
  }
  cloud.subscribeAuth((user, error) => {
    if (error) {
      signedInUser = null;
      authGate.hidden = false;
      workspace.hidden = true;
      setStatus(describeError(error), "error");
      telemetry?.event(
        "cloud.auth.failed",
        { errorCode: telemetry?.safeErrorCode(error, "auth_failed"), status: "failed" },
        { immediate: true, dedupeMs: 60000 },
      );
      return;
    }
    signedInUser = user || null;
    authGate.hidden = Boolean(user);
    workspace.hidden = !user;
    signOutButton.hidden = !user;
    accountName.textContent = user?.email || "";
    telemetry?.event("cloud.auth.state", {
      status: user ? "signed_in" : "signed_out",
    });
    if (user) loadKnowledge();
    else {
      knowledge = null;
      setStatus("");
      renderMetrics({ sessionCount: 0, flaggedSessionCount: 0, weatherIssueCount: 0, attendanceCheckIns: 0 });
      setBusy();
    }
  });
})(typeof window !== "undefined" ? window : globalThis);
