#!/usr/bin/env node
/**
 * pi-ai impersonates Claude Code when talking to the Anthropic API and
 * hardcodes the client version it reports (`claudeCodeVersion`). Anthropic
 * gates newer models on a minimum reported client version, so a stale
 * hardcoded value causes 400 errors like:
 *
 *   "Claude Code 2.1.75 does not support this model; version 2.1.251 or
 *    newer is required."
 *
 * This postinstall script rewrites the constant in every pi-ai copy under
 * node_modules (plain dist and bundled forms). Bump TARGET_VERSION when
 * Anthropic raises the floor again. Remove once fixed upstream in pi-ai.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TARGET_VERSION = "2.1.257";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let files = [];
try {
  files = execSync(
    `grep -rlE 'claudeCodeVersion ?= ?"' node_modules/@earendil-works --include='*.js' 2>/dev/null || true`,
    { cwd: root, encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean);
} catch {
  // no matches / no node_modules yet
}

let patched = 0;
for (const rel of files) {
  const path = join(root, rel);
  const before = readFileSync(path, "utf8");
  const after = before.replace(
    /claudeCodeVersion( ?= ?)"\d+\.\d+\.\d+"/g,
    `claudeCodeVersion$1"${TARGET_VERSION}"`,
  );
  if (after !== before) {
    writeFileSync(path, after);
    patched++;
    console.log(`[patch-pi-ai] ${rel} -> claudeCodeVersion ${TARGET_VERSION}`);
  }
}

if (patched === 0) {
  console.log("[patch-pi-ai] nothing to patch (already current or pi-ai absent)");
}
