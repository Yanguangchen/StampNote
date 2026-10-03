const assert = require("node:assert/strict");
const { test } = require("node:test");

const alarms = require("../robot-alarm-tones.js");
const tonePlayer = require("../tone-player.js");

const { ALARMS, PRIORITY } = alarms;

// Records every audible note the alarms ask the audio device for.
function createFakeAudio() {
  const notes = [];
  class FakeNode {
    connect(node) {
      return node;
    }

    disconnect() {}
  }
  const context = {
    currentTime: 0,
    destination: new FakeNode(),
    state: "running",
    createOscillator() {
      const note = { frequency: null, start: null, peak: 0, type: null };
      notes.push(note);
      const oscillator = new FakeNode();
      oscillator.frequency = {
        setValueAtTime(value) {
          note.frequency = value;
        },
      };
      oscillator.start = (time) => {
        note.start = time;
      };
      oscillator.stop = () => {};
      oscillator.connect = (gain) => {
        gain.note = note;
        return gain;
      };
      Object.defineProperty(oscillator, "type", {
        set(value) {
          note.type = value;
        },
      });
      return oscillator;
    },
    createGain() {
      const gain = new FakeNode();
      gain.gain = {
        setValueAtTime() {},
        exponentialRampToValueAtTime(value) {
          if (gain.note && value > gain.note.peak) gain.note.peak = value;
        },
      };
      return gain;
    },
  };
  return { context, notes, audible: () => notes.filter((note) => note.frequency) };
}

function createClock() {
  const timers = [];
  return {
    timers,
    setTimeout(callback, ms) {
      const timer = { callback, ms, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cancelled = true;
    },
    runNext() {
      const next = timers.find((timer) => !timer.cancelled && !timer.ran);
      if (!next) return false;
      next.ran = true;
      next.callback();
      return true;
    },
  };
}

function createAlarms(extra = {}) {
  const audio = createFakeAudio();
  const clock = createClock();
  const changes = [];
  const robot = alarms.createRobotAlarms({
    getContext: () => audio.context,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onChange: (name, on) => changes.push([name, on]),
    ...extra,
  });
  return { audio, clock, changes, robot };
}

test("urgency is heard in the pulse count: five, three or two", () => {
  assert.equal(alarms.phrase(PRIORITY.HIGH).length, 5);
  assert.equal(alarms.phrase(PRIORITY.MEDIUM).length, 3);
  assert.equal(alarms.phrase(PRIORITY.LOW).length, 2);
  // High is three pulses, a pause, then two: the gap is the longest spacing.
  const starts = alarms.phrase(PRIORITY.HIGH).map((note) => note.at);
  const gaps = starts.slice(1).map((start, index) => start - starts[index]);
  assert.equal(Math.max(...gaps), gaps[2]);
  // Higher priority is higher and louder, and none outshouts the shutter.
  const [high, medium, low] = [PRIORITY.HIGH, PRIORITY.MEDIUM, PRIORITY.LOW].map(
    (priority) => alarms.phrase(priority)[0],
  );
  assert.ok(high.frequency > medium.frequency && medium.frequency > low.frequency);
  assert.ok(high.peak > medium.peak && medium.peak > low.peak);
  [PRIORITY.HIGH, PRIORITY.MEDIUM, PRIORITY.LOW, "restored"].forEach((priority) => {
    alarms.phrase(priority).forEach((note) => assert.ok(note.peak <= 0.16 && note.peak < 0.24));
  });
  // Restored rises, so it cannot be mistaken for another alarm.
  const restored = alarms.phrase("restored").map((note) => note.frequency);
  restored.slice(1).forEach((frequency, index) => assert.ok(frequency > restored[index]));
  assert.deepEqual(alarms.phrase("nonsense"), []);
});

test("every alarm has a priority, and the signal and device alarms are high", () => {
  Object.values(ALARMS).forEach((name) => assert.ok(alarms.PRIORITY_OF[name], name));
  assert.equal(alarms.PRIORITY_OF[ALARMS.SIGNAL_LOST], PRIORITY.HIGH);
  assert.equal(alarms.PRIORITY_OF[ALARMS.NETWORK_LOST], PRIORITY.HIGH);
  assert.equal(alarms.PRIORITY_OF[ALARMS.CAMERA_LOST], PRIORITY.HIGH);
  assert.equal(alarms.PRIORITY_OF[ALARMS.SHARE_FAILED], PRIORITY.MEDIUM);
  assert.equal(alarms.PRIORITY_OF[ALARMS.ROBOT_STOPPED], PRIORITY.LOW);
});

test("a high alarm sounds at once, repeats while it lasts, and stops after a while", () => {
  const { audio, clock, changes, robot } = createAlarms();

  assert.equal(robot.raise(ALARMS.SIGNAL_LOST), true);
  assert.equal(audio.audible().length, 5);
  assert.equal(robot.isActive(ALARMS.SIGNAL_LOST), true);
  assert.deepEqual(changes, [[ALARMS.SIGNAL_LOST, true]]);
  assert.equal(clock.timers[0].ms, alarms.REPEAT_MS);

  // Raising it again while it sounds does not restart it.
  assert.equal(robot.raise(ALARMS.SIGNAL_LOST), false);
  assert.equal(audio.audible().length, 5);

  let repeats = 0;
  while (clock.runNext()) repeats += 1;
  assert.equal(repeats, alarms.MAX_REPEATS);
  assert.equal(audio.audible().length, 5 * (1 + alarms.MAX_REPEATS));
  assert.equal(robot.isActive(ALARMS.SIGNAL_LOST), true, "it stays raised after the repeats end");
});

test("clearing an alarm stops its repeats and plays the restored chime", () => {
  const { audio, clock, changes, robot } = createAlarms();
  robot.raise(ALARMS.NETWORK_LOST);
  assert.equal(robot.clear(ALARMS.NETWORK_LOST), true);
  assert.equal(robot.isActive(ALARMS.NETWORK_LOST), false);
  assert.equal(audio.audible().length, 5 + 3, "five alarm pulses, then three restored notes");
  assert.ok(audio.audible().at(-1).frequency > audio.audible().at(-3).frequency);
  assert.equal(clock.runNext(), false, "no repeat is left behind");
  assert.deepEqual(changes.at(-1), [ALARMS.NETWORK_LOST, false]);
  assert.equal(robot.clear(ALARMS.NETWORK_LOST), false, "clearing twice is harmless");
});

test("an alarm ended by the operator ends silently", () => {
  const { audio, robot } = createAlarms();
  robot.raise(ALARMS.SIGNAL_LOST);
  robot.raise(ALARMS.SHARE_FAILED);
  assert.equal(audio.audible().length, 5 + 3);
  robot.clearAll();
  assert.equal(audio.audible().length, 5 + 3);
  assert.equal(robot.isActive(ALARMS.SIGNAL_LOST), false);
  assert.equal(robot.isActive(ALARMS.SHARE_FAILED), false);

  robot.raise(ALARMS.CAMERA_LOST);
  robot.clear(ALARMS.CAMERA_LOST, { restored: false });
  assert.equal(audio.audible().length, 5 + 3 + 5);
});

test("medium alarms sound once; low alarms are notices that leave nothing raised", () => {
  const { audio, clock, robot } = createAlarms();
  robot.raise(ALARMS.SHARE_FAILED);
  assert.equal(audio.audible().length, 3);
  assert.equal(clock.timers.length, 0);
  assert.equal(robot.isActive(ALARMS.SHARE_FAILED), true);

  assert.equal(robot.raise(ALARMS.ROBOT_STOPPED), true);
  assert.equal(audio.audible().length, 3 + 2);
  assert.equal(robot.isActive(ALARMS.ROBOT_STOPPED), false);
  assert.equal(robot.raise(ALARMS.ROBOT_STOPPED), true, "each stop is announced");
  assert.equal(robot.raise("asteroid"), false);
});

test("a device without Web Audio raises and clears alarms without a sound or an error", () => {
  const clock = createClock();
  const quiet = alarms.createRobotAlarms({
    getContext: () => null,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  assert.equal(quiet.raise(ALARMS.SIGNAL_LOST), true);
  assert.equal(quiet.isActive(ALARMS.SIGNAL_LOST), true);
  assert.doesNotThrow(() => quiet.prime());
  assert.equal(quiet.clear(ALARMS.SIGNAL_LOST), true);
});

test("the shared tone player is what both the face scan and the alarms play through", () => {
  assert.equal(globalThis.StampNoteTonePlayer, tonePlayer);
  assert.equal(globalThis.StampNoteRobotAlarmTones, alarms);
  assert.equal(require("../face-scan-tones.js").STALE_CUE_MS, tonePlayer.STALE_MS);
  assert.equal(tonePlayer.phraseLength(alarms.phrase(PRIORITY.HIGH)) > 1, true);
});
