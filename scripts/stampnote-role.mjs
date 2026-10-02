#!/usr/bin/env node
// Shows or changes one account's StampNote role marker: the `stampnoteRole`
// custom claim that the app, the Firestore rules and Operations AI read.
//
//   node scripts/stampnote-role.mjs person@gmail.com                 show it
//   node scripts/stampnote-role.mjs person@gmail.com --clear         remove it
//   node scripts/stampnote-role.mjs person@gmail.com --set worker    set it
//
// Custom claims can only be changed with the Firebase Admin SDK, so this runs
// on a computer, not in the browser. It needs `npm install --no-save
// firebase-admin` and GOOGLE_APPLICATION_CREDENTIALS pointing at a service
// account key for the project (Firebase console → Project settings → Service
// accounts → Generate new private key). Nothing changes unless --clear or
// --set is given. The person reloads StampNote afterwards; the app refreshes
// their token on every load, so no sign-out is needed.

import { pathToFileURL } from "node:url";

export const DEFAULT_PROJECT_ID = "stampnote-eedcd";
export const ROLES = Object.freeze(["worker", "admin", "superadmin"]);

const USAGE = `Usage:
  node scripts/stampnote-role.mjs <email> [--clear | --set <${ROLES.join("|")}>] [--project <id>]`;

export function parseArgs(argv) {
  const args = [...argv];
  const options = { email: "", action: "show", role: null, projectId: DEFAULT_PROJECT_ID };
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--clear") {
      if (options.action !== "show") throw new Error("Use either --clear or --set, not both.");
      options.action = "clear";
    } else if (arg === "--set") {
      if (options.action !== "show") throw new Error("Use either --clear or --set, not both.");
      const role = String(args.shift() || "").toLowerCase();
      if (!ROLES.includes(role)) throw new Error(`--set needs one of: ${ROLES.join(", ")}.`);
      options.action = "set";
      options.role = role;
    } else if (arg === "--project") {
      options.projectId = String(args.shift() || "").trim();
      if (!options.projectId) throw new Error("--project needs a Firebase project ID.");
    } else if (arg?.startsWith("--")) {
      throw new Error(`Unknown option ${arg}.`);
    } else if (!options.email) {
      options.email = String(arg).trim();
    } else {
      throw new Error(`Unexpected argument ${arg}.`);
    }
  }
  if (!options.email.includes("@")) throw new Error("Give the account's email address.");
  return options;
}

function describe(user) {
  const claims = user.customClaims || {};
  const marker = claims.stampnoteRole ? `stampnoteRole: "${claims.stampnoteRole}"` : "no stampnoteRole";
  return `${user.email} (uid ${user.uid}) — ${marker}${user.emailVerified ? "" : ", email not verified"}${
    user.disabled ? ", account disabled" : ""
  }`;
}

// Kept apart from the Admin SDK so it can be checked without a project.
export async function run({ auth, options, log = console.log }) {
  let user;
  try {
    user = await auth.getUserByEmail(options.email);
  } catch (error) {
    if (error?.code === "auth/user-not-found") {
      throw new Error(`${options.email} has never signed in to this project, so it has no role marker.`);
    }
    throw error;
  }
  log(`Now: ${describe(user)}`);
  if (options.action === "show") return { changed: false, claims: user.customClaims || {} };

  // Only the StampNote marker is touched; any other claims stay as they are.
  const { stampnoteRole: previous, ...others } = user.customClaims || {};
  const next = options.action === "set" ? { ...others, stampnoteRole: options.role } : others;
  if ((previous || null) === (next.stampnoteRole || null)) {
    log("Nothing to change.");
    return { changed: false, claims: user.customClaims || {} };
  }
  await auth.setCustomUserClaims(user.uid, Object.keys(next).length > 0 ? next : null);
  log(
    options.action === "clear"
      ? "Removed the marker. Ask them to reload StampNote."
      : `Set stampnoteRole: "${options.role}". Ask them to reload StampNote.`,
  );
  return { changed: true, claims: next };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  let app;
  let auth;
  try {
    app = await import("firebase-admin/app");
    auth = await import("firebase-admin/auth");
  } catch {
    console.error("This needs the Firebase Admin SDK first: npm install --no-save firebase-admin");
    process.exitCode = 1;
    return;
  }

  app.initializeApp({ credential: app.applicationDefault(), projectId: options.projectId });
  try {
    await run({ auth: auth.getAuth(), options });
  } catch (error) {
    console.error(error?.message || error);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
