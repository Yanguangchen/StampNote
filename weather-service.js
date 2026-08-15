// What the sky was doing while a session was worked. A wet or stormy window is
// the usual reason a session ran late, so the dashboard can say so beside the
// session rather than leaving a reader to remember the day.
//
// Open-Meteo is used the way Nominatim already is on the capture screen: a free
// service, no key, called straight from the browser. Nothing about the site or
// the crew is sent — only a coordinate and a date.
(function initializeWeatherService(globalScope) {
  "use strict";

  const FORECAST_ENDPOINT = "https://api.open-meteo.com/v1/forecast";
  const ARCHIVE_ENDPOINT = "https://archive-api.open-meteo.com/v1/archive";
  // The forecast service keeps roughly three months of the recent past; older
  // days come from the archive, which is complete but lags a few days behind.
  const ARCHIVE_AFTER_DAYS = 60;
  const HOURLY_FIELDS = ["precipitation", "weather_code", "wind_gusts_10m", "temperature_2m"];

  // WMO weather codes, grouped only as finely as a site foreman needs.
  const THUNDERSTORM_CODES = new Set([95, 96, 99]);
  const HEAVY_RAIN_CODES = new Set([65, 67, 82]);
  const RAIN_CODES = new Set([61, 63, 66, 80, 81]);
  const DRIZZLE_CODES = new Set([51, 53, 55, 56, 57]);
  const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);
  const FOG_CODES = new Set([45, 48]);

  // Thresholds a day of work is judged against. Millimetres are the total over
  // the session, not an hourly rate.
  const STORM_GUST_KPH = 60;
  const WET_PRECIPITATION_MM = 1;
  const DAMP_PRECIPITATION_MM = 0.2;

  // What an hour of each kind of weather costs a crew. A storm stops work; rain
  // slows it by about half; a passing shower costs a little. These are the one
  // place the productivity figures come from, so they can be argued with and
  // changed in a single edit.
  const HOUR_IMPACT = Object.freeze({ storm: 1, wet: 0.5, damp: 0.15, dry: 0 });

  const SEVERITY = Object.freeze({
    storm: Object.freeze({ id: "storm", rank: 3, label: "Storm", delay: "Delays likely" }),
    wet: Object.freeze({ id: "wet", rank: 2, label: "Wet", delay: "Delays possible" }),
    // A shower is worth an icon and a word, not a warning.
    damp: Object.freeze({ id: "damp", rank: 1, label: "Showers", delay: "" }),
    dry: Object.freeze({ id: "dry", rank: 0, label: "Dry", delay: "" }),
    unknown: Object.freeze({ id: "unknown", rank: -1, label: "No record", delay: "" }),
  });

  // Decorative glyphs in the same plain style as the dashboard's ☀/☾ theme
  // toggle. The statement beside each one carries the meaning, so a font that
  // renders these differently costs nothing.
  const ICONS = Object.freeze({
    storm: "⛈",
    rain: "🌧",
    drizzle: "🌦",
    snow: "🌨",
    fog: "🌫",
    overcast: "☁",
    partly: "⛅",
    clear: "☀",
    unknown: "—",
  });

  // How much of a session the weather took, said in words rather than a figure
  // a reader would have to interpret.
  const IMPACT_BANDS = Object.freeze([
    Object.freeze({ id: "severe", label: "severe impact", from: 71 }),
    Object.freeze({ id: "high", label: "high impact", from: 41 }),
    Object.freeze({ id: "moderate", label: "moderate impact", from: 16 }),
    Object.freeze({ id: "low", label: "low impact", from: 1 }),
    Object.freeze({ id: "none", label: "no impact", from: 0 }),
  ]);

  function describeWeatherCode(code) {
    const value = Number(code);
    if (THUNDERSTORM_CODES.has(value)) return "Thunderstorm";
    if (HEAVY_RAIN_CODES.has(value)) return "Heavy rain";
    if (RAIN_CODES.has(value)) return "Rain";
    if (DRIZZLE_CODES.has(value)) return "Drizzle";
    if (SNOW_CODES.has(value)) return "Snow";
    if (FOG_CODES.has(value)) return "Fog";
    if (value === 3) return "Overcast";
    if (value === 2) return "Partly cloudy";
    if (value === 1) return "Mainly clear";
    if (value === 0) return "Clear";
    return "Unsettled";
  }

  function iconForCode(code) {
    const value = Number(code);
    if (THUNDERSTORM_CODES.has(value)) return ICONS.storm;
    if (HEAVY_RAIN_CODES.has(value) || RAIN_CODES.has(value)) return ICONS.rain;
    if (DRIZZLE_CODES.has(value)) return ICONS.drizzle;
    if (SNOW_CODES.has(value)) return ICONS.snow;
    if (FOG_CODES.has(value)) return ICONS.fog;
    if (value === 3) return ICONS.overcast;
    if (value === 1 || value === 2) return ICONS.partly;
    if (value === 0) return ICONS.clear;
    return ICONS.unknown;
  }

  // The icon follows the condition that was named, so it always agrees with the
  // words beside it.
  function weatherIcon(summary) {
    if (!summary || summary.severity === "unknown") return ICONS.unknown;
    const named = Object.entries({
      Thunderstorm: ICONS.storm,
      "Heavy rain": ICONS.rain,
      Rain: ICONS.rain,
      Drizzle: ICONS.drizzle,
      Snow: ICONS.snow,
      Fog: ICONS.fog,
      Overcast: ICONS.overcast,
      "Partly cloudy": ICONS.partly,
      "Mainly clear": ICONS.partly,
      Clear: ICONS.clear,
    }).find(([condition]) => condition === summary.condition);
    if (named) return named[1];
    return summary.severity === "dry" ? ICONS.clear : ICONS.rain;
  }

  function impactBand(summary) {
    const percent = Number(summary?.impactPercent);
    if (!summary || summary.severity === "unknown" || !Number.isFinite(percent)) return null;
    return IMPACT_BANDS.find((band) => percent >= band.from) || IMPACT_BANDS[IMPACT_BANDS.length - 1];
  }

  function isWetCode(code) {
    const value = Number(code);
    return (
      THUNDERSTORM_CODES.has(value) ||
      HEAVY_RAIN_CODES.has(value) ||
      RAIN_CODES.has(value) ||
      SNOW_CODES.has(value)
    );
  }

  function toNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  // Open-Meteo returns local times as "2026-08-13T14:00" when asked for the
  // site's own zone, so the hour a session covers is read straight off the
  // string rather than through a Date in the reader's zone.
  function readHourStamp(value) {
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):/.exec(String(value || ""));
    return match ? { dateKey: match[1], hour: Number(match[2]) } : null;
  }

  function daysSince(dateKey, now = Date.now()) {
    const parsed = Date.parse(`${dateKey}T12:00:00Z`);
    if (Number.isNaN(parsed)) return 0;
    return Math.floor((now - parsed) / 86_400_000);
  }

  function buildWeatherUrl(input = {}) {
    const latitude = toNumber(input.latitude);
    const longitude = toNumber(input.longitude);
    const dateKey = String(input.dateKey || "").trim();

    if (latitude === null || latitude < -90 || latitude > 90) {
      throw new TypeError("Weather needs a latitude between -90 and 90.");
    }
    if (longitude === null || longitude < -180 || longitude > 180) {
      throw new TypeError("Weather needs a longitude between -180 and 180.");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
      throw new TypeError("Weather needs a calendar date.");
    }

    const url = new URL(
      daysSince(dateKey, input.now) > ARCHIVE_AFTER_DAYS ? ARCHIVE_ENDPOINT : FORECAST_ENDPOINT,
    );
    url.searchParams.set("latitude", latitude.toFixed(4));
    url.searchParams.set("longitude", longitude.toFixed(4));
    url.searchParams.set("start_date", dateKey);
    url.searchParams.set("end_date", dateKey);
    url.searchParams.set("hourly", HOURLY_FIELDS.join(","));
    // The site's own clock, so a session's hours mean what they meant on site.
    url.searchParams.set("timezone", "auto");
    return url.toString();
  }

  // The hourly arrays come back as parallel columns; this turns them into rows,
  // which is the only shape anything downstream wants.
  function readHourlyRows(payload) {
    const hourly = payload?.hourly;
    const times = Array.isArray(hourly?.time) ? hourly.time : [];

    return times
      .map((time, index) => {
        const stamp = readHourStamp(time);
        if (!stamp) return null;
        return {
          dateKey: stamp.dateKey,
          hour: stamp.hour,
          precipitationMm: toNumber(hourly.precipitation?.[index]) ?? 0,
          weatherCode: toNumber(hourly.weather_code?.[index]),
          gustKph: toNumber(hourly.wind_gusts_10m?.[index]),
          temperatureC: toNumber(hourly.temperature_2m?.[index]),
        };
      })
      .filter(Boolean);
  }

  function hourSeverity(row) {
    const code = Number(row?.weatherCode);
    const precipitationMm = Number(row?.precipitationMm) || 0;
    const gustKph = Number(row?.gustKph);

    if (THUNDERSTORM_CODES.has(code) || (Number.isFinite(gustKph) && gustKph >= STORM_GUST_KPH)) {
      return "storm";
    }
    if (precipitationMm >= WET_PRECIPITATION_MM || isWetCode(code)) return "wet";
    if (precipitationMm >= DAMP_PRECIPITATION_MM || DRIZZLE_CODES.has(code)) return "damp";
    return "dry";
  }

  function unknownWeather() {
    return {
      severity: SEVERITY.unknown.id,
      label: SEVERITY.unknown.label,
      delayNote: "",
      condition: "",
      precipitationMm: null,
      maxGustKph: null,
      temperatureC: null,
      wetHours: 0,
      hours: 0,
      lostHours: null,
      impactPercent: null,
    };
  }

  // Judges one session's window: how much fell, how hard it blew, and the worst
  // thing the sky was doing while the crew was there.
  function summarizeSessionWeather(rows, session = {}) {
    const dateKey = String(session.dateKey || "").trim();
    const fromHour = Number.isFinite(session.fromHour) ? session.fromHour : 0;
    const toHour = Number.isFinite(session.toHour) ? session.toHour : 24;
    const window = (rows || []).filter(
      (row) =>
        (!dateKey || row.dateKey === dateKey) && row.hour >= fromHour && row.hour < toHour,
    );

    if (window.length === 0) return unknownWeather();

    const precipitationMm = window.reduce((total, row) => total + (row.precipitationMm || 0), 0);
    const gusts = window.map((row) => row.gustKph).filter((value) => value !== null);
    const temperatures = window.map((row) => row.temperatureC).filter((value) => value !== null);
    const maxGustKph = gusts.length > 0 ? Math.max(...gusts) : null;
    const codes = window.map((row) => row.weatherCode).filter((value) => value !== null);
    const wetHours = window.filter(
      (row) => (row.precipitationMm || 0) >= DAMP_PRECIPITATION_MM || isWetCode(row.weatherCode),
    ).length;
    // What the weather cost, hour by hour, rather than a judgement about the
    // session as a whole: one stopped hour in five is not a stopped session.
    const lostHours = window.reduce((total, row) => total + HOUR_IMPACT[hourSeverity(row)], 0);
    // The worst code of the window, not the average: a session is remembered by
    // the hour that stopped the work.
    const worstCode = codes.length > 0 ? codes.reduce((worst, code) => (code > worst ? code : worst), codes[0]) : null;

    let severity = SEVERITY.dry;
    if (codes.some((code) => THUNDERSTORM_CODES.has(code)) ||
      (maxGustKph !== null && maxGustKph >= STORM_GUST_KPH)) {
      severity = SEVERITY.storm;
    } else if (precipitationMm >= WET_PRECIPITATION_MM || codes.some(isWetCode)) {
      severity = SEVERITY.wet;
    } else if (precipitationMm >= DAMP_PRECIPITATION_MM || codes.some((code) => DRIZZLE_CODES.has(code))) {
      severity = SEVERITY.damp;
    }

    return {
      severity: severity.id,
      label: severity.label,
      delayNote: severity.delay,
      condition: worstCode === null ? "" : describeWeatherCode(worstCode),
      precipitationMm: Math.round(precipitationMm * 10) / 10,
      maxGustKph: maxGustKph === null ? null : Math.round(maxGustKph),
      temperatureC: temperatures.length > 0
        ? Math.round(temperatures.reduce((total, value) => total + value, 0) / temperatures.length)
        : null,
      wetHours,
      hours: window.length,
      lostHours: Math.round(lostHours * 10) / 10,
      impactPercent: Math.round((lostHours / window.length) * 100),
    };
  }

  // The impact on its own, for anywhere the condition is already named.
  function describeProductivityImpact(summary) {
    return impactBand(summary)?.label || "";
  }

  function severityOf(id) {
    return SEVERITY[String(id || "")] || SEVERITY.unknown;
  }

  // Puts the wording back on a reading that came from storage, so a stored
  // session and a freshly fetched one are the same shape from here on.
  function restoreSessionWeather(stored) {
    if (!stored || !stored.severity) return null;
    const severity = severityOf(stored.severity);
    return {
      severity: severity.id,
      label: severity.label,
      delayNote: severity.delay,
      condition: stored.condition || "",
      lostHours: stored.lostHours ?? null,
      impactPercent: stored.impactPercent ?? null,
      precipitationMm: stored.precipitationMm ?? null,
      maxGustKph: stored.maxGustKph ?? null,
      temperatureC: stored.temperatureC ?? null,
      wetHours: stored.wetHours ?? 0,
      hours: stored.hours ?? 0,
      provisional: stored.provisional === true,
      recordedAtMs: stored.recordedAtMs ?? null,
    };
  }

  // The last hour a session covers, on its own day. Until that hour has passed
  // a reading is partly forecast, and says so.
  function sessionWindowEnded(input = {}, now = Date.now()) {
    const dateKey = String(input.dateKey || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return false;
    const end = new Date(`${dateKey}T00:00:00`);
    if (Number.isNaN(end.getTime())) return false;
    end.setHours(Number.isFinite(input.toHour) ? input.toHour : 24, 0, 0, 0);
    return now > end.getTime();
  }

  // "Drizzle, low impact" — the condition and what it cost, in one glance.
  function describeSessionWeather(summary) {
    if (!summary || summary.severity === SEVERITY.unknown.id) return "";
    const condition = summary.condition || summary.label;
    const band = impactBand(summary);
    return band ? `${condition}, ${band.label}` : condition;
  }

  // The figures behind the statement, for a reader who wants to check it.
  function describeWeatherFigures(summary) {
    if (!summary || summary.severity === SEVERITY.unknown.id) return "";
    const parts = [];
    if (summary.precipitationMm > 0) parts.push(`${summary.precipitationMm} mm`);
    if (summary.maxGustKph !== null && summary.maxGustKph >= STORM_GUST_KPH) {
      parts.push(`gusts ${summary.maxGustKph} km/h`);
    }
    if (summary.lostHours > 0) parts.push(`${summary.lostHours} h lost of ${summary.hours}`);
    if (summary.temperatureC !== null) parts.push(`${summary.temperatureC} °C`);
    return parts.join(" · ");
  }

  function delaysLikely(summary) {
    return Boolean(summary) && (summary.severity === SEVERITY.storm.id || summary.severity === SEVERITY.wet.id);
  }

  async function fetchDayWeather(input = {}) {
    const fetchImplementation = input.fetchImplementation || globalScope.fetch;
    if (typeof fetchImplementation !== "function") {
      throw new Error("Weather lookup is not available in this browser.");
    }

    const response = await fetchImplementation(buildWeatherUrl(input), {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`Weather service returned ${response.status}.`);
    }

    return readHourlyRows(await response.json());
  }

  const api = Object.freeze({
    ARCHIVE_AFTER_DAYS,
    DAMP_PRECIPITATION_MM,
    SEVERITY,
    STORM_GUST_KPH,
    WET_PRECIPITATION_MM,
    HOUR_IMPACT,
    ICONS,
    IMPACT_BANDS,
    buildWeatherUrl,
    describeWeatherFigures,
    impactBand,
    weatherIcon,
    delaysLikely,
    describeProductivityImpact,
    hourSeverity,
    restoreSessionWeather,
    sessionWindowEnded,
    describeSessionWeather,
    describeWeatherCode,
    fetchDayWeather,
    readHourlyRows,
    summarizeSessionWeather,
  });

  globalScope.StampNoteWeather = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
