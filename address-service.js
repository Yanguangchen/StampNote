(function initializeAddressService(globalScope) {
  "use strict";

  const ENDPOINT = "https://nominatim.openstreetmap.org/reverse";
  const GEOLOCATION_OPTIONS = Object.freeze({
    enableHighAccuracy: true,
    timeout: 12000,
    maximumAge: 30000,
  });

  function getCurrentCoordinates(geolocation, options = GEOLOCATION_OPTIONS) {
    return new Promise((resolve, reject) => {
      if (!geolocation || typeof geolocation.getCurrentPosition !== "function") {
        reject(new Error("Geolocation is not supported by this browser."));
        return;
      }

      geolocation.getCurrentPosition(
        (position) => {
          resolve({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
          });
        },
        reject,
        options,
      );
    });
  }

  function buildReverseGeocodeUrl(latitude, longitude, language = "en") {
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      throw new TypeError("Latitude must be a number between -90 and 90.");
    }
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw new TypeError("Longitude must be a number between -180 and 180.");
    }

    const url = new URL(ENDPOINT);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("lat", String(latitude));
    url.searchParams.set("lon", String(longitude));
    url.searchParams.set("zoom", "18");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("layer", "address");
    url.searchParams.set("accept-language", language || "en");
    return url.toString();
  }

  // Keep only the street number and name; region, postcode and country are dropped.
  function formatAddress(result) {
    const address = result?.address || {};
    const road = address.road || address.pedestrian || address.footway;

    if (road) {
      return [address.house_number, road].filter(Boolean).join(" ").trim();
    }

    if (typeof result?.display_name === "string" && result.display_name.trim()) {
      const segments = result.display_name
        .split(",")
        .map((segment) => segment.trim())
        .filter(Boolean);
      // A leading bare number is the house number, so it belongs with the street.
      const streetOnly = /^\d+[a-z]?$/i.test(segments[0] || "")
        ? segments.slice(0, 2)
        : segments.slice(0, 1);

      return streetOnly.join(" ");
    }

    return "";
  }

  async function reverseGeocode(latitude, longitude, options = {}) {
    const fetchImplementation = options.fetchImplementation || globalScope.fetch;
    if (typeof fetchImplementation !== "function") {
      throw new Error("Address lookup is not available in this browser.");
    }

    const response = await fetchImplementation(
      buildReverseGeocodeUrl(latitude, longitude, options.language),
      { headers: { Accept: "application/json" } },
    );

    if (!response.ok) {
      throw new Error(`Address service returned ${response.status}.`);
    }

    const raw = await response.json();
    const address = formatAddress(raw);
    if (!address) {
      throw new Error("No street address was found for this location.");
    }

    return { address, raw };
  }

  function createCacheKey(latitude, longitude) {
    return `stampnote:address:${latitude.toFixed(5)},${longitude.toFixed(5)}`;
  }

  const api = Object.freeze({
    GEOLOCATION_OPTIONS,
    buildReverseGeocodeUrl,
    createCacheKey,
    formatAddress,
    getCurrentCoordinates,
    reverseGeocode,
  });

  globalScope.StampNoteAddress = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
