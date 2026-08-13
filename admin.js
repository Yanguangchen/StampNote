(function initializeAdminDashboard() {
  "use strict";

  const cloud = window.StampNoteFirebase;
  const data = window.StampNoteCloudData;
  const telemetry = window.StampNoteObservability;
  const signInButton = document.querySelector("#sign-in");
  const signOutButton = document.querySelector("#sign-out");
  const authGate = document.querySelector("#auth-gate");
  const accountName = document.querySelector("#account-name");
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
  const systemHealth = document.querySelector("#system-health");
  const systemHealthLabel = document.querySelector("#system-health-label");

  telemetry?.configure({ surface: "dashboard" });

  let signedInUser = null;
  let photos = [];
  let after = null;
  let hasMore = false;
  let loading = false;
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
        return "Create the Firestore database in the Firebase project, then reload this page.";
      default:
        return error?.message || "The cloud photo library could not be loaded.";
    }
  }

  async function checkHealth() {
    const startedAt = performance.now();
    const traceId = telemetry?.createTraceId();
    const liveServer =
      ["127.0.0.1", "localhost"].includes(window.location.hostname) &&
      window.location.port === "5500";
    const endpoint = liveServer
      ? "https://stampnote-omega.vercel.app/api/health"
      : "/api/health";

    try {
      const response = await fetch(endpoint, {
        headers: traceId ? { "X-StampNote-Trace-Id": traceId } : {},
        cache: "no-store",
      });
      const result = await response.json().catch(() => ({}));
      const healthState = result.status === "ok" ? "ok" : "degraded";

      systemHealth.dataset.state = healthState;
      systemHealthLabel.textContent = healthState === "ok" ? "System online" : "System degraded";
      telemetry?.event(
        "health.checked",
        {
          durationMs: performance.now() - startedAt,
          httpStatus: response.status,
          status: healthState,
        },
        { traceId },
      );
    } catch (error) {
      systemHealth.dataset.state = "failed";
      systemHealthLabel.textContent = "System unavailable";
      telemetry?.event(
        "health.checked",
        {
          durationMs: performance.now() - startedAt,
          errorCode: telemetry.safeErrorCode(error, "health_unavailable"),
          status: "failed",
          online: navigator.onLine !== false,
        },
        { traceId, immediate: true },
      );
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
    toolbar.hidden = !user;
    library.hidden = !user;
    signOutButton.hidden = !user;
    accountName.textContent = user?.email || "";

    if (!user) {
      photos = [];
      after = null;
      hasMore = false;
      library.replaceChildren();
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
  window.addEventListener("pagehide", revokePhotoUrls);

  if (!cloud || !data) {
    signInButton.disabled = true;
    setStatus("The Firebase photo client could not be loaded.", "error");
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
    }
  });

  checkHealth();
})();
