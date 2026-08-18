(function initializeCoordinatesWorkspace(globalScope) {
  "use strict";

  const coordinates = globalScope.StampNoteCoordinates;
  if (!coordinates) return;

  const {
    MATCH_THRESHOLD_METERS,
    MAX_GPS_ACCURACY_METERS,
    buildCoordinateSessions,
    compareSessionToTruck,
    sessionRecord,
    sortCoordinateSessions,
  } = coordinates;

  const document = globalScope.document;
  if (!document) return;
  // Other read-only surfaces reuse the session grouping API above without
  // mounting the coordinate workspace itself.
  if (!document.querySelector("#coordinate-session-list")) return;

  const cloud = globalScope.StampNoteFirebase;
  const data = globalScope.StampNoteCloudData;
  const weather = globalScope.StampNoteWeather;
  const telemetry = globalScope.StampNoteObservability;
  const signInButton = document.querySelector("#coordinate-sign-in");
  const signOutButton = document.querySelector("#coordinate-sign-out");
  const authGate = document.querySelector("#coordinate-auth-gate");
  const accountName = document.querySelector("#coordinate-account-name");
  const workspace = document.querySelector("#coordinate-workspace");
  const status = document.querySelector("#coordinate-status");
  const refreshButton = document.querySelector("#coordinate-refresh");
  const dateFilter = document.querySelector("#coordinate-date-filter");
  const locationFilter = document.querySelector("#coordinate-location-filter");
  const sortOrder = document.querySelector("#coordinate-sort-order");
  const clearFilters = document.querySelector("#coordinate-clear-filters");
  const searchToggle = document.querySelector("#coordinate-search-toggle");
  const searchLabel = document.querySelector("#coordinate-search-label");
  const filterBar = document.querySelector("#coordinate-toolbar");
  const resultCount = document.querySelector("#coordinate-result-count");
  const sessionList = document.querySelector("#coordinate-session-list");
  const emptyState = document.querySelector("#coordinate-empty");
  const coordinateData = document.querySelector("#coordinate-data");
  const mapDialog = document.querySelector("#coordinate-map-dialog");
  const mapClose = document.querySelector("#coordinate-map-close");
  const mapTitle = document.querySelector("#coordinate-map-title");
  const mapSummary = document.querySelector("#coordinate-map-summary");
  const mapCanvas = document.querySelector("#coordinate-map-canvas");
  const mapError = document.querySelector("#coordinate-map-error");

  if (
    !signInButton ||
    !signOutButton ||
    !authGate ||
    !workspace ||
    !status ||
    !sessionList ||
    !mapDialog ||
    !mapClose ||
    !mapTitle ||
    !mapSummary ||
    !mapCanvas ||
    !mapError ||
    !data ||
    !cloud
  ) {
    if (status) {
      status.textContent = "Geographic Surveillence could not initialize.";
      status.dataset.state = "error";
    }
    if (signInButton) signInButton.disabled = true;
    return;
  }

  telemetry?.configure({ surface: "coordinates" });

  let signedInUser = null;
  let sessions = [];
  let loading = false;
  let positionMap = null;
  const requestedSessionKey = (() => {
    try {
      return String(new URLSearchParams(globalScope.location?.search || "").get("session") || "").slice(0, 180);
    } catch (error) {
      return "";
    }
  })();
  let requestedSessionRevealed = false;

  function plural(count, noun) {
    return `${count} ${noun}${count === 1 ? "" : "s"}`;
  }

  function setStatus(message, state = "idle") {
    status.textContent = message;
    status.dataset.state = state;
  }

  function describeError(error) {
    if (error?.code === "permission-denied") {
      return "Firebase denied access. Confirm this account can read and update project sessions.";
    }
    return error?.message || "Geographic Surveillence could not be loaded.";
  }

  function formatDate(dateKey) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey || "")) return "Unknown date";
    const [year, month, day] = dateKey.split("-").map(Number);
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      weekday: "short",
    }).format(new Date(year, month - 1, day));
  }

  function formatTime(atMs, includeSeconds = false) {
    const date = new Date(Number(atMs));
    if (Number.isNaN(date.getTime())) return "Unknown";
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      ...(includeSeconds ? { second: "2-digit" } : {}),
    }).format(date);
  }

  function sessionTimeRange(session) {
    if (!session.firstAtMs || !session.lastAtMs) return "No recorded time";
    const first = formatTime(session.firstAtMs);
    const last = formatTime(session.lastAtMs);
    return first === last ? first : `${first} – ${last}`;
  }

  function appendCell(row, value, field) {
    const cell = document.createElement("td");
    const output = document.createElement("output");
    output.textContent = String(value);
    output.dataset.rpaField = field;
    output.dataset.value = String(value);
    cell.append(output);
    row.append(cell);
    return cell;
  }

  function createReadingTable(session) {
    const host = document.createElement("div");
    host.className = "coordinate-readings";
    host.setAttribute("aria-label", `GPS readings for ${session.sessionLabel} on ${session.dateKey}`);

    if (session.readings.length === 0) {
      const empty = document.createElement("p");
      empty.className = "coordinate-readings-empty";
      empty.textContent = "No automatic GPS coordinates were recorded in this session.";
      host.append(empty);
      return host;
    }

    const table = document.createElement("table");
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    ["Captured", "Source", "X · longitude", "Y · latitude", "Accuracy", "Use"].forEach((label) => {
      const heading = document.createElement("th");
      heading.scope = "col";
      heading.textContent = label;
      headRow.append(heading);
    });
    head.append(headRow);
    const referenceBody = document.createElement("tbody");
    const secondaryBody = document.createElement("tbody");
    const indexedReadings = session.readings.map((reading, index) => ({ reading, index }));
    const referenceEntry =
      indexedReadings.find((entry) => entry.reading.reference) || indexedReadings[0];
    const secondaryEntries = indexedReadings.filter((entry) => entry !== referenceEntry);
    let secondaryVisible = false;
    let expandButton = null;

    referenceBody.className = "coordinate-readings-reference";
    secondaryBody.className = "coordinate-readings-secondary";
    secondaryBody.id = `coordinate-secondary-readings-${session.key}`;
    secondaryBody.dataset.rpaSecondaryReadings = "true";
    secondaryBody.hidden = true;
    host.dataset.allReadingsVisible = "false";

    if (secondaryEntries.length > 0) {
      const icon = document.createElement("span");
      expandButton = document.createElement("button");
      expandButton.className = "coordinate-readings-expand";
      expandButton.type = "button";
      expandButton.dataset.rpaAction = "toggleOtherCoordinates";
      expandButton.setAttribute("aria-controls", secondaryBody.id);
      expandButton.setAttribute("aria-expanded", "false");
      icon.className = "coordinate-readings-expand-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = "⌄";
      expandButton.append(icon);

      function setSecondaryVisible(visible) {
        secondaryVisible = visible;
        secondaryBody.hidden = !visible;
        host.dataset.allReadingsVisible = String(visible);
        expandButton.setAttribute("aria-expanded", String(visible));
        const action = visible ? "Hide" : "Show";
        const description = `${action} ${plural(secondaryEntries.length, "other GPS reading")}`;
        expandButton.setAttribute("aria-label", description);
        expandButton.setAttribute("title", description);
      }

      expandButton.addEventListener("click", () => setSecondaryVisible(!secondaryVisible));
      setSecondaryVisible(false);
    }

    function createReadingRow(reading, index) {
      const row = document.createElement("tr");
      row.dataset.rpaGpsReading = "true";
      row.dataset.readingIndex = String(index);
      row.dataset.reference = String(Boolean(reading.reference));
      row.dataset.sourceType = reading.sourceType;
      row.dataset.gpsRecord = JSON.stringify(reading);
      appendCell(row, reading.capturedAtMs ? formatTime(reading.capturedAtMs, true) : "Unknown", "capturedAt");
      appendCell(row, reading.sourceType === "session_start" ? "Session start" : "Photo", "sourceType");
      appendCell(row, reading.longitude, "longitude");
      appendCell(row, reading.latitude, "latitude");
      const accuracyCell = appendCell(row, `±${reading.accuracyMeters} m`, "accuracyMeters");
      accuracyCell.children[0].dataset.value = String(reading.accuracyMeters);
      if (reading.accuracyMeters > MAX_GPS_ACCURACY_METERS) {
        accuracyCell.className = "coordinate-reading-warning";
      }
      const referenceCell = document.createElement("td");
      if (reading.reference) {
        const use = document.createElement("div");
        const label = document.createElement("span");
        use.className = "coordinate-reading-use";
        label.className = "coordinate-reference-label";
        label.textContent = "Reference";
        use.append(label);
        if (expandButton) use.append(expandButton);
        referenceCell.append(use);
      }
      row.append(referenceCell);
      return row;
    }

    referenceBody.append(createReadingRow(referenceEntry.reading, referenceEntry.index));
    secondaryEntries.forEach(({ reading, index }) => {
      secondaryBody.append(createReadingRow(reading, index));
    });
    table.append(head, referenceBody);
    if (secondaryEntries.length > 0) table.append(secondaryBody);
    host.append(table);
    return host;
  }

  function readCoordinate(input, axis) {
    const raw = String(input.value || "").trim();
    if (!raw) return null;
    const value = Number(raw);
    const minimum = axis === "X" ? -180 : -90;
    const maximum = axis === "X" ? 180 : 90;
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
      throw new Error(
        axis === "X"
          ? "Truck X must be a longitude between -180 and 180."
          : "Truck Y must be a latitude between -90 and 90.",
      );
    }
    return value;
  }

  function comparisonMessage(comparison) {
    switch (comparison.status) {
      case "within_threshold":
        return `Within threshold · ${comparison.distanceMeters} m from the GPS reference; limit ${MATCH_THRESHOLD_METERS} m.`;
      case "outside_threshold":
        return `Flag for review · ${comparison.distanceMeters} m from the GPS reference exceeds the ${MATCH_THRESHOLD_METERS} m limit.`;
      case "insufficient_accuracy":
        return "Photo and truck location discrepancy.";
      case "gps_unavailable":
        return "Flag for review · this session has no automatic GPS reference.";
      case "incomplete":
        return "Enter both truck X and Y coordinates.";
      default:
        return "Enter the truck coordinates to compare them with the highlighted GPS reference.";
    }
  }

  function clearPositionMap() {
    positionMap?.remove?.();
    positionMap = null;
    mapCanvas.replaceChildren();
  }

  function closePositionMap() {
    if (typeof mapDialog.close === "function" && mapDialog.open) {
      mapDialog.close();
      return;
    }
    mapDialog.hidden = true;
    clearPositionMap();
  }

  function openPositionMap(session, truckLocation, comparison) {
    const reference = session.reference;
    if (!reference || truckLocation.x === null || truckLocation.y === null) return;

    clearPositionMap();
    mapTitle.textContent = `${session.location} · ${session.sessionLabel}`;
    mapSummary.textContent = comparison.flaggedForReview
      ? `Flag for review · Truck is ${comparison.distanceMeters} m from the GPS reference.`
      : `Within threshold · Truck is ${comparison.distanceMeters} m from the GPS reference.`;
    mapSummary.dataset.reviewRequired = String(comparison.flaggedForReview);
    mapError.hidden = true;
    mapError.textContent = "";
    mapCanvas.dataset.referenceLatitude = String(reference.latitude);
    mapCanvas.dataset.referenceLongitude = String(reference.longitude);
    mapCanvas.dataset.truckLatitude = String(truckLocation.y);
    mapCanvas.dataset.truckLongitude = String(truckLocation.x);
    mapCanvas.dataset.distanceMeters = String(comparison.distanceMeters);

    mapDialog.hidden = false;
    if (typeof mapDialog.showModal === "function") mapDialog.showModal();
    else mapDialog.setAttribute("open", "");

    const leaflet = globalScope.L;
    if (!leaflet?.map || !leaflet?.tileLayer || !leaflet?.circleMarker || !leaflet?.polyline) {
      mapError.textContent = "The map library could not load. Check the connection and try again.";
      mapError.hidden = false;
      return;
    }

    const referencePoint = [reference.latitude, reference.longitude];
    const truckPoint = [truckLocation.y, truckLocation.x];
    positionMap = leaflet.map(mapCanvas, { zoomControl: true });
    leaflet
      .tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      })
      .addTo(positionMap);

    if (leaflet.circle && reference.accuracyMeters > 0) {
      leaflet
        .circle(referencePoint, {
          radius: reference.accuracyMeters,
          color: "#16875f",
          fillColor: "#16875f",
          fillOpacity: 0.1,
          weight: 1,
        })
        .addTo(positionMap);
    }
    leaflet
      .circleMarker(referencePoint, {
        radius: 8,
        color: "#ffffff",
        fillColor: "#16875f",
        fillOpacity: 1,
        weight: 3,
      })
      .addTo(positionMap)
      .bindTooltip("GPS reference", { direction: "top", permanent: true });
    leaflet
      .circleMarker(truckPoint, {
        radius: 8,
        color: "#ffffff",
        fillColor: "#d5483f",
        fillOpacity: 1,
        weight: 3,
      })
      .addTo(positionMap)
      .bindTooltip("Truck position", { direction: "bottom", permanent: true });
    const differenceLine = leaflet
      .polyline([referencePoint, truckPoint], {
        color: comparison.flaggedForReview ? "#d5483f" : "#516159",
        dashArray: "7 7",
        weight: 3,
      })
      .addTo(positionMap);
    // The line is the whole point of the map, so it says how long it is rather
    // than leaving the reader to find the same figure in the summary above.
    differenceLine.bindTooltip?.(`${comparison.distanceMeters} m`, {
      permanent: true,
      direction: "center",
      className: "coordinate-map-distance",
    });
    positionMap.fitBounds(differenceLine.getBounds(), { maxZoom: 19, padding: [48, 48] });
    positionMap.invalidateSize?.();
    globalScope.setTimeout?.(() => positionMap?.invalidateSize?.(), 0);
  }

  function updateMachineIndex() {
    if (!coordinateData) return;
    coordinateData.textContent = JSON.stringify(
      sortCoordinateSessions(sessions, sortOrder?.value).map((session) => sessionRecord(session, data)),
    );
  }

  function createTruckForm(session, card) {
    const form = document.createElement("form");
    const heading = document.createElement("h3");
    const fields = document.createElement("div");
    const xLabel = document.createElement("label");
    const yLabel = document.createElement("label");
    const xText = document.createElement("span");
    const yText = document.createElement("span");
    const xInput = document.createElement("input");
    const yInput = document.createElement("input");
    const comparisonOutput = document.createElement("p");
    const saveStatus = document.createElement("p");
    const actions = document.createElement("div");
    const saveButton = document.createElement("button");
    const mapButton = document.createElement("button");
    const clearButton = document.createElement("button");

    form.className = "coordinate-truck-form";
    form.dataset.sessionKey = session.key;
    form.setAttribute(
      "aria-label",
      `Truck coordinates for ${session.location}, ${session.dateKey}, ${session.sessionLabel}`,
    );
    heading.textContent = "Truck coordinates";
    fields.className = "coordinate-truck-fields";
    xText.textContent = "X · longitude";
    yText.textContent = "Y · latitude";

    [
      [xInput, "x", session.truckLocation.x, "truckLongitude", xLabel, xText],
      [yInput, "y", session.truckLocation.y, "truckLatitude", yLabel, yText],
    ].forEach(([input, axis, value, field, label, text]) => {
      input.id = `coordinate-truck-${axis}-${session.key}`;
      input.name = axis === "x" ? "truckLocationX" : "truckLocationY";
      input.type = "number";
      input.value = value === null ? "" : String(value);
      input.dataset.coordinateAxis = axis;
      input.dataset.rpaField = field;
      input.setAttribute("step", "any");
      input.setAttribute("inputmode", "decimal");
      input.setAttribute("autocomplete", "off");
      input.setAttribute("placeholder", axis.toUpperCase());
      label.setAttribute("for", input.id);
      label.append(text, input);
    });

    comparisonOutput.className = "coordinate-comparison";
    comparisonOutput.setAttribute("role", "status");
    comparisonOutput.setAttribute("aria-live", "polite");
    saveStatus.className = "coordinate-save-status";
    saveStatus.setAttribute("role", "status");
    saveStatus.setAttribute("aria-live", "polite");
    actions.className = "coordinate-form-actions";
    saveButton.className = "button button-primary";
    saveButton.type = "submit";
    saveButton.dataset.rpaAction = "saveTruckLocation";
    saveButton.textContent = "Save coordinates";
    mapButton.className = "button button-quiet coordinate-map-button";
    mapButton.type = "button";
    mapButton.dataset.rpaAction = "comparePositionsOnMap";
    mapButton.textContent = "Compare on map";
    clearButton.className = "button button-quiet";
    clearButton.type = "button";
    clearButton.dataset.rpaAction = "clearTruckLocation";
    clearButton.textContent = "Clear";

    function inputTruckLocation() {
      return {
        x: readCoordinate(xInput, "X"),
        y: readCoordinate(yInput, "Y"),
      };
    }

    function showComparison() {
      let truckLocation;
      try {
        truckLocation = inputTruckLocation();
      } catch (error) {
        comparisonOutput.textContent = error.message;
        comparisonOutput.dataset.state = "error";
        comparisonOutput.dataset.comparisonStatus = "invalid";
        comparisonOutput.dataset.reviewRequired = "false";
        mapButton.disabled = true;
        mapButton.title = "Enter valid truck coordinates before opening the map.";
        return null;
      }
      const comparison = compareSessionToTruck(session, truckLocation, data);
      comparisonOutput.textContent = comparisonMessage(comparison);
      comparisonOutput.dataset.state = comparison.state;
      comparisonOutput.dataset.comparisonStatus = comparison.status;
      comparisonOutput.dataset.reviewRequired = String(comparison.flaggedForReview);
      card.dataset.reviewRequired = String(comparison.flaggedForReview);
      card.dataset.reviewReason = comparison.reviewReason || "";
      card.dataset.sessionRecord = JSON.stringify(sessionRecord(session, data, truckLocation));
      const mapAvailable = Boolean(
        session.reference && truckLocation.x !== null && truckLocation.y !== null,
      );
      mapButton.disabled = !mapAvailable;
      mapButton.title = mapAvailable
        ? "Show the GPS reference and truck position on a map."
        : session.reference
          ? "Enter both truck coordinates to compare positions on a map."
          : "This session has no GPS reference to map.";
      return truckLocation;
    }

    function showMap() {
      const truckLocation = inputTruckLocation();
      const comparison = compareSessionToTruck(session, truckLocation, data);
      if (!session.reference || truckLocation.x === null || truckLocation.y === null) return;
      openPositionMap(session, truckLocation, comparison);
    }

    async function save(event, options = {}) {
      event?.preventDefault?.();
      let truckLocation;
      try {
        truckLocation = options.clear ? { x: null, y: null } : inputTruckLocation();
        if ((truckLocation.x === null) !== (truckLocation.y === null)) {
          throw new Error("Enter both truck X and Y coordinates, or clear both.");
        }
      } catch (error) {
        saveStatus.textContent = error.message;
        saveStatus.dataset.state = "error";
        return;
      }

      saveButton.disabled = true;
      mapButton.disabled = true;
      clearButton.disabled = true;
      xInput.disabled = true;
      yInput.disabled = true;
      saveStatus.textContent = options.clear ? "Clearing…" : "Saving…";
      saveStatus.dataset.state = "loading";
      const traceId = telemetry?.createTraceId?.();
      try {
        const saved = await cloud.updateSessionTruckLocation(
          {
            key: session.key,
            location: session.location,
            locationKey: session.locationKey,
            dateKey: session.dateKey,
            sessionId: session.sessionId,
            label: session.sessionLabel,
          },
          truckLocation,
        );
        session.truckLocation = data.cleanTruckLocation(saved?.truckLocation || truckLocation);
        xInput.value = session.truckLocation.x === null ? "" : String(session.truckLocation.x);
        yInput.value = session.truckLocation.y === null ? "" : String(session.truckLocation.y);
        saveStatus.textContent = options.clear ? "Truck coordinates cleared." : "Truck coordinates saved.";
        saveStatus.dataset.state = "success";
        showComparison();
        updateMachineIndex();
        telemetry?.event?.(
          "coordinates.truck_location.updated",
          { action: options.clear ? "clear" : "save", status: "success" },
          { traceId },
        );
      } catch (error) {
        saveStatus.textContent = describeError(error);
        saveStatus.dataset.state = "error";
        telemetry?.event?.(
          "coordinates.truck_location.failed",
          {
            errorCode: telemetry?.safeErrorCode?.(error, "truck_location_update_failed"),
            status: "failed",
          },
          { traceId, immediate: true },
        );
      } finally {
        saveButton.disabled = false;
        clearButton.disabled = session.truckLocation.x === null && session.truckLocation.y === null;
        xInput.disabled = false;
        yInput.disabled = false;
      }
    }

    xInput.addEventListener("input", showComparison);
    yInput.addEventListener("input", showComparison);
    form.addEventListener("submit", save);
    mapButton.addEventListener("click", showMap);
    clearButton.addEventListener("click", (event) => save(event, { clear: true }));
    clearButton.disabled = session.truckLocation.x === null && session.truckLocation.y === null;
    fields.append(xLabel, yLabel);
    actions.append(saveButton, mapButton, clearButton);
    form.append(heading, fields, comparisonOutput, actions, saveStatus);
    showComparison();
    return form;
  }

  function headingField(label, value, options = {}) {
    const field = document.createElement("div");
    const name = document.createElement("span");
    const content = options.time ? document.createElement("time") : document.createElement("strong");
    name.textContent = label;
    content.textContent = value;

    if (options.datetime) content.setAttribute("datetime", options.datetime);
    if (options.rpaField) {
      content.dataset.rpaField = options.rpaField;
      content.dataset.value = options.rawValue ?? value;
    }
    // The glyph is decorative and sits beside the value rather than inside it,
    // so the value an agent reads is exactly the statement and nothing else.
    if (options.icon) {
      const glyph = document.createElement("span");
      glyph.className = "coordinate-weather-icon";
      glyph.setAttribute("aria-hidden", "true");
      glyph.textContent = options.icon;
      field.append(name, glyph, content);
      return field;
    }
    field.append(name, content);
    return field;
  }

  function createSessionCard(session) {
    const card = document.createElement("article");
    const heading = document.createElement("header");
    const controls = document.createElement("div");
    const toggle = document.createElement("button");
    const body = document.createElement("div");
    const bodyClip = document.createElement("div");
    const bodyInner = document.createElement("div");
    let coordinatesVisible = false;
    let collapseTimer = null;

    card.className = "coordinate-session";
    card.dataset.sessionKey = session.key;
    card.dataset.locationKey = session.locationKey;
    card.dataset.dateKey = session.dateKey;
    card.dataset.sessionId = session.sessionId;
    card.dataset.sessionRecord = JSON.stringify(sessionRecord(session, data));
    heading.className = "coordinate-session-heading";
    heading.append(
      headingField("Date", formatDate(session.dateKey), {
        time: true,
        datetime: session.dateKey,
        rpaField: "dateKey",
        rawValue: session.dateKey,
      }),
      headingField("Time session", `${session.sessionLabel} · ${sessionTimeRange(session)}`, {
        rpaField: "sessionId",
        rawValue: session.sessionId,
      }),
      headingField("Location", session.location, {
        rpaField: "location",
        rawValue: session.location,
      }),
    );
    // Written down against the session when the dashboard read the day, and
    // said here in the same few words: what it was, and what it cost.
    const weatherSummary = weather?.restoreSessionWeather(session.weather);
    if (weatherSummary) {
      heading.append(
        headingField("Weather", weather.describeSessionWeather(weatherSummary), {
          icon: weather.weatherIcon(weatherSummary),
          rpaField: "weather",
          rawValue: weatherSummary.severity,
        }),
      );
    }
    controls.className = "coordinate-session-controls";
    toggle.className = "coordinate-visibility-toggle";
    toggle.type = "button";
    toggle.dataset.rpaAction = "toggleSessionCoordinates";
    toggle.textContent = "Show coordinates";
    body.className = "coordinate-session-body";
    body.id = `coordinate-session-body-${session.key}`;
    body.dataset.collapsed = "true";
    body.inert = true;
    body.hidden = true;
    body.setAttribute("aria-hidden", "true");
    bodyClip.className = "coordinate-session-body-clip";
    bodyInner.className = "coordinate-session-body-inner";
    toggle.setAttribute("aria-controls", body.id);
    toggle.setAttribute("aria-expanded", "false");
    card.dataset.coordinatesVisible = "false";

    function finishCollapse() {
      if (!coordinatesVisible && body.dataset.collapsed === "true") {
        body.hidden = true;
      }
      collapseTimer = null;
    }

    function setCoordinatesVisible(visible) {
      coordinatesVisible = visible;
      toggle.textContent = visible ? "Hide coordinates" : "Show coordinates";
      toggle.setAttribute("aria-expanded", String(visible));
      card.dataset.coordinatesVisible = String(visible);
      body.inert = !visible;
      body.setAttribute("aria-hidden", String(!visible));

      const reducedMotion =
        globalScope.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
      const canAnimate =
        !reducedMotion &&
        typeof globalScope.requestAnimationFrame === "function" &&
        typeof body.getBoundingClientRect === "function";

      if (collapseTimer !== null) {
        globalScope.clearTimeout?.(collapseTimer);
        collapseTimer = null;
      }

      if (!canAnimate) {
        body.dataset.collapsed = String(!visible);
        body.hidden = !visible;
        return;
      }

      if (visible) {
        body.hidden = false;
        // Commit the zero-row state before expanding it. Without this layout
        // read, removing `hidden` and opening in the same frame would jump.
        body.dataset.collapsed = "true";
        body.getBoundingClientRect();
        globalScope.requestAnimationFrame(() => {
          if (coordinatesVisible) body.dataset.collapsed = "false";
        });
        return;
      }

      body.dataset.collapsed = "true";
      // `transitionend` is the normal path; the timer covers backgrounded tabs
      // and engines that drop transition events while throttling rendering.
      collapseTimer = globalScope.setTimeout?.(finishCollapse, 440) ?? null;
    }

    body.addEventListener("transitionend", (event) => {
      if (event.target === body && event.propertyName === "grid-template-rows") {
        finishCollapse();
      }
    });
    toggle.addEventListener("click", () => setCoordinatesVisible(!coordinatesVisible));
    controls.append(toggle);
    heading.append(controls);
    bodyInner.append(createReadingTable(session), createTruckForm(session, card));
    bodyClip.append(bodyInner);
    body.append(bodyClip);
    card.append(heading, body);
    return card;
  }

  function updateLocationFilter() {
    const selected = locationFilter.value || "all";
    const all = document.createElement("option");
    all.value = "all";
    all.textContent = "All locations";
    const locations = [...new Map(sessions.map((session) => [session.locationKey, session.location]))]
      .sort((left, right) => left[1].localeCompare(right[1]))
      .map(([locationKey, location]) => {
        const option = document.createElement("option");
        option.value = locationKey;
        option.textContent = location;
        return option;
      });
    locationFilter.replaceChildren(all, ...locations);
    locationFilter.value = locations.some((option) => option.value === selected) ? selected : "all";

    const dates = sessions
      .map((session) => session.dateKey)
      .filter((dateKey) => /^\d{4}-\d{2}-\d{2}$/.test(dateKey))
      .sort();
    if (dates.length > 0) {
      dateFilter.min = dates[0];
      dateFilter.max = dates[dates.length - 1];
    }
  }

  function visibleSessions() {
    return sortCoordinateSessions(sessions, sortOrder.value).filter(
      (session) =>
        (!dateFilter.value || session.dateKey === dateFilter.value) &&
        (locationFilter.value === "all" || session.locationKey === locationFilter.value),
    );
  }

  // A filter is only hidden while it is doing nothing. The moment one narrows
  // the list, the bar is opened and the button says so, because a shortened
  // list with no visible reason is the one thing this must not do.
  function filtersAreNarrowing() {
    return Boolean(dateFilter.value) || locationFilter.value !== "all";
  }

  function setSearchOpen(open, options = {}) {
    const shown = open || filtersAreNarrowing();
    filterBar.hidden = !shown;
    searchToggle.setAttribute("aria-expanded", String(shown));
    searchToggle.dataset.active = String(filtersAreNarrowing());
    searchLabel.textContent = shown ? "Hide search" : "Search";
    if (shown && options.focus) dateFilter.focus?.();
    if (!shown && options.restoreFocus) searchToggle.focus?.();
  }

  function render() {
    // Opening is the reader's business, but a narrowing filter reopens it.
    if (filtersAreNarrowing()) setSearchOpen(true);
    else searchToggle.dataset.active = "false";
    const visible = visibleSessions();
    sessionList.replaceChildren(...visible.map(createSessionCard));
    resultCount.textContent = plural(visible.length, "session");
    emptyState.hidden = visible.length > 0;
    updateMachineIndex();
  }

  function revealRequestedSession() {
    if (requestedSessionRevealed || !requestedSessionKey) return;
    const session = sessions.find((entry) => entry.key === requestedSessionKey);
    if (!session) return;
    dateFilter.value = session.dateKey;
    locationFilter.value = session.locationKey;
    setSearchOpen(true);
    render();
    const card = [...sessionList.children].find(
      (entry) => entry.dataset.sessionKey === requestedSessionKey,
    );
    const toggle = card?.querySelector(".coordinate-visibility-toggle");
    requestedSessionRevealed = true;
    toggle?.click();
    globalScope.requestAnimationFrame?.(() => {
      card?.scrollIntoView?.({ behavior: "smooth", block: "center" });
      toggle?.focus?.({ preventScroll: true });
    });
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

  async function loadCoordinates() {
    if (!signedInUser || loading) return;
    loading = true;
    const now = () => (typeof performance !== "undefined" && performance?.now ? performance.now() : Date.now());
    const startedAt = now();
    const traceId = telemetry?.createTraceId?.();
    refreshButton.disabled = true;
    setStatus("Loading Geographic Surveillence…", "loading");
    telemetry?.event?.("coordinates.load.started", { online: navigator.onLine !== false }, { traceId });

    try {
      const [photos, attendance, savedSessions] = await Promise.all([
        loadAllPhotos(),
        cloud.getAttendance({ pageSize: 500 }),
        cloud.getDashboardSessions(),
      ]);
      sessions = buildCoordinateSessions({ photos, attendance, savedSessions }, data);
      updateLocationFilter();
      render();
      revealRequestedSession();
      setStatus(
        `${plural(sessions.length, "session")} · ${plural(
          sessions.reduce((total, session) => total + session.readings.length, 0),
          "GPS reading",
        )}`,
        "success",
      );
      telemetry?.event?.(
        "coordinates.load.completed",
        {
          durationMs: now() - startedAt,
          sessionCount: sessions.length,
          flaggedCount: sessions.filter((s) => s.comparison?.flaggedForReview).length,
          status: "success",
        },
        { traceId },
      );
    } catch (error) {
      setStatus(describeError(error), "error");
      sessions = [];
      updateLocationFilter();
      render();
      telemetry?.event?.(
        "coordinates.load.failed",
        {
          durationMs: now() - startedAt,
          errorCode: telemetry?.safeErrorCode?.(error, "coordinates_load_failed"),
          status: "failed",
        },
        { traceId, immediate: true, dedupeMs: 60000 },
      );
    } finally {
      loading = false;
      refreshButton.disabled = false;
    }
  }

  function setUser(user) {
    signedInUser = user || null;
    authGate.hidden = Boolean(user);
    workspace.hidden = !user;
    signOutButton.hidden = !user;
    accountName.textContent = user?.email || "";
    if (user) {
      loadCoordinates();
    } else {
      closePositionMap();
      sessions = [];
      sessionList.replaceChildren();
      resultCount.textContent = "0 sessions";
      coordinateData.textContent = "[]";
      setStatus("");
    }
  }

  signInButton.addEventListener("click", async () => {
    signInButton.disabled = true;
    setStatus("Opening Google sign-in…", "loading");
    try {
      await cloud.signIn();
    } catch (error) {
      setStatus(describeError(error), "error");
      telemetry?.event?.(
        "cloud.auth.failed",
        { errorCode: telemetry?.safeErrorCode?.(error, "auth_failed"), status: "failed" },
        { immediate: true, dedupeMs: 60000 },
      );
    } finally {
      signInButton.disabled = false;
    }
  });
  signOutButton.addEventListener("click", () => {
    cloud.signOut().catch((error) => {
      setStatus(describeError(error), "error");
      telemetry?.event?.(
        "cloud.auth.failed",
        { errorCode: telemetry?.safeErrorCode?.(error, "auth_failed"), status: "failed" },
        { immediate: true, dedupeMs: 60000 },
      );
    });
  });
  refreshButton.addEventListener("click", loadCoordinates);
  dateFilter.addEventListener("change", render);
  locationFilter.addEventListener("change", render);
  sortOrder.addEventListener("change", render);
  clearFilters.addEventListener("click", () => {
    dateFilter.value = "";
    locationFilter.value = "all";
    sortOrder.value = "newest";
    render();
    // Nothing is being narrowed any more, so the bar folds itself away again.
    setSearchOpen(false, { restoreFocus: true });
  });

  searchToggle.addEventListener("click", () => {
    const open = searchToggle.getAttribute("aria-expanded") !== "true";
    if (!open && filtersAreNarrowing()) {
      // Closing on an active filter would hide the reason the list is short,
      // so the filters are cleared with it.
      dateFilter.value = "";
      locationFilter.value = "all";
      render();
    }
    setSearchOpen(open, { focus: open, restoreFocus: !open });
  });

  filterBar.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || filtersAreNarrowing()) return;
    setSearchOpen(false, { restoreFocus: true });
  });
  mapClose.addEventListener("click", closePositionMap);
  mapDialog.addEventListener("close", clearPositionMap);

  cloud.subscribeAuth((user, error) => {
    if (error) {
      setUser(null);
      setStatus(describeError(error), "error");
      telemetry?.event?.(
        "cloud.auth.failed",
        { errorCode: telemetry?.safeErrorCode?.(error, "auth_failed"), status: "failed" },
        { immediate: true, dedupeMs: 60000 },
      );
      return;
    }
    telemetry?.event?.("cloud.auth.state", {
      status: user ? "signed_in" : "signed_out",
    });
    setUser(user);
  });
})(typeof globalThis !== "undefined" ? globalThis : this);
