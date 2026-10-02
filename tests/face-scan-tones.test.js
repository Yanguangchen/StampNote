const assert = require("node:assert/strict");
const { test } = require("node:test");

const tones = require("../face-scan-tones.js");

function createFakeAudio({ state = "running" } = {}) {
  const notes = [];
  const calls = { contexts: 0, resumes: 0 };

  class FakeNode {
    connect(node) {
      return node;
    }

    disconnect() {}
  }

  function param(log) {
    return {
      setValueAtTime(value, time) {
        log.push({ method: "setValueAtTime", value, time });
      },
      exponentialRampToValueAtTime(value, time) {
        log.push({ method: "exponentialRampToValueAtTime", value, time });
      },
    };
  }

  const context = {
    currentTime: 2,
    destination: new FakeNode(),
    state,
    resume() {
      calls.resumes += 1;
      this.state = "running";
      return Promise.resolve();
    },
    createOscillator() {
      const note = { frequency: [], gain: null, start: null, stop: null, type: null };
      notes.push(note);
      const oscillator = new FakeNode();
      oscillator.frequency = param(note.frequency);
      oscillator.start = (time) => {
        note.start = time;
      };
      oscillator.stop = (time) => {
        note.stop = time;
      };
      Object.defineProperty(oscillator, "type", {
        set(value) {
          note.type = value;
        },
      });
      oscillator.connect = (gain) => {
        note.gain = gain.log;
        return gain;
      };
      return oscillator;
    },
    createGain() {
      const gain = new FakeNode();
      gain.log = [];
      gain.gain = param(gain.log);
      return gain;
    },
  };

  return {
    calls,
    context,
    getContext() {
      calls.contexts += 1;
      return context;
    },
    notes,
  };
}

function audible(notes) {
  return notes.filter((note) =>
    note.gain?.some((call) => call.method === "exponentialRampToValueAtTime" && call.value > 0.01),
  );
}

test("each step of a scan is mapped to the cue it deserves", () => {
  const { CUES, planCue } = tones;

  assert.equal(planCue(null, { status: "loading", samples: 0, total: 3 }), CUES.START);
  assert.equal(planCue(null, { status: "unavailable", samples: 0, total: 3 }), CUES.ERROR);
  assert.equal(
    planCue({ status: "scanning", samples: 1 }, { status: "scanning", samples: 2 }),
    CUES.SAMPLE,
  );
  // Framing prompts flicker with every movement, so they stay silent.
  assert.equal(
    planCue({ status: "scanning", samples: 1 }, { status: "move_closer", samples: 1 }),
    null,
  );
  assert.equal(
    planCue({ status: "scanning", samples: 2 }, { status: "retrying", samples: 3 }),
    CUES.RETRY,
    "a miss is more useful to hear than the view that caused it",
  );
  assert.equal(
    planCue({ status: "retrying", samples: 3 }, { status: "retrying", samples: 3 }),
    null,
  );
  assert.equal(
    planCue({ status: "scanning", samples: 2 }, { status: "not_this_worker", samples: 0 }),
    CUES.RETRY,
  );
  assert.equal(
    planCue({ status: "scanning", samples: 3 }, { status: "verifying", samples: 0 }),
    CUES.RETRY,
    "views thrown away mean the scan starts over",
  );
  assert.equal(
    planCue({ status: "scanning", samples: 1 }, { status: "unavailable", samples: 1 }),
    CUES.ERROR,
  );
  assert.equal(
    planCue({ status: "unavailable", samples: 0 }, { status: "unavailable", samples: 0 }),
    null,
  );
  assert.equal(planCue({ status: "scanning", samples: 1 }, null), null);
});

test("sample ticks climb with progress and finish on the same note for any scan length", () => {
  const three = [1, 2, 3].map((count) => tones.sampleFrequency(count, 3));
  const seven = [1, 2, 3, 4, 5, 6, 7].map((count) => tones.sampleFrequency(count, 7));

  [three, seven].forEach((ladder) => {
    ladder.slice(1).forEach((frequency, index) => {
      assert.ok(frequency > ladder[index], "every accepted view sounds higher than the last");
    });
  });
  assert.equal(three.at(-1), seven.at(-1));
  assert.ok(three[0] > 523, "the first tick is above the start cue's resting note");
  assert.ok(seven.at(-1) < 1400, "the top tick stays below a piercing pitch");
  assert.equal(tones.sampleFrequency(9, 3), three.at(-1), "overshoot is clamped");
});

test("every cue is quiet, short, and quieter than the shutter", () => {
  Object.values(tones.CUES).forEach((cue) => {
    const notes = tones.phrase(cue, { samples: 1, total: 3 });
    assert.ok(notes.length > 0, `${cue} has notes`);
    notes.forEach((note) => {
      assert.ok(note.peak > 0 && note.peak <= 0.1, `${cue} peaks below the 0.24 shutter`);
      assert.ok(note.frequency > 200 && note.frequency < 1400);
      assert.ok(note.at + note.duration <= 0.6, `${cue} is over in well under a second`);
    });
  });
  assert.deepEqual(tones.phrase("unknown"), []);
});

test("observing a scan plays a start cue, rising ticks, then the page's chime", () => {
  const audio = createFakeAudio();
  const player = tones.createFaceScanTones({ getContext: audio.getContext, now: () => 0 });

  assert.equal(player.observe({ status: "no_face", samples: 0, total: 3 }), "start");
  assert.equal(player.observe({ status: "no_face", samples: 0, total: 3 }), null);
  assert.equal(player.observe({ status: "move_closer", samples: 0, total: 3 }), null);
  assert.equal(player.observe({ status: "scanning", samples: 1, total: 3 }), "sample");
  assert.equal(player.observe({ status: "scanning", samples: 2, total: 3 }), "sample");
  assert.equal(player.observe({ status: "scanning", samples: 3, total: 3 }), "sample");
  assert.equal(player.play("complete"), true);

  const notes = audible(audio.notes);
  // Two start notes, three ticks and a four-note chime.
  assert.equal(notes.length, 9);
  const ticks = notes.slice(2, 5).map((note) => note.frequency[0].value);
  assert.ok(ticks[0] < ticks[1] && ticks[1] < ticks[2]);
  notes.forEach((note) => {
    assert.ok(note.stop > note.start, "every note is stopped so its nodes are released");
    assert.equal(note.gain[0].method, "setValueAtTime");
    assert.ok(note.gain[0].value > 0 && note.gain[0].value < 0.001, "attack starts near silence");
  });
  // Cues queue rather than sounding on top of one another.
  const starts = notes.map((note) => note.start);
  starts.slice(1).forEach((start, index) => assert.ok(start > starts[index]));
  assert.ok(starts[0] >= audio.context.currentTime);
});

test("a run of misses is a reminder every few seconds, not an alarm", () => {
  const audio = createFakeAudio();
  let clock = 0;
  const player = tones.createFaceScanTones({ getContext: audio.getContext, now: () => clock });

  player.observe({ status: "scanning", samples: 3, total: 3 });
  assert.equal(player.observe({ status: "retrying", samples: 3, total: 3 }), "retry");
  clock += 500;
  player.observe({ status: "move_closer", samples: 3, total: 3 });
  assert.equal(
    player.observe({ status: "retrying", samples: 3, total: 3 }),
    null,
    "a flicker back to the miss is not a second miss",
  );
  clock += tones.RETRY_INTERVAL_MS;
  player.observe({ status: "move_closer", samples: 3, total: 3 });
  assert.equal(player.observe({ status: "retrying", samples: 3, total: 3 }), "retry");

  // Ending the scan lets the next one open with its own cue.
  player.reset();
  assert.equal(player.observe({ status: "no_face", samples: 0, total: 3 }), "start");
});

test("sound is optional: no audio device and broken graphs never interrupt a scan", async () => {
  const silent = tones.createFaceScanTones({ getContext: () => null });
  assert.equal(silent.observe({ status: "no_face", samples: 0, total: 3 }), "start");
  assert.equal(silent.play("complete"), false);
  silent.prime();

  const broken = tones.createFaceScanTones({
    getContext: () => ({
      currentTime: 0,
      state: "running",
      createOscillator() {
        throw new Error("no audio graph");
      },
    }),
  });
  assert.doesNotThrow(() => broken.play("complete"));
  assert.doesNotThrow(() => broken.prime());

  // A page without Web Audio at all opens nothing.
  const bare = tones.createFaceScanTones({ globalObject: {} });
  assert.equal(bare.play("start"), false);

  // A context still waiting for a tap is resumed before it is used.
  const suspended = createFakeAudio({ state: "suspended" });
  const player = tones.createFaceScanTones({ getContext: suspended.getContext });
  assert.equal(player.play("start"), true);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(suspended.calls.resumes, 1);
  assert.equal(audible(suspended.notes).length, 2);
});

test("cues held up by a locked audio device are dropped rather than played late in a burst", async () => {
  const audio = createFakeAudio({ state: "suspended" });
  let unlock;
  let clock = 0;
  audio.context.resume = () =>
    new Promise((resolve) => {
      unlock = resolve;
    });
  const player = tones.createFaceScanTones({ getContext: audio.getContext, now: () => clock });

  player.play("sample", { samples: 1, total: 3 });
  clock += tones.STALE_CUE_MS + 1;
  audio.context.state = "running";
  unlock();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(audible(audio.notes).length, 0, "the stale tick is not played");

  player.play("complete");
  assert.equal(audible(audio.notes).length, 4, "a cue for the scan as it is now still plays");
});

test("priming unlocks audio with a silent note and opens one context of its own", () => {
  let constructed = 0;
  const audio = createFakeAudio();
  class FakeAudioContext {
    constructor() {
      constructed += 1;
      return audio.context;
    }
  }
  const player = tones.createFaceScanTones({ globalObject: { AudioContext: FakeAudioContext } });

  player.prime();
  assert.equal(constructed, 1);
  assert.equal(audio.notes.length, 1);
  assert.equal(audio.notes[0].gain[0].value, 0, "the primer makes no sound");
  assert.equal(audible(audio.notes).length, 0);

  player.play("start");
  assert.equal(constructed, 1, "later cues reuse the unlocked context");
  assert.equal(audible(audio.notes).length, 2);
});

test("the module is exposed to the browser pages that scan faces", () => {
  assert.equal(globalThis.StampNoteFaceScanTones, tones);
});
