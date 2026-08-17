/* Three counts a site runs on, day by day: who was checked in, what the review
   flagged, and how many sessions the work fell into. Each is its own panel with
   its own colour — three separate measures on three separate scales, never two
   of them sharing one plot and inventing a correlation between them. */
(function initializeMetrics(globalScope) {
  "use strict";

  const data = globalScope.StampNoteCloudData;

  const DAY_MS = 86_400_000;

  // Three measures, three fixed slots. The colour belongs to the measure, so a
  // change of range never repaints them.
  const SERIES = Object.freeze([
    Object.freeze({
      id: "attendance",
      slot: 1,
      title: "Attendance taken",
      unit: "check-in",
      description: "Worker check-ins recorded by face match.",
    }),
    Object.freeze({
      id: "flags",
      slot: 2,
      title: "Flags raised",
      unit: "flag",
      description: "Photos the review sent back rather than kept.",
    }),
    Object.freeze({
      id: "sessions",
      slot: 3,
      title: "Sessions created",
      unit: "session",
      description: "Distinct location, day and time period worked.",
    }),
  ]);

  function photoTimeMs(photo) {
    return Number(photo?.capturedAtMs) || Date.parse(photo?.capturedAt) || 0;
  }

  // Every day in the range gets a column, including the ones nothing happened
  // on: a gap the reader has to infer is worse than a zero they can see.
  function rangeDayKeys(days, now = Date.now()) {
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const keys = [];
    for (let offset = days - 1; offset >= 0; offset -= 1) {
      keys.push(data.createDateKey(new Date(today.getTime() - offset * DAY_MS)));
    }
    return keys;
  }

  function countByDay(keys, entries, atMsOf) {
    const counts = new Map(keys.map((key) => [key, 0]));
    entries.forEach((entry) => {
      const atMs = atMsOf(entry);
      if (!Number.isFinite(atMs) || atMs <= 0) return;
      const key = data.createDateKey(new Date(atMs));
      if (counts.has(key)) counts.set(key, counts.get(key) + 1);
    });
    return keys.map((key) => counts.get(key));
  }

  // A session is a location, a day and one of the day's periods. Counting the
  // distinct ones is what "sessions created" means — the work, not the records.
  function countSessionsByDay(keys, attendance, photos) {
    const seen = new Map(keys.map((key) => [key, new Set()]));
    const add = (atMs, location) => {
      if (!Number.isFinite(atMs) || atMs <= 0) return;
      const key = data.createDateKey(new Date(atMs));
      if (!seen.has(key)) return;
      seen
        .get(key)
        .add(`${data.createLocationKey(location)}|${data.sessionDefinitionFor(atMs).id}`);
    };

    attendance.forEach((entry) => add(Number(entry?.checkedInAtMs), entry?.location));
    photos.forEach((photo) => add(photoTimeMs(photo), photo?.location));
    return keys.map((key) => seen.get(key).size);
  }

  // One slice, read the same way by every panel and by the table.
  function buildDailyMetrics(input = {}) {
    const attendance = input.attendance || [];
    const photos = input.photos || [];
    const keys = rangeDayKeys(Math.max(1, Number(input.days) || 30), input.now);
    const values = {
      attendance: countByDay(keys, attendance, (entry) => Number(entry?.checkedInAtMs)),
      flags: countByDay(keys, photos.filter((photo) => data.isFlagged(photo)), photoTimeMs),
      sessions: countSessionsByDay(keys, attendance, photos),
    };

    return SERIES.map((definition) => ({
      ...definition,
      keys,
      values: values[definition.id],
      total: values[definition.id].reduce((sum, value) => sum + value, 0),
    }));
  }

  const api = Object.freeze({ SERIES, buildDailyMetrics, rangeDayKeys });
  globalScope.StampNoteMetrics = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;

  const document = globalScope.document;
  if (!document?.querySelector("#metrics-panels")) return;

  const cloud = globalScope.StampNoteFirebase;
  const telemetry = globalScope.StampNoteObservability;

  const signInButton = document.querySelector("#metrics-sign-in");
  const signOutButton = document.querySelector("#metrics-sign-out");
  const authGate = document.querySelector("#metrics-auth-gate");
  const accountName = document.querySelector("#metrics-account");
  const workspace = document.querySelector("#metrics-workspace");
  const status = document.querySelector("#metrics-status");
  const panelHost = document.querySelector("#metrics-panels");
  const rangeGroup = document.querySelector("#metrics-range");
  const refreshButton = document.querySelector("#metrics-refresh");
  const tableToggle = document.querySelector("#metrics-table-toggle");
  const tableWrap = document.querySelector("#metrics-table");
  const tableBody = document.querySelector("#metrics-table-body");
  const tableCaption = document.querySelector("#metrics-table-caption");

  telemetry?.configure({ surface: "metrics" });

  const PHOTO_PAGE_SIZE = 100;
  const MAX_PHOTO_PAGES = 60;

  let signedInUser = null;
  let loading = false;
  let attendance = [];
  let photos = [];
  let rangeDays = 30;
  let series = [];

  function setStatus(message, state = "idle") {
    status.textContent = message;
    status.dataset.state = state;
  }

  function describeError(error) {
    switch (error?.code) {
      case "permission-denied":
        return "Firebase denied access. Check that this is the capture account.";
      case "failed-precondition":
        return "Firestore needs an index for this query. Deploy the checked-in indexes and reload.";
      default:
        return error?.message || "The metrics could not be loaded.";
    }
  }

  function plural(count, noun) {
    return `${count} ${noun}${count === 1 ? "" : "s"}`;
  }

  function formatDay(key) {
    const parsed = new Date(`${key}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) return key;
    return parsed.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }

  function formatLongDay(key) {
    const parsed = new Date(`${key}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) return key;
    return parsed.toLocaleDateString(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  }

  // --- The chart -------------------------------------------------------------

  const SVG_NS = "http://www.w3.org/2000/svg";
  const VIEW = Object.freeze({
    width: 640,
    height: 190,
    left: 34,
    right: 10,
    top: 12,
    // The x labels live inside the box, so the card never grows a scrollbar of
    // its own to reach them.
    bottom: 26,
  });
  const MAX_BAR = 24;
  const SURFACE_GAP = 2;

  function svgElement(name, attributes = {}) {
    const node = document.createElementNS(SVG_NS, name);
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
    return node;
  }

  // Axis ticks land on round numbers, so the gridlines mean something.
  function niceCeiling(value) {
    if (value <= 4) return Math.max(1, value);
    const magnitude = 10 ** Math.floor(Math.log10(value));
    return Math.ceil(value / (magnitude / 2)) * (magnitude / 2);
  }

  // A column with a 4px rounded cap and square feet on the baseline.
  function barPath(x, y, width, height, radius) {
    const cap = Math.min(radius, height, width / 2);
    return [
      `M${x} ${y + height}`,
      `V${y + cap}`,
      `A${cap} ${cap} 0 0 1 ${x + cap} ${y}`,
      `H${x + width - cap}`,
      `A${cap} ${cap} 0 0 1 ${x + width} ${y + cap}`,
      `V${y + height}`,
      "Z",
    ].join(" ");
  }

  function createChart(entry, tooltip) {
    const plotWidth = VIEW.width - VIEW.left - VIEW.right;
    const plotHeight = VIEW.height - VIEW.top - VIEW.bottom;
    const baseline = VIEW.top + plotHeight;
    const ceiling = niceCeiling(Math.max(...entry.values, 0));
    const band = plotWidth / entry.values.length;
    const barWidth = Math.max(2, Math.min(MAX_BAR, band - SURFACE_GAP));

    const svg = svgElement("svg", {
      class: "chart",
      viewBox: `0 0 ${VIEW.width} ${VIEW.height}`,
      preserveAspectRatio: "none",
      role: "img",
      "aria-label": `${entry.title}: ${plural(entry.total, entry.unit)} over the last ${entry.values.length} days.`,
    });

    // Gridlines: solid hairlines a step off the surface, behind everything.
    [0, 0.5, 1].forEach((fraction) => {
      const y = VIEW.top + plotHeight * (1 - fraction);
      svg.append(
        svgElement("line", {
          class: fraction === 0 ? "chart-axis" : "chart-grid",
          x1: VIEW.left,
          x2: VIEW.width - VIEW.right,
          y1: y,
          y2: y,
        }),
      );
      const tick = svgElement("text", {
        class: "chart-tick",
        x: VIEW.left - 7,
        y: y + 3.5,
        "text-anchor": "end",
      });
      tick.textContent = String(Math.round(ceiling * fraction));
      svg.append(tick);
    });

    entry.values.forEach((value, index) => {
      const bandLeft = VIEW.left + band * index;
      const x = bandLeft + (band - barWidth) / 2;
      const height = ceiling > 0 ? (value / ceiling) * plotHeight : 0;

      if (height > 0) {
        svg.append(
          svgElement("path", {
            class: "chart-bar",
            d: barPath(x, baseline - height, barWidth, height, 4),
          }),
        );
      }

      // The hit area is the whole band, full height — a 2px column of paint is
      // not something anyone can aim at.
      const target = svgElement("rect", {
        class: "chart-hit",
        x: bandLeft,
        y: VIEW.top,
        width: band,
        height: plotHeight,
        tabindex: "0",
        role: "button",
        "aria-label": `${formatLongDay(entry.keys[index])}: ${plural(value, entry.unit)}`,
      });

      const show = () => {
        target.dataset.active = "true";
        tooltip.hidden = false;
        tooltip.replaceChildren();
        const amount = document.createElement("strong");
        amount.textContent = plural(value, entry.unit);
        const when = document.createElement("span");
        when.textContent = formatLongDay(entry.keys[index]);
        tooltip.append(amount, when);
        const left = ((bandLeft + band / 2) / VIEW.width) * 100;
        tooltip.style.left = `${Math.min(88, Math.max(12, left))}%`;
      };
      const hide = () => {
        delete target.dataset.active;
        tooltip.hidden = true;
      };

      target.addEventListener("pointerenter", show);
      target.addEventListener("pointermove", show);
      target.addEventListener("pointerleave", hide);
      target.addEventListener("focus", show);
      target.addEventListener("blur", hide);
      svg.append(target);
    });

    // Labels at the ends and the middle only: a date under every column is a
    // wall of text nobody reads.
    [0, Math.floor(entry.values.length / 2), entry.values.length - 1].forEach((index, position, all) => {
      if (all.indexOf(index) !== position) return;
      const label = svgElement("text", {
        class: "chart-tick",
        x: VIEW.left + band * (index + 0.5),
        y: VIEW.height - 8,
        "text-anchor": position === 0 ? "start" : position === all.length - 1 ? "end" : "middle",
      });
      label.textContent = formatDay(entry.keys[index]);
      svg.append(label);
    });

    return svg;
  }

  function createPanel(entry) {
    const panel = document.createElement("section");
    panel.className = "metric-panel";
    panel.dataset.series = entry.id;
    panel.dataset.slot = String(entry.slot);

    const heading = document.createElement("div");
    heading.className = "metric-heading";
    const title = document.createElement("h2");
    title.textContent = entry.title;
    const note = document.createElement("p");
    note.className = "metric-note";
    note.textContent = entry.description;
    heading.append(title, note);

    // The stat tile: the total the panel is about, in plain proportional
    // figures, so the reader has the headline without reading the columns.
    const total = document.createElement("p");
    total.className = "metric-total";
    const amount = document.createElement("strong");
    amount.textContent = entry.total.toLocaleString();
    const unit = document.createElement("span");
    unit.textContent = `${entry.unit}${entry.total === 1 ? "" : "s"} in ${rangeDays} days`;
    total.append(amount, unit);

    const plot = document.createElement("div");
    plot.className = "metric-plot";
    const tooltip = document.createElement("div");
    tooltip.className = "chart-tooltip";
    tooltip.hidden = true;
    plot.append(createChart(entry, tooltip), tooltip);

    panel.append(heading, total, plot);
    return panel;
  }

  function renderTable(entries) {
    tableBody.replaceChildren();
    const keys = entries[0]?.keys || [];
    tableCaption.textContent = `Daily counts over the last ${keys.length} days`;

    keys.forEach((key, index) => {
      const row = document.createElement("tr");
      const day = document.createElement("th");
      day.setAttribute("scope", "row");
      day.textContent = formatLongDay(key);
      row.append(day);
      entries.forEach((entry) => {
        const cell = document.createElement("td");
        cell.textContent = String(entry.values[index]);
        row.append(cell);
      });
      tableBody.append(row);
    });
  }

  function render() {
    series = buildDailyMetrics({ attendance, photos, days: rangeDays });
    panelHost.replaceChildren(...series.map(createPanel));
    renderTable(series);
    panelHost.dataset.stale = "false";
  }

  // --- Loading ---------------------------------------------------------------

  async function loadAllPhotos() {
    const loaded = [];
    let after = null;
    for (let page = 0; page < MAX_PHOTO_PAGES; page += 1) {
      const result = await cloud.getPhotosPage({ pageSize: PHOTO_PAGE_SIZE, after });
      loaded.push(...(result.photos || []));
      if (!result.hasMore || !result.after) break;
      after = result.after;
    }
    return [...new Map(loaded.map((photo) => [photo.id, photo])).values()];
  }

  async function loadMetrics() {
    if (!signedInUser || loading) return;
    loading = true;
    refreshButton.disabled = true;
    // The frame is kept while it reloads: no skeleton, no jump.
    if (panelHost.children.length > 0) panelHost.dataset.stale = "true";
    setStatus("Loading metrics…", "loading");

    const now = () => (typeof performance !== "undefined" && performance?.now ? performance.now() : Date.now());
    const startedAt = now();
    const traceId = telemetry?.createTraceId?.();

    try {
      const [entries, loadedPhotos] = await Promise.all([
        cloud.getAttendance({ pageSize: 500 }),
        loadAllPhotos(),
      ]);
      attendance = entries || [];
      photos = loadedPhotos;
      render();
      setStatus("");
      telemetry?.event(
        "metrics.load.completed",
        {
          durationMs: now() - startedAt,
          checkInCount: attendance.length,
          photoCount: photos.length,
          status: "success",
        },
        { traceId },
      );
    } catch (error) {
      panelHost.dataset.stale = "false";
      setStatus(describeError(error), "error");
      telemetry?.event(
        "metrics.load.failed",
        {
          durationMs: now() - startedAt,
          errorCode: telemetry?.safeErrorCode?.(error, "metrics_failed") || "metrics_failed",
          status: "failed",
        },
        { traceId, immediate: true, dedupeMs: 60000 },
      );
    } finally {
      loading = false;
      refreshButton.disabled = false;
    }
  }

  // --- Controls --------------------------------------------------------------

  rangeGroup?.addEventListener("click", (event) => {
    const option = event.target.closest?.(".range-option");
    if (!option) return;
    const days = Number(option.dataset.days);
    if (!Number.isFinite(days) || days === rangeDays) return;
    rangeDays = days;
    [...rangeGroup.querySelectorAll(".range-option")].forEach((entry) => {
      entry.setAttribute("aria-pressed", String(Number(entry.dataset.days) === rangeDays));
    });
    // The slice changes for every panel and the table at once, so the numbers
    // on screen always describe the same days.
    if (signedInUser) render();
  });

  tableToggle?.addEventListener("click", () => {
    const open = tableWrap.hidden;
    tableWrap.hidden = !open;
    tableToggle.setAttribute("aria-expanded", String(open));
    tableToggle.textContent = open ? "Hide table" : "Show table";
  });

  refreshButton?.addEventListener("click", loadMetrics);

  signInButton?.addEventListener("click", async () => {
    signInButton.disabled = true;
    try {
      await cloud.signIn();
    } catch (error) {
      setStatus(describeError(error), "error");
    } finally {
      signInButton.disabled = false;
    }
  });

  signOutButton?.addEventListener("click", () => cloud.signOut());

  if (!cloud || !data) {
    setStatus("The metrics dependencies are unavailable. Reload the page.", "error");
    return;
  }

  cloud.subscribeAuth(async (user, error) => {
    signedInUser = user;
    authGate.hidden = Boolean(user);
    workspace.hidden = !user;
    signOutButton.hidden = !user;
    accountName.textContent = user?.email || "";
    if (error) {
      setStatus(describeError(error), "error");
      telemetry?.event(
        "cloud.auth.failed",
        { errorCode: telemetry.safeErrorCode(error, "auth_failed"), status: "failed" },
        { immediate: true, dedupeMs: 60000 },
      );
      return;
    }
    telemetry?.event("cloud.auth.state", {
      status: user ? "signed_in" : "signed_out",
    });
    if (!user) {
      attendance = [];
      photos = [];
      panelHost.replaceChildren();
      setStatus("");
      return;
    }
    await loadMetrics();
  });
})(typeof window !== "undefined" ? window : globalThis);
