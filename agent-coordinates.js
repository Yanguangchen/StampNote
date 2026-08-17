(function initializeAgentCoordinates(globalScope) {
  "use strict";

  const MATCH_THRESHOLD_METERS = 25;
  const MAX_GPS_ACCURACY_METERS = 20;

  function normalizeSearchText(value) {
    return String(value || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function filterSessions(sessions, query = "", filterMode = "all") {
    const rawTokens = normalizeSearchText(query).split(" ").filter(Boolean);
    return (sessions || []).filter((session) => {
      // 1. Check filter mode
      const hasCoords = session.truckLocation?.x !== null && session.truckLocation?.y !== null;
      const isFlagged = Boolean(session.comparison?.flaggedForReview);

      if (filterMode === "missing" && hasCoords) return false;
      if (filterMode === "set" && !hasCoords) return false;
      if (filterMode === "flagged" && !isFlagged) return false;

      // 2. Check query tokens
      if (rawTokens.length === 0) return true;

      const searchableText = normalizeSearchText([
        session.sessionKey,
        session.location,
        ...(session.aliases || []),
        session.dateKey,
        session.sessionId,
        session.sessionLabel,
        session.comparison?.status,
        session.comparison?.reviewReason,
        hasCoords ? "has coordinates set filled" : "missing unassigned empty coordinates",
        isFlagged ? "flagged review warning discrepancy" : "matched verified ok",
      ].join(" "));

      return rawTokens.every((token) => searchableText.includes(token));
    });
  }

  function sessionStatusSummary(session) {
    const comparison = session.comparison;
    const hasCoords = session.truckLocation?.x !== null && session.truckLocation?.y !== null;

    if (!hasCoords) {
      return {
        type: "missing",
        label: "Missing X/Y",
        details: "Coordinates not set",
      };
    }

    if (comparison?.status === "gps_unavailable") {
      return {
        type: "gps-none",
        label: "Coordinates Set",
        details: "No GPS reference to compare against",
      };
    }

    if (comparison?.flaggedForReview) {
      if (comparison?.status === "outside_threshold") {
        return {
          type: "flagged",
          label: `Flagged: ${comparison.distanceMeters} m`,
          details: `Exceeds ${comparison.distanceThresholdMeters || MATCH_THRESHOLD_METERS} m proximity limit`,
        };
      }
      if (comparison?.status === "insufficient_accuracy") {
        return {
          type: "flagged",
          label: "Flagged (Low GPS Quality)",
          details: "GPS reference uncertainty is too high",
        };
      }
      return {
        type: "flagged",
        label: "Flagged for review",
        details: comparison.reviewReason || "Review required",
      };
    }

    if (comparison?.status === "within_threshold") {
      return {
        type: "matched",
        label: `Matched (${comparison.distanceMeters} m)`,
        details: `Within ${comparison.distanceThresholdMeters || MATCH_THRESHOLD_METERS} m limit`,
      };
    }

    return {
      type: "set",
      label: "Coordinates Set",
      details: `X: ${session.truckLocation.x}, Y: ${session.truckLocation.y}`,
    };
  }

  const api = {
    MATCH_THRESHOLD_METERS,
    MAX_GPS_ACCURACY_METERS,
    filterSessions,
    normalizeSearchText,
    sessionStatusSummary,
  };

  globalScope.StampNoteAgentCoordinates = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;

  const document = globalScope.document;
  if (!document) return;
  if (!document.querySelector("#agent-session-list")) return;

  const cloud = globalScope.StampNoteFirebase;
  const data = globalScope.StampNoteCloudData;
  const coordModule = globalScope.StampNoteCoordinates;
  const telemetry = globalScope.StampNoteObservability;

  const signInButton = document.querySelector("#agent-sign-in");
  const signOutButton = document.querySelector("#agent-sign-out");
  const authGate = document.querySelector("#agent-auth-gate");
  const accountName = document.querySelector("#agent-account-name");
  const workspace = document.querySelector("#agent-workspace");
  const status = document.querySelector("#agent-status");
  const searchInput = document.querySelector("#agent-search-input");
  const searchClear = document.querySelector("#agent-search-clear");
  const filterChips = document.querySelector("#agent-filter-chips");
  const resultCount = document.querySelector("#agent-result-count");
  const sessionList = document.querySelector("#agent-session-list");
  const emptyState = document.querySelector("#agent-empty");
  const emptyReset = document.querySelector("#agent-empty-reset");
  const refreshButton = document.querySelector("#agent-refresh");
  const copyJsonButton = document.querySelector("#agent-copy-json");
  const copyJsonLabel = document.querySelector("#agent-copy-json-label");
  const batchToggle = document.querySelector("#agent-batch-toggle");
  const batchPanel = document.querySelector("#agent-batch-panel");
  const batchClose = document.querySelector("#agent-batch-close");
  const batchInput = document.querySelector("#agent-batch-input");
  const batchApply = document.querySelector("#agent-batch-apply");
  const batchExport = document.querySelector("#agent-batch-export");
  const batchCopy = document.querySelector("#agent-batch-copy");
  const batchStatus = document.querySelector("#agent-batch-status");
  const agentData = document.querySelector("#agent-data");

  const countAll = document.querySelector("#count-all");
  const countMissing = document.querySelector("#count-missing");
  const countSet = document.querySelector("#count-set");
  const countFlagged = document.querySelector("#count-flagged");

  if (
    !signInButton ||
    !signOutButton ||
    !authGate ||
    !workspace ||
    !status ||
    !sessionList ||
    !searchInput ||
    !data ||
    !cloud
  ) {
    if (status) {
      status.textContent = "AI Coordinate workspace could not initialize.";
      status.dataset.state = "error";
    }
    if (signInButton) signInButton.disabled = true;
    return;
  }

  telemetry?.configure({ surface: "agent-coordinates" });

  let rawSessions = [];
  let currentFilter = "all";
  let currentQuery = "";
  let savingKey = null;

  async function copyToClipboard(text) {
    if (globalScope.navigator?.clipboard?.writeText) {
      try {
        await globalScope.navigator.clipboard.writeText(text);
        return true;
      } catch (e) {
        // Continue to fallback
      }
    }
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.append(textarea);
      textarea.focus();
      textarea.select();
      const success = typeof document.execCommand === "function" ? document.execCommand("copy") : false;
      textarea.remove();
      return success;
    } catch (err) {
      return false;
    }
  }

  function formatExportableSessions(sessionsToExport) {
    return (sessionsToExport || []).map((session) => ({
      sessionKey: session.sessionKey,
      location: session.location,
      locationKey: session.locationKey,
      dateKey: session.dateKey,
      sessionId: session.sessionId,
      sessionLabel: session.sessionLabel,
      referenceGps: session.reference
        ? {
            longitude: session.reference.longitude,
            latitude: session.reference.latitude,
            accuracyMeters: session.reference.accuracyMeters,
          }
        : null,
      truckLocation: { ...session.truckLocation },
      comparison: { ...session.comparison },
    }));
  }

  // Read initial query params
  try {
    const params = new URLSearchParams(globalScope.location?.search || "");
    const qParam = params.get("q") || params.get("session") || params.get("search");
    if (qParam) {
      currentQuery = qParam.trim();
      searchInput.value = currentQuery;
      if (searchClear) searchClear.hidden = false;
    }
    const filterParam = params.get("filter");
    if (filterParam && ["all", "missing", "set", "flagged"].includes(filterParam)) {
      currentFilter = filterParam;
    }
  } catch (error) {
    // Ignore URL parse error
  }

  function setStatus(message, state = "idle") {
    status.textContent = message;
    status.dataset.state = state;
  }

  function updateCounts() {
    if (!countAll || !countMissing || !countSet || !countFlagged) return;
    const total = rawSessions.length;
    const missing = rawSessions.filter(
      (s) => s.truckLocation.x === null || s.truckLocation.y === null,
    ).length;
    const set = total - missing;
    const flagged = rawSessions.filter((s) => s.comparison?.flaggedForReview).length;

    countAll.textContent = String(total);
    countMissing.textContent = String(missing);
    countSet.textContent = String(set);
    countFlagged.textContent = String(flagged);
  }

  function updateMachineData(filteredSessions) {
    if (!agentData) return;
    const exportable = formatExportableSessions(filteredSessions);
    agentData.textContent = JSON.stringify(exportable, null, 2);
  }

  function renderSessions() {
    const filtered = filterSessions(rawSessions, currentQuery, currentFilter);
    sessionList.replaceChildren();

    if (resultCount) {
      const total = rawSessions.length;
      resultCount.textContent =
        filtered.length === total
          ? `${total} session${total === 1 ? "" : "s"}`
          : `Showing ${filtered.length} of ${total} session${total === 1 ? "" : "s"}`;
    }

    updateCounts();
    updateMachineData(filtered);

    if (filtered.length === 0) {
      if (emptyState) emptyState.hidden = false;
      return;
    }
    if (emptyState) emptyState.hidden = true;

    filtered.forEach((session) => {
      const summary = sessionStatusSummary(session);
      const card = document.createElement("article");
      card.className = `session-card ${summary.type === "flagged" ? "is-flagged" : ""} ${summary.type === "matched" ? "is-matched" : ""}`;
      card.id = `card-${session.sessionKey}`;
      card.dataset.agentSession = "true";
      card.dataset.sessionKey = session.sessionKey;
      card.dataset.location = session.location;
      card.dataset.dateKey = session.dateKey;
      card.dataset.sessionId = session.sessionId;
      card.dataset.status = summary.type;
      card.dataset.hasCoordinates = String(
        session.truckLocation.x !== null && session.truckLocation.y !== null,
      );

      // Card Header
      const header = document.createElement("header");
      header.className = "session-card-header";

      const titleGroup = document.createElement("div");
      titleGroup.className = "session-card-title-group";

      const locationEl = document.createElement("h3");
      locationEl.className = "session-location";
      locationEl.textContent = session.location;

      const dateBadge = document.createElement("span");
      dateBadge.className = "session-badge";
      dateBadge.textContent = `${session.dateKey} · ${session.sessionLabel}`;

      titleGroup.append(locationEl, dateBadge);

      const statusBadge = document.createElement("span");
      statusBadge.className = `session-status-badge status-${summary.type}`;
      statusBadge.textContent = summary.label;
      statusBadge.title = summary.details;

      header.append(titleGroup, statusBadge);

      // GPS Reference Row
      const gpsRefRow = document.createElement("div");
      gpsRefRow.className = "session-gps-ref";

      if (session.reference) {
        const refLabel = document.createElement("span");
        refLabel.className = "gps-ref-label";
        refLabel.textContent = "GPS Reference:";

        const refCoords = document.createElement("span");
        refCoords.className = "gps-ref-coords";
        refCoords.innerHTML = `X (Lng): <code>${session.reference.longitude}</code>, Y (Lat): <code>${session.reference.latitude}</code> (±${session.reference.accuracyMeters} m)`;

        const copyBtn = document.createElement("button");
        copyBtn.className = "copy-gps-btn button button-quiet";
        copyBtn.type = "button";
        copyBtn.dataset.action = "copy-gps";
        copyBtn.textContent = "Copy GPS";
        copyBtn.title = "Copy GPS reference to truck inputs";
        copyBtn.addEventListener("click", () => {
          const xInput = form.querySelector('[name="truckLocationX"]');
          const yInput = form.querySelector('[name="truckLocationY"]');
          if (xInput && yInput) {
            xInput.value = String(session.reference.longitude);
            yInput.value = String(session.reference.latitude);
            xInput.focus();
          }
        });

        gpsRefRow.append(refLabel, refCoords, copyBtn);
      } else {
        gpsRefRow.classList.add("session-gps-none");
        gpsRefRow.textContent = "No automatic GPS reference recorded for this session.";
      }

      // Coordinate Form
      const form = document.createElement("form");
      form.className = "coordinate-form";
      form.dataset.sessionKey = session.sessionKey;

      // X Field (Longitude)
      const xWrap = document.createElement("div");
      xWrap.className = "coord-field";
      const xLabel = document.createElement("label");
      xLabel.htmlFor = `input-x-${session.sessionKey}`;
      xLabel.textContent = "X · Longitude (-180 to 180)";
      const xInput = document.createElement("input");
      xInput.id = `input-x-${session.sessionKey}`;
      xInput.name = "truckLocationX";
      xInput.type = "number";
      xInput.step = "any";
      xInput.min = "-180";
      xInput.max = "180";
      xInput.placeholder = "e.g. 103.8545";
      xInput.value = session.truckLocation.x !== null ? String(session.truckLocation.x) : "";
      xWrap.append(xLabel, xInput);

      // Y Field (Latitude)
      const yWrap = document.createElement("div");
      yWrap.className = "coord-field";
      const yLabel = document.createElement("label");
      yLabel.htmlFor = `input-y-${session.sessionKey}`;
      yLabel.textContent = "Y · Latitude (-90 to 90)";
      const yInput = document.createElement("input");
      yInput.id = `input-y-${session.sessionKey}`;
      yInput.name = "truckLocationY";
      yInput.type = "number";
      yInput.step = "any";
      yInput.min = "-90";
      yInput.max = "90";
      yInput.placeholder = "e.g. 1.2868";
      yInput.value = session.truckLocation.y !== null ? String(session.truckLocation.y) : "";
      yWrap.append(yLabel, yInput);

      // Actions
      const actionsWrap = document.createElement("div");
      actionsWrap.className = "coord-actions-wrap";

      const saveBtn = document.createElement("button");
      saveBtn.className = "button button-primary save-btn";
      saveBtn.type = "submit";
      saveBtn.textContent = "Save";

      const clearBtn = document.createElement("button");
      clearBtn.className = "button button-quiet clear-btn";
      clearBtn.type = "button";
      clearBtn.dataset.action = "clear";
      clearBtn.textContent = "Clear";

      const copySessionJsonBtn = document.createElement("button");
      copySessionJsonBtn.className = "button button-quiet copy-session-json-btn";
      copySessionJsonBtn.type = "button";
      copySessionJsonBtn.dataset.action = "copy-session-json";
      copySessionJsonBtn.textContent = "Copy JSON";
      copySessionJsonBtn.title = "Copy this session as JSON";
      copySessionJsonBtn.addEventListener("click", async () => {
        const sessionJson = JSON.stringify(formatExportableSessions([session])[0], null, 2);
        const success = await copyToClipboard(sessionJson);
        if (success) {
          copySessionJsonBtn.textContent = "✓ Copied";
          copySessionJsonBtn.classList.add("is-copied");
          setStatus(`Copied session JSON for ${session.location} (${session.dateKey}).`, "success");
          setTimeout(() => {
            copySessionJsonBtn.textContent = "Copy JSON";
            copySessionJsonBtn.classList.remove("is-copied");
          }, 2000);
        }
      });

      actionsWrap.append(saveBtn, clearBtn, copySessionJsonBtn);

      // Inline Status
      const inlineStatus = document.createElement("span");
      inlineStatus.className = "card-inline-status";
      inlineStatus.setAttribute("role", "status");

      if (savingKey === session.sessionKey) {
        saveBtn.disabled = true;
        clearBtn.disabled = true;
        inlineStatus.textContent = "Saving coordinates…";
        inlineStatus.dataset.state = "saving";
      }

      form.append(xWrap, yWrap, actionsWrap, inlineStatus);

      // Form Event Handlers
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const rawX = xInput.value.trim();
        const rawY = yInput.value.trim();

        if (!rawX || !rawY) {
          inlineStatus.textContent = "Enter both X and Y coordinates, or click Clear.";
          inlineStatus.dataset.state = "error";
          return;
        }

        const numX = Number(rawX);
        const numY = Number(rawY);

        if (!Number.isFinite(numX) || numX < -180 || numX > 180) {
          inlineStatus.textContent = "Longitude X must be between -180 and 180.";
          inlineStatus.dataset.state = "error";
          xInput.focus();
          return;
        }

        if (!Number.isFinite(numY) || numY < -90 || numY > 90) {
          inlineStatus.textContent = "Latitude Y must be between -90 and 90.";
          inlineStatus.dataset.state = "error";
          yInput.focus();
          return;
        }

        await saveCoordinates(session, { x: numX, y: numY }, inlineStatus, [saveBtn, clearBtn]);
      });

      clearBtn.addEventListener("click", async () => {
        xInput.value = "";
        yInput.value = "";
        await saveCoordinates(session, { x: null, y: null }, inlineStatus, [saveBtn, clearBtn]);
      });

      card.append(header, gpsRefRow, form);
      sessionList.append(card);
    });
  }

  async function saveCoordinates(session, coords, inlineStatus, buttons = []) {
    if (savingKey) return;
    savingKey = session.sessionKey;
    buttons.forEach((b) => (b.disabled = true));
    if (inlineStatus) {
      inlineStatus.textContent = coords.x === null ? "Clearing coordinates…" : "Saving coordinates…";
      inlineStatus.dataset.state = "saving";
    }

    try {
      const descriptor = {
        key: session.sessionKey,
        location: session.location,
        locationKey: session.locationKey,
        dateKey: session.dateKey,
        sessionId: session.sessionId,
      };
      await cloud.updateSessionTruckLocation(descriptor, coords);

      // Update in-memory session
      const target = rawSessions.find((s) => s.sessionKey === session.sessionKey);
      if (target) {
        target.truckLocation = { x: coords.x, y: coords.y };
        if (coordModule?.compareSessionToTruck) {
          const comparison = coordModule.compareSessionToTruck(
            target,
            target.truckLocation,
            data,
          );
          target.comparison = {
            status: comparison.status,
            distanceMeters: comparison.distanceMeters,
            flaggedForReview: comparison.flaggedForReview,
            reviewReason: comparison.reviewReason,
            distanceThresholdMeters: MATCH_THRESHOLD_METERS,
            maximumGpsAccuracyMeters: MAX_GPS_ACCURACY_METERS,
          };
        }
      }

      telemetry?.record({
        action: "agent_coordinates.truck_location.updated",
        level: "info",
        outcome: "success",
        context: {
          sessionKey: session.sessionKey,
          hasCoordinates: coords.x !== null,
        },
      });

      savingKey = null;
      renderSessions();
      setStatus(`Updated coordinates for ${session.location} (${session.dateKey}).`, "success");
    } catch (error) {
      savingKey = null;
      buttons.forEach((b) => (b.disabled = false));
      const msg = error?.message || "Failed to save coordinates.";
      if (inlineStatus) {
        inlineStatus.textContent = msg;
        inlineStatus.dataset.state = "error";
      }
      setStatus(msg, "error");
      telemetry?.record({
        action: "agent_coordinates.truck_location.failed",
        level: "error",
        outcome: "failure",
        context: {
          sessionKey: session.sessionKey,
          errorCode: error?.code || "save_failed",
        },
      });
    }
  }

  async function loadData() {
    setStatus("Loading session coordinates…", "idle");
    try {
      const [photosResult, attendance, savedSessions] = await Promise.all([
        cloud.getPhotosPage ? cloud.getPhotosPage({ limit: 1000 }) : { photos: [] },
        cloud.getAttendance ? cloud.getAttendance() : [],
        cloud.getDashboardSessions ? cloud.getDashboardSessions() : [],
      ]);

      const photos = photosResult?.photos || [];
      if (coordModule?.buildCoordinateSessions) {
        const built = coordModule.buildCoordinateSessions(
          { photos, attendance, savedSessions },
          data,
        );
        const sorted = coordModule.sortCoordinateSessions
          ? coordModule.sortCoordinateSessions(built, "newest")
          : built;

        rawSessions = sorted.map((session) =>
          coordModule.sessionRecord ? coordModule.sessionRecord(session, data) : session,
        );
      } else {
        rawSessions = [];
      }

      setStatus("", "idle");
      renderSessions();
    } catch (error) {
      const msg = error?.code === "permission-denied"
        ? "Access denied. Sign in with an authorized Google account."
        : error?.message || "Could not load session coordinates.";
      setStatus(msg, "error");
    }
  }

  // Setup UI Listeners
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      currentQuery = searchInput.value.trim();
      if (searchClear) searchClear.hidden = !currentQuery;
      renderSessions();
    });
  }

  if (searchClear) {
    searchClear.addEventListener("click", () => {
      searchInput.value = "";
      currentQuery = "";
      searchClear.hidden = true;
      searchInput.focus();
      renderSessions();
    });
  }

  if (filterChips) {
    filterChips.addEventListener("click", (event) => {
      const chip = event.target.closest(".filter-chip");
      if (!chip) return;
      filterChips.querySelectorAll(".filter-chip").forEach((c) => c.classList.remove("is-active"));
      chip.classList.add("is-active");
      currentFilter = chip.dataset.filter || "all";
      renderSessions();
    });
  }

  if (emptyReset) {
    emptyReset.addEventListener("click", () => {
      currentQuery = "";
      currentFilter = "all";
      if (searchInput) searchInput.value = "";
      if (searchClear) searchClear.hidden = true;
      if (filterChips) {
        filterChips.querySelectorAll(".filter-chip").forEach((c) => {
          c.classList.toggle("is-active", c.dataset.filter === "all");
        });
      }
      renderSessions();
    });
  }

  if (refreshButton) {
    refreshButton.addEventListener("click", () => loadData());
  }

  if (batchToggle && batchPanel) {
    batchToggle.addEventListener("click", () => {
      const isOpen = !batchPanel.hidden;
      batchPanel.hidden = isOpen;
      batchToggle.setAttribute("aria-expanded", String(!isOpen));
      if (!isOpen && batchInput && !batchInput.value) {
        loadSessionsIntoBatch();
      }
    });
  }

  if (batchClose && batchPanel) {
    batchClose.addEventListener("click", () => {
      batchPanel.hidden = true;
      batchToggle?.setAttribute("aria-expanded", "false");
    });
  }

  function loadSessionsIntoBatch() {
    if (!batchInput) return;
    const exportable = rawSessions.map((s) => ({
      sessionKey: s.sessionKey,
      location: s.location,
      dateKey: s.dateKey,
      sessionId: s.sessionId,
      x: s.truckLocation.x,
      y: s.truckLocation.y,
    }));
    batchInput.value = JSON.stringify(exportable, null, 2);
    if (batchStatus) batchStatus.textContent = `Loaded ${exportable.length} sessions to editor.`;
  }

  if (batchExport) {
    batchExport.addEventListener("click", loadSessionsIntoBatch);
  }

  if (batchApply && batchInput) {
    batchApply.addEventListener("click", async () => {
      const text = batchInput.value.trim();
      if (!text) {
        if (batchStatus) batchStatus.textContent = "Please enter JSON array of coordinates.";
        return;
      }

      let entries;
      try {
        entries = JSON.parse(text);
        if (!Array.isArray(entries)) throw new Error("Root must be a JSON array.");
      } catch (err) {
        if (batchStatus) batchStatus.textContent = `JSON Error: ${err.message}`;
        return;
      }

      batchApply.disabled = true;
      if (batchStatus) batchStatus.textContent = `Applying ${entries.length} coordinate updates…`;

      let updatedCount = 0;
      let errorCount = 0;

      for (const entry of entries) {
        if (!entry || !entry.sessionKey) continue;
        const matching = rawSessions.find((s) => s.sessionKey === entry.sessionKey);
        if (!matching) {
          errorCount += 1;
          continue;
        }

        const x = entry.x !== undefined && entry.x !== null && entry.x !== "" ? Number(entry.x) : null;
        const y = entry.y !== undefined && entry.y !== null && entry.y !== "" ? Number(entry.y) : null;

        if (x !== null && (!Number.isFinite(x) || x < -180 || x > 180)) {
          errorCount += 1;
          continue;
        }
        if (y !== null && (!Number.isFinite(y) || y < -90 || y > 90)) {
          errorCount += 1;
          continue;
        }
        if ((x === null) !== (y === null)) {
          errorCount += 1;
          continue;
        }

        try {
          const descriptor = {
            key: matching.sessionKey,
            location: matching.location,
            locationKey: matching.locationKey,
            dateKey: matching.dateKey,
            sessionId: matching.sessionId,
          };
          await cloud.updateSessionTruckLocation(descriptor, { x, y });
          matching.truckLocation = { x, y };
          if (coordModule?.compareSessionToTruck) {
            const comp = coordModule.compareSessionToTruck(matching, { x, y }, data);
            matching.comparison = {
              status: comp.status,
              distanceMeters: comp.distanceMeters,
              flaggedForReview: comp.flaggedForReview,
              reviewReason: comp.reviewReason,
              distanceThresholdMeters: MATCH_THRESHOLD_METERS,
              maximumGpsAccuracyMeters: MAX_GPS_ACCURACY_METERS,
            };
          }
          updatedCount += 1;
        } catch (e) {
          errorCount += 1;
        }
      }

      batchApply.disabled = false;
      renderSessions();
      if (batchStatus) {
        batchStatus.textContent = `Batch complete: ${updatedCount} updated, ${errorCount} errors.`;
      }
      setStatus(`Batch applied: ${updatedCount} session(s) updated.`, "success");
    });
  }

  // Copy JSON actions
  if (copyJsonButton) {
    copyJsonButton.addEventListener("click", async () => {
      const filtered = filterSessions(rawSessions, currentQuery, currentFilter);
      const jsonText = JSON.stringify(formatExportableSessions(filtered), null, 2);
      const success = await copyToClipboard(jsonText);
      if (success) {
        copyJsonButton.classList.add("is-copied");
        if (copyJsonLabel) copyJsonLabel.textContent = "Copied JSON!";
        setStatus(`Copied ${filtered.length} session record(s) as JSON to clipboard.`, "success");
        setTimeout(() => {
          copyJsonButton.classList.remove("is-copied");
          if (copyJsonLabel) copyJsonLabel.textContent = "Copy JSON";
        }, 2000);
      } else {
        setStatus("Clipboard access unavailable.", "error");
      }
    });
  }

  if (batchCopy && batchInput) {
    batchCopy.addEventListener("click", async () => {
      const textToCopy =
        batchInput.value.trim() ||
        JSON.stringify(formatExportableSessions(rawSessions), null, 2);
      const success = await copyToClipboard(textToCopy);
      if (batchStatus) {
        batchStatus.textContent = success
          ? "Copied JSON to clipboard!"
          : "Failed to copy to clipboard.";
      }
    });
  }

  // Auth Handling
  if (signInButton) {
    signInButton.addEventListener("click", () => {
      cloud.signIn?.().catch((error) => {
        setStatus(error?.message || "Sign in failed.", "error");
      });
    });
  }

  if (signOutButton) {
    signOutButton.addEventListener("click", () => {
      cloud.signOut?.().catch((error) => {
        setStatus(error?.message || "Sign out failed.", "error");
      });
    });
  }

  if (cloud.subscribeAuth) {
    cloud.subscribeAuth(async (user) => {
      if (user) {
        authGate.hidden = true;
        workspace.hidden = false;
        if (signOutButton) signOutButton.hidden = false;
        if (accountName) accountName.textContent = user.displayName || user.email || "Signed in";
        return loadData();
      } else {
        authGate.hidden = false;
        workspace.hidden = true;
        if (signOutButton) signOutButton.hidden = true;
        if (accountName) accountName.textContent = "";
        rawSessions = [];
        renderSessions();
      }
    });
  }

  // Programmatic API for AI Agents / Automation
  Object.assign(api, {
    getSessions(filter = currentFilter, query = currentQuery) {
      return filterSessions(rawSessions, query, filter);
    },
    getSessionsJson(filter = currentFilter, query = currentQuery) {
      const list = filterSessions(rawSessions, query, filter);
      return JSON.stringify(formatExportableSessions(list), null, 2);
    },
    async copyJson(filter = currentFilter, query = currentQuery) {
      const json = api.getSessionsJson(filter, query);
      await copyToClipboard(json);
      return json;
    },
    async copySessionJson(sessionKey) {
      const session = rawSessions.find((s) => s.sessionKey === sessionKey);
      if (!session) throw new Error(`Session not found: ${sessionKey}`);
      const json = JSON.stringify(formatExportableSessions([session])[0], null, 2);
      await copyToClipboard(json);
      return json;
    },
    async updateSessionCoordinates(sessionKey, coords) {
      const session = rawSessions.find((s) => s.sessionKey === sessionKey);
      if (!session) throw new Error(`Session not found: ${sessionKey}`);
      const descriptor = {
        key: session.sessionKey,
        location: session.location,
        locationKey: session.locationKey,
        dateKey: session.dateKey,
        sessionId: session.sessionId,
      };
      const updated = await cloud.updateSessionTruckLocation(descriptor, coords);
      session.truckLocation = { x: coords.x ?? null, y: coords.y ?? null };
      renderSessions();
      return updated;
    },
    async batchUpdateCoordinates(items = []) {
      const results = [];
      for (const item of items) {
        try {
          const res = await api.updateSessionCoordinates(item.sessionKey, {
            x: item.x,
            y: item.y,
          });
          results.push({ sessionKey: item.sessionKey, success: true, result: res });
        } catch (err) {
          results.push({ sessionKey: item.sessionKey, success: false, error: err.message });
        }
      }
      return results;
    },
    search(query) {
      currentQuery = String(query || "").trim();
      if (searchInput) searchInput.value = currentQuery;
      if (searchClear) searchClear.hidden = !currentQuery;
      renderSessions();
    },
    setFilter(filter) {
      currentFilter = filter;
      if (filterChips) {
        filterChips.querySelectorAll(".filter-chip").forEach((c) => {
          c.classList.toggle("is-active", c.dataset.filter === filter);
        });
      }
      renderSessions();
    },
    refresh() {
      return loadData();
    },
    copyToClipboard,
  });
})(typeof window !== "undefined" ? window : globalThis);
