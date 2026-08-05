(function initializeApp() {
  "use strict";

  const service = window.StampNoteAddress;
  const locateButton = document.querySelector("#locate-button");
  const buttonLabel = document.querySelector(".locate-button-label");
  const addressField = document.querySelector("#address-field");
  const status = document.querySelector("#location-status");
  const addressPanel = document.querySelector("#address-panel");
  const photoInputs = document.querySelectorAll("#camera-input, #gallery-input");

  if (!service || !locateButton || !buttonLabel || !addressField || !status || !addressPanel) {
    return;
  }

  function setStatus(message, state = "idle") {
    status.textContent = message;
    status.dataset.state = state;
  }

  function setLoading(isLoading) {
    locateButton.disabled = isLoading;
    locateButton.classList.toggle("is-loading", isLoading);
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

  function userMessage(error) {
    if (error?.code === 1) {
      return "Permission denied — enter address manually.";
    }
    if (error?.code === 2) {
      return "Location unavailable.";
    }
    if (error?.code === 3) {
      return "Timed out.";
    }
    return error?.message || "Address not found.";
  }

  async function requestLocation({ focusField = true } = {}) {
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
    } catch (error) {
      setStatus(userMessage(error), "error");
    } finally {
      setLoading(false);
    }
  }

  function revealAddressPanel() {
    if (!addressPanel.hidden) {
      return;
    }

    addressPanel.hidden = false;
    requestLocation({ focusField: false });
  }

  photoInputs.forEach((input) => {
    input.addEventListener("change", () => {
      if (input.files && input.files.length > 0) {
        revealAddressPanel();
      }
    });
  });

  locateButton.addEventListener("click", () => requestLocation());
})();
