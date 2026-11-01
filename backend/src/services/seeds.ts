import { parse as parseToml } from "smol-toml";
import { PrincipalName } from "@pekohub/shared";

/**
 * Seeds: a peko's definition, never its existence (runtime ADR-060).
 *
 * A seed is a `principal.toml` plus an optional inline `persona` (the
 * Markdown body for the root role) — exactly what `peko create -s` reads.
 * The Hub stores the TOML text and refuses anything that would carry an
 * identity, an owner, a grant, or deployment state from one peko to the
 * next: those keys belong to an existence, and `peko seed` strips them.
 */

/** Top-level keys a published seed must not carry. */
export const IDENTITY_KEYS = [
  "id",
  "did",
  "actor_key",
  "owner",
  "permissions",
  "boot_state",
  "status",
  "exposure",
  "children",
] as const;

export const MAX_SEED_BYTES = 64 * 1024;
export const MAX_README_BYTES = 64 * 1024;

const VERSION_PATTERN = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?$/;

export function isValidSeedVersion(version: unknown): version is string {
  return typeof version === "string" && VERSION_PATTERN.test(version);
}

/** What the Hub reads out of a seed to list and describe it. */
export interface SeedSummary {
  name: string;
  displayName: string | null;
  description: string | null;
  avatar: string | null;
  /** `preferred_model_id`: the model the seed was written for, if any. */
  model: string | null;
  hasPersona: boolean;
}

export type SeedValidation =
  | { ok: true; summary: SeedSummary }
  | { ok: false; error: string };

function optionalString(table: unknown, key: string): string | null {
  if (!table || typeof table !== "object") return null;
  const value = (table as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Parse and check a seed; the error is written for the person publishing it. */
export function validateSeed(text: string): SeedValidation {
  if (Buffer.byteLength(text, "utf8") > MAX_SEED_BYTES) {
    return { ok: false, error: `A seed is at most ${MAX_SEED_BYTES / 1024} KB.` };
  }
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(text) as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : "invalid TOML";
    return { ok: false, error: `This isn't valid TOML: ${reason}` };
  }

  const carried = IDENTITY_KEYS.filter((key) => key in doc);
  if (carried.length > 0) {
    return {
      ok: false,
      error:
        `A seed can't carry ${carried.map((key) => `\`${key}\``).join(", ")} — ` +
        "those belong to one peko, not its definition. Export the seed with `peko seed <name>`, " +
        "or remove those keys.",
    };
  }

  const name = PrincipalName.safeParse(doc.name);
  if (!name.success) {
    return {
      ok: false,
      error:
        "A seed needs a `name`: 1–64 letters, digits, `-` or `_`, starting with a letter or digit.",
    };
  }
  if (doc.persona !== undefined && typeof doc.persona !== "string") {
    return { ok: false, error: "`persona` must be a string (the root role's Markdown body)." };
  }

  return {
    ok: true,
    summary: {
      name: name.data,
      displayName: optionalString(doc.identity, "display_name"),
      description: optionalString(doc.identity, "description"),
      avatar: optionalString(doc.identity, "avatar"),
      model: optionalString(doc, "preferred_model_id"),
      hasPersona: typeof doc.persona === "string" && doc.persona.trim().length > 0,
    },
  };
}

export async function seedDigest(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `sha256:${Buffer.from(digest).toString("hex")}`;
}
