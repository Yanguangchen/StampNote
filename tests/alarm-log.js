// Shared by the Live tunnel and Robotic control tests: the real alarm rules
// with no speaker behind them, so what a page raises and clears is written
// down instead of played. Not a test file itself (node --test skips it).
const robotAlarmTones = require("../robot-alarm-tones.js");

function createAlarmLog() {
  const log = [];
  return {
    log,
    api: {
      ...robotAlarmTones,
      createRobotAlarms() {
        const real = robotAlarmTones.createRobotAlarms({
          getContext: () => null,
          setTimeout: () => null,
          clearTimeout() {},
        });
        return {
          raise(name) {
            const raised = real.raise(name);
            if (raised) log.push(["raise", name]);
            return raised;
          },
          clear(name, options = {}) {
            const cleared = real.clear(name, options);
            if (cleared) log.push(["clear", name, options.restored !== false ? "restored" : "silent"]);
            return cleared;
          },
          clearAll() {
            Object.values(robotAlarmTones.ALARMS).forEach((name) => this.clear(name, { restored: false }));
          },
          isActive: (name) => real.isActive(name),
          prime() {
            log.push(["prime"]);
          },
        };
      },
    },
  };
}

module.exports = { createAlarmLog };
