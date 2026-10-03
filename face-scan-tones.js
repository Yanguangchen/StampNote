/* A face scan asks somebody to hold still and look at the camera, which is the
   moment they are least able to read the screen. So each step of the scan is
   also heard: a soft cue when it begins, a tick for every view accepted that
   climbs in pitch as the scan fills, a gentle falling pair when a view is not
   a match yet, a chime when the face is recognised or saved, and a low pair
   when the scan cannot go on. The tones are synthesised on the spot, so there
   is nothing to download and nothing to fail to load. Sound is progressive
   enhancement: a device without Web Audio scans exactly as before. */
(function initializeFaceScanTones(globalScope) {
  "use strict";

  // The shared player loads first on the page; under Node it is required.
  const tonePlayer =
    globalScope.StampNoteTonePlayer ||
    (typeof require === "function" ? require("./tone-player.js") : null);

  const CUES = Object.freeze({
    START: "start",
    SAMPLE: "sample",
    RETRY: "retry",
    COMPLETE: "complete",
    ERROR: "error",
  });

  // A miss keeps the scan going on its own, often for several views in a row,
  // and the guidance can flicker between "move closer" and "no match yet" from
  // one frame to the next. One reminder every few seconds says "still trying"
  // without turning into an alarm.
  const RETRY_INTERVAL_MS = 4000;

  // A cue describes the scan as it is now, so one held up by a locked audio
  // device is dropped rather than played late (see tone-player.js).
  const STALE_CUE_MS = tonePlayer?.STALE_MS || 1000;

  // Statuses that mean the scan has looked and not found what it needs yet.
  // Framing prompts (move closer, centre up, hold still) are left silent: they
  // change with every small movement and the oval already shows them.
  const RETRY_STATUSES = new Set(["retrying", "not_recognized", "not_this_worker"]);

  // A major pentatonic ladder up from C5. Every step sounds consonant with the
  // last, so a scan of three views and one of seven both climb pleasantly and
  // both finish on the same top note.
  const BASE_FREQUENCY = 523.25;
  const LADDER = [0, 2, 4, 7, 9, 12, 14, 16];

  function semitones(base, steps) {
    return base * 2 ** (steps / 12);
  }

  function sampleFrequency(samples, total) {
    const count = Math.max(0, Number(samples) || 0);
    const size = Math.max(1, Number(total) || 1);
    const progress = Math.min(1, count / size);
    const step = Math.min(LADDER.length - 1, Math.max(1, Math.ceil(progress * (LADDER.length - 1))));
    return semitones(BASE_FREQUENCY, LADDER[step]);
  }

  // Each cue is a short phrase of notes: when the note starts relative to the
  // cue, its pitch, how long it rings, its waveform and how loud it peaks.
  // Peaks stay well below the shutter so a scan is never louder than a photo.
  function phrase(cue, detail = {}) {
    switch (cue) {
      case CUES.START:
        return [
          { at: 0, frequency: 392, duration: 0.09, type: "sine", peak: 0.07 },
          { at: 0.1, frequency: 523.25, duration: 0.12, type: "sine", peak: 0.07 },
        ];
      case CUES.SAMPLE:
        return [
          {
            at: 0,
            frequency: sampleFrequency(detail.samples, detail.total),
            duration: 0.11,
            type: "sine",
            peak: 0.08,
          },
        ];
      case CUES.RETRY:
        return [
          { at: 0, frequency: 523.25, duration: 0.12, type: "triangle", peak: 0.06 },
          { at: 0.14, frequency: 392, duration: 0.16, type: "triangle", peak: 0.06 },
        ];
      case CUES.COMPLETE:
        return [
          { at: 0, frequency: 523.25, duration: 0.1, type: "sine", peak: 0.09 },
          { at: 0.08, frequency: 659.25, duration: 0.1, type: "sine", peak: 0.09 },
          { at: 0.16, frequency: 783.99, duration: 0.1, type: "sine", peak: 0.09 },
          { at: 0.24, frequency: 1046.5, duration: 0.34, type: "sine", peak: 0.1 },
        ];
      case CUES.ERROR:
        return [
          { at: 0, frequency: 311.13, duration: 0.16, type: "triangle", peak: 0.08 },
          { at: 0.19, frequency: 233.08, duration: 0.24, type: "triangle", peak: 0.08 },
        ];
      default:
        return [];
    }
  }


  // Works out which cue, if any, the step from one scan state to the next
  // deserves. Pure, so the whole progression can be checked without a speaker.
  // Completion is not decided here: a recognised face and a saved enrollment
  // are each confirmed by the page that knows they happened.
  function planCue(previous, current) {
    if (!current) return null;
    const status = String(current.status || "");
    const samples = Math.max(0, Number(current.samples) || 0);
    if (!previous) {
      return status === "unavailable" ? CUES.ERROR : CUES.START;
    }

    const previousStatus = String(previous.status || "");
    const previousSamples = Math.max(0, Number(previous.samples) || 0);
    if (status === "unavailable") {
      return previousStatus === "unavailable" ? null : CUES.ERROR;
    }
    if (RETRY_STATUSES.has(status) && status !== previousStatus) return CUES.RETRY;
    // Views already counted were thrown away, so the scan is starting over.
    if (samples < previousSamples) return CUES.RETRY;
    if (samples > previousSamples) return CUES.SAMPLE;
    return null;
  }

  // `getContext` lets a page that already holds an AudioContext (the recording
  // page has one for its shutter) share it, so a scan does not open a second
  // audio device. Without one, the first cue opens its own.
  function createFaceScanTones(options = {}) {
    const now = typeof options.now === "function" ? options.now : () => Date.now();
    const player = tonePlayer?.createTonePlayer({
      getContext: options.getContext,
      globalObject: options.globalObject || globalScope,
      now,
      staleMs: STALE_CUE_MS,
    });
    let previous = null;
    let lastRetryAt = -Infinity;

    function play(cue, detail = {}) {
      return player?.playNotes(phrase(cue, detail)) || false;
    }

    function prime() {
      player?.prime();
    }

    // Fed every scan state the page renders. Only a change worth hearing makes
    // a sound, so calling it on every frame is the intended use.
    function observe(state) {
      if (!state) return null;
      const snapshot = {
        status: String(state.status || ""),
        samples: Math.max(0, Number(state.samples) || 0),
        total: Math.max(1, Number(state.total) || 1),
      };
      const cue = planCue(previous, snapshot);
      previous = snapshot;
      if (cue === CUES.RETRY) {
        const time = now();
        if (time - lastRetryAt < RETRY_INTERVAL_MS) return null;
        lastRetryAt = time;
      }
      if (!cue) return null;
      play(cue, snapshot);
      return cue;
    }

    // A scan has ended — matched, saved, skipped or cancelled — so the next
    // state seen belongs to a new scan and opens with its own start cue.
    function reset() {
      previous = null;
      lastRetryAt = -Infinity;
    }

    return Object.freeze({ observe, play, prime, reset });
  }

  const api = Object.freeze({
    CUES,
    RETRY_INTERVAL_MS,
    STALE_CUE_MS,
    createFaceScanTones,
    phrase,
    planCue,
    sampleFrequency,
  });
  globalScope.StampNoteFaceScanTones = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
