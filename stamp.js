(function initializeStamp(globalScope) {
  "use strict";

  const MONTHS = [
    "JAN",
    "FEB",
    "MAR",
    "APR",
    "MAY",
    "JUN",
    "JUL",
    "AUG",
    "SEP",
    "OCT",
    "NOV",
    "DEC",
  ];

  // The bar is only as tall as one line of text plus its breathing room.
  function computeStampLayout(width) {
    const fontSize = Math.max(16, Math.min(Math.round(width * 0.045), 76));
    const paddingY = Math.round(fontSize * 0.6);
    const paddingX = Math.round(fontSize * 1.1);

    return {
      fontSize,
      paddingX,
      paddingY,
      barHeight: fontSize + paddingY * 2,
    };
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function formatStampTime(date) {
    const value = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();

    return [
      `${pad(value.getDate())} ${MONTHS[value.getMonth()]} ${value.getFullYear()}`,
      `${pad(value.getHours())}:${pad(value.getMinutes())}`,
    ].join(" · ");
  }

  // Shrinks the address until both halves fit on the single line.
  function fitAddress(context, address, available) {
    if (!address || context.measureText(address).width <= available) {
      return address;
    }

    let text = address;
    while (text.length > 1 && context.measureText(`${text}…`).width > available) {
      text = text.slice(0, -1);
    }

    return `${text.trim()}…`;
  }

  function drawStampedImage(image, options = {}) {
    const documentRef = options.document || globalScope.document;
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    const layout = computeStampLayout(width);
    const timestamp = formatStampTime(options.date);
    const address = (options.address || "").trim().toUpperCase();

    const bar = layout.barHeight;

    // Location rides above the photo, date and time below it.
    const canvas = documentRef.createElement("canvas");
    canvas.width = width;
    canvas.height = height + bar * 2;

    const context = canvas.getContext("2d");
    context.drawImage(image, 0, bar, width, height);

    context.fillStyle = "#0d1512";
    context.fillRect(0, 0, width, bar);
    context.fillRect(0, bar + height, width, bar);

    context.fillStyle = "#ffffff";
    context.font = `500 ${layout.fontSize}px ui-monospace, "DM Mono", "SFMono-Regular", monospace`;
    context.textBaseline = "middle";
    context.textAlign = "center";

    const available = width - layout.paddingX * 2;
    const centre = width / 2;

    context.fillText(fitAddress(context, address, available), centre, bar / 2);
    context.fillText(timestamp, centre, bar + height + bar / 2);

    return canvas;
  }

  const api = Object.freeze({
    computeStampLayout,
    drawStampedImage,
    formatStampTime,
  });

  globalScope.StampNoteStamp = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
