import { describe, it, expect } from "vitest";
import { isValidSeedVersion, validateSeed } from "../../src/services/seeds.js";

const SEED = `name = "ada"
preferred_model_id = "claude-opus-5-5"
persona = "You are Ada, a careful research partner."

[identity]
display_name = "Ada"
description = "Reads papers and keeps notes"
avatar = "🦉"
`;

describe("validateSeed", () => {
  it("reads the summary out of a seed", () => {
    const result = validateSeed(SEED);
    expect(result).toEqual({
      ok: true,
      summary: {
        name: "ada",
        displayName: "Ada",
        description: "Reads papers and keeps notes",
        avatar: "🦉",
        model: "claude-opus-5-5",
        hasPersona: true,
      },
    });
  });

  it("refuses identity, ownership, grants, and deployment state", () => {
    for (const line of [
      'id = "p_1"',
      'did = "did:key:z6Mk"',
      'actor_key = "k"',
      'owner = "user:local:me"',
      "permissions = []",
      'boot_state = "alive"',
      'status = "online"',
      'exposure = "public"',
    ]) {
      const result = validateSeed(`${line}\n${SEED}`);
      expect(result.ok, line).toBe(false);
      if (!result.ok) expect(result.error).toContain("peko seed");
    }
  });

  it("explains a missing name and broken TOML", () => {
    const noName = validateSeed('[identity]\ndisplay_name = "x"\n');
    expect(noName.ok).toBe(false);
    if (!noName.ok) expect(noName.error).toContain("`name`");

    const broken = validateSeed('name = "ada\n');
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.error).toMatch(/^This isn't valid TOML/);

    const badName = validateSeed('name = "../etc"\n');
    expect(badName.ok).toBe(false);
  });

  it("caps the size at 64 KB", () => {
    const big = `name = "ada"\npersona = "${"x".repeat(70 * 1024)}"\n`;
    const result = validateSeed(big);
    expect(result.ok).toBe(false);
  });
});

describe("isValidSeedVersion", () => {
  it("takes semver-shaped versions only", () => {
    expect(isValidSeedVersion("1.0.0")).toBe(true);
    expect(isValidSeedVersion("0.2.10-beta.1")).toBe(true);
    for (const bad of ["latest", "1.0", "v1.0.0", "1.0.0+build", "", "1.0.0-"]) {
      expect(isValidSeedVersion(bad), bad).toBe(false);
    }
  });
});
