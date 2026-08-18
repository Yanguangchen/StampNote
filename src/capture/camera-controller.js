(function initializeCaptureCamera(globalScope) {
  "use strict";

  function describeCameraError(error, environment = {}) {
    if (environment.isSecureContext === false) {
      return "The camera needs a secure page. Open this site over https:// (or on localhost).";
    }

    switch (error?.name) {
      case "NotAllowedError":
        return "Camera permission was denied — allow it in your browser's site settings and start again.";
      case "NotFoundError":
      case "OverconstrainedError":
        return "No camera was found on this device.";
      case "NotReadableError":
        return "The camera is already in use by another app.";
      default:
        return error?.message || "The camera could not be started.";
    }
  }

  function videoRequest(cameraFacing, facing) {
    return {
      video: cameraFacing
        ? cameraFacing.videoConstraints(facing, { width: 1920, height: 1080, frameRate: 30 })
        : {
            facingMode: facing,
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            frameRate: { ideal: 30 },
          },
      audio: false,
    };
  }

  const api = Object.freeze({
    describeCameraError,
    videoRequest,
  });
  globalScope.StampNoteCaptureCamera = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
