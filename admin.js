(function initializeAdminDashboard() {
  "use strict";

  const cloud = window.StampNoteFirebase;
  const data = window.StampNoteCloudData;
  const telemetry = window.StampNoteObservability;
  const weather = window.StampNoteWeather;
  const adminScope = window.StampNoteAdminScope;
  const operationsData = window.StampNoteOperationsData?.createOperationsDataService(cloud);
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
  const streetOptions = document.querySelector("#street-options");
  const locationOptions = document.querySelector("#location-options");
  const dateOptions = document.querySelector("#date-options");
  const datePicker = document.querySelector("#date-picker");
  const dateHint = document.querySelector("#date-hint");
  const dateSearch = document.querySelector("#date-search");
  const dateSearchToggle = document.querySelector("#date-search-toggle");
  const dateSearchLabel = document.querySelector("#date-search-label");
  const sessionOptions = document.querySelector("#session-options");
  const scopeBreadcrumb = document.querySelector("#scope-breadcrumb");
  const sessionActions = document.querySelector("#session-actions");
  const sessionTruckLocation = document.querySelector("#session-truck-location");
  const sessionWeather = document.querySelector("#session-weather");
  const sessionRenameButton = document.querySelector("#session-rename");
  const locationDeleteButton = document.querySelector("#location-delete");
  const dateDeleteButton = document.querySelector("#date-delete");
  const sessionDeleteButton = document.querySelector("#session-delete");
  const sessionRenameDialog = document.querySelector("#session-rename-dialog");
  const sessionRenameForm = document.querySelector("#session-rename-form");
  const sessionRenameInput = document.querySelector("#session-rename-input");
  const sessionRenameError = document.querySelector("#session-rename-error");
  const sessionRenameCancel = document.querySelector("#session-rename-cancel");
  const sessionRenameSave = document.querySelector("#session-rename-save");
  const locationStep = document.querySelector("#location-step");
  const dateStep = document.querySelector("#date-step");
  const sessionStep = document.querySelector("#session-step");
  const detailColumn = document.querySelector("#detail-column");
  const sessionFacts = document.querySelector("#session-facts");
  const photosPanel = document.querySelector("#photos-panel");
  const scopeGuidanceLine = document.querySelector("#scope-guidance");
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
  // A day's weather at a site, asked for once. Three sessions read the same
  // answer, and the sky over a past day does not change.
  const weatherDays = new Map();
  // Session keys already written this visit, so a day is never saved twice.
  const weatherWrites = new Set();

  // A day is read as three working sessions so a location's morning crew is
  // never mixed with the people who arrived after lunch.
  const SESSIONS = data?.SESSION_DEFINITIONS || [];

  // The rail lists the days a location has worked, and that list only ever grows.
  // Only the newest few are worth a button; the calendar beside them reaches the
  // rest without the rail growing a row taller for every day that passes.
  const RECENT_DATE_LIMIT = 6;
  // Nothing is chosen until it is chosen. A null session means the fourth step
  // has not been answered yet; "all" is the reader having picked "Whole day".
  const selection = { streetKey: null, locationKey: null, dateKey: null, sessionId: null };

  function readNavigationRequest(location = window.location) {
    return adminScope.readNavigationRequest(location);
  }

  const navigationRequest = readNavigationRequest();
  let navigationApplied = false;
  let navigationRevealed = false;

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
    return adminScope.describeError(error);
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
    return adminScope.workerInitials(worker);
  }

  function summarizeAttendance(entries) {
    return adminScope.summarizeAttendance(entries);
  }

  function photoTimeMs(photo) {
    return adminScope.photoTimeMs(photo);
  }

  function sessionDefinitionFor(value) {
    return data.sessionDefinitionFor(value);
  }

  function countWorkers(entries) {
    return adminScope.countWorkers(entries);
  }

  function plural(count, noun) {
    return adminScope.plural(count, noun);
  }

  function buildScope() {
    return adminScope.buildScope({
      photos,
      attendance,
      data,
      dashboardSessions,
      sessionDefinitions: SESSIONS,
    });
  }

  function resolveSelection(scope) {
    return adminScope.resolveSelection(scope, selection);
  }

  function applyNavigationRequest(scope) {
    if (navigationApplied) return;
    if (adminScope.applyNavigationRequest(scope, navigationRequest, selection)) {
      navigationApplied = true;
    }
  }

  function revealNavigationTarget(view) {
    if (navigationRevealed || !navigationApplied || !isScopeChosen(view)) return;
    const target = document.getElementById(navigationRequest.section);
    if (!target) return;
    navigationRevealed = true;
    window.requestAnimationFrame?.(() => {
      target.scrollIntoView?.({ behavior: "smooth", block: "start" });
      target.setAttribute("tabindex", "-1");
      target.focus?.({ preventScroll: true });
    });
  }

  // The detail side is a reward for finishing the rail: a street, an address, a
  // date, and an answer to the fourth step, whether one session or the day.
  function isScopeChosen(view) {
    return adminScope.isScopeChosen(view, selection.sessionId);
  }

  function scopeGuidance(view, scope) {
    return adminScope.scopeGuidance(view, scope);
  }

  function scopedEntries(view) {
    return adminScope.scopedEntries(view);
  }

  function scopedPhotos(view) {
    return adminScope.scopedPhotos(view);
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
    const reviewFlag = document.createElement("span");

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
    if (worker.flaggedCheckIns > 0) {
      row.dataset.reviewRequired = "true";
      reviewFlag.className = "attendance-review-flag";
      reviewFlag.textContent = `${plural(worker.flaggedCheckIns, "manual check-in")} · Needs review`;
      timing.append(reviewFlag);
    }
    row.append(avatar, identity, timing);
    return row;
  }

  function createScopeOption({ title, detail, selected, onSelect, severity, icon, automation = {} }) {
    const option = document.createElement("button");
    const name = document.createElement("strong");
    const meta = document.createElement("span");

    option.type = "button";
    option.className = "scope-option";
    option.dataset.selected = String(Boolean(selected));
    if (severity) option.dataset.severity = severity;
    Object.entries(automation).forEach(([name, value]) => {
      if (value !== undefined && value !== null) option.dataset[name] = String(value);
    });
    option.setAttribute("aria-pressed", String(Boolean(selected)));
    name.textContent = title;
    meta.textContent = detail;
    option.append(name, meta);
    if (icon) {
      const glyph = document.createElement("span");
      glyph.className = "scope-option-icon";
      glyph.setAttribute("aria-hidden", "true");
      glyph.textContent = icon;
      option.append(glyph);
    }
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
      // The two empty fields say this themselves; a line of prose under them
      // only repeated their labels.
      return { message: "", state: "idle" };
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
    // No visible legend: the pane is already the session's, and the two labelled
    // fields say what they are. The name stays on the form for assistive tech.
    form.setAttribute("aria-label", `Truck location for ${session.label} session`);

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
    coordinateStatus.textContent = busy ? "Saving…" : summary.message;
    coordinateStatus.dataset.state = busy ? "loading" : summary.state;
    coordinateStatus.hidden = !coordinateStatus.textContent;
    coordinateStatus.setAttribute("role", "status");
    coordinateStatus.setAttribute("aria-live", "polite");

    formActions.className = "truck-location-actions";
    saveButton.className = "button button-primary truck-location-save";
    saveButton.type = "submit";
    saveButton.textContent = "Save";
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

    fieldset.append(xLabel, yLabel);
    formActions.append(saveButton, clearButton);
    form.append(fieldset, coordinateStatus, formActions);
    return form;
  }

  // A row, not a card. Rename, delete and the truck coordinates belong to the
  // session being looked at, so they are drawn once in the detail pane rather
  // than three times over inside the rail — which is what made a step holding
  // three fixed periods want seven hundred pixels of a sticky column.
  function createSessionScopeOption(view, session) {
    const range = sessionRange(session);
    const summary = sessionWeatherSummary(view, session);
    return createScopeOption({
      title: range ? `${session.label} · ${range}` : session.label,
      detail: [
        plural(countWorkers(session.entries), "worker"),
        plural(session.photos.length, "photo"),
        describeSessionWeather(summary),
      ]
        .filter(Boolean)
        .join(" · "),
      icon: summary && weather ? weather.weatherIcon(summary) : null,
      selected: session.id === view.session?.id,
      // A stormy or wet session is marked in the rail, so a reader scanning the
      // day sees which one to ask about before opening it.
      severity: weather?.delaysLikely(summary) ? summary.severity : null,
      automation: {
        scopeKind: "session",
        locationKey: view.location?.locationKey,
        dateKey: view.dateGroup?.dateKey,
        sessionId: session.id,
        weather: summary?.severity || null,
      },
      onSelect: () => {
        selection.sessionId = session.id;
        renderDashboard();
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Weather
  // ---------------------------------------------------------------------------

  function weatherDayKey(location, dateGroup) {
    return `${location?.locationKey || ""}|${dateGroup?.dateKey || ""}`;
  }

  // Asks the sky about one site on one day, once. The rail is drawn again when
  // the answer lands, so nothing waits on the network to appear.
  // A session's weather is final once its hours have passed and it has been
  // written down. Anything else is still worth asking about.
  function sessionWeatherIsFinal(dateGroup, session) {
    const stored = session?.weather;
    if (!stored) return false;
    if (!stored.provisional) return true;
    // A provisional reading was partly forecast; it stands only until the
    // session's own hours are over.
    return !weather.sessionWindowEnded({ dateKey: dateGroup.dateKey, toHour: session.toHour });
  }

  function ensureDayWeather(location, dateGroup) {
    if (!weather || !location?.point || !dateGroup) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateGroup.dateKey)) return null;

    // Every session already written down and final: the day needs no network.
    if ((dateGroup.sessions || []).every((session) => sessionWeatherIsFinal(dateGroup, session))) {
      return null;
    }

    const key = weatherDayKey(location, dateGroup);
    const cached = weatherDays.get(key);
    if (cached) return cached;

    const entry = { status: "loading", rows: [] };
    weatherDays.set(key, entry);
    weather
      .fetchDayWeather({
        latitude: location.point.latitude,
        longitude: location.point.longitude,
        dateKey: dateGroup.dateKey,
      })
      .then(async (rows) => {
        entry.status = "ready";
        entry.rows = rows;
        renderDashboard();
        await recordDayWeather(location, dateGroup, rows);
      })
      .catch((error) => {
        entry.status = "failed";
        entry.error = error;
        telemetry?.event(
          "dashboard.weather.failed",
          {
            errorCode: telemetry.safeErrorCode(error, "weather_unavailable"),
            status: "failed",
          },
          { dedupeMs: 300000 },
        );
        renderDashboard();
      });
    return entry;
  }

  function sessionWeatherSummary(view, session) {
    if (!weather) return null;
    // What was written down at the time is the record. Only a session without
    // one is read from the day just fetched.
    const stored = weather.restoreSessionWeather(session?.weather);
    if (stored) return stored;

    const entry = weatherDays.get(weatherDayKey(view.location, view.dateGroup));
    if (!entry || entry.status !== "ready") return null;
    return weather.summarizeSessionWeather(entry.rows, {
      dateKey: view.dateGroup.dateKey,
      fromHour: session.fromHour,
      toHour: session.toHour,
    });
  }

  // Writes a day's readings against the sessions they belong to, so the next
  // reader — and the next device — sees the same weather without asking again.
  async function recordDayWeather(location, dateGroup, rows) {
    if (!cloud?.updateSessionWeather || !signedInUser || rows.length === 0) return;

    const pending = (dateGroup.sessions || []).filter(
      (session) => !sessionWeatherIsFinal(dateGroup, session) && !weatherWrites.has(session.key),
    );
    if (pending.length === 0) return;

    let wrote = false;
    for (const session of pending) {
      const summary = weather.summarizeSessionWeather(rows, {
        dateKey: dateGroup.dateKey,
        fromHour: session.fromHour,
        toHour: session.toHour,
      });
      // A session the service has no hours for is not a session that was fine,
      // so nothing is written for it. The cost it carries is written with it, so
      // a stored reading never has to be re-judged.
      if (summary.severity === "unknown") continue;

      weatherWrites.add(session.key);
      try {
        await cloud.updateSessionWeather(
          {
            location: location.location,
            locationKey: location.locationKey,
            dateKey: dateGroup.dateKey,
            sessionId: session.id,
          },
          {
            ...summary,
            provisional: !weather.sessionWindowEnded({
              dateKey: dateGroup.dateKey,
              toHour: session.toHour,
            }),
            recordedAtMs: Date.now(),
          },
        );
        wrote = true;
      } catch (error) {
        // A reading that could not be saved is still on screen; it will be
        // written the next time the day is opened.
        weatherWrites.delete(session.key);
        telemetry?.event(
          "dashboard.weather.save_failed",
          {
            errorCode: telemetry.safeErrorCode(error, "weather_save_failed"),
            status: "failed",
          },
          { dedupeMs: 300000 },
        );
      }
    }

    if (wrote) await loadDashboardSessions();
  }

  // Beside the session in the rail: short enough to sit under the counts.
  function describeSessionWeather(summary) {
    return weather ? weather.describeSessionWeather(summary) : "";
  }

  function renderSessionWeather(view) {
    if (!sessionWeather) return;
    sessionWeather.replaceChildren();

    const entry = weatherDays.get(weatherDayKey(view.location, view.dateGroup));
    const summary = view.session ? sessionWeatherSummary(view, view.session) : null;
    const failed = entry?.status === "failed";
    // A reading — written down or just fetched — is shown. A failure says so.
    // Anything else is still on its way, and the panel stays out of the way.
    const hidden = !view.session || (!summary && !failed);
    sessionWeather.hidden = hidden;
    if (hidden) return;

    // A reading that was written down stands even if today's lookup failed.
    const unavailable = failed && !summary;
    const severity = unavailable ? "unavailable" : summary?.severity || "unknown";

    const row = document.createElement("div");
    row.className = "session-weather-row";
    row.dataset.severity = severity;

    const icon = document.createElement("span");
    icon.className = "weather-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = unavailable ? "—" : weather.weatherIcon(summary);

    // "Drizzle, low impact": what it was and what it cost, in one glance.
    const badge = document.createElement("span");
    badge.className = "weather-badge";
    badge.dataset.severity = severity;
    badge.textContent = unavailable
      ? "Weather unavailable"
      : describeSessionWeather(summary) || "No record";
    row.append(icon, badge);

    // A warning only when the weather earns one, and in as few words.
    if (summary?.delayNote) {
      const note = document.createElement("span");
      note.className = "weather-delay";
      note.dataset.severity = summary.severity;
      note.textContent = summary.delayNote;
      row.append(note);
    }
    sessionWeather.append(row);

    // The figures behind the statement, for a reader who wants to check it.
    const figures = weather.describeWeatherFigures(summary);
    if (figures) {
      const detail = document.createElement("p");
      detail.className = "weather-figures";
      detail.textContent = figures;
      sessionWeather.append(detail);
    }
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
    streetOptions.replaceChildren();
    locationOptions.replaceChildren();
    dateOptions.replaceChildren();
    sessionOptions.replaceChildren();

    if (locationStep) locationStep.hidden = !view.street;
    if (dateStep) dateStep.hidden = !view.location;
    if (sessionStep) sessionStep.hidden = !view.dateGroup;

    if (scope.length === 0) {
      streetOptions.append(createScopeEmpty("No streets have reported yet."));
      renderDatePicker([], view);
      return;
    }

    const streets = adminScope.groupLocationsByStreet(scope);
    streets.forEach((street) => {
      const dayCount = new Set(
        street.locations.flatMap((location) => location.dates.map((date) => date.dateKey)),
      ).size;
      streetOptions.append(
        createScopeOption({
          title: street.streetName,
          detail: `${street.locations.length} ${
            street.locations.length === 1 ? "address" : "addresses"
          } · ${plural(dayCount, "day")}`,
          selected: street.streetKey === view.street?.streetKey,
          automation: { scopeKind: "street", streetKey: street.streetKey },
          onSelect: () => {
            selection.streetKey = street.streetKey;
            selection.locationKey = null;
            selection.dateKey = null;
            selection.sessionId = null;
            renderDashboard();
          },
        }),
      );
    });

    if (!view.street) return;

    view.street.locations.forEach((location) => {
      locationOptions.append(
        createScopeOption({
          title: location.location,
          detail: [
            plural(location.dates.length, "day"),
            plural(location.photos.length, "photo"),
          ]
            .filter(Boolean)
            .join(" · "),
          selected: location.locationKey === view.location?.locationKey,
          automation: { scopeKind: "location", locationKey: location.locationKey },
          onSelect: () => {
            selection.streetKey = location.streetKey;
            selection.locationKey = location.locationKey;
            selection.dateKey = null;
            selection.sessionId = null;
            renderDashboard();
          },
        }),
      );
    });

    const dates = view.location?.dates || [];
    renderDatePicker(dates, view);

    // A step that is not on screen has nothing to say.
    if (!view.location) return;

    // The selected day keeps its button even when it is old enough to have
    // fallen out of the recent few, so the rail never shows nothing chosen.
    const recent = dates.slice(0, RECENT_DATE_LIMIT);
    const selectedDate = dates.find((entry) => entry.dateKey === view.dateGroup?.dateKey);
    if (selectedDate && !recent.includes(selectedDate)) {
      recent.push(selectedDate);
    }

    recent.forEach((dateGroup) => {
      dateOptions.append(
        createScopeOption({
          title: formatDate(dateGroup.dateKey),
          detail: `${plural(countWorkers(dateGroup.entries), "worker")} · ${plural(dateGroup.photos.length, "photo")}`,
          selected: dateGroup.dateKey === view.dateGroup?.dateKey,
          automation: {
            scopeKind: "date",
            locationKey: view.location.locationKey,
            dateKey: dateGroup.dateKey,
          },
          onSelect: () => selectDate(dateGroup.dateKey),
        }),
      );
    });

    if (!view.dateGroup) return;

    sessionOptions.append(
      createScopeOption({
        title: "Whole day",
        detail: `${plural(countWorkers(view.dateGroup.entries), "worker")} · ${plural(view.dateGroup.photos.length, "photo")}`,
        selected: selection.sessionId === "all",
        automation: {
          scopeKind: "session",
          locationKey: view.location.locationKey,
          dateKey: view.dateGroup.dateKey,
          sessionId: "all",
        },
        onSelect: () => {
          selection.sessionId = "all";
          renderDashboard();
        },
      }),
    );

    view.dateGroup.sessions.forEach((session) => {
      sessionOptions.append(createSessionScopeOption(view, session));
    });
  }

  function selectDate(dateKey) {
    selection.dateKey = dateKey;
    selection.sessionId = null;
    renderDashboard();
  }

  // Dates arrive newest first, and only the real calendar ones can be typed into
  // a date field — a photograph with an unreadable timestamp is grouped under
  // "unknown-date" and stays reachable through its button alone.
  function renderDatePicker(dates, view) {
    if (!datePicker) return;

    const calendarDates = dates
      .map((dateGroup) => dateGroup.dateKey)
      .filter((dateKey) => /^\d{4}-\d{2}-\d{2}$/.test(dateKey));
    const selectedKey = view.dateGroup?.dateKey || "";

    datePicker.disabled = calendarDates.length === 0;
    datePicker.value = /^\d{4}-\d{2}-\d{2}$/.test(selectedKey) ? selectedKey : "";
    if (calendarDates.length > 0) {
      datePicker.min = calendarDates[calendarDates.length - 1];
      datePicker.max = calendarDates[0];
    } else {
      datePicker.removeAttribute?.("min");
      datePicker.removeAttribute?.("max");
    }

    if (!dateHint) return;
    if (dates.length === 0) {
      dateHint.textContent = "Pick a location first.";
      dateHint.dataset.state = "idle";
      return;
    }
    const hidden = Math.max(0, dates.length - RECENT_DATE_LIMIT);
    dateHint.textContent = hidden
      ? `${plural(dates.length, "day")} recorded — the newest are below.`
      : `${plural(dates.length, "day")} recorded.`;
    dateHint.dataset.state = "idle";
  }

  // Opening it moves focus into the field, because the press was a request for
  // the calendar rather than for a wider step.
  function setDateSearchOpen(open) {
    if (!dateSearch) return;
    dateSearch.hidden = !open;
    dateSearchToggle?.setAttribute?.("aria-expanded", String(Boolean(open)));
    const label = open ? "Hide the date jump" : "Jump to a date";
    dateSearchToggle?.setAttribute?.("title", label);
    if (dateSearchLabel) dateSearchLabel.textContent = label;
    if (open) datePicker?.focus?.();
  }

  function handleDatePicked() {
    const chosen = String(datePicker?.value || "");
    if (!chosen) return;

    const view = resolveSelection(buildScope());
    const match = (view.location?.dates || []).find((entry) => entry.dateKey === chosen);
    if (!match) {
      // Left selected rather than reverted, so the reader can see which day they
      // asked for while being told there is nothing under it.
      if (dateHint) {
        dateHint.textContent = `No check-ins or photos on ${formatDate(chosen)}.`;
        dateHint.dataset.state = "error";
      }
      return;
    }

    selectDate(match.dateKey);
  }

  function renderBreadcrumb(view, scope) {
    if (!isScopeChosen(view)) {
      scopeBreadcrumb.textContent = scopeGuidance(view, scope);
      return;
    }
    const parts = [view.street.streetName, view.location.location, formatDate(view.dateGroup.dateKey)];
    parts.push(view.session ? `${view.session.label} session` : "Whole day");
    scopeBreadcrumb.textContent = parts.join(" · ");
  }

  function sessionDescriptorFor(location, dateGroup, session) {
    return adminScope.sessionDescriptorFor(location, dateGroup, session);
  }

  function sessionDescriptor(view) {
    return sessionDescriptorFor(view.location, view.dateGroup, view.session);
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
    // Each level can only be deleted once something is chosen at it.
    setDeleteButtonState(locationDeleteButton, scopeDescriptor(view, "location"));
    setDeleteButtonState(dateDeleteButton, scopeDescriptor(view, "date"));
    setDeleteButtonState(sessionDeleteButton, scopeDescriptor(view, "session"));
  }

  function setDeleteButtonState(button, descriptor) {
    if (!button) return;
    button.disabled = sessionActionBusy || !descriptor;
    if (descriptor) {
      button.title = `Delete ${descriptor.label}`;
    } else {
      button.removeAttribute?.("title");
    }
  }

  function renderTruckLocation(view) {
    if (!sessionTruckLocation) return;

    const descriptor = sessionDescriptor(view);
    sessionTruckLocation.replaceChildren();
    sessionTruckLocation.hidden = !descriptor;
    if (!descriptor || !view.session) return;
    sessionTruckLocation.append(createTruckLocationForm(descriptor, view.session));
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

  // The photographs, the attendance and the truck fields all belong to one
  // chosen session, so none of them is drawn until the rail has been answered.
  function renderDetailReveal(view, scope) {
    const chosen = isScopeChosen(view);
    if (sessionFacts) sessionFacts.hidden = !chosen;
    if (detailColumn) detailColumn.hidden = !chosen;
    if (photosPanel) photosPanel.hidden = !chosen;
    if (scopeGuidanceLine) {
      // Drawn only when it has something to say, so the dashed frame never
      // stands empty where a sentence used to be.
      const guidance = chosen ? "" : scopeGuidance(view, scope);
      scopeGuidanceLine.hidden = !guidance;
      scopeGuidanceLine.textContent = guidance;
    }
    return chosen;
  }

  function renderDashboard() {
    const scope = buildScope();
    applyNavigationRequest(scope);
    const view = resolveSelection(scope);
    ensureDayWeather(view.location, view.dateGroup);
    renderScopeRail(scope, view);
    renderBreadcrumb(view, scope);
    renderSessionActions(view);
    if (!renderDetailReveal(view, scope)) {
      // Nothing below is on screen, so nothing below needs building.
      clearDetail();
      return;
    }
    renderSessionWeather(view);
    renderTruckLocation(view);
    renderAttendance(view);
    renderPhotos(view);
    revealNavigationTarget(view);
  }

  // An unanswered rail leaves no stale session's photographs or totals behind.
  function clearDetail() {
    // The guidance panel is saying what to do next, so the status line does not
    // repeat it, and it stops claiming to be loading once the fetch is done.
    if (!photoLoadFailed && !loading) setStatus("");
    if (sessionWeather) {
      sessionWeather.replaceChildren();
      sessionWeather.hidden = true;
    }
    if (sessionTruckLocation) {
      sessionTruckLocation.replaceChildren();
      sessionTruckLocation.hidden = true;
    }
    attendanceList.replaceChildren();
    presentWorkerCount.textContent = "0";
    attendanceCheckinCount.textContent = "0";
    library.replaceChildren();
    library.hidden = true;
    toolbar.hidden = true;
    loadMoreRow.hidden = true;
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

  // The three levels differ only in how much they take and what is left selected
  // afterwards, so they are one path rather than three near-copies. `node` is the
  // location, day or session being removed, and carries the check-ins and photos
  // that belong to it.
  function scopeDescriptor(view, level) {
    if (!view.location) return null;
    const locationKeys = [view.location.locationKey, ...(view.location.aliasKeys || [])];
    if (level === "location") {
      return {
        level,
        node: view.location,
        label: view.location.location,
        streetKey: view.location.streetKey,
        location: view.location.location,
        locationKey: view.location.locationKey,
        locationKeys,
      };
    }
    if (!view.dateGroup) return null;
    if (level === "date") {
      return {
        level,
        node: view.dateGroup,
        label: `${formatDate(view.dateGroup.dateKey)} at ${view.location.location}`,
        streetKey: view.location.streetKey,
        location: view.location.location,
        locationKey: view.location.locationKey,
        locationKeys,
        dateKey: view.dateGroup.dateKey,
      };
    }
    const session = sessionDescriptor(view);
    return session
      ? { ...session, streetKey: view.location.streetKey, level: "session", locationKeys, node: view.session }
      : null;
  }

  // Said plainly and with the counts, because none of this comes back.
  function describeDeletion(descriptor) {
    return adminScope.describeDeletion(descriptor);
  }

  function selectionAfterDeletion(descriptor) {
    return adminScope.selectionAfterDeletion(descriptor);
  }

  function deletedSessionKeys(descriptor, deleted) {
    return adminScope.deletedSessionKeys(descriptor, deleted);
  }

  async function deleteSelectedScope(level) {
    if (sessionActionBusy) return;
    const descriptor = scopeDescriptor(resolveSelection(buildScope()), level);
    if (!descriptor) return;
    if (!window.confirm?.(describeDeletion(descriptor))) return;

    sessionActionBusy = true;
    refreshSessionControls();
    setStatus(`Deleting ${descriptor.label}…`);
    try {
      const deleted = await cloud.deleteScope({
        location: descriptor.location,
        locationKey: descriptor.locationKey,
        locationKeys: descriptor.locationKeys,
        dateKey: descriptor.dateKey,
        sessionId: descriptor.sessionId,
      });
      // The scope's own rows are dropped alongside the ids the cloud reports, so
      // the rail is right even where the two disagree.
      const attendanceIds = new Set([
        ...descriptor.node.entries.map((entry) => entry.eventId),
        ...(deleted.attendanceEventIds || []),
      ]);
      const photoIds = new Set([
        ...descriptor.node.photos.map((photo) => photo.id),
        ...(deleted.photoIds || []),
      ]);
      attendance = attendance.filter((entry) => !attendanceIds.has(entry.eventId));
      photos = photos.filter((photo) => !photoIds.has(photo.id));
      photoIds.forEach((photoId) => {
        const pendingUrl = photoUrls.get(photoId);
        pendingUrl?.then?.((url) => URL.revokeObjectURL(url)).catch?.(() => {});
        photoUrls.delete(photoId);
      });
      deletedSessionKeys(descriptor, deleted).forEach((key) => dashboardSessions.delete(key));
      Object.assign(selection, selectionAfterDeletion(descriptor));
      renderDashboard();
      setStatus(
        `Deleted ${descriptor.label}: ${plural(deleted.attendanceDeleted, "check-in")} and ${plural(deleted.photoDeleted, "photo")}.`,
      );
      telemetry?.event(`dashboard.${descriptor.level}.deleted`, {
        checkInCount: deleted.attendanceDeleted,
        photoCount: deleted.photoDeleted,
        status: "success",
      });
    } catch (error) {
      setStatus(`${describeError(error)} Deletion may be incomplete; refresh before retrying.`, "error");
      telemetry?.event(
        `dashboard.${descriptor.level}.delete_failed`,
        {
          errorCode: telemetry.safeErrorCode(error, `${descriptor.level}_delete_failed`),
          status: "failed",
        },
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
      controls.coordinateStatus.hidden = false;
      return;
    }

    truckLocationSavingKey = descriptor.key;
    controls.saveButton.disabled = true;
    controls.clearButton.disabled = true;
    controls.xInput.disabled = true;
    controls.yInput.disabled = true;
    controls.coordinateStatus.textContent = options.clear ? "Clearing…" : "Saving…";
    controls.coordinateStatus.dataset.state = "loading";
    controls.coordinateStatus.hidden = false;
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
      controls.coordinateStatus.hidden = false;
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
    // The gallery and its filter were put away while the rail was unanswered;
    // drawing a scope's photographs brings them back.
    toolbar.hidden = false;
    library.hidden = false;
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
      selection.streetKey = null;
      selection.locationKey = null;
      selection.dateKey = null;
      selection.sessionId = null;
      attendanceWorkerFilter.value = "all";
      updateAttendanceWorkerOptions([]);
      library.replaceChildren();
      streetOptions.replaceChildren();
      locationOptions.replaceChildren();
      dateOptions.replaceChildren();
      sessionOptions.replaceChildren();
      attendanceList.replaceChildren();
      scopeBreadcrumb.textContent = "";
      sessionActions.hidden = true;
      // Nothing is selected at any level once the rail is empty, so nothing can
      // be deleted from it either.
      [locationDeleteButton, dateDeleteButton, sessionDeleteButton].forEach((button) =>
        setDeleteButtonState(button, null),
      );
      if (sessionTruckLocation) {
        sessionTruckLocation.replaceChildren();
        sessionTruckLocation.hidden = true;
      }
      if (datePicker) {
        datePicker.value = "";
        datePicker.disabled = true;
      }
      if (dateHint) {
        dateHint.textContent = "";
        dateHint.dataset.state = "idle";
      }
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
  datePicker?.addEventListener("change", handleDatePicked);
  dateSearchToggle?.addEventListener("click", () => setDateSearchOpen(dateSearch?.hidden));
  // Closed is the starting state, set here rather than left to the markup so the
  // button's expanded flag and its name cannot drift from what is on screen.
  setDateSearchOpen(false);
  sessionRenameButton.addEventListener("click", () => openRenameDialog());
  locationDeleteButton?.addEventListener("click", () => deleteSelectedScope("location"));
  dateDeleteButton?.addEventListener("click", () => deleteSelectedScope("date"));
  sessionDeleteButton.addEventListener("click", () => deleteSelectedScope("session"));
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
