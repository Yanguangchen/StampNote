(function initializeCaptureAttendance(globalScope) {
  "use strict";

  function attendanceDateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function createAttendanceEventId(cryptoApi = globalScope.crypto) {
    if (typeof cryptoApi?.randomUUID === "function") {
      return cryptoApi.randomUUID().replace(/-/g, "");
    }
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
  }

  function createAttendanceRecorder(options = {}) {
    const requiredVotes = Number(options.requiredMatchVotes) || 3;
    const entries = new Map();
    const matchVotes = new Map();
    const enrolledNames = new Map();
    let sessionVersion = 0;

    function rememberEnrollment(workerId, personLabel) {
      const id = String(workerId || "").trim().toUpperCase();
      if (!id) return;
      enrolledNames.set(id, String(personLabel || id).trim() || id);
    }

    function resetSession() {
      sessionVersion += 1;
      entries.clear();
      matchVotes.clear();
      enrolledNames.clear();
    }

    function save(enrollment, evidence = {}) {
      const workerId = String(enrollment?.workerId || "").trim().toUpperCase();
      const source = evidence.source === "manual" ? "manual" : "face-match";
      const enrolledLabel = enrolledNames.get(workerId);
      const personLabel = String(
        source === "manual" ? enrolledLabel || "" : enrollment?.personLabel || workerId,
      ).trim();
      const cloud = options.cloud;
      if (!cloud?.saveAttendance || !workerId || !personLabel) {
        return false;
      }

      const now = Date.now();
      const previous = entries.get(workerId);
      if (
        previous?.status === "pending" ||
        previous?.status === "saved" ||
        (previous?.retryAt || 0) > now
      ) {
        return false;
      }

      const eventId = previous?.eventId || createAttendanceEventId(options.crypto);
      const version = sessionVersion;
      const reviewStatus = source === "manual" ? "flagged" : "clear";
      entries.set(workerId, { eventId, status: "pending", retryAt: 0, source, reviewStatus });
      const checkedInAt = new Date();
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || null;

      cloud
        .saveAttendance({
          eventId,
          workerId,
          displayName: personLabel,
          checkedInAtMs: checkedInAt.getTime(),
          dateKey: attendanceDateKey(checkedInAt),
          timeZone,
          location: options.getLocation?.() || "",
          source,
          reviewStatus,
          reviewReason: source === "manual" ? "manual-entry" : null,
        })
        .then(() => {
          if (version !== sessionVersion) return;
          entries.set(workerId, {
            eventId,
            status: "saved",
            retryAt: 0,
            source,
            reviewStatus,
          });
          options.onSaved?.(personLabel, { source, reviewStatus });
        })
        .catch((error) => {
          if (version !== sessionVersion) return;
          entries.set(workerId, {
            eventId,
            status: "retrying",
            retryAt: Date.now() + 10_000,
            source,
            reviewStatus,
          });
          options.onSaveFailed?.(personLabel, error, { source, reviewStatus });
        });
      return true;
    }

    function saveMatched(enrollment) {
      return save(enrollment, { source: "face-match" });
    }

    function saveManual(enrollment) {
      return save(enrollment, { source: "manual" });
    }

    function saveVisible(bodies = []) {
      const seenWorkers = new Set();
      (bodies || []).forEach((body) => {
        const workerId = String(body?.workerId || "").trim().toUpperCase();
        if (!workerId || !body?.faceMatched || seenWorkers.has(workerId)) return;
        seenWorkers.add(workerId);

        const entry = entries.get(workerId);
        if (entry?.status === "pending" || entry?.status === "saved") return;

        const votes = (matchVotes.get(workerId) || 0) + 1;
        matchVotes.set(workerId, votes);
        if (votes < requiredVotes) return;

        saveMatched({
          workerId,
          personLabel: enrolledNames.get(workerId) || workerId,
        });
      });
    }

    return Object.freeze({
      getEntries: () => entries,
      getEnrollments: () =>
        [...enrolledNames].map(([workerId, personLabel]) => ({ workerId, personLabel })),
      rememberEnrollment,
      resetSession,
      saveManual,
      saveMatched,
      saveVisible,
    });
  }

  const api = Object.freeze({
    attendanceDateKey,
    createAttendanceEventId,
    createAttendanceRecorder,
  });
  globalScope.StampNoteCaptureAttendance = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
