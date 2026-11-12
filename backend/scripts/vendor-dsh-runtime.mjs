#!/usr/bin/env node
// Vendor the DeepSeek Harness npm runtime into backend/data/dsh-runtime.
// Run with Node >= 24.9; the target directory and node_modules are gitignored.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PACKAGE = "@deepseek-ai/dsh";
const VERSION = "0.2.2-rc.1";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = path.join(ROOT, "data", "dsh-runtime");
const BIN = path.join(TARGET, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
execFileSync(
  npm,
  ["install", "--prefix", TARGET, "--no-audit", "--no-fund", `${PACKAGE}@${VERSION}`],
  { stdio: "inherit", shell: process.platform === "win32" },
);

const digest = createHash("sha256").update(readFileSync(BIN)).digest("hex");
const lock = {
  package: PACKAGE,
  version: VERSION,
  binPath: "node_modules/@deepseek-ai/dsh/lib/bin.js",
  binSha256: digest,
};
writeFileSync(path.join(ROOT, "dsh-runtime.lock.json"), `${JSON.stringify(lock, null, 2)}\n`, "utf8");
console.log(`vendored ${PACKAGE}@${VERSION} sha256=${digest}`);
