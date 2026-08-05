(function initializeApp() {
  "use strict";

  const service = window.StampNoteAddress;
  const stamp = window.StampNoteStamp;
  const locateButton = document.querySelector("#locate-button");
  const buttonLabel = document.querySelector(".locate-button-label");
  const addressField = document.querySelector("#address-field");
  const status = document.querySelector("#location-status");
  const addressPanel = document.querySelector("#address-panel");
  const previews = document.querySelector("#previews");
  const saveButton = document.querySelector("#save-button");
  const shareButton = document.querySelector("#share-button");
  const photoInputs = document.querySelectorAll("#camera-input, #gallery-input");

  if (!service || !stamp || !locateButton || !addressField || !status || !addressPanel) {
    return;
  }

  // One entry per chosen photo: the loaded image, its capture time, its canvas.
  const photos = [];

  function setStatus(message, state = "idle") {
    status.textContent = message;
    status.dataset.state = state;
  }

  function setLoading(isLoading) {
    locateButton.disabled = isLoading;
    buttonLabel.textContent = isLoading ? "Locating…" : "Use current location";
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
    return {
      isSecureContext: window.isSecureContext !== false,
      userAgent: navigator.userAgent || "",
      maxTouchPoints: navigator.maxTouchPoints || 0,
    };
  }

  function userMessage(error) {
    return service.describeGeolocationError(error, environment());
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

    saveButton.hidden = false;
    if (shareButton && typeof navigator.canShare === "function") {
      shareButton.hidden = false;
    }
    document.body.classList.add("is-stamped");
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

  // Called straight from the button's click handler: getCurrentPosition has to
  // run while the tap is still the current task, or iOS Safari treats it as an
  // unprompted request and rejects it.
  async function requestLocation({ focusField = true } = {}) {
    if (environment().isSecureContext === false) {
      setStatus(userMessage(null), "error");
      return;
    }

    setLoading(true);
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
      if (focusField) {
        addressField.focus();
      }
      render();
    } catch (error) {
      setStatus(userMessage(error), "error");
    } finally {
      setLoading(false);
    }
  }

  // Photos finish loading asynchronously, so by the time we get here the tap
  // that picked them no longer counts as user activation. iOS Safari denies
  // geolocation asked for outside a gesture without ever showing the prompt,
  // and remembers that denial for the site — which used to block every later
  // press of the button too. So only locate on our own when permission is
  // already granted; otherwise invite the user to tap.
  async function autoLocate() {
    const context = environment();

    if (context.isSecureContext === false) {
      setStatus(userMessage(null), "error");
      return;
    }

    const state = await service.getPermissionState(navigator.permissions);

    if (state === "granted") {
      requestLocation({ focusField: false });
      return;
    }

    if (state === "denied") {
      setStatus(userMessage({ code: 1 }), "error");
      return;
    }

    setStatus("Tap “Use current location” to stamp the street address.");
  }

  async function addPhotos(files) {
    const loaded = await Promise.allSettled([...files].map(loadPhoto));
    const failed = loaded.filter((entry) => entry.status === "rejected");

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
      setStatus("Sharing is not available here — save the photo instead.", "error");
      return;
    }

    try {
      await navigator.share({ files });
    } catch (error) {
      if (error?.name !== "AbortError") {
        setStatus("Sharing failed — save the photo instead.", "error");
      }
    }
  }

  function save() {
    photos.forEach((photo, index) => {
      if (!photo.canvas) {
        return;
      }

      const link = document.createElement("a");
      link.href = photo.canvas.toDataURL("image/jpeg", 0.92);
      link.download = `stamped-${index + 1}-${(photo.name || "photo").replace(/\.[^.]+$/, "")}.jpg`;
      link.click();
    });
  }

  photoInputs.forEach((input) => {
    input.addEventListener("change", () => {
      if (input.files && input.files.length > 0) {
        addPhotos(input.files);
      }
    });
  });

  addressField.addEventListener("input", render);
  locateButton.addEventListener("click", () => requestLocation());
  saveButton?.addEventListener("click", save);

  // Only offer the button where the browser can actually share files.
  if (shareButton && typeof navigator.canShare === "function") {
    shareButton.addEventListener("click", share);
  }
})();
