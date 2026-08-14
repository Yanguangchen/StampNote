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
    embedded:
      "This page is embedded in another site, which is not allowed to share your location. " +
      "Open it in its own tab.",
    inAppBrowser:
      "You are in an app's built-in browser, which cannot ask for location. " +
      "Tap the ⋯ or share button and choose “Open in Safari”, then try again.",
    iosDenied:
      "Location is blocked for this site. 1) iOS Settings → Privacy & Security → Location Services → " +
      "on, and Safari Websites → While Using the App. 2) Back in Safari, tap “aA” in the address bar → " +
      "Website Settings → Location → Allow. Then reload and tap the button again.",
    denied: "Location permission was denied — allow it in your browser's site settings and reload.",
    unavailable: "Location unavailable — check location services and try again.",
    timeout: "Location timed out — check your connection and try again.",
  });

  // iPadOS 13+ reports a desktop user agent, so touch support is the tiebreaker.
  function isIosBrowser(environment = {}) {
    const userAgent = environment.userAgent || "";
    return (
      /iPad|iPhone|iPod/.test(userAgent) ||
      (/Macintosh/.test(userAgent) && (environment.maxTouchPoints || 0) > 1)
    );
  }

  // Every in-app browser on iOS (Telegram, Instagram, WeChat, …) is a WKWebView
  // whose host app usually has no location permission of its own, so the request
  // is refused before Safari's prompt would appear. Real Safari always sends a
  // "Version/" token; a WKWebView does not. Home Screen apps skip the token too,
  // but navigator.standalone identifies them and they can hold permission.
  function isInAppBrowser(environment = {}) {
    const userAgent = environment.userAgent || "";

    if (/FBAN|FBAV|Instagram|MicroMessenger|Line\/|Twitter|BytedanceWebview/.test(userAgent)) {
      return true;
    }

    if (!isIosBrowser(environment) || environment.standalone === true) {
      return false;
    }

    return !/Version\/\d/.test(userAgent);
  }

  function describeGeolocationError(error, environment = {}) {
    if (environment.isSecureContext === false) {
      return HELP.insecure;
    }

    switch (error?.code) {
      case 1:
        if (environment.embedded === true) {
          return HELP.embedded;
        }
        if (isInAppBrowser(environment)) {
          return HELP.inAppBrowser;
        }
        return isIosBrowser(environment) ? HELP.iosDenied : HELP.denied;
      case 2:
        return HELP.unavailable;
      case 3:
        return HELP.timeout;
      default:
        return error?.message || "Address not found.";
    }
  }

  // Shown on screen after a failure so the cause can be reported accurately;
  // every value comes from this browser, nothing is sent anywhere.
  function describeEnvironment(environment = {}, extra = {}) {
    return [
      `secure context: ${environment.isSecureContext !== false}`,
      `permission: ${extra.permissionState || "unknown"}`,
      `error: ${extra.errorCode === undefined ? "none" : `code ${extra.errorCode}`}` +
        (extra.errorMessage ? ` (${extra.errorMessage})` : ""),
      `geolocation api: ${extra.hasGeolocation === false ? "missing" : "present"}`,
      `embedded: ${environment.embedded === true}`,
      `home screen app: ${environment.standalone === true}`,
      `in-app browser: ${isInAppBrowser(environment)}`,
      `ios: ${isIosBrowser(environment)}`,
      `ua: ${environment.userAgent || "unknown"}`,
    ].join("\n");
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
    describeEnvironment,
    describeGeolocationError,
    formatAddress,
    getCurrentCoordinates,
    getPermissionState,
    isInAppBrowser,
    isIosBrowser,
    reverseGeocode,
  });

  globalScope.StampNoteAddress = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
