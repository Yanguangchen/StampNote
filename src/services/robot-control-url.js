(function initializeRobotControlUrl(globalScope) {
  "use strict";

  const IPV4 =
    /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

  function parseRobotControlUrl(raw, urlCtor = globalScope.URL) {
    const trimmed = String(raw ?? "").trim();
    if (!trimmed) {
      return { ok: false, error: "Enter a robot IP address." };
    }
    if (trimmed.length > 128 || /[\s<>"'`]/.test(trimmed)) {
      return { ok: false, error: "Enter a robot IP address, like 192.168.1.50." };
    }
    if (/^(javascript|data|file|blob|vbscript):/i.test(trimmed)) {
      return { ok: false, error: "Use an http or https robot address." };
    }

    const candidate = /^[a-zA-Z][a-zA-Z+\-.]*:/.test(trimmed) ? trimmed : `http://${trimmed}`;
    let parsed;
    try {
      parsed = new urlCtor(candidate);
    } catch {
      return { ok: false, error: "Enter a robot IP address, like 192.168.1.50." };
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
      return { ok: false, error: "Enter a robot IP address, like 192.168.1.50." };
    }

    return { ok: true, href: String(parsed.href), host: String(parsed.host) };
  }

  const api = { parseRobotControlUrl };
  globalScope.StampNoteRobotControlUrl = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
