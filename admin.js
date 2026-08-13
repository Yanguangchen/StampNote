(function initializeAdminDashboard() {
  "use strict";

  const cloud = window.StampNoteFirebase;
  const data = window.StampNoteCloudData;
  const telemetry = window.StampNoteObservability;
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
  const dialogPeople = document.querySelector("#dialog-people");
  const dialogReview = document.querySelector("#dialog-review");
  const attendanceRefresh = document.querySelector("#attendance-refresh");
  const attendanceWorkerFilter = document.querySelector("#attendance-worker-filter");
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
  let attendance = [];
  let renderVersion = 0;
  const photoUrls = new Map();

  function setStatus(message, state = "idle") {
    status.textContent = message;
    status.dataset.state = state;
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

  function attendanceForSelectedWorker() {
    const selectedWorkerId = attendanceWorkerFilter.value;
    return selectedWorkerId === "all"
      ? attendance
      : attendance.filter((entry) => entry.workerId === selectedWorkerId);
  }

  function updateAttendanceWorkerOptions() {
    const selectedWorkerId = attendanceWorkerFilter.value || "all";
    const workers = summarizeAttendance(attendance).sort((left, right) =>
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

  function updateAttendanceStatus(entries) {
    const workers = summarizeAttendance(entries);
    const workerCount = workers.length;
    const checkInCount = entries.length;
    if (attendanceWorkerFilter.value === "all") {
      attendanceStatus.textContent = `${workerCount} worker${workerCount === 1 ? "" : "s"} · ${checkInCount} recent check-in${checkInCount === 1 ? "" : "s"}`;
      return;
    }
    const worker = workers[0];
    attendanceStatus.textContent = `${worker?.displayName || attendanceWorkerFilter.value} · ${checkInCount} recent check-in${checkInCount === 1 ? "" : "s"}`;
  }

  function groupAttendance(entries) {
    const locations = new Map();

    entries.forEach((entry) => {
      const location = String(entry.location || "").trim() || "Location not recorded";
      const locationKey = location.toLocaleLowerCase();
      const dateKey = /^\d{4}-\d{2}-\d{2}$/.test(entry.dateKey || "")
        ? entry.dateKey
        : "Unknown date";
      const locationGroup = locations.get(locationKey) || {
        location,
        dates: new Map(),
      };
      const dateEntries = locationGroup.dates.get(dateKey) || [];
      dateEntries.push(entry);
      locationGroup.dates.set(dateKey, dateEntries);
      locations.set(locationKey, locationGroup);
    });

    return [...locations.values()]
      .map((location) => ({
        location: location.location,
        dates: [...location.dates.entries()]
          .map(([dateKey, dateEntries]) => ({
            dateKey,
            entries: dateEntries,
            workers: summarizeAttendance(dateEntries),
          }))
          .sort((left, right) => right.dateKey.localeCompare(left.dateKey)),
      }))
      .sort((left, right) => left.location.localeCompare(right.location));
  }

  function createAttendanceRow(worker) {
    const row = document.createElement("article");
    const avatar = document.createElement("span");
    const identity = document.createElement("div");
    const name = document.createElement("strong");
    const workerId = document.createElement("span");
    const timing = document.createElement("div");
    const statusBadge = document.createElement("span");
    const firstIn = document.createElement("span");
    const detail = document.createElement("span");

    row.className = "attendance-row";
    avatar.className = "attendance-avatar";
    avatar.textContent = workerInitials(worker);
    identity.className = "attendance-identity";
    name.textContent = worker.displayName;
    workerId.textContent = worker.workerId;
    timing.className = "attendance-timing";
    statusBadge.className = "attendance-badge";
    statusBadge.textContent = "Present";
    firstIn.textContent = `First in ${formatAttendanceTime(worker.firstInAtMs)}`;
    const latest =
      worker.checkIns > 1 ? ` · Last ${formatAttendanceTime(worker.latestAtMs)}` : "";
    detail.textContent = `${worker.checkIns} check-in${worker.checkIns === 1 ? "" : "s"}${latest}`;

    identity.append(name, workerId);
    timing.append(statusBadge, firstIn, detail);
    row.append(avatar, identity, timing);
    return row;
  }

  function createAttendanceLocationGroup(group) {
    const section = document.createElement("section");
    const heading = document.createElement("div");
    const title = document.createElement("h3");
    const count = document.createElement("span");
    const checkIns = group.dates.reduce(
      (total, dateGroup) => total + dateGroup.entries.length,
      0,
    );

    section.className = "attendance-location-group";
    heading.className = "attendance-location-heading";
    title.textContent = group.location;
    count.textContent = `${checkIns} check-in${checkIns === 1 ? "" : "s"}`;
    heading.append(title, count);
    section.append(heading);

    group.dates.forEach((dateGroup) => {
      const dateSection = document.createElement("section");
      const dateHeading = document.createElement("h4");
      const rows = document.createElement("div");

      dateSection.className = "attendance-date-group";
      dateHeading.className = "attendance-date-heading";
      dateHeading.textContent = formatDate(dateGroup.dateKey);
      rows.className = "attendance-date-rows";
      dateGroup.workers.forEach((worker) => rows.append(createAttendanceRow(worker)));
      dateSection.append(dateHeading, rows);
      section.append(dateSection);
    });

    return section;
  }

  function renderAttendance() {
    const visibleAttendance = attendanceForSelectedWorker();
    const workers = summarizeAttendance(visibleAttendance);
    const groups = groupAttendance(visibleAttendance);
    presentWorkerCount.textContent = String(workers.length);
    attendanceCheckinCount.textContent = String(visibleAttendance.length);
    attendanceList.replaceChildren();

    if (workers.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty-attendance";
      empty.textContent = attendance.length
        ? "No attendance has been recorded for this worker."
        : "No matched worker attendance has been recorded yet.";
      attendanceList.append(empty);
      return;
    }

    groups.forEach((group) => attendanceList.append(createAttendanceLocationGroup(group)));
  }

  async function loadAttendance() {
    if (!signedInUser || loadingAttendance) return;
    loadingAttendance = true;
    attendanceRefresh.disabled = true;
    attendanceWorkerFilter.disabled = true;
    attendanceStatus.textContent = "Loading attendance…";
    attendanceStatus.dataset.state = "idle";
    const startedAt = performance.now();
    const traceId = telemetry?.createTraceId();

    try {
      attendance = await cloud.getAttendance({
        pageSize: 500,
      });
      updateAttendanceWorkerOptions();
      renderAttendance();
      updateAttendanceStatus(attendanceForSelectedWorker());
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
      updateAttendanceWorkerOptions();
      renderAttendance();
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
      attendanceWorkerFilter.disabled = attendance.length === 0;
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

  function createPhotoCard(photo, version) {
    const card = document.createElement("article");
    const button = document.createElement("button");
    const frame = document.createElement("div");
    const image = new Image();
    const badge = document.createElement("span");
    const meta = document.createElement("span");
    const time = document.createElement("strong");
    const people = document.createElement("span");
    const size = document.createElement("span");

    card.className = "photo-card";
    button.className = "photo-open";
    button.type = "button";
    button.setAttribute("aria-label", `Open photo from ${formatDateTime(photo)}`);
    frame.className = "photo-frame";
    image.alt = "";
    image.loading = "lazy";
    badge.className = "photo-badge";
    badge.dataset.flagged = String(data.isFlagged(photo));
    badge.textContent = reviewLabel(photo);
    meta.className = "photo-meta";
    time.textContent = formatTime(photo);
    people.className = "photo-people";
    if (photo.uniquePeopleSeen === null || photo.uniquePeopleSeen === undefined) {
      people.textContent = "Unique count unavailable";
    } else {
      const uniquePeople = Math.max(0, Math.floor(Number(photo.uniquePeopleSeen) || 0));
      people.textContent = `${uniquePeople} unique ${uniquePeople === 1 ? "person" : "people"}`;
    }
    size.textContent = photo.imageBytes
      ? `${Math.max(1, Math.round(Number(photo.imageBytes) / 1024))} KB`
      : "";

    frame.append(image, badge);
    meta.append(time, people, size);
    button.append(frame, meta);
    button.addEventListener("click", () => openPhoto(photo));
    card.append(button);

    loadImage(image, photo, version);
    return card;
  }

  function renderPhotos() {
    renderVersion += 1;
    const version = renderVersion;
    const mode = filter.value;
    const visible = photos.filter((photo) => {
      if (mode === "flagged") {
        return data.isFlagged(photo);
      }
      if (mode === "kept") {
        return !data.isFlagged(photo);
      }
      return true;
    });
    const groups = data.groupPhotos(visible);

    library.replaceChildren();

    if (groups.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty-library";
      empty.textContent =
        photos.length === 0
          ? "No reviewed photos have reached Firebase yet. A complete Gemini batch contains eight photos."
          : "No photos match this filter.";
      library.append(empty);
    }

    groups.forEach((location) => {
      const section = document.createElement("section");
      const heading = document.createElement("div");
      const title = document.createElement("h2");
      const count = document.createElement("span");

      section.className = "location-group";
      heading.className = "location-heading";
      title.textContent = location.location;
      const locationCount = location.dates.reduce(
        (total, dateGroup) => total + dateGroup.photos.length,
        0,
      );
      count.textContent = `${locationCount} photo${locationCount === 1 ? "" : "s"}`;
      heading.append(title, count);
      section.append(heading);

      location.dates.forEach((dateGroup) => {
        const dateSection = document.createElement("section");
        const dateHeading = document.createElement("h3");
        const grid = document.createElement("div");

        dateSection.className = "date-group";
        dateHeading.className = "date-heading";
        dateHeading.textContent = formatDate(dateGroup.dateKey);
        grid.className = "photo-grid";
        dateGroup.photos.forEach((photo) => grid.append(createPhotoCard(photo, version)));
        dateSection.append(dateHeading, grid);
        section.append(dateSection);
      });

      library.append(section);
    });

    setStatus(
      `${visible.length} of ${photos.length} loaded photo${photos.length === 1 ? "" : "s"}`,
    );
    loadMoreRow.hidden = !hasMore;
  }

  async function loadPhotos({ reset = false } = {}) {
    if (!signedInUser || loading) {
      return;
    }

    loading = true;
    const startedAt = performance.now();
    const traceId = telemetry?.createTraceId();
    loadMoreButton.disabled = true;
    setStatus(reset ? "Loading your cloud photos…" : "Loading more photos…");
    telemetry?.event(
      "dashboard.load.started",
      { photoCount: photos.length, online: navigator.onLine !== false },
      { traceId },
    );

    try {
      const page = await cloud.getPhotosPage({ pageSize: 48, after: reset ? null : after });
      const entries = reset ? page.photos : [...photos, ...page.photos];
      photos = [...new Map(entries.map((photo) => [photo.id, photo])).values()];
      after = page.after;
      hasMore = page.hasMore;
      renderPhotos();
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
      library.replaceChildren();
      attendance = [];
      updateAttendanceWorkerOptions();
      attendanceList.replaceChildren();
      presentWorkerCount.textContent = "0";
      attendanceCheckinCount.textContent = "0";
      attendanceStatus.textContent = "";
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
  filter.addEventListener("change", renderPhotos);
  attendanceWorkerFilter.addEventListener("change", () => {
    const visibleAttendance = attendanceForSelectedWorker();
    renderAttendance();
    updateAttendanceStatus(visibleAttendance);
  });
  attendanceRefresh.addEventListener("click", loadAttendance);
  window.addEventListener("pagehide", revokePhotoUrls);

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
    }
  });
})();
