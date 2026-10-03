/* Robot alarms are heard, not only read: whoever is driving is watching the
   picture or the road, not the status line. Each alarm has a priority, and
   the priority decides its sound, following the pulse patterns of the
   IEC 60601-1-8 alarm convention so urgency is recognisable without words:

     high    five pulses (three, a pause, two), repeated while it lasts
     medium  three pulses, once
     low     two soft pulses, once

   Clearing a high or medium alarm plays a short rising "restored" chime, so
   the end of a problem is heard as clearly as its start. Every sound is
   synthesised through the shared tone player and peaks below the shutter. */
(function initializeRobotAlarmTones(globalScope) {
  "use strict";

  const tonePlayer =
    globalScope.StampNoteTonePlayer ||
    (typeof require === "function" ? require("./tone-player.js") : null);

  const PRIORITY = Object.freeze({ HIGH: "high", MEDIUM: "medium", LOW: "low" });

  const ALARMS = Object.freeze({
    // Live tunnel: nothing has arrived from the robot for a while, or the link
    // to it failed outright.
    SIGNAL_LOST: "signal_lost",
    // Live tunnel: the robot ended its recording on purpose.
    ROBOT_STOPPED: "robot_stopped",
    // Robotic control: this device dropped off the network.
    NETWORK_LOST: "network_lost",
    // Robotic control: the camera stopped delivering video.
    CAMERA_LOST: "camera_lost",
    // Robotic control: the camera is running but Live tunnel cannot share it.
    SHARE_FAILED: "share_failed",
  });

  const PRIORITY_OF = Object.freeze({
    [ALARMS.SIGNAL_LOST]: PRIORITY.HIGH,
    [ALARMS.NETWORK_LOST]: PRIORITY.HIGH,
    [ALARMS.CAMERA_LOST]: PRIORITY.HIGH,
    [ALARMS.SHARE_FAILED]: PRIORITY.MEDIUM,
    [ALARMS.ROBOT_STOPPED]: PRIORITY.LOW,
  });

  // A high-priority alarm sounds again at this interval while it lasts, a
  // limited number of times: long enough to reach someone who looked away,
  // short of becoming noise in a room that already knows.
  const REPEAT_MS = 10_000;
  const MAX_REPEATS = 5;

  function pulses(starts, frequency, peak) {
    return starts.map((at) => ({ at, frequency, duration: 0.13, type: "triangle", peak }));
  }

  function phrase(priority) {
    switch (priority) {
      case PRIORITY.HIGH:
        return pulses([0, 0.2, 0.4, 0.85, 1.05], 880, 0.16);
      case PRIORITY.MEDIUM:
        return pulses([0, 0.22, 0.44], 659.25, 0.13);
      case PRIORITY.LOW:
        return pulses([0, 0.26], 523.25, 0.1);
      case "restored":
        return [
          { at: 0, frequency: 659.25, duration: 0.1, type: "sine", peak: 0.1 },
          { at: 0.11, frequency: 880, duration: 0.1, type: "sine", peak: 0.1 },
          { at: 0.22, frequency: 1318.51, duration: 0.24, type: "sine", peak: 0.1 },
        ];
      default:
        return [];
    }
  }

  function createRobotAlarms(options = {}) {
    const player = tonePlayer?.createTonePlayer({
      getContext: options.getContext,
      globalObject: options.globalObject || globalScope,
      now: options.now,
    });
    const setTimer = options.setTimeout || ((callback, ms) => globalScope.setTimeout(callback, ms));
    const clearTimer = options.clearTimeout || ((id) => globalScope.clearTimeout(id));
    const onChange = typeof options.onChange === "function" ? options.onChange : () => {};
    const active = new Map();

    function sound(priority) {
      return player?.playNotes(phrase(priority)) || false;
    }

    function stopRepeats(entry) {
      if (entry?.timer != null) clearTimer(entry.timer);
      if (entry) entry.timer = null;
    }

    function scheduleRepeat(name) {
      const entry = active.get(name);
      if (!entry || entry.repeats >= MAX_REPEATS) return;
      entry.timer = setTimer(() => {
        const current = active.get(name);
        if (current !== entry) return;
        entry.repeats += 1;
        sound(entry.priority);
        scheduleRepeat(name);
      }, REPEAT_MS);
      entry.timer?.unref?.();
    }

    // Safe to call on every state update: an alarm already sounding is not
    // started again. Low alarms are notices, so they sound and are done.
    function raise(name) {
      const priority = PRIORITY_OF[name];
      if (!priority) return false;
      if (active.has(name)) return false;
      sound(priority);
      if (priority === PRIORITY.LOW) return true;
      active.set(name, { priority, repeats: 0, timer: null });
      if (priority === PRIORITY.HIGH) scheduleRepeat(name);
      onChange(name, true);
      return true;
    }

    // `restored: false` ends an alarm silently: the operator left, signed out
    // or stopped the robot, so nothing came back.
    function clear(name, { restored = true } = {}) {
      const entry = active.get(name);
      if (!entry) return false;
      stopRepeats(entry);
      active.delete(name);
      if (restored) sound("restored");
      onChange(name, false);
      return true;
    }

    function clearAll() {
      [...active.keys()].forEach((name) => clear(name, { restored: false }));
    }

    function isActive(name) {
      return active.has(name);
    }

    function prime() {
      player?.prime();
    }

    return Object.freeze({ clear, clearAll, isActive, prime, raise });
  }

  const api = Object.freeze({
    ALARMS,
    MAX_REPEATS,
    PRIORITY,
    PRIORITY_OF,
    REPEAT_MS,
    createRobotAlarms,
    phrase,
  });
  globalScope.StampNoteRobotAlarmTones = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
