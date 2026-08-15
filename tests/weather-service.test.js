const assert = require("node:assert/strict");
const { test } = require("node:test");

const weather = require("../weather-service.js");

// One day of hourly columns, in the shape Open-Meteo answers with.
function payload(hours) {
  return {
    hourly: {
      time: hours.map((entry) => entry.time),
      precipitation: hours.map((entry) => entry.precipitation ?? 0),
      weather_code: hours.map((entry) => entry.code ?? 0),
      wind_gusts_10m: hours.map((entry) => entry.gust ?? 8),
      temperature_2m: hours.map((entry) => entry.temperature ?? 30),
    },
  };
}

function hour(hourOfDay, overrides = {}) {
  return { time: `2026-08-13T${String(hourOfDay).padStart(2, "0")}:00`, ...overrides };
}

const AFTERNOON = { dateKey: "2026-08-13", fromHour: 12, toHour: 17 };

test("the request names one place, one day, and the site's own clock", () => {
  const url = new URL(
    weather.buildWeatherUrl({
      latitude: 1.28683,
      longitude: 103.85447,
      dateKey: "2026-08-13",
      now: Date.parse("2026-08-16T00:00:00Z"),
    }),
  );

  assert.equal(url.origin + url.pathname, "https://api.open-meteo.com/v1/forecast");
  assert.equal(url.searchParams.get("latitude"), "1.2868");
  assert.equal(url.searchParams.get("longitude"), "103.8545");
  assert.equal(url.searchParams.get("start_date"), "2026-08-13");
  assert.equal(url.searchParams.get("end_date"), "2026-08-13");
  // The session's hours mean what they meant on site, not in the reader's zone.
  assert.equal(url.searchParams.get("timezone"), "auto");
  assert.match(url.searchParams.get("hourly"), /precipitation/);
  assert.match(url.searchParams.get("hourly"), /weather_code/);
  assert.match(url.searchParams.get("hourly"), /wind_gusts_10m/);

  // A day older than the forecast service keeps comes from the archive instead.
  const old = new URL(
    weather.buildWeatherUrl({
      latitude: 1.2868,
      longitude: 103.8545,
      dateKey: "2026-01-05",
      now: Date.parse("2026-08-16T00:00:00Z"),
    }),
  );
  assert.equal(old.origin + old.pathname, "https://archive-api.open-meteo.com/v1/archive");

  assert.throws(() => weather.buildWeatherUrl({ latitude: 200, longitude: 0, dateKey: "2026-08-13" }), /latitude/);
  assert.throws(() => weather.buildWeatherUrl({ latitude: 1, longitude: 0, dateKey: "13-08-2026" }), /calendar date/);
});

test("a storm in the session's own hours is called a storm", () => {
  const rows = weather.readHourlyRows(
    payload([
      hour(11, { precipitation: 9, code: 95, gust: 70 }),
      hour(13, { precipitation: 6.4, code: 95, gust: 74 }),
      hour(14, { precipitation: 2.1, code: 61, gust: 40 }),
      hour(15, { precipitation: 0, code: 3, gust: 20 }),
      hour(16, { precipitation: 0, code: 1, gust: 14 }),
    ]),
  );

  const summary = weather.summarizeSessionWeather(rows, AFTERNOON);
  assert.equal(summary.severity, "storm");
  assert.equal(summary.condition, "Thunderstorm");
  // The 11:00 downpour belongs to the morning and is not counted here.
  assert.equal(summary.precipitationMm, 8.5);
  assert.equal(summary.maxGustKph, 74);
  assert.equal(summary.wetHours, 2);
  assert.equal(summary.hours, 4);
  assert.equal(summary.delayNote, "Delays likely");
  assert.equal(weather.delaysLikely(summary), true);
  // One statement, read at a glance: what it was, and what it cost. One stopped
  // hour and one halved of four is a moderate loss, not a severe one — the
  // condition and the cost are two separate questions.
  assert.equal(weather.describeSessionWeather(summary), "Thunderstorm, moderate impact");
  assert.equal(weather.weatherIcon(summary), weather.ICONS.storm);
  // The figures stay available for a reader who wants to check the claim.
  assert.match(weather.describeWeatherFigures(summary), /8.5 mm/);
  assert.match(weather.describeWeatherFigures(summary), /gusts 74 km\/h/);
});

test("rain without thunder is wet, a passing shower is not, and a dry day is dry", () => {
  const wet = weather.summarizeSessionWeather(
    weather.readHourlyRows(
      payload([hour(12, { precipitation: 1.8, code: 63 }), hour(13, { precipitation: 0, code: 3 })]),
    ),
    AFTERNOON,
  );
  assert.equal(wet.severity, "wet");
  assert.equal(wet.condition, "Rain");
  assert.equal(weather.delaysLikely(wet), true);

  const damp = weather.summarizeSessionWeather(
    weather.readHourlyRows(payload([hour(12, { precipitation: 0.4, code: 51 })])),
    AFTERNOON,
  );
  assert.equal(damp.severity, "damp");
  // A shower is worth mentioning but is not an alert.
  assert.equal(weather.delaysLikely(damp), false);
  // A shower is worth an icon and a word, not a warning.
  assert.equal(damp.delayNote, "");

  const dry = weather.summarizeSessionWeather(
    weather.readHourlyRows(payload([hour(12, { code: 0 }), hour(13, { code: 1 })])),
    AFTERNOON,
  );
  assert.equal(dry.severity, "dry");
  assert.equal(dry.delayNote, "");
  assert.equal(weather.delaysLikely(dry), false);
  // The worst hour names the session, so a clear hour and a mainly clear one
  // read as the latter.
  assert.equal(weather.describeSessionWeather(dry), "Mainly clear, no impact");
  assert.equal(weather.weatherIcon(dry), weather.ICONS.partly);
  // The example the statement is modelled on.
  assert.equal(weather.describeSessionWeather(damp), "Drizzle, low impact");
  assert.equal(weather.weatherIcon(damp), weather.ICONS.drizzle);
});

test("a gale on a dry day still counts as a storm", () => {
  const summary = weather.summarizeSessionWeather(
    weather.readHourlyRows(payload([hour(12, { code: 3, gust: 82 }), hour(13, { code: 2, gust: 61 })])),
    AFTERNOON,
  );
  assert.equal(summary.severity, "storm");
  assert.equal(summary.precipitationMm, 0);
  assert.equal(summary.maxGustKph, 82);
});

test("a session with no weather record says so rather than claiming it was fine", () => {
  const empty = weather.summarizeSessionWeather([], AFTERNOON);
  assert.equal(empty.severity, "unknown");
  assert.equal(empty.precipitationMm, null);
  assert.equal(weather.describeSessionWeather(empty), "");
  assert.equal(weather.delaysLikely(empty), false);

  // Hours belonging to another day never leak into this one.
  const otherDay = weather.summarizeSessionWeather(
    weather.readHourlyRows(payload([{ time: "2026-08-12T13:00", precipitation: 20, code: 95 }])),
    AFTERNOON,
  );
  assert.equal(otherDay.severity, "unknown");
});

test("the day is fetched once and read as rows", async () => {
  const calls = [];
  const rows = await weather.fetchDayWeather({
    latitude: 1.2868,
    longitude: 103.8545,
    dateKey: "2026-08-13",
    now: Date.parse("2026-08-14T00:00:00Z"),
    fetchImplementation: async (url) => {
      calls.push(url);
      return { ok: true, json: async () => payload([hour(12, { precipitation: 3, code: 61 })]) };
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(rows, [
    {
      dateKey: "2026-08-13",
      hour: 12,
      precipitationMm: 3,
      weatherCode: 61,
      gustKph: 8,
      temperatureC: 30,
    },
  ]);

  await assert.rejects(
    weather.fetchDayWeather({
      latitude: 1.2868,
      longitude: 103.8545,
      dateKey: "2026-08-13",
      fetchImplementation: async () => ({ ok: false, status: 503 }),
    }),
    /503/,
  );
});

test("the productivity cost is counted hour by hour, not judged in one go", () => {
  // Five worked hours: one stopped by a storm, one halved by rain, one nicked
  // by a shower, two clear. 1 + 0.5 + 0.15 = 1.65 of 5, which is 33%.
  const summary = weather.summarizeSessionWeather(
    weather.readHourlyRows(
      payload([
        hour(12, { precipitation: 8, code: 95, gust: 68 }),
        hour(13, { precipitation: 2.2, code: 63 }),
        hour(14, { precipitation: 0.3, code: 51 }),
        hour(15, { code: 1 }),
        hour(16, { code: 0 }),
      ]),
    ),
    AFTERNOON,
  );

  assert.equal(summary.lostHours, 1.7);
  assert.equal(summary.impactPercent, 33);
  // A third of the session gone reads as moderate rather than as a percentage
  // the reader has to interpret.
  assert.equal(weather.impactBand(summary).id, "moderate");
  assert.equal(weather.describeProductivityImpact(summary), "moderate impact");
  assert.equal(weather.describeSessionWeather(summary), "Thunderstorm, moderate impact");
});

test("a dry session states its cost too, and a storm that never let up costs all of it", () => {
  const dry = weather.summarizeSessionWeather(
    weather.readHourlyRows(payload([hour(12, { code: 0 }), hour(13, { code: 2 })])),
    AFTERNOON,
  );
  assert.equal(dry.lostHours, 0);
  assert.equal(dry.impactPercent, 0);
  // Stated with every reading: "no impact" is an answer, not a silence.
  assert.equal(weather.describeProductivityImpact(dry), "no impact");
  assert.equal(weather.describeSessionWeather(dry), "Partly cloudy, no impact");

  const washout = weather.summarizeSessionWeather(
    weather.readHourlyRows(
      payload([
        hour(12, { precipitation: 14, code: 95, gust: 80 }),
        hour(13, { precipitation: 11, code: 99, gust: 77 }),
      ]),
    ),
    AFTERNOON,
  );
  assert.equal(washout.impactPercent, 100);
  assert.equal(washout.lostHours, 2);
  assert.equal(weather.describeProductivityImpact(washout), "severe impact");

  // A session with no record makes no claim about what it cost.
  assert.equal(weather.describeProductivityImpact(weather.summarizeSessionWeather([], AFTERNOON)), "");
});

test("an hour is judged on rain, thunder or wind alone", () => {
  assert.equal(weather.hourSeverity({ weatherCode: 95, precipitationMm: 0 }), "storm");
  // A gale in dry air stops work as surely as rain does.
  assert.equal(weather.hourSeverity({ weatherCode: 3, gustKph: 64 }), "storm");
  assert.equal(weather.hourSeverity({ weatherCode: 63, precipitationMm: 0 }), "wet");
  assert.equal(weather.hourSeverity({ weatherCode: 3, precipitationMm: 1.4 }), "wet");
  assert.equal(weather.hourSeverity({ weatherCode: 51, precipitationMm: 0 }), "damp");
  assert.equal(weather.hourSeverity({ weatherCode: 3, precipitationMm: 0.1 }), "dry");
  assert.equal(weather.hourSeverity({ weatherCode: 0 }), "dry");
});

test("a reading read back from storage keeps its cost and regains its wording", () => {
  const restored = weather.restoreSessionWeather({
    severity: "wet",
    condition: "Rain",
    precipitationMm: 4.2,
    maxGustKph: 22,
    temperatureC: 27,
    wetHours: 3,
    hours: 6,
    lostHours: 2.1,
    impactPercent: 35,
    provisional: true,
    recordedAtMs: 1786635912000,
  });

  // The words are put back rather than stored over and over.
  assert.equal(restored.label, "Wet");
  assert.equal(restored.delayNote, "Delays possible");
  assert.equal(restored.impactPercent, 35);
  assert.equal(weather.describeSessionWeather(restored), "Rain, moderate impact");
  assert.equal(weather.weatherIcon(restored), weather.ICONS.rain);
  assert.equal(restored.provisional, true);
  assert.equal(weather.restoreSessionWeather(null), null);
  assert.equal(weather.restoreSessionWeather({}), null);
});

test("a session is provisional only until its own hours are over", () => {
  const afternoonOf = (dateKey) => ({ dateKey, toHour: 17 });
  const duringTheSession = new Date(2026, 7, 13, 14, 0).getTime();
  const afterTheSession = new Date(2026, 7, 13, 18, 0).getTime();

  assert.equal(weather.sessionWindowEnded(afternoonOf("2026-08-13"), duringTheSession), false);
  assert.equal(weather.sessionWindowEnded(afternoonOf("2026-08-13"), afterTheSession), true);
  // A day with no readable date is never treated as finished.
  assert.equal(weather.sessionWindowEnded({ dateKey: "unknown-date", toHour: 17 }), false);
});
