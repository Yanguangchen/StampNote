(function initializeAddressService(globalScope) {
  "use strict";

  const ENDPOINT = "https://nominatim.openstreetmap.org/reverse";
  const GEOLOCATION_OPTIONS = Object.freeze({
    enableHighAccuracy: true,
    timeout: 12000,
    maximumAge: 30000,
  });

  const HELP = Object.freeze({
    insecure:
      "Location needs a secure page. Open this site over https:// (or on localhost) and try again.",
    iosDenied:
      "Location is blocked for this site. In Safari tap “aA” in the address bar → Website Settings → Location → Allow, then tap the button again.",
    denied: "Location permission was denied — allow it in your browser's site settings, " +
      "or type the address below.",
    unavailable: "Location unavailable — type the address below.",
    timeout: "Location timed out — try again, or type the address below.",
  });

  // iPadOS 13+ reports a desktop user agent, so touch support is the tiebreaker.
  function isIosBrowser(environment = {}) {
    const userAgent = environment.userAgent || "";
    return (
      /iPad|iPhone|iPod/.test(userAgent) ||
      (/Macintosh/.test(userAgent) && (environment.maxTouchPoints || 0) > 1)
    );
  }

  function describeGeolocationError(error, environment = {}) {
    if (environment.isSecureContext === false) {
      return HELP.insecure;
    }

    switch (error?.code) {
      case 1:
        return isIosBrowser(environment) ? HELP.iosDenied : HELP.denied;
      case 2:
        return HELP.unavailable;
      case 3:
        return HELP.timeout;
      default:
        return error?.message || "Address not found.";
    }
  }

  // "unknown" whenever the browser cannot tell us: Safari has only recently
  // exposed geolocation through the Permissions API, and older builds reject
  // the query outright.
  async function getPermissionState(permissions) {
    if (!permissions || typeof permissions.query !== "function") {
      return "unknown";
    }

    try {
      const status = await permissions.query({ name: "geolocation" });
      return status?.state || "unknown";
    } catch {
      return "unknown";
    }
  }

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
    describeGeolocationError,
    formatAddress,
    getCurrentCoordinates,
    getPermissionState,
    isIosBrowser,
    reverseGeocode,
  });

  globalScope.StampNoteAddress = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
