#!/usr/bin/env node
// Check the Hub's tunnel types against peko-runtime's wire contract.
//
// peko-runtime keeps one sample of every tunnel message, serialized by its
// real types, in `peko-rs/core/src/tunnel/fixtures/tunnel_messages.json`
// (its tests keep the file current). This script type-checks every sample
// against the Hub's `TunnelMessage` (backend/src/services/tunnel-protocol.ts):
// an unknown field, a missing required field, or a wrong type fails `tsc`.
// It also lists message types the Hub declares that the runtime never sends
// or accepts.
//
// Usage: node scripts/check-tunnel-contract.mjs [path/to/peko-runtime]

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE = "peko-rs/core/src/tunnel/fixtures/tunnel_messages.json";

// Declared by the Hub, unknown to the runtime. Each entry is drift with a
// reason; remove it once the two sides agree.
const HUB_ONLY = new Map([
  ["invite_mint", "chat invite tokens: the runtime has no tunnel handler (gap map follow-up)"],
  ["invite_minted", "chat invite tokens: the runtime has no tunnel handler (gap map follow-up)"],
  ["invite_revoke", "chat invite tokens: the runtime has no tunnel handler (gap map follow-up)"],
  ["invite_revoked", "chat invite tokens: the runtime has no tunnel handler (gap map follow-up)"],
]);

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = resolve(process.argv[2] ?? join(repo, "..", "peko-runtime"));
const samples = JSON.parse(readFileSync(join(runtime, FIXTURE), "utf8"));
const protocolPath = join(repo, "backend/src/services/tunnel-protocol.ts");
const protocol = readFileSync(protocolPath, "utf8");

let failed = false;

// 1. Every sample type-checks as a TunnelMessage.
const work = mkdtempSync(join(repo, "backend", ".tunnel-contract-"));
try {
  const check = join(work, "fixture.check.ts");
  writeFileSync(
    check,
    `import type { TunnelMessage } from "${protocolPath.replace(/\.ts$/, ".js")}";\n` +
      `export const samples: TunnelMessage[] = ${JSON.stringify(samples, null, 2)};\n`,
  );
  writeFileSync(
    join(work, "tsconfig.json"),
    JSON.stringify({
      extends: join(repo, "backend/tsconfig.json"),
      compilerOptions: { noEmit: true, rootDir: repo, noUnusedLocals: false },
      include: [check],
    }),
  );
  try {
    execFileSync("npx", ["tsc", "-p", join(work, "tsconfig.json")], {
      cwd: join(repo, "backend"),
      stdio: "pipe",
      encoding: "utf8",
    });
  } catch (error) {
    failed = true;
    console.error("❌ runtime tunnel messages don't type-check as the Hub's TunnelMessage:");
    console.error(String(error.stdout || error.message).replace(new RegExp(work, "g"), "<fixture>"));
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

// 2. Types the Hub declares that the runtime doesn't know.
const union = protocol.slice(protocol.indexOf("export type TunnelMessage ="));
const declared = new Set(
  [...union.slice(0, union.indexOf(";\n\n") + 1).matchAll(/type:\s*"([a-z_]+)"/g)].map((m) => m[1]),
);
const spoken = new Set(samples.map((s) => s.type));
for (const type of declared) {
  if (spoken.has(type)) continue;
  if (HUB_ONLY.has(type)) {
    console.warn(`⚠️  ${type}: Hub-only (${HUB_ONLY.get(type)})`);
  } else {
    failed = true;
    console.error(`❌ ${type}: the Hub declares it, the runtime neither sends nor accepts it`);
  }
}
for (const type of spoken) {
  if (!declared.has(type)) {
    failed = true;
    console.error(`❌ ${type}: the runtime speaks it, the Hub's TunnelMessage has no such type`);
  }
}

if (failed) {
  console.error(`\nUpdate ${protocolPath.slice(repo.length + 1)} to match ${FIXTURE}.`);
  process.exit(1);
}
console.log(`✓ ${samples.length} runtime tunnel messages match the Hub's TunnelMessage`);
