#!/usr/bin/env node
// Check that a PekoHub API is up from the outside: `/health` answers 200
// (the API and its database), and the runtime tunnel accepts a WebSocket
// upgrade through every proxy in front of it (Cloudflare, Fly, nginx).
// A plain HTTP GET can't check the tunnel: without an upgrade the route
// answers 404 whether or not WebSockets get through.
//
// The probe opens the socket and closes it; it never says hello, so the
// hub logs nothing and keeps no state.
//
// Usage: node scripts/probe-uptime.mjs https://api.pekohub.ai
// Exits 0 when both answer, 1 otherwise. Needs Node 22+ (global WebSocket).

const TIMEOUT_MS = 15_000;

const origin = (process.argv[2] ?? "").replace(/\/+$/, "");
if (!/^https?:\/\//.test(origin)) {
  console.error("usage: node scripts/probe-uptime.mjs <api origin, e.g. https://api.pekohub.ai>");
  process.exit(2);
}

async function checkHealth() {
  const res = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = await res.text();
  if (res.status !== 200) throw new Error(`/health answered ${res.status}: ${body}`);
  return body;
}

function checkTunnel() {
  const url = `${origin.replace(/^http/, "ws")}/v1/tunnel`;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`${url}: no upgrade within ${TIMEOUT_MS} ms`));
    }, TIMEOUT_MS);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      socket.close(1000, "uptime probe");
      resolve(url);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`${url}: the upgrade failed`));
    });
  });
}

let failed = false;
for (const [name, check] of [
  ["health", checkHealth],
  ["tunnel", checkTunnel],
]) {
  try {
    console.log(`ok   ${name}: ${await check()}`);
  } catch (err) {
    failed = true;
    console.error(`FAIL ${name}: ${err instanceof Error ? err.message : err}`);
  }
}
process.exit(failed ? 1 : 0);
