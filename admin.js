(function initializeAdminDashboard() {
  "use strict";

  const cloud = window.StampNoteFirebase;
  const data = window.StampNoteCloudData;
  const telemetry = window.StampNoteObservability;
  const themeToggle = document.querySelector("#theme-toggle");
  const themeToggleIcon = document.querySelector("#theme-toggle-icon");
  const themeToggleLabel = document.querySelector("#theme-toggle-label");
  const signInButton = document.querySelector("#sign-in");
  const signOutButton = document.querySelector("#sign-out");
  const authGate = document.querySelector("#auth-gate");
  const accountName = document.querySelector("#account-name");
  const workspace = document.querySelector("#dashboard-workspace");
  const toolbar = document.querySelector("#gallery-toolbar");
  const filter = document.querySelector("#photo-filter");
  const library = document.querySelector("#photo-library");
  const status = document.querySelector("#dashboard-status");
  const loadMoreRow = document.querySelector("#load-more-row");
  const loadMoreButton = document.querySelector("#load-more");
  const dialog = document.querySelector("#photo-dialog");
  const dialogImage = document.querySelector("#dialog-image");
  const dialogLocation = document.querySelector("#dialog-location");
  const dialogTime = document.querySelector("#dialog-time");
  const dialogGpsReference = document.querySelector("#dialog-gps-reference");
  const dialogCoordinateStatus = document.querySelector("#dialog-coordinate-status");
  const dialogPeople = document.querySelector("#dialog-people");
  const dialogReview = document.querySelector("#dialog-review");
  const attendanceRefresh = document.querySelector("#attendance-refresh");
  const attendanceWorkerFilter = document.querySelector("#attendance-worker-filter");
  const locationOptions = document.querySelector("#location-options");
  const dateOptions = document.querySelector("#date-options");
  const sessionOptions = document.querySelector("#session-options");
  const scopeBreadcrumb = document.querySelector("#scope-breadcrumb");
  const sessionActions = document.querySelector("#session-actions");
  const sessionRenameButton = document.querySelector("#session-rename");
  const sessionDeleteButton = document.querySelector("#session-delete");
  const sessionRenameDialog = document.querySelector("#session-rename-dialog");
  const sessionRenameForm = document.querySelector("#session-rename-form");
  const sessionRenameInput = document.querySelector("#session-rename-input");
  const sessionRenameError = document.querySelector("#session-rename-error");
  const sessionRenameCancel = document.querySelector("#session-rename-cancel");
  const sessionRenameSave = document.querySelector("#session-rename-save");
  const attendanceStatus = document.querySelector("#attendance-status");
  const attendanceList = document.querySelector("#attendance-list");
  const presentWorkerCount = document.querySelector("#present-worker-count");
  const attendanceCheckinCount = document.querySelector("#attendance-checkin-count");

  telemetry?.configure({ surface: "dashboard" });

  let signedInUser = null;
  let photos = [];
  let after = null;
  let hasMore = false;
  let loading = false;
  let loadingAttendance = false;
  let attendanceLoadError = null;
  let photoLoadFailed = false;
  let attendance = [];
  let dashboardSessions = new Map();
  let sessionActionBusy = false;
  let truckLocationSavingKey = null;
  let editingSession = null;
  let renderVersion = 0;
  const photoUrls = new Map();

  // A day is read as three working sessions so a location's morning crew is
  // never mixed with the people who arrived after lunch.
  const SESSIONS = data?.SESSION_DEFINITIONS || [];
  const selection = { locationKey: null, dateKey: null, sessionId: "all" };

  const THEME_KEY = "stampnote-theme";

  function readStoredTheme() {
    try {
      const saved = window.localStorage?.getItem(THEME_KEY);
      return saved === "dark" || saved === "light" ? saved : null;
    } catch (error) {
      return null;
    }
  }

  function systemPrefersDark() {
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
  }

  // Nothing is written to the document element until the reader picks a theme,
  // so an untouched dashboard keeps following the operating system.
  function applyTheme(theme) {
    const root = document.documentElement;
    if (root) {
      if (theme) {
        root.dataset.theme = theme;
      } else {
        delete root.dataset.theme;
      }
    }

    const dark = theme ? theme === "dark" : systemPrefersDark();
    if (themeToggle) {
      themeToggle.setAttribute("aria-pressed", dark ? "true" : "false");
      themeToggle.setAttribute("title", dark ? "Switch to light theme" : "Switch to dark theme");
    }
    if (themeToggleIcon) themeToggleIcon.textContent = dark ? "☀" : "☾";
    if (themeToggleLabel) themeToggleLabel.textContent = dark ? "Light" : "Dark";
  }

  function toggleTheme() {
    const next = (readStoredTheme() || (systemPrefersDark() ? "dark" : "light")) === "dark"
      ? "light"
      : "dark";
    try {
      window.localStorage?.setItem(THEME_KEY, next);
    } catch (error) {
      /* The theme still applies for this visit even when storage is blocked. */
    }
    applyTheme(next);
    telemetry?.event("dashboard.theme.changed", { theme: next });
  }

  function setStatus(message, state = "idle") {
    status.textContent = message;
    status.dataset.state = state;
  }

  // The button keeps its own throbber so a slow page fetch is visible even when
  // the status line has scrolled out of view.
  function setLoadMoreBusy(busy) {
    loadMoreButton.textContent = busy ? "Loading…" : "Load more photos";
    loadMoreButton.setAttribute("aria-busy", busy ? "true" : "false");
    if (busy) {
      const spinner = document.createElement("span");
      spinner.className = "throbber";
      spinner.setAttribute("aria-hidden", "true");
      loadMoreButton.prepend(spinner);
    }
  }

  function describeError(error) {
    switch (error?.code) {
      case "auth/unauthorized-domain":
        return "Add this domain to Firebase Authentication → Settings → Authorized domains.";
      case "auth/operation-not-allowed":
        return "Enable the Google provider in Firebase Authentication.";
      case "permission-denied":
        return "Firebase denied access. Check that the project rules are deployed and this is the capture account.";
      case "failed-precondition":
        return "Firestore needs an index for this dashboard query. Deploy the checked-in Firestore indexes, then reload this page.";
      default:
        return error?.message || "The dashboard data could not be loaded.";
    }
  }

  function revokePhotoUrls() {
    photoUrls.forEach((entry) => {
      entry.then?.((url) => URL.revokeObjectURL(url)).catch?.(() => {});
    });
    photoUrls.clear();
  }

  function getPhotoUrl(photo) {
    if (!photoUrls.has(photo.id)) {
      photoUrls.set(
        photo.id,
        cloud.getPhotoBlob(photo).then((blob) => URL.createObjectURL(blob)),
      );
    }

    return photoUrls.get(photo.id);
  }

  function formatDate(dateKey) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey || "")) {
      return "Unknown date";
    }

    const [year, month, day] = dateKey.split("-").map(Number);
    return new Intl.DateTimeFormat(undefined, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(new Date(year, month - 1, day));
  }

  function formatTime(photo) {
    const date = new Date(photo.capturedAt || photo.capturedAtMs);
    if (Number.isNaN(date.getTime())) {
      return "Unknown time";
    }
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    }).format(date);
  }

  function formatAttendanceTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Unknown time";
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
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
    entries.forEach((entry) => {
      const saved = workers.get(entry.workerId) || {
        workerId: entry.workerId,
        displayName: entry.displayName,
        firstInAtMs: entry.checkedInAtMs,
        latestAtMs: entry.checkedInAtMs,
        checkIns: 0,
        location: entry.location || null,
      };
      saved.displayName = entry.displayName || saved.displayName;
      saved.firstInAtMs = Math.min(saved.firstInAtMs, entry.checkedInAtMs);
      if (entry.checkedInAtMs >= saved.latestAtMs) {
        saved.latestAtMs = entry.checkedInAtMs;
        saved.location = entry.location || saved.location;
      }
      saved.checkIns += 1;
      workers.set(entry.workerId, saved);
    });
    return [...workers.values()].sort((left, right) => right.latestAtMs - left.latestAtMs);
  }

  function photoTimeMs(photo) {
    return Number(photo?.capturedAtMs) || Date.parse(photo?.capturedAt) || 0;
  }

  function sessionDefinitionFor(value) {
    return data.sessionDefinitionFor(value);
  }

  function countWorkers(entries) {
    return new Set(entries.map((entry) => entry.workerId)).size;
  }

  function plural(count, noun) {
    return `${count} ${noun}${count === 1 ? "" : "s"}`;
  }

  // Check-ins and photographs share one location → date → session tree so the
  // dashboard only ever shows one site's work at a time.
  function buildScope() {
    const locations = new Map();

    function locationNode(rawLocation, atMs) {
      const location = data.normalizeLocation(rawLocation);
      const locationKey = data.createLocationKey(location);
      if (!locations.has(locationKey)) {
        locations.set(locationKey, { location, locationKey, latestAtMs: 0, dates: new Map() });
      }
      const node = locations.get(locationKey);
      node.latestAtMs = Math.max(node.latestAtMs, atMs || 0);
      return node;
    }

    function dateNode(location, rawDateKey, atMs) {
      const dateKey = /^\d{4}-\d{2}-\d{2}$/.test(rawDateKey || "")
        ? rawDateKey
        : "unknown-date";
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
      const definition = sessionDefinitionFor(atMs);
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
          right.latestAtMs - left.latestAtMs ||
          left.location.localeCompare(right.location),
      )
      .map((location) => {
        const dates = [...location.dates.values()]
          .sort((left, right) => right.dateKey.localeCompare(left.dateKey))
          .map((dateGroup) => ({
            ...dateGroup,
            sessions: SESSIONS.map((definition) => dateGroup.sessions.get(definition.id))
              .filter(Boolean)
              .map((session) => {
                const key = data.createSessionKey({
                  locationKey: location.locationKey,
                  dateKey: dateGroup.dateKey,
                  sessionId: session.id,
                });
                const savedSession = dashboardSessions.get(key);
                return {
                  ...session,
                  key,
                  label: savedSession?.label || session.label,
                  truckLocation: data.cleanTruckLocation(savedSession?.truckLocation),
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

  function resolveSelection(scope) {
    const location =
      scope.find((entry) => entry.locationKey === selection.locationKey) || scope[0] || null;
    const dateGroup = location
      ? location.dates.find((entry) => entry.dateKey === selection.dateKey) ||
        location.dates[0] ||
        null
      : null;
    const session = dateGroup
      ? dateGroup.sessions.find((entry) => entry.id === selection.sessionId) || null
      : null;

    selection.locationKey = location?.locationKey || null;
    selection.dateKey = dateGroup?.dateKey || null;
    selection.sessionId = session?.id || "all";

    return { location, dateGroup, session };
  }

  function scopedEntries(view) {
    return view.session?.entries || view.dateGroup?.entries || [];
  }

  function scopedPhotos(view) {
    return view.session?.photos || view.dateGroup?.photos || [];
  }

  function attendanceForSelectedWorker(entries) {
    const selectedWorkerId = attendanceWorkerFilter.value;
    return selectedWorkerId === "all"
      ? entries
      : entries.filter((entry) => entry.workerId === selectedWorkerId);
  }

  function updateAttendanceWorkerOptions(entries) {
    const selectedWorkerId = attendanceWorkerFilter.value || "all";
    const workers = summarizeAttendance(entries).sort((left, right) =>
      String(left.displayName || left.workerId).localeCompare(
        String(right.displayName || right.workerId),
      ),
    );
    const allWorkers = document.createElement("option");
    allWorkers.value = "all";
    allWorkers.textContent = "All workers";
    const options = workers.map((worker) => {
      const option = document.createElement("option");
      option.value = worker.workerId;
      option.textContent = worker.displayName
        ? `${worker.displayName} · ${worker.workerId}`
        : worker.workerId;
      return option;
    });

    attendanceWorkerFilter.replaceChildren(allWorkers, ...options);
    attendanceWorkerFilter.value = workers.some(
      (worker) => worker.workerId === selectedWorkerId,
    )
      ? selectedWorkerId
      : "all";
    attendanceWorkerFilter.disabled = workers.length === 0;
  }

  function updateAttendanceStatus() {
    attendanceStatus.dataset.state = "idle";
    attendanceStatus.textContent = "";
  }

  function createAttendanceRow(worker) {
    const row = document.createElement("article");
    const avatar = document.createElement("span");
    const identity = document.createElement("div");
    const name = document.createElement("strong");
    const workerId = document.createElement("span");
    const timing = document.createElement("div");
    const hours = document.createElement("span");

    row.className = "attendance-row";
    avatar.className = "attendance-avatar";
    avatar.textContent = workerInitials(worker);
    identity.className = "attendance-identity";
    name.textContent = worker.displayName;
    workerId.textContent = worker.workerId;
    timing.className = "attendance-timing";
    // Every row in this list is a worker who was present, so a "Present" badge
    // on each one is noise. What differs between rows is the hours.
    const firstAt = formatAttendanceTime(worker.firstInAtMs);
    const lastAt = formatAttendanceTime(worker.latestAtMs);
    const span = firstAt === lastAt ? firstAt : `${firstAt} – ${lastAt}`;
    hours.textContent =
      worker.checkIns > 1 ? `${span} · ${plural(worker.checkIns, "check-in")}` : span;

    identity.append(name, workerId);
    timing.append(hours);
    row.append(avatar, identity, timing);
    return row;
  }

  function createScopeOption({ title, detail, selected, onSelect }) {
    const option = document.createElement("button");
    const name = document.createElement("strong");
    const meta = document.createElement("span");

    option.type = "button";
    option.className = "scope-option";
    option.dataset.selected = String(Boolean(selected));
    option.setAttribute("aria-pressed", String(Boolean(selected)));
    name.textContent = title;
    meta.textContent = detail;
    option.append(name, meta);
    option.addEventListener("click", onSelect);
    return option;
  }

  function createScopeEmpty(message) {
    const empty = document.createElement("p");
    empty.className = "scope-empty";
    empty.textContent = message;
    return empty;
  }

  function truckLocationSummary(session) {
    const truckLocation = data.cleanTruckLocation(session?.truckLocation);
    if (truckLocation.x === null || truckLocation.y === null) {
      return { message: "Enter X and Y for this session.", state: "idle" };
    }

    const comparisons = (session.photos || [])
      .map((photo) => data.compareTruckLocation(photo.gpsLocation, truckLocation))
      .filter((comparison) =>
        comparison.status === "flagged" || comparison.status === "within_accuracy",
      );
    const flagged = comparisons.filter((comparison) => comparison.flagged).length;
    if (flagged > 0) {
      return {
        message: `${flagged} of ${plural(comparisons.length, "photo")} exceeds GPS accuracy.`,
        state: "error",
      };
    }
    if (comparisons.length > 0) {
      return {
        message: `${plural(comparisons.length, "photo")} within GPS accuracy.`,
        state: "success",
      };
    }
    return { message: "Saved · No automatic GPS photo is available yet.", state: "success" };
  }

  function createTruckLocationForm(descriptor, session) {
    const form = document.createElement("form");
    const fieldset = document.createElement("fieldset");
    const legend = document.createElement("legend");
    const xLabel = document.createElement("label");
    const xText = document.createElement("span");
    const xInput = document.createElement("input");
    const yLabel = document.createElement("label");
    const yText = document.createElement("span");
    const yInput = document.createElement("input");
    const coordinateStatus = document.createElement("p");
    const formActions = document.createElement("div");
    const saveButton = document.createElement("button");
    const clearButton = document.createElement("button");
    const summary = truckLocationSummary(session);
    const storedLocation = data.cleanTruckLocation(session.truckLocation);
    const busy = truckLocationSavingKey === descriptor.key;
    const hasLocation = storedLocation.x !== null && storedLocation.y !== null;

    form.className = "truck-location-form";
    form.dataset.sessionKey = descriptor.key;
    form.setAttribute("aria-label", `Truck location for ${session.label} session`);
    legend.textContent = "Truck location";

    xText.textContent = "X · longitude";
    xInput.id = `truck-location-x-${descriptor.key}`;
    xInput.name = "truckLocationX";
    xInput.type = "number";
    xInput.value = coordinateFieldValue(storedLocation.x);
    xInput.dataset.coordinateAxis = "x";
    xInput.setAttribute("step", "any");
    xInput.setAttribute("inputmode", "decimal");
    xInput.setAttribute("autocomplete", "off");
    xInput.setAttribute("placeholder", "X");
    xInput.disabled = busy;
    xLabel.setAttribute("for", xInput.id);
    xLabel.append(xText, xInput);

    yText.textContent = "Y · latitude";
    yInput.id = `truck-location-y-${descriptor.key}`;
    yInput.name = "truckLocationY";
    yInput.type = "number";
    yInput.value = coordinateFieldValue(storedLocation.y);
    yInput.dataset.coordinateAxis = "y";
    yInput.setAttribute("step", "any");
    yInput.setAttribute("inputmode", "decimal");
    yInput.setAttribute("autocomplete", "off");
    yInput.setAttribute("placeholder", "Y");
    yInput.disabled = busy;
    yLabel.setAttribute("for", yInput.id);
    yLabel.append(yText, yInput);

    coordinateStatus.className = "truck-location-status";
    coordinateStatus.textContent = busy ? "Saving truck location…" : summary.message;
    coordinateStatus.dataset.state = busy ? "loading" : summary.state;
    coordinateStatus.setAttribute("role", "status");
    coordinateStatus.setAttribute("aria-live", "polite");

    formActions.className = "truck-location-actions";
    saveButton.className = "button button-primary truck-location-save";
    saveButton.type = "submit";
    saveButton.textContent = "Save truck location";
    saveButton.disabled = busy;
    clearButton.className = "button button-quiet truck-location-clear";
    clearButton.type = "button";
    clearButton.textContent = "Clear";
    clearButton.disabled = busy || !hasLocation;

    const controls = { xInput, yInput, coordinateStatus, saveButton, clearButton };
    form.addEventListener("submit", (event) => saveTruckLocation(event, descriptor, controls));
    clearButton.addEventListener("click", (event) =>
      saveTruckLocation(event, descriptor, controls, { clear: true }),
    );

    fieldset.append(legend, xLabel, yLabel);
    formActions.append(saveButton, clearButton);
    form.append(fieldset, coordinateStatus, formActions);
    return form;
  }

  function createSessionScopeCard(view, session) {
    const card = document.createElement("div");
    const actions = document.createElement("div");
    const renameButton = document.createElement("button");
    const deleteButton = document.createElement("button");
    const range = sessionRange(session);
    const descriptor = sessionDescriptorFor(view.location, view.dateGroup, session);

    card.className = "scope-session-card";
    actions.className = "session-option-actions";
    renameButton.type = "button";
    renameButton.className = "session-option-action session-option-rename";
    renameButton.textContent = "Rename";
    renameButton.setAttribute("aria-label", `Rename ${session.label} session`);
    renameButton.disabled = sessionActionBusy;
    deleteButton.type = "button";
    deleteButton.className = "session-option-action session-option-delete";
    deleteButton.textContent = "Delete";
    deleteButton.setAttribute("aria-label", `Delete ${session.label} session`);
    deleteButton.disabled = sessionActionBusy;

    renameButton.addEventListener("click", () => openRenameDialog(descriptor));
    deleteButton.addEventListener("click", () => deleteSelectedSession(descriptor));
    actions.append(renameButton, deleteButton);
    card.append(
      createScopeOption({
        title: range ? `${session.label} · ${range}` : session.label,
        detail: `${plural(countWorkers(session.entries), "worker")} · ${plural(session.photos.length, "photo")}`,
        selected: session.id === view.session?.id,
        onSelect: () => {
          selection.sessionId = session.id;
          renderDashboard();
        },
      }),
      actions,
      createTruckLocationForm(descriptor, session),
    );
    return card;
  }

  function sessionRange(session) {
    const times = [...session.entries.map((entry) => entry.checkedInAtMs), ...session.photos.map(photoTimeMs)]
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((left, right) => left - right);
    if (times.length === 0) {
      return "";
    }
    const first = formatAttendanceTime(times[0]);
    const last = formatAttendanceTime(times[times.length - 1]);
    return first === last ? first : `${first} – ${last}`;
  }

  function renderScopeRail(scope, view) {
    locationOptions.replaceChildren();
    dateOptions.replaceChildren();
    sessionOptions.replaceChildren();

    if (scope.length === 0) {
      locationOptions.append(createScopeEmpty("No sites have reported yet."));
      dateOptions.append(createScopeEmpty("Pick a location first."));
      sessionOptions.append(createScopeEmpty("Pick a date first."));
      return;
    }

    scope.forEach((location) => {
      locationOptions.append(
        createScopeOption({
          title: location.location,
          detail: `${plural(location.dates.length, "day")} · ${plural(location.photos.length, "photo")}`,
          selected: location.locationKey === view.location?.locationKey,
          onSelect: () => {
            selection.locationKey = location.locationKey;
            selection.dateKey = null;
            selection.sessionId = "all";
            renderDashboard();
          },
        }),
      );
    });

    (view.location?.dates || []).forEach((dateGroup) => {
      dateOptions.append(
        createScopeOption({
          title: formatDate(dateGroup.dateKey),
          detail: `${plural(countWorkers(dateGroup.entries), "worker")} · ${plural(dateGroup.photos.length, "photo")}`,
          selected: dateGroup.dateKey === view.dateGroup?.dateKey,
          onSelect: () => {
            selection.dateKey = dateGroup.dateKey;
            selection.sessionId = "all";
            renderDashboard();
          },
        }),
      );
    });

    if (!view.dateGroup) {
      dateOptions.append(createScopeEmpty("Pick a location first."));
      sessionOptions.append(createScopeEmpty("Pick a date first."));
      return;
    }

    sessionOptions.append(
      createScopeOption({
        title: "Whole day",
        detail: `${plural(countWorkers(view.dateGroup.entries), "worker")} · ${plural(view.dateGroup.photos.length, "photo")}`,
        selected: !view.session,
        onSelect: () => {
          selection.sessionId = "all";
          renderDashboard();
        },
      }),
    );

    view.dateGroup.sessions.forEach((session) => {
      sessionOptions.append(createSessionScopeCard(view, session));
    });
  }

  function renderBreadcrumb(view) {
    if (!view.location) {
      scopeBreadcrumb.textContent = "No location has reported attendance or photos yet.";
      return;
    }
    const parts = [view.location.location, formatDate(view.dateGroup?.dateKey)];
    parts.push(view.session ? `${view.session.label} session` : "Whole day");
    scopeBreadcrumb.textContent = parts.join(" · ");
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

  function sessionDescriptor(view) {
    return sessionDescriptorFor(view.location, view.dateGroup, view.session);
  }

  function findSessionView(descriptor) {
    const scope = buildScope();
    const location = scope.find((entry) => entry.locationKey === descriptor?.locationKey) || null;
    const dateGroup = location?.dates.find((entry) => entry.dateKey === descriptor?.dateKey) || null;
    const session = dateGroup?.sessions.find((entry) => entry.id === descriptor?.sessionId) || null;
    return { location, dateGroup, session };
  }

  function refreshSessionControls() {
    const scope = buildScope();
    const view = resolveSelection(scope);
    renderScopeRail(scope, view);
    renderSessionActions(view);
  }

  function renderSessionActions(view) {
    const descriptor = sessionDescriptor(view);
    sessionActions.hidden = !descriptor;
    sessionRenameButton.disabled = sessionActionBusy || !descriptor;
    sessionDeleteButton.disabled = sessionActionBusy || !descriptor;
  }

  function renderAttendance(view) {
    const entries = scopedEntries(view);
    updateAttendanceWorkerOptions(entries);
    const visibleAttendance = attendanceForSelectedWorker(entries);
    const workers = summarizeAttendance(visibleAttendance);
    presentWorkerCount.textContent = String(workers.length);
    attendanceCheckinCount.textContent = String(visibleAttendance.length);
    attendanceList.replaceChildren();
    updateAttendanceStatus();
    if (attendanceLoadError) {
      attendanceStatus.textContent = describeError(attendanceLoadError);
      attendanceStatus.dataset.state = "error";
    }

    if (workers.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty-attendance";
      empty.textContent = attendance.length
        ? "No worker checked in during this session."
        : "No matched worker attendance has been recorded yet.";
      attendanceList.append(empty);
      return;
    }

    workers.forEach((worker) => attendanceList.append(createAttendanceRow(worker)));
  }

  function renderDashboard() {
    const scope = buildScope();
    const view = resolveSelection(scope);
    renderScopeRail(scope, view);
    renderBreadcrumb(view);
    renderSessionActions(view);
    renderAttendance(view);
    renderPhotos(view);
  }

  async function loadDashboardSessions() {
    if (!signedInUser) return;
    try {
      const sessions = await cloud.getDashboardSessions();
      dashboardSessions = new Map(sessions.map((session) => [session.key, session]));
      renderDashboard();
    } catch (error) {
      telemetry?.event(
        "dashboard.sessions.failed",
        { errorCode: telemetry.safeErrorCode(error, "dashboard_sessions_failed"), status: "failed" },
        { immediate: true, dedupeMs: 60000 },
      );
    }
  }

  function closeRenameDialog() {
    editingSession = null;
    if (typeof sessionRenameDialog.close === "function") {
      sessionRenameDialog.close();
    } else {
      sessionRenameDialog.removeAttribute("open");
    }
  }

  function openRenameDialog(descriptor = null) {
    editingSession = descriptor || sessionDescriptor(resolveSelection(buildScope()));
    if (!editingSession || sessionActionBusy) return;
    sessionRenameInput.value = editingSession.label;
    sessionRenameError.textContent = "";
    if (typeof sessionRenameDialog.showModal === "function") {
      sessionRenameDialog.showModal();
    } else {
      sessionRenameDialog.setAttribute("open", "");
    }
    sessionRenameInput.focus?.();
    sessionRenameInput.select?.();
  }

  async function renameSelectedSession(event) {
    event?.preventDefault?.();
    if (!editingSession || sessionActionBusy) return;
    const label = String(sessionRenameInput.value || "").trim().replace(/\s+/g, " ");
    if (!label || label.length > 60) {
      sessionRenameError.textContent = "Enter a session name between 1 and 60 characters.";
      return;
    }

    sessionActionBusy = true;
    sessionRenameSave.disabled = true;
    sessionRenameCancel.disabled = true;
    sessionRenameError.textContent = "";
    renderSessionActions(resolveSelection(buildScope()));
    try {
      const renamed = await cloud.renameSession({ ...editingSession, label });
      dashboardSessions.set(renamed.key, {
        ...dashboardSessions.get(renamed.key),
        ...renamed,
        truckLocation: dashboardSessions.get(renamed.key)?.truckLocation,
      });
      closeRenameDialog();
      renderDashboard();
      setStatus(`Renamed session to ${renamed.label}.`);
      telemetry?.event("dashboard.session.renamed", { status: "success" });
    } catch (error) {
      sessionRenameError.textContent = describeError(error);
      telemetry?.event(
        "dashboard.session.rename_failed",
        { errorCode: telemetry.safeErrorCode(error, "session_rename_failed"), status: "failed" },
        { immediate: true },
      );
    } finally {
      sessionActionBusy = false;
      sessionRenameSave.disabled = false;
      sessionRenameCancel.disabled = false;
      renderSessionActions(resolveSelection(buildScope()));
    }
  }

  async function deleteSelectedSession(requestedSession = null) {
    if (sessionActionBusy) return;
    const selectedView = resolveSelection(buildScope());
    const descriptor = requestedSession || sessionDescriptor(selectedView);
    const view = requestedSession ? findSessionView(requestedSession) : selectedView;
    if (!descriptor || !view.session) return;
    const confirmed = window.confirm?.(
      `Permanently delete ${descriptor.label} and all of its attendance check-ins and photos? This cannot be undone.`,
    );
    if (!confirmed) return;

    sessionActionBusy = true;
    refreshSessionControls();
    setStatus(`Deleting ${descriptor.label}…`);
    try {
      const deleted = await cloud.deleteSession(descriptor);
      const attendanceIds = new Set([
        ...view.session.entries.map((entry) => entry.eventId),
        ...(deleted.attendanceEventIds || []),
      ]);
      const photoIds = new Set([
        ...view.session.photos.map((photo) => photo.id),
        ...(deleted.photoIds || []),
      ]);
      attendance = attendance.filter((entry) => !attendanceIds.has(entry.eventId));
      photos = photos.filter((photo) => !photoIds.has(photo.id));
      photoIds.forEach((photoId) => {
        const pendingUrl = photoUrls.get(photoId);
        pendingUrl?.then?.((url) => URL.revokeObjectURL(url)).catch?.(() => {});
        photoUrls.delete(photoId);
      });
      dashboardSessions.delete(descriptor.key);
      if (
        selection.locationKey === descriptor.locationKey &&
        selection.dateKey === descriptor.dateKey &&
        selection.sessionId === descriptor.sessionId
      ) {
        selection.sessionId = "all";
      }
      renderDashboard();
      setStatus(
        `Deleted ${descriptor.label}: ${plural(deleted.attendanceDeleted, "check-in")} and ${plural(deleted.photoDeleted, "photo")}.`,
      );
      telemetry?.event("dashboard.session.deleted", {
        checkInCount: deleted.attendanceDeleted,
        photoCount: deleted.photoDeleted,
        status: "success",
      });
    } catch (error) {
      setStatus(`${describeError(error)} Deletion may be incomplete; refresh before retrying.`, "error");
      telemetry?.event(
        "dashboard.session.delete_failed",
        { errorCode: telemetry.safeErrorCode(error, "session_delete_failed"), status: "failed" },
        { immediate: true },
      );
    } finally {
      sessionActionBusy = false;
      refreshSessionControls();
    }
  }

  async function loadAttendance() {
    if (!signedInUser || loadingAttendance) return;
    loadingAttendance = true;
    attendanceLoadError = null;
    attendanceRefresh.disabled = true;
    attendanceWorkerFilter.disabled = true;
    attendanceStatus.textContent = "Loading attendance…";
    attendanceStatus.dataset.state = "loading";
    const startedAt = performance.now();
    const traceId = telemetry?.createTraceId();

    try {
      attendance = await cloud.getAttendance({
        pageSize: 500,
      });
      attendanceLoadError = null;
      renderDashboard();
      telemetry?.event(
        "attendance.load.completed",
        {
          durationMs: performance.now() - startedAt,
          checkInCount: attendance.length,
          workerCount: summarizeAttendance(attendance).length,
          status: "success",
        },
        { traceId },
      );
    } catch (error) {
      attendance = [];
      attendanceLoadError = error;
      sessionActionBusy = false;
      editingSession = null;
      renderDashboard();
      attendanceStatus.textContent = describeError(error);
      attendanceStatus.dataset.state = "error";
      telemetry?.event(
        "attendance.load.failed",
        {
          durationMs: performance.now() - startedAt,
          errorCode: telemetry?.safeErrorCode(error, "attendance_load_failed"),
          status: "failed",
        },
        { traceId, immediate: true },
      );
    } finally {
      loadingAttendance = false;
      attendanceRefresh.disabled = false;
    }
  }

  function formatDateTime(photo) {
    const date = new Date(photo.capturedAt || photo.capturedAtMs);
    if (Number.isNaN(date.getTime())) {
      return "Unknown capture time";
    }
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "full",
      timeStyle: "medium",
    }).format(date);
  }

  function reviewLabel(photo) {
    if (data.isFlagged(photo)) {
      return photo.aiReview?.action === "discard" ? "AI reject" : "Uncertain AI flag";
    }
    return photo.poseDetected ? "Kept · person" : "Kept";
  }

  function peopleLabel(photo) {
    const inPhoto = Math.max(0, Math.floor(Number(photo?.people) || 0));
    const visible = `${inPhoto} ${inPhoto === 1 ? "person" : "people"} in this photo`;
    if (photo?.uniquePeopleSeen === null || photo?.uniquePeopleSeen === undefined) {
      return `${visible} · Unique session count unavailable`;
    }
    const unique = Math.max(0, Math.floor(Number(photo.uniquePeopleSeen) || 0));
    const session = `${unique} unique ${unique === 1 ? "person" : "people"} seen this session`;
    return `${visible} · ${session}`;
  }

  function coordinateFieldValue(value) {
    const coordinate = value === "" || value === null || value === undefined ? null : Number(value);
    return Number.isFinite(coordinate) ? String(coordinate) : "";
  }

  function readCoordinate(field, axis) {
    const raw = String(field.value || "").trim();
    if (!raw) return null;
    const coordinate = Number(raw);
    if (!Number.isFinite(coordinate)) {
      throw new Error(`Truck location ${axis} must be a valid number.`);
    }
    if ((axis === "X" && (coordinate < -180 || coordinate > 180)) ||
        (axis === "Y" && (coordinate < -90 || coordinate > 90))) {
      throw new Error(
        axis === "X"
          ? "Truck location X must be a longitude between -180 and 180."
          : "Truck location Y must be a latitude between -90 and 90.",
      );
    }
    return coordinate;
  }

  function photoSessionKey(photo) {
    const atMs = photoTimeMs(photo);
    return data.createSessionKey({
      locationKey: photo.locationKey || data.createLocationKey(photo.location),
      dateKey: /^\d{4}-\d{2}-\d{2}$/.test(photo.dateKey || "")
        ? photo.dateKey
        : data.createDateKey(atMs),
      sessionId: data.sessionDefinitionFor(atMs).id,
    });
  }

  function truckLocationForPhoto(photo) {
    return data.cleanTruckLocation(dashboardSessions.get(photoSessionKey(photo))?.truckLocation);
  }

  function coordinateVerificationForPhoto(photo) {
    return data.compareTruckLocation(photo?.gpsLocation, truckLocationForPhoto(photo));
  }

  function isGpsDiscrepant(photo) {
    return coordinateVerificationForPhoto(photo).flagged;
  }

  function showCoordinateVerification(photo) {
    const truckLocation = truckLocationForPhoto(photo);
    const verification = coordinateVerificationForPhoto(photo);
    const distance = verification.distanceMeters;
    const accuracy = verification.accuracyMeters;
    const prefix =
      truckLocation.x === null || truckLocation.y === null
        ? "Truck location"
        : `Truck location · X ${truckLocation.x} · Y ${truckLocation.y}`;

    switch (verification.status) {
      case "flagged":
        dialogCoordinateStatus.textContent =
          `${prefix} · Flagged · ${distance} m from automatic GPS; accuracy threshold ${accuracy} m.`;
        dialogCoordinateStatus.dataset.state = "error";
        break;
      case "within_accuracy":
        dialogCoordinateStatus.textContent =
          `${prefix} · Within GPS accuracy · ${distance} m distance; threshold ${accuracy} m.`;
        dialogCoordinateStatus.dataset.state = "success";
        break;
      case "gps_unavailable":
        dialogCoordinateStatus.textContent =
          `${prefix} · Automatic GPS coordinates are unavailable for this legacy photo.`;
        dialogCoordinateStatus.dataset.state = "idle";
        break;
      case "incomplete":
        dialogCoordinateStatus.textContent = "Enter both Truck location X and Y in this session.";
        dialogCoordinateStatus.dataset.state = "idle";
        break;
      default:
        dialogCoordinateStatus.textContent = "Truck location is not set for this session.";
        dialogCoordinateStatus.dataset.state = "idle";
    }
  }

  function gpsReferenceLabel(photo) {
    const gps = data.normalizeGpsLocation(photo?.gpsLocation);
    return gps
      ? `Automatic GPS · X ${gps.longitude} · Y ${gps.latitude} · accuracy ±${gps.accuracyMeters} m`
      : "Automatic GPS unavailable for this photo";
  }

  async function loadImage(image, photo, version) {
    try {
      const url = await getPhotoUrl(photo);
      if (version !== renderVersion || !image.isConnected) {
        return;
      }
      image.src = url;
      image.dataset.loaded = "true";
    } catch (error) {
      if (version === renderVersion && image.isConnected) {
        image.dataset.error = "true";
        image.alt = describeError(error);
      }
      telemetry?.event(
        "dashboard.image.failed",
        { errorCode: telemetry.safeErrorCode(error, "image_load_failed") },
        { immediate: true, dedupeMs: 60000 },
      );
    }
  }

  function openPhoto(photo) {
    dialogImage.removeAttribute("src");
    dialogImage.alt = `Photo captured at ${photo.location}`;
    dialogLocation.textContent = photo.location;
    dialogTime.textContent = formatDateTime(photo);
    dialogGpsReference.textContent = gpsReferenceLabel(photo);
    showCoordinateVerification(photo);
    dialogPeople.textContent = peopleLabel(photo);
    dialogReview.textContent = photo.aiReview
      ? `${reviewLabel(photo)} · ${Math.round((photo.aiReview.confidence || 0) * 100)}% confidence · ${
          photo.aiReview.reason || "No review note"
        }`
      : "No Gemini review metadata";

    getPhotoUrl(photo)
      .then((url) => {
        dialogImage.src = url;
      })
      .catch((error) => setStatus(describeError(error), "error"));

    if (typeof dialog.showModal === "function") {
      dialog.showModal();
    } else {
      dialog.setAttribute("open", "");
    }
  }

  async function saveTruckLocation(event, descriptor, controls, options = {}) {
    event?.preventDefault?.();
    if (!descriptor || truckLocationSavingKey) return;

    let truckLocation;
    try {
      truckLocation = options.clear
        ? { x: null, y: null }
        : {
            x: readCoordinate(controls.xInput, "X"),
            y: readCoordinate(controls.yInput, "Y"),
          };
      if ((truckLocation.x === null) !== (truckLocation.y === null)) {
        throw new Error("Enter both Truck location X and Y, or clear both.");
      }
    } catch (error) {
      controls.coordinateStatus.textContent = error.message;
      controls.coordinateStatus.dataset.state = "error";
      return;
    }

    truckLocationSavingKey = descriptor.key;
    controls.saveButton.disabled = true;
    controls.clearButton.disabled = true;
    controls.xInput.disabled = true;
    controls.yInput.disabled = true;
    controls.coordinateStatus.textContent = options.clear
      ? "Clearing truck location…"
      : "Saving truck location…";
    controls.coordinateStatus.dataset.state = "loading";
    const traceId = telemetry?.createTraceId();
    let completed = false;

    try {
      const saved = await cloud.updateSessionTruckLocation(descriptor, truckLocation);
      dashboardSessions.set(saved.key, {
        ...dashboardSessions.get(saved.key),
        ...saved,
      });
      completed = true;
      setStatus(
        options.clear
          ? `Cleared Truck location for ${descriptor.label}.`
          : `Saved Truck location for ${descriptor.label}.`,
      );
      telemetry?.event(
        "dashboard.session.truck_location.updated",
        { action: options.clear ? "clear" : "save", status: "success" },
        { traceId },
      );
    } catch (error) {
      controls.coordinateStatus.textContent = describeError(error);
      controls.coordinateStatus.dataset.state = "error";
      telemetry?.event(
        "dashboard.session.truck_location.failed",
        {
          errorCode: telemetry?.safeErrorCode(error, "truck_location_update_failed"),
          status: "failed",
        },
        { traceId, immediate: true },
      );
    } finally {
      truckLocationSavingKey = null;
      if (completed) {
        renderDashboard();
      } else {
        controls.saveButton.disabled = false;
        controls.clearButton.disabled = false;
        controls.xInput.disabled = false;
        controls.yInput.disabled = false;
      }
    }
  }

  function createPhotoCard(photo, version) {
    const card = document.createElement("article");
    const button = document.createElement("button");
    const frame = document.createElement("div");
    const image = new Image();
    const badges = document.createElement("span");
    const meta = document.createElement("span");
    const time = document.createElement("strong");

    card.className = "photo-card";
    button.className = "photo-open";
    button.type = "button";
    button.setAttribute("aria-label", `Open photo from ${formatDateTime(photo)}`);
    frame.className = "photo-frame";
    image.alt = "";
    image.loading = "lazy";
    meta.className = "photo-meta";
    time.textContent = formatTime(photo);

    // Only a flagged photo earns a badge. A grid where every card is labelled
    // "Kept" spends the reader's attention without telling them anything, and
    // the people count and file size are already in the photo viewer.
    frame.append(image);
    badges.className = "photo-badges";
    if (isGpsDiscrepant(photo)) {
      const locationBadge = document.createElement("span");
      locationBadge.className = "photo-badge";
      locationBadge.dataset.flagged = "true";
      locationBadge.dataset.kind = "location";
      locationBadge.textContent = "GPS discrepancy";
      badges.append(locationBadge);
    }
    if (data.isFlagged(photo)) {
      const reviewBadge = document.createElement("span");
      reviewBadge.className = "photo-badge";
      reviewBadge.dataset.flagged = "true";
      reviewBadge.dataset.kind = "review";
      reviewBadge.textContent = reviewLabel(photo);
      badges.append(reviewBadge);
    }
    if (badges.children.length > 0) {
      frame.append(badges);
    }
    meta.append(time);
    button.append(frame, meta);
    button.addEventListener("click", () => openPhoto(photo));
    card.append(button);

    loadImage(image, photo, version);
    return card;
  }

  function renderPhotos(view) {
    renderVersion += 1;
    const version = renderVersion;
    const mode = filter.value;
    const visible = scopedPhotos(view)
      .filter((photo) => {
        if (mode === "flagged") {
          return data.isFlagged(photo);
        }
        if (mode === "location-flagged") {
          return isGpsDiscrepant(photo);
        }
        if (mode === "kept") {
          return !data.isFlagged(photo) && !isGpsDiscrepant(photo);
        }
        return true;
      })
      .sort((left, right) => photoTimeMs(right) - photoTimeMs(left));

    library.replaceChildren();

    if (visible.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty-library";
      empty.textContent =
        photos.length === 0
          ? "No reviewed photos have reached Firebase yet. A complete Gemini batch contains eight photos."
          : "No photos match this filter in the selected session.";
      library.append(empty);
    } else {
      const grid = document.createElement("div");
      grid.className = "photo-grid";
      visible.forEach((photo) => grid.append(createPhotoCard(photo, version)));
      library.append(grid);
    }

    // A failed page keeps its own error on the status line rather than being
    // overwritten by a photo tally the dashboard could not load.
    if (!photoLoadFailed) {
      const scoped = scopedPhotos(view).length;
      setStatus(
        visible.length === scoped
          ? plural(visible.length, "photo")
          : `${visible.length} of ${plural(scoped, "photo")}`,
      );
    }
    loadMoreRow.hidden = photoLoadFailed || !hasMore;
  }

  async function loadPhotos({ reset = false } = {}) {
    if (!signedInUser || loading) {
      return;
    }

    loading = true;
    const startedAt = performance.now();
    const traceId = telemetry?.createTraceId();
    loadMoreButton.disabled = true;
    setStatus(reset ? "Loading your cloud photos…" : "Loading more photos…", "loading");
    setLoadMoreBusy(true);
    telemetry?.event(
      "dashboard.load.started",
      { photoCount: photos.length, online: navigator.onLine !== false },
      { traceId },
    );

    try {
      const page = await cloud.getPhotosPage({ pageSize: 48, after: reset ? null : after });
      const entries = reset ? page.photos : [...photos, ...page.photos];
      photos = [...new Map(entries.map((photo) => [photo.id, photo])).values()];
      photoLoadFailed = false;
      after = page.after;
      hasMore = page.hasMore;
      renderDashboard();
      telemetry?.event(
        "dashboard.load.completed",
        {
          durationMs: performance.now() - startedAt,
          photoCount: photos.length,
          status: "success",
        },
        { traceId },
      );
    } catch (error) {
      photoLoadFailed = true;
      setStatus(describeError(error), "error");
      loadMoreRow.hidden = true;
      telemetry?.event(
        "dashboard.load.failed",
        {
          durationMs: performance.now() - startedAt,
          errorCode: telemetry.safeErrorCode(error, "dashboard_load_failed"),
          status: "failed",
          online: navigator.onLine !== false,
        },
        { traceId, immediate: true },
      );
    } finally {
      loading = false;
      loadMoreButton.disabled = false;
      setLoadMoreBusy(false);
    }
  }

  function setSignedInUser(user) {
    signedInUser = user || null;
    authGate.hidden = Boolean(user);
    workspace.hidden = !user;
    toolbar.hidden = !user;
    library.hidden = !user;
    signOutButton.hidden = !user;
    accountName.textContent = user?.email || "";

    if (!user) {
      photos = [];
      after = null;
      hasMore = false;
      attendance = [];
      dashboardSessions = new Map();
      attendanceLoadError = null;
      photoLoadFailed = false;
      selection.locationKey = null;
      selection.dateKey = null;
      selection.sessionId = "all";
      attendanceWorkerFilter.value = "all";
      updateAttendanceWorkerOptions([]);
      library.replaceChildren();
      locationOptions.replaceChildren();
      dateOptions.replaceChildren();
      sessionOptions.replaceChildren();
      attendanceList.replaceChildren();
      scopeBreadcrumb.textContent = "";
      sessionActions.hidden = true;
      presentWorkerCount.textContent = "0";
      attendanceCheckinCount.textContent = "0";
      attendanceStatus.textContent = "";
      attendanceStatus.dataset.state = "idle";
      loadMoreRow.hidden = true;
      revokePhotoUrls();
      setStatus("");
    }
  }

  signInButton.addEventListener("click", async () => {
    signInButton.disabled = true;
    setStatus("Opening Google sign-in…");
    try {
      await cloud.signIn();
    } catch (error) {
      if (error?.code !== "auth/popup-closed-by-user" && error?.code !== "auth/cancelled-popup-request") {
        setStatus(describeError(error), "error");
        telemetry?.event(
          "cloud.auth.failed",
          { errorCode: telemetry.safeErrorCode(error), status: "failed" },
          { immediate: true, dedupeMs: 60000 },
        );
      }
    } finally {
      signInButton.disabled = false;
    }
  });

  signOutButton.addEventListener("click", () => {
    cloud.signOut().catch((error) => {
      setStatus(describeError(error), "error");
      telemetry?.event(
        "cloud.auth.failed",
        { errorCode: telemetry.safeErrorCode(error), status: "failed" },
        { immediate: true, dedupeMs: 60000 },
      );
    });
  });
  loadMoreButton.addEventListener("click", () => loadPhotos());
  filter.addEventListener("change", renderDashboard);
  attendanceWorkerFilter.addEventListener("change", renderDashboard);
  attendanceRefresh.addEventListener("click", loadAttendance);
  sessionRenameButton.addEventListener("click", () => openRenameDialog());
  sessionDeleteButton.addEventListener("click", () => deleteSelectedSession());
  sessionRenameForm.addEventListener("submit", renameSelectedSession);
  sessionRenameCancel.addEventListener("click", closeRenameDialog);
  themeToggle?.addEventListener("click", toggleTheme);
  window.addEventListener("pagehide", revokePhotoUrls);

  applyTheme(readStoredTheme());

  // While no theme is pinned, the button keeps naming the opposite of whatever
  // the operating system is showing right now.
  window
    .matchMedia?.("(prefers-color-scheme: dark)")
    .addEventListener?.("change", () => applyTheme(readStoredTheme()));

  if (!cloud || !data) {
    signInButton.disabled = true;
    setStatus("The Firebase client could not be loaded.", "error");
    telemetry?.event(
      "client.error",
      { errorCode: "firebase_client_missing" },
      { immediate: true },
    );
    return;
  }

  cloud.subscribeAuth((user, error) => {
    if (error) {
      setSignedInUser(null);
      setStatus(describeError(error), "error");
      telemetry?.event(
        "cloud.auth.failed",
        { errorCode: telemetry.safeErrorCode(error), status: "failed" },
        { immediate: true, dedupeMs: 60000 },
      );
      return;
    }

    const changedAccount = user?.uid !== signedInUser?.uid;
    setSignedInUser(user);
    telemetry?.event("cloud.auth.state", {
      status: user ? "signed_in" : "signed_out",
    });
    if (user && changedAccount) {
      revokePhotoUrls();
      loadPhotos({ reset: true });
      loadAttendance();
      loadDashboardSessions();
    }
  });
})();
