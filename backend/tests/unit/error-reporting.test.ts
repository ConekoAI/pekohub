import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { gunzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";

import {
  initErrorReporting,
  reportError,
  flushErrorReports,
  setErrorReporterForTests,
} from "../../src/services/error-reporting.js";

/** A stand-in Sentry ingest: records every envelope posted to it. */
async function fakeIngest(): Promise<{ server: Server; dsn: string; envelopes: string[] }> {
  const envelopes: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const gzipped = req.headers["content-encoding"] === "gzip";
      envelopes.push((gzipped ? gunzipSync(body) : body).toString("utf8"));
      res.writeHead(200).end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, dsn: `http://publickey@127.0.0.1:${port}/1`, envelopes };
}

describe("error reporting", () => {
  let server: Server | null = null;

  afterEach(async () => {
    const Sentry = await import("@sentry/node");
    await Sentry.close(1000);
    setErrorReporterForTests(null);
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  it("is off without a DSN, and reporting is a no-op", async () => {
    expect(await initErrorReporting({ environment: "test" })).toBe(false);
    expect(() => reportError(new Error("ignored"))).not.toThrow();
    await flushErrorReports(10);
  });

  it("sends the error and the call site's context to the configured DSN", async () => {
    const ingest = await fakeIngest();
    server = ingest.server;

    expect(await initErrorReporting({ dsn: ingest.dsn, environment: "test", release: "abc123" })).toBe(true);
    reportError(new Error("relay broke"), { where: "tunnel message", runtimeId: "did:key:z6MkRuntime" });
    await flushErrorReports(5000);

    const event = ingest.envelopes.find((e) => e.includes('"type":"event"'));
    expect(event).toBeDefined();
    expect(event).toContain("relay broke");
    expect(event).toContain("did:key:z6MkRuntime");
    expect(event).toContain('"environment":"test"');
    expect(event).toContain('"release":"abc123"');
  });
});
