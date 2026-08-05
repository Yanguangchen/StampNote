# StampNote

StampNote is a browser-based image annotation toolkit for field photos, site visits, deliveries, inspections, and personal records. Users can take a new photo or choose images from their device, then stamp each image with its location and capture date/time.

## Current milestone: front-end UI

This first milestone includes:

- A responsive landing and upload workspace
- A mobile camera input using `capture="environment"`
- A gallery picker that accepts one or more images
- Icon-only controls, each with a hidden text name and a pointer tooltip
- Accessible labels, keyboard focus states, and mobile-friendly controls

The camera and gallery controls are native HTML file inputs, so the browser keeps the selected photos on the user's device. Annotation and download logic will be added in the next milestone. The address will be obtained by reverse-geocoding the device or photo coordinates without embedding a map SDK, with manual entry available as a fallback.

## Run locally

Start the local server, then open `http://127.0.0.1:8080` in a modern browser:

```sh
npm start
```

Using localhost is important because browsers restrict precise geolocation to secure contexts. No third-party packages are required.

To try it from a phone, reach the page over HTTPS (a tunnel or the deployed URL). Safari refuses
geolocation on a plain `http://` LAN address and reports it as a permission failure.

iOS Safari only shows the location prompt for a request made during a tap, so the app asks for a
position from the "Use current location" button and never on its own — it auto-fills after an upload
only when permission was already granted. If location was denied earlier, Safari keeps denying it
silently; re-enable it with "aA" in the address bar → Website Settings → Location → Allow.

For the best camera experience, open the page on a mobile device. Browser camera behavior varies by device: supported mobile browsers open the rear camera, while desktop browsers generally show a file picker.

## Automated tests

Node.js 18 or newer is required. Run the suite with:

```sh
npm test
```

The suite checks the page foundation, camera and gallery input contracts, accessible label wiring, address lookup service, date/time stamp copy, responsive CSS, and reduced-motion support. It uses Node's built-in test runner and has no third-party test dependencies.

## Planned workflow

1. Take a photo or choose one or more images.
2. The street address fills in automatically where the browser allows it; otherwise type it in.
3. The stamped image saves itself once the address settles — no button to press.
4. Share the result through the OS share sheet, without uploading the original to a server.

## Project files

- `index.html` — page structure and upload controls
- `styles.css` — responsive visual design
- `address-service.js` — geolocation and reverse-geocoding functions
- `app.js` — street-address interface behavior and session caching
- `server.js` — dependency-free local development server
- `tests/ui.test.js` — automated front-end contract tests
- `package.json` — test command and project metadata
- `README.md` — product scope and development notes

## Next milestone

Connect the working address field to the image preview, draw the address and date/time annotation onto a canvas, and download the finished images.

## Address data

On upload, the prototype sends the device's current coordinates to OpenStreetMap's public Nominatim reverse-geocoding service. The result is cached for the browser session and remains editable. The on-page OpenStreetMap
attribution was removed at the client's request; ODbL still requires attributing OSM wherever the
data is shown, so it should be restored — in the stamp, an about screen, or the share text — before
this goes public. This public endpoint is suitable for a moderate prototype under its usage policy; substantial production traffic should use a dedicated provider or hosted Nominatim instance.
