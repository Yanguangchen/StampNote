(function initializeApp() {
  "use strict";

  const service = window.StampNoteAddress;
  const stamp = window.StampNoteStamp;
  const addressField = document.querySelector("#address-field");
  const status = document.querySelector("#location-status");
  const addressPanel = document.querySelector("#address-panel");
  const previews = document.querySelector("#previews");
  const shareButton = document.querySelector("#share-button");
  const diagnostics = document.querySelector("#location-diagnostics");
  const diagnosticsBody = document.querySelector("#location-diagnostics-body");
  const photoInputs = document.querySelectorAll("#camera-input, #gallery-input");

  if (!service || !stamp || !addressField || !status || !addressPanel) {
    return;
  }

  // One entry per chosen photo: the loaded image, its capture time, its canvas.
  const photos = [];

  // Long enough that typing an address does not save a file per keystroke.
  const AUTO_SAVE_DELAY = 1500;
  let autoSaveTimer = null;
  let autoSaved = false;

  function setStatus(message, state = "idle") {
    status.textContent = message;
    status.dataset.state = state;
  }

  function readCache(key) {
    try {
      return window.sessionStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function writeCache(key, value) {
    try {
      window.sessionStorage.setItem(key, value);
    } catch {
      // Private browsing can disable storage; address lookup still works.
    }
  }

  function environment() {
    let embedded = false;
    try {
      embedded = window.top !== window.self;
    } catch {
      // A cross-origin parent throws on access, which is itself the answer.
      embedded = true;
    }

    return {
      isSecureContext: window.isSecureContext !== false,
      userAgent: navigator.userAgent || "",
      maxTouchPoints: navigator.maxTouchPoints || 0,
      standalone:
        navigator.standalone === true ||
        window.matchMedia?.("(display-mode: standalone)").matches === true,
      embedded,
    };
  }

  function userMessage(error) {
    return service.describeGeolocationError(error, environment());
  }

  // The message alone cannot say which of the several iOS blocks is in play,
  // so the details stay on screen for the user to read back.
  async function showDiagnostics(error) {
    if (!diagnostics || !diagnosticsBody) {
      return;
    }

    diagnosticsBody.textContent = service.describeEnvironment(environment(), {
      permissionState: await service.getPermissionState(navigator.permissions),
      errorCode: error?.code,
      errorMessage: error?.message,
      hasGeolocation: typeof navigator.geolocation?.getCurrentPosition === "function",
    });
    diagnostics.hidden = false;
  }

  function render() {
    if (photos.length === 0) {
      return;
    }

    previews.replaceChildren();

    photos.forEach((photo) => {
      photo.canvas = stamp.drawStampedImage(photo.image, {
        address: addressField.value,
        date: photo.date,
      });
      photo.canvas.className = "preview";
      previews.append(photo.canvas);
    });

    if (shareButton && typeof navigator.canShare === "function") {
      shareButton.hidden = false;
    }
    document.body.classList.add("is-stamped");
    scheduleAutoSave();
  }

  // The file downloads on its own once the stamp settles, so nothing has to be
  // pressed. It waits for an address to avoid saving a half-finished stamp, and
  // saves one set per upload so editing afterwards does not pile up files.
  function scheduleAutoSave() {
    if (autoSaved || !addressField.value.trim()) {
      return;
    }

    window.clearTimeout(autoSaveTimer);
    autoSaveTimer = window.setTimeout(autoSave, AUTO_SAVE_DELAY);
  }

  async function autoSave() {
    const stamped = photos.filter((photo) => photo.canvas);
    const files = (await Promise.all(stamped.map(toFile))).filter(Boolean);

    if (files.length === 0) {
      return;
    }

    autoSaved = true;

    files.forEach((file) => {
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");

      link.href = url;
      link.download = file.name;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10000);
    });

    setStatus(files.length === 1 ? "Saved." : `Saved ${files.length} photos.`, "success");
  }

  function loadPhoto(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();

      image.addEventListener("load", () => {
        URL.revokeObjectURL(url);
        resolve({ image, date: new Date(file.lastModified || Date.now()), name: file.name });
      });
      image.addEventListener("error", () => {
        URL.revokeObjectURL(url);
        reject(new Error(`${file.name} could not be opened.`));
      });

      image.src = url;
    });
  }

  async function requestLocation({ focusField = true } = {}) {
    if (environment().isSecureContext === false) {
      setStatus(userMessage(null), "error");
      showDiagnostics(null);
      return;
    }

    setStatus("Locating…");

    try {
      const coordinates = await service.getCurrentCoordinates(navigator.geolocation);
      const cacheKey = service.createCacheKey(coordinates.latitude, coordinates.longitude);
      let address = readCache(cacheKey);

      if (!address) {
        setStatus("Looking up address…");
        const result = await service.reverseGeocode(coordinates.latitude, coordinates.longitude, {
          language: navigator.language || "en",
        });
        address = result.address;
        writeCache(cacheKey, address);
      }

      setStatus("", "success");
      addressField.value = address;
      if (diagnostics) {
        diagnostics.hidden = true;
      }
      if (focusField) {
        addressField.focus();
      }
      render();
    } catch (error) {
      setStatus(userMessage(error), "error");
      showDiagnostics(error);
    }
  }

  // With no location button left, this automatic attempt is the only chance to
  // fill the address, so it runs whenever permission has not already been
  // refused. Browsers that prompt without a gesture (desktop Safari, Chrome,
  // Firefox) still ask here; iOS refuses a request made outside a tap and no
  // longer has a tap to offer, so it falls through to typing.
  async function autoLocate() {
    const context = environment();

    if (context.isSecureContext === false) {
      setStatus(userMessage(null), "error");
      showDiagnostics(null);
      return;
    }

    const blocked =
      (await service.getPermissionState(navigator.permissions)) === "denied" ||
      service.isInAppBrowser(context) ||
      context.embedded;

    if (blocked) {
      setStatus("Type the street address above.");
      showDiagnostics({ code: 1 });
      return;
    }

    requestLocation({ focusField: false });
  }

  async function addPhotos(files) {
    const loaded = await Promise.allSettled([...files].map(loadPhoto));
    const failed = loaded.filter((entry) => entry.status === "rejected");

    // A new upload is a new set to save.
    window.clearTimeout(autoSaveTimer);
    autoSaved = false;

    photos.length = 0;
    loaded
      .filter((entry) => entry.status === "fulfilled")
      .forEach((entry) => photos.push(entry.value));

    if (photos.length === 0) {
      setStatus("That photo could not be opened.", "error");
      return;
    }

    render();

    const firstRun = addressPanel.hidden;
    addressPanel.hidden = false;

    if (failed.length > 0) {
      setStatus(`${failed.length} photo(s) could not be opened.`, "error");
      return;
    }

    if (firstRun) {
      autoLocate();
    }
  }

  function toFile(photo, index) {
    return new Promise((resolve) => {
      photo.canvas.toBlob(
        (blob) => {
          const name = `stamped-${index + 1}-${(photo.name || "photo").replace(/\.[^.]+$/, "")}.jpg`;
          resolve(blob ? new File([blob], name, { type: "image/jpeg" }) : null);
        },
        "image/jpeg",
        0.92,
      );
    });
  }

  // Hands the stamped photos to the OS share sheet, where Telegram (and any
  // other installed app) shows up as a target. There is no way to post into a
  // Telegram chat directly from a page.
  async function share() {
    const stamped = photos.filter((photo) => photo.canvas);
    const files = (await Promise.all(stamped.map(toFile))).filter(Boolean);

    if (files.length === 0 || !navigator.canShare?.({ files })) {
      setStatus("Sharing is not available here — press and hold the photo to save it.", "error");
      return;
    }

    try {
      await navigator.share({ files });
    } catch (error) {
      if (error?.name !== "AbortError") {
        setStatus("Sharing failed — press and hold the photo to save it.", "error");
      }
    }
  }

  photoInputs.forEach((input) => {
    input.addEventListener("change", () => {
      if (input.files && input.files.length > 0) {
        addPhotos(input.files);
      }
    });
  });

  addressField.addEventListener("input", render);

  // Only offer the button where the browser can actually share files.
  if (shareButton && typeof navigator.canShare === "function") {
    shareButton.addEventListener("click", share);
  }
})();
