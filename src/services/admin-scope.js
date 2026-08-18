(function initializeAdminScope(globalScope) {
  "use strict";

  const ALLOWED_SECTIONS = Object.freeze([
    "attendance-panel",
    "photos-panel",
    "session-facts",
    "session-truck-location",
  ]);

  function photoTimeMs(photo) {
    return Number(photo?.capturedAtMs) || Date.parse(photo?.capturedAt) || 0;
  }

  function plural(count, noun) {
    return `${count} ${noun}${count === 1 ? "" : "s"}`;
  }

  function countWorkers(entries) {
    return new Set((entries || []).map((entry) => entry.workerId)).size;
  }

  function workerInitials(worker) {
    return String(worker.displayName || worker.workerId)
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase();
  }

  function summarizeAttendance(entries) {
    const workers = new Map();
    (entries || []).forEach((entry) => {
      const saved = workers.get(entry.workerId) || {
        workerId: entry.workerId,
        displayName: entry.displayName,
        firstInAtMs: entry.checkedInAtMs,
        latestAtMs: entry.checkedInAtMs,
        checkIns: 0,
        flaggedCheckIns: 0,
        location: entry.location || null,
      };
      saved.displayName = entry.displayName || saved.displayName;
      saved.firstInAtMs = Math.min(saved.firstInAtMs, entry.checkedInAtMs);
      if (entry.checkedInAtMs >= saved.latestAtMs) {
        saved.latestAtMs = entry.checkedInAtMs;
        saved.location = entry.location || saved.location;
      }
      saved.checkIns += 1;
      if (entry.reviewStatus === "flagged" || entry.source === "manual") {
        saved.flaggedCheckIns += 1;
      }
      workers.set(entry.workerId, saved);
    });
    return [...workers.values()].sort((left, right) => right.latestAtMs - left.latestAtMs);
  }

  function describeError(error) {
    switch (error?.code) {
      case "auth/unauthorized-domain":
        return "Add this domain to Firebase Authentication → Settings → Authorized domains.";
      case "auth/operation-not-allowed":
        return "Enable the Google provider in Firebase Authentication.";
      case "permission-denied":
        return "Firebase denied access. Sign out and sign in again with this Gmail. If it continues, Firestore photo rules may not be deployed yet.";
      case "failed-precondition":
        return "Firestore needs an index for this dashboard query. Deploy the checked-in Firestore indexes, then reload this page.";
      default:
        return error?.message || "The dashboard data could not be loaded.";
    }
  }

  function readNavigationRequest(location = {}) {
    try {
      const params = new URLSearchParams(location.search || "");
      const section = String(location.hash || "").replace(/^#/, "");
      const allowedSections = new Set(ALLOWED_SECTIONS);
      return {
        locationKey: String(params.get("location") || "").slice(0, 96),
        dateKey: String(params.get("date") || "").slice(0, 16),
        sessionId: String(params.get("session") || "").slice(0, 32),
        section: allowedSections.has(section) ? section : "session-facts",
      };
    } catch (error) {
      return { locationKey: "", dateKey: "", sessionId: "", section: "session-facts" };
    }
  }

  function buildScope({
    photos = [],
    attendance = [],
    data,
    dashboardSessions = new Map(),
    sessionDefinitions = [],
  } = {}) {
    const locations = new Map();
    // Session-start fixes are available before a reviewed photo is uploaded and
    // cover more history than the currently loaded photo page. They make the
    // street parent stable even when the reverse geocoder changed road labels.
    const sites = data.createSiteIndex([...photos, ...dashboardSessions.values()]);
    const sessions = sessionDefinitions.length ? sessionDefinitions : data.SESSION_DEFINITIONS || [];

    function locationNode(rawLocation, atMs) {
      const recordedLocation = data.normalizeLocation(rawLocation);
      const site = sites.siteFor(rawLocation);
      const locationKey = data.createLocationKey(recordedLocation);
      if (!locations.has(locationKey)) {
        locations.set(locationKey, {
          location: recordedLocation,
          locationKey,
          streetName:
            site.streetName || data.streetNameForLocation?.(site.location || recordedLocation) || recordedLocation,
          streetKey:
            site.streetKey || data.createStreetKey?.(site.location || recordedLocation) || site.locationKey,
          point: site.point,
          // These are shown as sibling addresses under the street, not silently
          // folded into this address row.
          aliases: (site.addresses || [site.location]).filter(
            (address) => data.normalizeLocation(address) !== recordedLocation,
          ),
          aliasKeys: [],
          siteAliasKeys: (site.addresses || [site.location])
            .filter((address) => data.normalizeLocation(address) !== recordedLocation)
            .map((address) => data.createLocationKey(address)),
          latestAtMs: 0,
          dates: new Map(),
        });
      }
      const node = locations.get(locationKey);
      node.latestAtMs = Math.max(node.latestAtMs, atMs || 0);
      return node;
    }

    function dateNode(location, rawDateKey, atMs) {
      const dateKey = /^\d{4}-\d{2}-\d{2}$/.test(rawDateKey || "") ? rawDateKey : "unknown-date";
      if (!location.dates.has(dateKey)) {
        location.dates.set(dateKey, {
          dateKey,
          latestAtMs: 0,
          entries: [],
          photos: [],
          sessions: new Map(),
        });
      }
      const node = location.dates.get(dateKey);
      node.latestAtMs = Math.max(node.latestAtMs, atMs || 0);
      return node;
    }

    function sessionNode(dateGroup, atMs) {
      const definition = data.sessionDefinitionFor(atMs);
      if (!dateGroup.sessions.has(definition.id)) {
        dateGroup.sessions.set(definition.id, { ...definition, entries: [], photos: [] });
      }
      return dateGroup.sessions.get(definition.id);
    }

    attendance.forEach((entry) => {
      const location = locationNode(entry.location, entry.checkedInAtMs);
      const dateGroup = dateNode(location, entry.dateKey, entry.checkedInAtMs);
      dateGroup.entries.push(entry);
      sessionNode(dateGroup, entry.checkedInAtMs).entries.push(entry);
    });

    photos.forEach((photo) => {
      const atMs = photoTimeMs(photo);
      const location = locationNode(photo.location, atMs);
      const dateGroup = dateNode(location, photo.dateKey, atMs);
      dateGroup.photos.push(photo);
      sessionNode(dateGroup, atMs).photos.push(photo);
    });

    return [...locations.values()]
      .sort(
        (left, right) =>
          right.latestAtMs - left.latestAtMs || left.location.localeCompare(right.location),
      )
      .map((location) => {
        const dates = [...location.dates.values()]
          .sort((left, right) => right.dateKey.localeCompare(left.dateKey))
          .map((dateGroup) => ({
            ...dateGroup,
            sessions: sessions
              .map((definition) => dateGroup.sessions.get(definition.id))
              .filter(Boolean)
              .map((session) => {
                const key = data.createSessionKey({
                  locationKey: location.locationKey,
                  dateKey: dateGroup.dateKey,
                  sessionId: session.id,
                });
                const savedSession =
                  dashboardSessions.get(key) ||
                  (location.siteAliasKeys || [])
                    .map((aliasKey) =>
                      dashboardSessions.get(
                        data.createSessionKey({
                          locationKey: aliasKey,
                          dateKey: dateGroup.dateKey,
                          sessionId: session.id,
                        }),
                      ),
                    )
                    .find(Boolean);
                return {
                  ...session,
                  key,
                  label: savedSession?.label || session.label,
                  truckLocation: data.cleanTruckLocation(savedSession?.truckLocation),
                  weather: data.cleanSessionWeather(savedSession?.weather),
                  entries: [...session.entries].sort(
                    (left, right) => left.checkedInAtMs - right.checkedInAtMs,
                  ),
                };
              }),
          }));

        return {
          ...location,
          dates,
          entries: dates.flatMap((dateGroup) => dateGroup.entries),
          photos: dates.flatMap((dateGroup) => dateGroup.photos),
        };
      });
  }

  function groupLocationsByStreet(scope = []) {
    const groups = new Map();
    (scope || []).forEach((location) => {
      const streetKey = location.streetKey || location.locationKey;
      if (!groups.has(streetKey)) {
        groups.set(streetKey, {
          streetName: location.streetName || location.location,
          streetKey,
          latestAtMs: 0,
          locations: [],
        });
      }
      const group = groups.get(streetKey);
      group.latestAtMs = Math.max(group.latestAtMs, location.latestAtMs || 0);
      group.locations.push(location);
    });

    return [...groups.values()]
      .map((group) => ({
        ...group,
        locations: [...group.locations].sort((left, right) =>
          left.location.localeCompare(right.location, undefined, { numeric: true }),
        ),
      }))
      .sort(
        (left, right) =>
          right.latestAtMs - left.latestAtMs || left.streetName.localeCompare(right.streetName),
      );
  }

  function resolveSelection(scope, selection) {
    const streets = groupLocationsByStreet(scope);
    const requestedLocation = selection.locationKey
      ? scope.find((entry) => entry.locationKey === selection.locationKey) || null
      : null;
    // Existing deep links name an address but predate the street step. Infer its
    // parent so those links still open all four levels.
    if (!selection.streetKey && requestedLocation) {
      selection.streetKey = requestedLocation.streetKey;
    }
    const street = selection.streetKey
      ? streets.find((entry) => entry.streetKey === selection.streetKey) || null
      : null;
    const location =
      requestedLocation && requestedLocation.streetKey === street?.streetKey
        ? requestedLocation
        : null;
    const dateGroup =
      location && selection.dateKey
        ? location.dates.find((entry) => entry.dateKey === selection.dateKey) || null
        : null;
    const session = dateGroup
      ? dateGroup.sessions.find((entry) => entry.id === selection.sessionId) || null
      : null;

    selection.streetKey = street?.streetKey || null;
    selection.locationKey = location?.locationKey || null;
    selection.dateKey = dateGroup?.dateKey || null;
    if (!dateGroup) selection.sessionId = null;
    else if (selection.sessionId !== "all") selection.sessionId = session?.id || null;

    return { street, location, dateGroup, session };
  }

  function applyNavigationRequest(scope, request, selection) {
    if (!request?.locationKey || !request?.dateKey || !request?.sessionId) {
      return false;
    }
    const location = scope.find((entry) => entry.locationKey === request.locationKey);
    const dateGroup = location?.dates.find((entry) => entry.dateKey === request.dateKey);
    const session = dateGroup?.sessions.find((entry) => entry.id === request.sessionId);
    if (!location || !dateGroup || !session) return false;
    selection.locationKey = location.locationKey;
    selection.streetKey = location.streetKey;
    selection.dateKey = dateGroup.dateKey;
    selection.sessionId = session.id;
    return true;
  }

  function isScopeChosen(view, sessionId) {
    return Boolean(view.location && view.dateGroup && sessionId);
  }

  function scopeGuidance(view, scope) {
    if (scope.length === 0) return "No site has reported attendance or photos yet.";
    if (!view.street) return "";
    if (!view.location) return "Now pick an address.";
    if (!view.dateGroup) return "Now pick a date.";
    return "Now pick a time session, or the whole day.";
  }

  function scopedEntries(view) {
    return view.session?.entries || view.dateGroup?.entries || [];
  }

  function scopedPhotos(view) {
    return view.session?.photos || view.dateGroup?.photos || [];
  }

  function sessionDescriptorFor(location, dateGroup, session) {
    if (!location || !dateGroup || !session) return null;
    return {
      key: session.key,
      label: session.label,
      location: location.location,
      locationKey: location.locationKey,
      dateKey: dateGroup.dateKey,
      sessionId: session.id,
    };
  }

  function describeDeletion(descriptor) {
    const checkIns = plural(descriptor.node.entries.length, "check-in");
    const photoCount = plural(descriptor.node.photos.length, "photo");
    if (descriptor.level === "location") {
      const days = plural(descriptor.node.dates.length, "day");
      return `Permanently delete ${descriptor.label} and everything recorded there — ${days}, ${checkIns} and ${photoCount}? This cannot be undone.`;
    }
    if (descriptor.level === "date") {
      return `Permanently delete ${descriptor.label}, including every time session in it — ${checkIns} and ${photoCount}? This cannot be undone.`;
    }
    return `Permanently delete ${descriptor.label} and all of its attendance check-ins and photos? This cannot be undone.`;
  }

  function selectionAfterDeletion(descriptor) {
    if (descriptor.level === "location") {
      return {
        streetKey: descriptor.streetKey || null,
        locationKey: null,
        dateKey: null,
        sessionId: "all",
      };
    }
    if (descriptor.level === "date") {
      return { locationKey: descriptor.locationKey, dateKey: null, sessionId: "all" };
    }
    return {
      locationKey: descriptor.locationKey,
      dateKey: descriptor.dateKey,
      sessionId: "all",
    };
  }

  function deletedSessionKeys(descriptor, deleted) {
    const keys = new Set(deleted.sessionKeys || []);
    if (descriptor.level === "session") {
      keys.add(descriptor.key);
      return keys;
    }
    const dateGroups = descriptor.level === "location" ? descriptor.node.dates : [descriptor.node];
    dateGroups.forEach((dateGroup) => {
      dateGroup.sessions.forEach((session) => keys.add(session.key));
    });
    return keys;
  }

  const api = Object.freeze({
    applyNavigationRequest,
    buildScope,
    countWorkers,
    deletedSessionKeys,
    describeDeletion,
    describeError,
    isScopeChosen,
    groupLocationsByStreet,
    photoTimeMs,
    plural,
    readNavigationRequest,
    resolveSelection,
    scopeGuidance,
    scopedEntries,
    scopedPhotos,
    selectionAfterDeletion,
    sessionDescriptorFor,
    summarizeAttendance,
    workerInitials,
  });
  globalScope.StampNoteAdminScope = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
