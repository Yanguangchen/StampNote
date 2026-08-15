(function initializeFrameScaler(globalScope) {
  "use strict";

  // The camera is opened at photo resolution because the saved photograph wants
  // it. Every model, though, shrinks what it is handed before looking at it, so
  // passing the video element itself makes each one upload and resize two
  // megapixels of its own — three of them on the tick that takes attendance,
  // each in its own WebGL context. Drawing the frame down once and handing that
  // to all of them pays for the resize a single time.
  //
  // The width is chosen from what the face pipeline asks for rather than from
  // what looks good. Enrollment wants eyes at least `enrollmentMinimumEyePixels`
  // apart and at least `enrollmentMinimumEyeRatio` of the frame apart, and at
  // 960 those two gates fall in the same place, so shrinking to here asks no
  // more of the worker than the full frame did. The recognition crop wants the
  // eyes 54px apart, which a face filling the guide still clears.
  const INFERENCE_WIDTH = 960;

  function sizeOf(source) {
    return {
      width: Number(source?.videoWidth || source?.naturalWidth || source?.width || 0),
      height: Number(source?.videoHeight || source?.naturalHeight || source?.height || 0),
    };
  }

  function createFrameScaler(options = {}) {
    const documentRef = options.document || globalScope.document;
    const targetWidth = Number(options.width) || INFERENCE_WIDTH;
    let canvas = null;
    let context = null;

    // Returns the frame the models should read: the shared downscaled copy, or
    // the source untouched when it is already small enough or cannot be drawn.
    function scale(source) {
      const { width, height } = sizeOf(source);
      if (!width || !height || width <= targetWidth || !documentRef?.createElement) {
        return source;
      }

      const scaledHeight = Math.max(1, Math.round((height * targetWidth) / width));

      try {
        if (!canvas) {
          canvas = documentRef.createElement("canvas");
          // No `willReadFrequently` here: everything downstream draws from this
          // canvas or uploads it as a texture, and nothing reads its pixels
          // back, so it is left where the GPU can keep it.
          context = canvas.getContext("2d", { alpha: false });
        }
        if (!context) return source;
        if (canvas.width !== targetWidth || canvas.height !== scaledHeight) {
          canvas.width = targetWidth;
          canvas.height = scaledHeight;
        }
        context.drawImage(source, 0, 0, targetWidth, scaledHeight);
        return canvas;
      } catch {
        // A frame the browser will not draw yet is better handed on whole than
        // dropped: the models refuse it themselves if it is unusable.
        return source;
      }
    }

    function release() {
      if (canvas) {
        canvas.width = 1;
        canvas.height = 1;
      }
      canvas = null;
      context = null;
    }

    return Object.freeze({ scale, release });
  }

  const api = Object.freeze({ INFERENCE_WIDTH, createFrameScaler });
  globalScope.StampNoteFrameScaler = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
