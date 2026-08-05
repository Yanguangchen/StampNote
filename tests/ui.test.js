const assert = require("node:assert/strict");
const { readFileSync, existsSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");

const projectRoot = resolve(__dirname, "..");
const html = readFileSync(resolve(projectRoot, "index.html"), "utf8");
const css = readFileSync(resolve(projectRoot, "styles.css"), "utf8");
const addressService = require(resolve(projectRoot, "address-service.js"));

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tagWithId(tagName, id) {
  const pattern = new RegExp(
    `<${tagName}\\b(?=[^>]*\\bid=["']${escapeRegExp(id)}["'])[^>]*>`,
    "i",
  );
  const match = html.match(pattern);
  assert.ok(match, `Expected a <${tagName}> with id="${id}"`);
  return match[0];
}

function hasAttribute(tag, name, expectedValue) {
  if (expectedValue === undefined) {
    return new RegExp(`\\s${name}(?:\\s|=|/?>)`, "i").test(tag);
  }

  return new RegExp(
    `\\s${name}=["']${escapeRegExp(expectedValue)}["']`,
    "i",
  ).test(tag);
}

test("page has the required HTML foundation", () => {
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html\s+lang=["']en["']/i);
  assert.match(
    html,
    /<meta\s+name=["']viewport["']\s+content=["']width=device-width, initial-scale=1\.0["']/i,
  );
  assert.match(html, /<link\s+rel=["']stylesheet["']\s+href=["']styles\.css["']/i);
  assert.ok(existsSync(resolve(projectRoot, "styles.css")));
});

test("camera control requests the rear-facing camera", () => {
  const cameraInput = tagWithId("input", "camera-input");

  assert.ok(hasAttribute(cameraInput, "type", "file"));
  assert.ok(hasAttribute(cameraInput, "accept", "image/*"));
  assert.ok(hasAttribute(cameraInput, "capture", "environment"));
  assert.equal(hasAttribute(cameraInput, "multiple"), false);
});

test("gallery control accepts multiple images", () => {
  const galleryInput = tagWithId("input", "gallery-input");

  assert.ok(hasAttribute(galleryInput, "type", "file"));
  assert.ok(hasAttribute(galleryInput, "accept", "image/*"));
  assert.ok(hasAttribute(galleryInput, "multiple"));
  assert.equal(hasAttribute(galleryInput, "capture"), false);
});

test("upload controls have visible, correctly wired labels", () => {
  assert.match(
    html,
    /<label\b[^>]*for=["']camera-input["'][^>]*>[\s\S]*?Open camera[\s\S]*?<\/label>/i,
  );
  assert.match(
    html,
    /<label\b[^>]*for=["']gallery-input["'][^>]*>[\s\S]*?Choose from gallery[\s\S]*?<\/label>/i,
  );
});

test("annotation preview describes an address and date-time", () => {
  assert.match(html, /Street address/i);
  assert.match(html, /Date &amp; time/i);
  assert.match(html, /10 BAYFRONT AVE, SINGAPORE/i);
  assert.match(html, /05 AUG 2026 · 14:32/i);
});

test("street-address controls are present and accessible", () => {
  const locateButton = tagWithId("button", "locate-button");
  const addressField = tagWithId("textarea", "address-field");

  assert.ok(hasAttribute(locateButton, "type", "button"));
  assert.ok(hasAttribute(addressField, "autocomplete", "street-address"));
  assert.match(html, /<label\b[^>]*for=["']address-field["'][^>]*>Street address<\/label>/i);
  assert.match(html, /id=["']location-status["'][^>]*role=["']status["'][^>]*aria-live=["']polite["']/i);
  assert.match(html, /OpenStreetMap contributors/i);
});

test("geolocation helper resolves coordinates and accuracy", async () => {
  const fakeGeolocation = {
    getCurrentPosition(success, _error, options) {
      assert.equal(options.enableHighAccuracy, true);
      success({ coords: { latitude: 1.2834, longitude: 103.8607, accuracy: 12.5 } });
    },
  };

  const result = await addressService.getCurrentCoordinates(fakeGeolocation);
  assert.deepEqual(result, { latitude: 1.2834, longitude: 103.8607, accuracy: 12.5 });
});

test("reverse geocoder requests one detailed address and formats the response", async () => {
  let requestedUrl;
  const fakeFetch = async (url, options) => {
    requestedUrl = new URL(url);
    assert.equal(options.headers.Accept, "application/json");
    return {
      ok: true,
      async json() {
        return {
          display_name: "10 Bayfront Avenue, Downtown Core, Singapore 018956",
          address: {
            house_number: "10",
            road: "Bayfront Avenue",
            suburb: "Downtown Core",
            postcode: "018956",
            country: "Singapore",
          },
        };
      },
    };
  };

  const result = await addressService.reverseGeocode(1.2834, 103.8607, {
    fetchImplementation: fakeFetch,
    language: "en-SG",
  });

  assert.equal(requestedUrl.hostname, "nominatim.openstreetmap.org");
  assert.equal(requestedUrl.pathname, "/reverse");
  assert.equal(requestedUrl.searchParams.get("format"), "jsonv2");
  assert.equal(requestedUrl.searchParams.get("zoom"), "18");
  assert.equal(requestedUrl.searchParams.get("layer"), "address");
  assert.equal(requestedUrl.searchParams.get("accept-language"), "en-SG");
  assert.equal(result.address, "10 Bayfront Avenue");
});

test("formatter keeps only the street number and name", () => {
  assert.equal(
    addressService.formatAddress({
      display_name: "10, Bayfront Avenue, Downtown Core, Singapore 018956, Singapore",
      address: {
        house_number: "10",
        road: "Bayfront Avenue",
        suburb: "Downtown Core",
        state: "Central Region",
        postcode: "018956",
        country: "Singapore",
      },
    }),
    "10 Bayfront Avenue",
  );

  assert.equal(
    addressService.formatAddress({ address: { road: "Orchard Road", city: "Singapore" } }),
    "Orchard Road",
  );

  // Falls back to display_name, still trimmed to the street.
  assert.equal(
    addressService.formatAddress({
      display_name: "10, Bayfront Avenue, Downtown Core, Singapore 018956",
    }),
    "10 Bayfront Avenue",
  );

  assert.equal(addressService.formatAddress({}), "");
});

test("reverse geocoder reports service and empty-address failures", async () => {
  await assert.rejects(
    addressService.reverseGeocode(1.28, 103.86, {
      fetchImplementation: async () => ({ ok: false, status: 503 }),
    }),
    /returned 503/,
  );

  await assert.rejects(
    addressService.reverseGeocode(1.28, 103.86, {
      fetchImplementation: async () => ({ ok: true, json: async () => ({}) }),
    }),
    /No street address/,
  );
});

test("CSS includes keyboard focus, mobile layout, and reduced motion support", () => {
  assert.match(css, /\.visually-hidden:focus\s*\+\s*\.button/);
  assert.match(css, /@media\s*\(max-width:\s*900px\)/);
  assert.match(css, /@media\s*\(max-width:\s*560px\)/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
});
