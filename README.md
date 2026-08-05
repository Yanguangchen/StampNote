# StampNote

StampNote is a browser-based image annotation toolkit for field photos, site visits, deliveries, inspections, and personal records. Users can take a new photo or choose images from their device, then stamp each image with its location and capture date/time.

## Current milestone: front-end UI

This first milestone includes:

- A responsive landing and upload workspace
- A mobile camera input using `capture="environment"`
- A gallery picker that accepts one or more images
- A visual preview of the planned street address and date/time stamps
- Accessible labels, keyboard focus states, and mobile-friendly controls

The camera and gallery controls are native HTML file inputs, so the browser keeps the selected photos on the user's device. Annotation and download logic will be added in the next milestone. The address will be obtained by reverse-geocoding the device or photo coordinates without embedding a map SDK, with manual entry available as a fallback.

## Run locally

Start the local server, then open `http://127.0.0.1:8080` in a modern browser:

```sh
npm start
```

Using localhost is important because browsers restrict precise geolocation to secure contexts. No third-party packages are required.

For the best camera experience, open the page on a mobile device. Browser camera behavior varies by device: supported mobile browsers open the rear camera, while desktop browsers generally show a file picker.

## Automated tests

Node.js 18 or newer is required. Run the suite with:

```sh
npm test
```

The suite checks the page foundation, camera and gallery input contracts, accessible label wiring, address lookup service, date/time stamp copy, responsive CSS, and reduced-motion support. It uses Node's built-in test runner and has no third-party test dependencies.

## Planned workflow

1. Take a photo or choose one or more images.
2. Allow location access or enter a location manually.
3. Review and reposition the location and date/time stamp.
4. Export the annotated image without uploading the original to a server.

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

After the user presses the location button, the prototype sends the device's current coordinates to OpenStreetMap's public Nominatim reverse-geocoding service. The result is cached for the browser session, displayed with attribution, and remains editable. This public endpoint is suitable for a moderate prototype under its usage policy; substantial production traffic should use a dedicated provider or hosted Nominatim instance.
