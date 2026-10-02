const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");

const root = resolve(__dirname, "..");
const scriptPath = resolve(root, "scripts/stampnote-role.mjs");
const loadScript = () => import(scriptPath);

function createAuth(users) {
  const writes = [];
  return {
    writes,
    async getUserByEmail(email) {
      const user = users[email];
      if (!user) throw Object.assign(new Error("no user"), { code: "auth/user-not-found" });
      return { ...user, email };
    },
    async setCustomUserClaims(uid, claims) {
      writes.push({ uid, claims });
    },
  };
}

test("the role script only reads unless told to change something", async () => {
  const { parseArgs, run } = await loadScript();
  const auth = createAuth({
    "lysshaan2005@gmail.com": { uid: "u-1", emailVerified: true, customClaims: { stampnoteRole: "worker" } },
  });
  const lines = [];
  const result = await run({ auth, options: parseArgs(["lysshaan2005@gmail.com"]), log: (line) => lines.push(line) });

  assert.equal(result.changed, false);
  assert.equal(auth.writes.length, 0);
  assert.match(lines[0], /lysshaan2005@gmail\.com \(uid u-1\) — stampnoteRole: "worker"/);
});

test("clearing removes only the StampNote marker", async () => {
  const { parseArgs, run } = await loadScript();
  const auth = createAuth({
    "worker@gmail.com": { uid: "u-1", emailVerified: true, customClaims: { stampnoteRole: "worker" } },
    "mixed@gmail.com": {
      uid: "u-2",
      emailVerified: true,
      customClaims: { stampnoteRole: "worker", team: "north" },
    },
    "plain@gmail.com": { uid: "u-3", emailVerified: true, customClaims: undefined },
  });
  const log = () => {};

  assert.equal((await run({ auth, options: parseArgs(["worker@gmail.com", "--clear"]), log })).changed, true);
  assert.deepEqual(auth.writes.at(-1), { uid: "u-1", claims: null });

  await run({ auth, options: parseArgs(["mixed@gmail.com", "--clear"]), log });
  assert.deepEqual(auth.writes.at(-1), { uid: "u-2", claims: { team: "north" } });

  const lines = [];
  const unchanged = await run({
    auth,
    options: parseArgs(["plain@gmail.com", "--clear"]),
    log: (line) => lines.push(line),
  });
  assert.equal(unchanged.changed, false);
  assert.equal(auth.writes.length, 2, "an account without a marker is left alone");
  assert.match(lines.at(-1), /Nothing to change/);
});

test("setting a role keeps other claims and accepts only StampNote roles", async () => {
  const { parseArgs, run } = await loadScript();
  const auth = createAuth({
    "person@gmail.com": { uid: "u-9", emailVerified: true, customClaims: { team: "north" } },
  });
  await run({ auth, options: parseArgs(["person@gmail.com", "--set", "ADMIN"]), log: () => {} });
  assert.deepEqual(auth.writes, [{ uid: "u-9", claims: { team: "north", stampnoteRole: "admin" } }]);

  assert.throws(() => parseArgs(["person@gmail.com", "--set", "owner"]), /worker, admin, superadmin/);
  assert.throws(() => parseArgs(["person@gmail.com", "--set"]), /--set needs/);
  assert.throws(() => parseArgs(["person@gmail.com", "--clear", "--set", "admin"]), /either --clear or --set/);
  assert.throws(() => parseArgs([]), /email address/);
  assert.throws(() => parseArgs(["person@gmail.com", "--force"]), /Unknown option/);
  assert.equal(parseArgs(["person@gmail.com"]).projectId, "stampnote-eedcd");
  assert.equal(parseArgs(["person@gmail.com", "--project", "other-1"]).projectId, "other-1");
});

test("an account that never signed in is reported plainly", async () => {
  const { parseArgs, run } = await loadScript();
  await assert.rejects(
    () => run({ auth: createAuth({}), options: parseArgs(["new@gmail.com", "--clear"]), log: () => {} }),
    /has never signed in to this project/,
  );
});

test("the script explains a bad command and the missing Admin SDK instead of crashing", () => {
  let usage;
  try {
    execFileSync(process.execPath, [scriptPath], { encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    usage = error;
  }
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /Usage:/);

  // This repository does not depend on firebase-admin, so the script asks for it.
  let missing;
  try {
    execFileSync(process.execPath, [scriptPath, "person@gmail.com"], { encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    missing = error;
  }
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /npm install --no-save firebase-admin/);
});

test("the script is kept out of the deployed site", () => {
  assert.match(readFileSync(resolve(root, ".vercelignore"), "utf8"), /^scripts\/$/m);
});
