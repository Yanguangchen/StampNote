(function initializeRobotControlUrl(globalScope) {
  "use strict";

  const IPV4 =
    /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
  const DOMAIN = /^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z](?:[a-z\d-]{0,61}[a-z\d])?\.?$/i;
  const ADDRESS_ERROR = "Enter a robot IP address or HTTPS URL.";

  // The rover's control page, reachable over HTTPS from anywhere. Live tunnel
  // opens it on its own, so nobody has to type an address; another robot can
  // still be opened by its IP or its own HTTPS URL.
  const DEFAULT_ROBOT_CONTROL_URL = "https://rover.webwizardsg.com/";

  function parseRobotControlUrl(raw, urlCtor = globalScope.URL) {
    const trimmed = String(raw ?? "").trim();
    if (!trimmed) {
      return { ok: false, error: ADDRESS_ERROR };
    }
    if (trimmed.length > 2048 || /[\s<>"'`\\]/.test(trimmed)) {
      return { ok: false, error: ADDRESS_ERROR };
    }
    if (/^(javascript|data|file|blob|vbscript):/i.test(trimmed)) {
      return { ok: false, error: "Use an http or https robot address." };
    }

    const candidate = /^[a-zA-Z][a-zA-Z+\-.]*:/.test(trimmed) ? trimmed : `http://${trimmed}`;
    let parsed;
    try {
      parsed = new urlCtor(candidate);
    } catch {
      return { ok: false, error: ADDRESS_ERROR };
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, error: "Use an http or https robot address." };
    }
    if (parsed.username || parsed.password) {
      return { ok: false, error: "Leave the username and password off the robot address." };
    }

    const isIpv4 = IPV4.test(parsed.hostname);
    const isIpv6 = parsed.hostname.includes(":");
    if (!isIpv4 && !isIpv6) {
      if (parsed.hostname.length > 253 || !DOMAIN.test(parsed.hostname)) {
        return { ok: false, error: ADDRESS_ERROR };
      }
      if (parsed.protocol !== "https:") {
        return { ok: false, error: "Use a full HTTPS URL for remote robot controls." };
      }
    }

    return { ok: true, href: String(parsed.href), host: String(parsed.host) };
  }

  const api = { DEFAULT_ROBOT_CONTROL_URL, parseRobotControlUrl };
  globalScope.StampNoteRobotControlUrl = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
