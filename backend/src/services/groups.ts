/**
 * Registered groups (peko-runtime ADR-092 D5/D6).
 *
 * A group lives on its home runtime; the Hub gives it an ID (a snowflake),
 * keeps its name, owner, home and visibility, and the accounts in it as the
 * home reports them, so a person's devices can find their groups. It keeps
 * no posts and no peko members.
 *
 * Invite links are minted and checked by the home: a compact JWS signed by
 * the home runtime's key, payload `{ v, g, c, h, exp, n }`. The Hub checks
 * the signature and expiry only to decide whether to show an invite-only
 * group's page; the home decides who joins.
 */

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { hubGroupMembers, hubGroups, instances, runtimes, users } from "../db/schema.js";
import { nextSnowflake } from "./snowflake.js";
import { verifyDidKeyJws } from "./tunnel-crypto.js";

export const INVITE_TOKEN_VERSION = "peko-group-invite/1";

export type GroupVisibility = "invite_only" | "public";

export class GroupRegistrationError extends Error {}

export interface RegisterGroupInput {
  homeRuntime: string;
  channelId: string;
  name: string;
  ownerAddress: string;
  visibility: GroupVisibility;
}

/** What anyone with the ID (and, for an invite-only group, an invite) sees. */
export interface PublicGroup {
  id: string;
  name: string;
  visibility: GroupVisibility;
  owner: { kind: "peko" | "person"; name: string | null; handle: string | null };
  homeRuntime: string;
  channelId: string;
}

async function runtimeOwner(runtimeDid: string): Promise<string | null> {
  const row = await db.query.runtimes.findFirst({ where: eq(runtimes.runtimeDid, runtimeDid) });
  return row?.ownerId ?? null;
}

/**
 * Register a group from its home, or update its name and visibility. The
 * owner must be a peko linked to that runtime, or the person the runtime
 * is registered to.
 */
export async function registerGroup(input: RegisterGroupInput): Promise<string> {
  const ownerId = await runtimeOwner(input.homeRuntime);
  if (!ownerId) throw new GroupRegistrationError("this runtime is not registered");
  if (!["invite_only", "public"].includes(input.visibility)) {
    throw new GroupRegistrationError("visibility is invite_only or public");
  }
  const name = input.name.trim();
  if (!name || name.length > 256) throw new GroupRegistrationError("a group needs a name of up to 256 characters");
  const owner = input.ownerAddress;
  if (owner.startsWith("principal:hub:")) {
    const hubId = owner.slice("principal:hub:".length);
    const linked = await db.query.instances.findFirst({
      where: and(eq(instances.hubId, hubId), eq(instances.runtimeId, input.homeRuntime)),
    });
    if (!linked) throw new GroupRegistrationError("the owning peko is not online on this runtime");
  } else if (owner.startsWith("user:hub:")) {
    if (owner.slice("user:hub:".length) !== ownerId) {
      throw new GroupRegistrationError("a person registers only their own groups");
    }
  } else {
    throw new GroupRegistrationError("the owner is a peko or a person on PekoHub");
  }

  const existing = await db.query.hubGroups.findFirst({
    where: and(eq(hubGroups.homeRuntime, input.homeRuntime), eq(hubGroups.channelId, input.channelId)),
  });
  if (existing) {
    await db
      .update(hubGroups)
      .set({ name, visibility: input.visibility, ownerAddress: owner, updatedAt: new Date() })
      .where(eq(hubGroups.id, existing.id));
    return existing.id.toString();
  }
  const id = nextSnowflake();
  await db.insert(hubGroups).values({
    id: BigInt(id),
    name,
    homeRuntime: input.homeRuntime,
    channelId: input.channelId,
    ownerId,
    ownerAddress: owner,
    visibility: input.visibility,
  });
  return id;
}

/**
 * The home reports which accounts are in the group. Only the home may;
 * unknown accounts are skipped.
 */
export async function setGroupRoster(homeRuntime: string, groupId: string, accounts: string[]): Promise<void> {
  if (!/^[0-9]+$/.test(groupId)) throw new GroupRegistrationError("not a group ID");
  const gid = BigInt(groupId);
  const group = await db.query.hubGroups.findFirst({ where: eq(hubGroups.id, gid) });
  if (!group || group.homeRuntime !== homeRuntime) {
    throw new GroupRegistrationError("only the group's home reports its members");
  }
  const ids = accounts.filter((a) => /^[0-9a-f-]{36}$/i.test(a));
  const known = ids.length
    ? await db.select({ id: users.id }).from(users).where(inArray(users.id, ids))
    : [];
  await db.delete(hubGroupMembers).where(eq(hubGroupMembers.groupId, gid));
  if (known.length) {
    await db.insert(hubGroupMembers).values(known.map((u) => ({ groupId: gid, userId: u.id })));
  }
}

/** The registered groups `userId` is in (their devices' list, ADR-092 D4). */
export async function groupsOfAccount(userId: string) {
  const rows = await db
    .select({
      groupId: hubGroups.id,
      name: hubGroups.name,
      homeRuntime: hubGroups.homeRuntime,
      channelId: hubGroups.channelId,
    })
    .from(hubGroupMembers)
    .innerJoin(hubGroups, eq(hubGroups.id, hubGroupMembers.groupId))
    .where(eq(hubGroupMembers.userId, userId));
  return rows.map((r) => ({ ...r, groupId: r.groupId.toString() }));
}

/** Whether `token` is an unexpired invite to `group`, signed by its home. */
export async function inviteIsValid(
  group: { id: string; homeRuntime: string; channelId: string },
  token: string,
): Promise<boolean> {
  const payload = await verifyDidKeyJws(group.homeRuntime, token);
  if (!payload) return false;
  return (
    payload.v === INVITE_TOKEN_VERSION &&
    payload.g === group.id &&
    payload.c === group.channelId &&
    payload.h === group.homeRuntime &&
    typeof payload.exp === "number" &&
    payload.exp * 1000 > Date.now()
  );
}

/**
 * A group as its page shows it: a public group to anyone, an invite-only
 * one only with a valid invite. `null` otherwise, so an invite-only
 * group's existence isn't revealed.
 */
export async function publicGroup(id: string, invite?: string): Promise<PublicGroup | null> {
  if (!/^[0-9]+$/.test(id)) return null;
  const row = await db.query.hubGroups.findFirst({ where: eq(hubGroups.id, BigInt(id)) });
  if (!row) return null;
  const group = { ...row, id: row.id.toString() };
  if (group.visibility !== "public" && !(invite && (await inviteIsValid(group, invite)))) {
    return null;
  }
  let owner: PublicGroup["owner"] = { kind: "person", name: null, handle: null };
  if (group.ownerAddress.startsWith("principal:hub:")) {
    const peko = await db.query.instances.findFirst({
      where: eq(instances.hubId, group.ownerAddress.slice("principal:hub:".length)),
    });
    const person = await db.query.users.findFirst({ where: eq(users.id, group.ownerId) });
    owner = {
      kind: "peko",
      name: peko?.publicName ?? peko?.name ?? null,
      handle: person && peko ? `@${person.namespace}/${peko.name}` : null,
    };
  } else {
    const person = await db.query.users.findFirst({ where: eq(users.id, group.ownerId) });
    owner = {
      kind: "person",
      name: person?.displayName ?? person?.namespace ?? null,
      handle: person ? `@${person.namespace}` : null,
    };
  }
  return {
    id: group.id,
    name: group.name,
    visibility: group.visibility as GroupVisibility,
    owner,
    homeRuntime: group.homeRuntime,
    channelId: group.channelId,
  };
}
