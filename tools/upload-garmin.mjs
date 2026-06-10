#!/usr/bin/env node
/**
 * Upload a .FIT ride to Garmin Connect.
 *
 * Usage:
 *   npm run upload                      -> uploads the newest .fit in your Downloads folder
 *   npm run upload -- path\to\ride.fit  -> uploads a specific file
 *
 * Credentials: set environment variables GARMIN_EMAIL and GARMIN_PASSWORD,
 * or create a file named .garmin.json next to package.json:
 *   { "email": "you@example.com", "password": "..." }
 *
 * Note: this uses the unofficial garmin-connect library (same login as the
 * Garmin website). Your credentials never leave your machine.
 */
import { GarminConnect } from "garmin-connect";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

function findFitFile() {
  const arg = process.argv[2];
  if (arg) {
    const p = resolve(arg);
    if (!existsSync(p)) {
      console.error(`File not found: ${p}`);
      process.exit(1);
    }
    return p;
  }
  const downloads = join(homedir(), "Downloads");
  const fits = readdirSync(downloads)
    .filter((f) => f.toLowerCase().endsWith(".fit"))
    .map((f) => ({ f: join(downloads, f), t: statSync(join(downloads, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (fits.length === 0) {
    console.error(`No .fit files found in ${downloads}. Pass a path: npm run upload -- ride.fit`);
    process.exit(1);
  }
  return fits[0].f;
}

function getCredentials() {
  let email = process.env.GARMIN_EMAIL;
  let password = process.env.GARMIN_PASSWORD;
  const credFile = resolve(".garmin.json");
  if ((!email || !password) && existsSync(credFile)) {
    const j = JSON.parse(readFileSync(credFile, "utf8"));
    email = email || j.email;
    password = password || j.password;
  }
  if (!email || !password) {
    console.error(
      "Missing credentials. Set GARMIN_EMAIL / GARMIN_PASSWORD env vars\n" +
      'or create .garmin.json: { "email": "...", "password": "..." }'
    );
    process.exit(1);
  }
  return { email, password };
}

const file = findFitFile();
const { email, password } = getCredentials();

console.log(`Uploading ${file} to Garmin Connect as ${email} ...`);
const gc = new GarminConnect({ username: email, password });
try {
  await gc.login();
  const res = await gc.uploadActivity(file);
  console.log("Upload complete!", res?.detailedImportResult?.uploadId ? `Upload id: ${res.detailedImportResult.uploadId}` : "");
  console.log("Check https://connect.garmin.com/modern/activities");
} catch (err) {
  console.error("Upload failed:", err.message || err);
  console.error("You can always import manually at connect.garmin.com (cloud icon -> Import Data).");
  process.exit(1);
}
