import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import configPlugin from "../../src/plugins/config.js";

const base = {
  DATABASE_URL: "postgres://localhost:5432/pekohub_test",
  JWT_SECRET: "test-secret-key-that-is-32-chars-long!!",
};

async function loadConfig(env: Record<string, string>) {
  const saved = process.env;
  process.env = { ...base, ...env };
  try {
    const app = Fastify({ logger: false });
    await app.register(configPlugin);
    await app.ready();
    return app.config;
  } finally {
    process.env = saved;
  }
}

describe("config: ops settings", () => {
  it("treats empty error-tracking and metrics settings as unset", async () => {
    const config = await loadConfig({ SENTRY_DSN: "", METRICS_TOKEN: "", SENTRY_ENVIRONMENT: "" });
    expect(config.SENTRY_DSN).toBeUndefined();
    expect(config.METRICS_TOKEN).toBeUndefined();
    expect(config.SENTRY_ENVIRONMENT).toBeUndefined();
    expect(config.API_DOCS).toBe("false");
  });

  it("refuses a DSN that isn't a URL and a short metrics token", async () => {
    await expect(loadConfig({ SENTRY_DSN: "not a url" })).rejects.toThrow(/Invalid configuration/);
    await expect(loadConfig({ METRICS_TOKEN: "short" })).rejects.toThrow(/Invalid configuration/);
  });
});
