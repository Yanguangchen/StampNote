/* Plays short synthesised phrases through Web Audio. Every sound StampNote
   makes beyond the shutter — face-scan cues and robot alarms — is a list of
   notes handed to this player, so they share one way of opening the audio
   device, queueing behind each other and failing quietly. Sound is always
   progressive enhancement: without Web Audio, nothing plays and nothing
   breaks. */
(function initializeTonePlayer(globalScope) {
  "use strict";

  // A phrase describes the moment it was asked for. One that waited longer
  // than this for a locked audio device to open would describe something that
  // has moved on, and a backlog of them would all sound at once on the next
  // tap.
  const STALE_MS = 1000;

  function phraseLength(notes) {
    return notes.reduce((end, note) => Math.max(end, note.at + note.duration), 0);
  }

  function resolveContextFactory(globalObject) {
    let ownContext = null;
    return function getOwnContext() {
      if (ownContext?.state === "closed") ownContext = null;
      if (ownContext) return ownContext;
      const AudioContext = globalObject?.AudioContext || globalObject?.webkitAudioContext;
      if (typeof AudioContext !== "function") return null;
      try {
        ownContext = new AudioContext();
      } catch {
        ownContext = null;
      }
      return ownContext;
    };
  }

  // Each note says when it starts relative to the phrase, its pitch, how long
  // it rings, its waveform and how loud it peaks.
  //
  // `getContext` lets a page that already holds an AudioContext share it, so a
  // second sound source does not open a second audio device. Without one, the
  // first phrase opens its own.
  function createTonePlayer(options = {}) {
    const getContext =
      typeof options.getContext === "function"
        ? options.getContext
        : resolveContextFactory(options.globalObject || globalScope);
    const now = typeof options.now === "function" ? options.now : () => Date.now();
    const staleMs = Number(options.staleMs) || STALE_MS;
    // Phrases queue behind one another rather than sounding on top of each
    // other, so two cues in quick succession stay two sounds.
    let busyUntil = 0;
    let busyContext = null;

    function schedule(context, notes) {
      // A replaced context restarts its clock at zero.
      if (context !== busyContext) {
        busyContext = context;
        busyUntil = 0;
      }
      const start = Math.max(Number(context.currentTime) || 0, busyUntil);
      notes.forEach((note) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const begin = start + note.at;
        const end = begin + note.duration;
        oscillator.type = note.type;
        oscillator.frequency.setValueAtTime(note.frequency, begin);
        // Exponential ramps cannot start from zero; a near-silent floor keeps
        // the attack and release free of clicks.
        gain.gain.setValueAtTime(0.0001, begin);
        gain.gain.exponentialRampToValueAtTime(note.peak, begin + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, end);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.onended = () => {
          oscillator.disconnect();
          gain.disconnect();
        };
        oscillator.start(begin);
        oscillator.stop(end + 0.02);
      });
      busyUntil = start + phraseLength(notes);
    }

    function playNotes(notes) {
      if (!Array.isArray(notes) || notes.length === 0) return false;
      const context = getContext();
      if (!context) return false;
      const requestedAt = now();

      const sound = () => {
        if (now() - requestedAt > staleMs) return;
        try {
          schedule(context, notes);
        } catch {
          // Nothing depends on its sound.
        }
      };

      if (context.state === "suspended" && typeof context.resume === "function") {
        try {
          const resumed = context.resume();
          if (resumed?.then) {
            resumed.then(sound).catch(() => {});
            return true;
          }
        } catch {
          return false;
        }
      }
      sound();
      return true;
    }

    // Opening the audio device has to happen inside a tap on mobile browsers.
    // A silent note does that without the tap itself making a sound.
    function prime() {
      const context = getContext();
      if (!context) return;
      try {
        context.resume?.()?.catch?.(() => {});
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const time = Number(context.currentTime) || 0;
        gain.gain.setValueAtTime(0, time);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.onended = () => {
          oscillator.disconnect();
          gain.disconnect();
        };
        oscillator.start(time);
        oscillator.stop(time + 0.01);
      } catch {
        // Sound is optional.
      }
    }

    return Object.freeze({ playNotes, prime });
  }

  const api = Object.freeze({ STALE_MS, createTonePlayer, phraseLength });
  globalScope.StampNoteTonePlayer = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
