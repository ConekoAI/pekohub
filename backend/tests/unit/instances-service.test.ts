import { describe, it, expect } from "vitest";
import { instanceService } from "../../src/services/instances.js";
import type { Subject } from "@pekohub/shared";

describe("instanceService.canChat", () => {
  const baseInstance = {
    id: "test-id",
    type: "principal" as const,
    name: "Test Instance",
    ownerId: 1,
    ownerSubject: { kind: "user" as const, id: "1" } as Subject,
    runtimeId: "runtime-1",
    runtimeDisplayName: null,
    bundleRef: null,
    status: "online" as const,
    exposure: "private" as const,
    allowedPrincipals: [] as Subject[],
    lastSeenAt: null,
    createdAt: new Date(),
    capabilities: [],
    metadata: {},
    publicName: null,
    description: null,
    tags: [],
    category: null,
    tosRequired: false,
    tosText: null,
    dailyQuota: null,
    weeklyQuota: null,
    publishedAt: null,
    featured: false,
  };

  it("returns false when instance is offline", async () => {
    const instance = { ...baseInstance, status: "offline" as const };
    expect(await instanceService.canChat(instance, 1)).toBe(false);
  });

  it("returns false when instance is unexposed", async () => {
    const instance = { ...baseInstance, exposure: "unexposed" as const };
    expect(await instanceService.canChat(instance, 1)).toBe(false);
  });

  it("returns true when instance is public and online", async () => {
    const instance = {
      ...baseInstance,
      status: "online" as const,
      exposure: "public" as const,
    };
    expect(await instanceService.canChat(instance, 999)).toBe(true);
  });

  it("returns false when private instance and no userId provided", async () => {
    const instance = {
      ...baseInstance,
      status: "online" as const,
      exposure: "private" as const,
    };
    expect(await instanceService.canChat(instance, undefined)).toBe(false);
    expect(await instanceService.canChat(instance, null)).toBe(false);
  });

  it("returns true when private instance and user is owner", async () => {
    const instance = {
      ...baseInstance,
      status: "online" as const,
      exposure: "private" as const,
      ownerId: 42,
      ownerSubject: { kind: "user" as const, id: "42" } as Subject,
    };
    expect(await instanceService.canChat(instance, 42)).toBe(true);
  });

  it("returns true when private instance and user is in typed allowedPrincipals", async () => {
    const instance = {
      ...baseInstance,
      status: "online" as const,
      exposure: "private" as const,
      ownerId: 1,
      ownerSubject: { kind: "user" as const, id: "1" } as Subject,
      allowedPrincipals: [
        { kind: "user" as const, id: "7" } as Subject,
        { kind: "principal" as const, id: "helper" } as Subject,
      ],
    };
    expect(await instanceService.canChat(instance, 7)).toBe(true);
  });

  it("returns false when private instance and user is not authorized", async () => {
    const instance = {
      ...baseInstance,
      status: "online" as const,
      exposure: "private" as const,
      ownerId: 1,
      ownerSubject: { kind: "user" as const, id: "1" } as Subject,
      allowedPrincipals: [
        { kind: "user" as const, id: "7" } as Subject,
      ],
    };
    expect(await instanceService.canChat(instance, 2)).toBe(false);
  });

  it("returns true when busy status and public exposure", async () => {
    const instance = {
      ...baseInstance,
      status: "busy" as const,
      exposure: "public" as const,
    };
    expect(await instanceService.canChat(instance, 123)).toBe(true);
  });

  // Issue #11: Agent caller against an Agent-owned instance.
  it("allows an Agent caller against an Agent-owned instance", async () => {
    const instance = {
      ...baseInstance,
      status: "online" as const,
      exposure: "private" as const,
      ownerId: 99, // legacy column populated but the typed owner wins
      ownerSubject: { kind: "principal" as const, id: "helper" } as Subject,
    };
    expect(
      await instanceService.canChat(instance, {
        kind: "principal",
        id: "helper",
      }),
    ).toBe(true);
  });

  // Issue #11 backfill: the runtime migration writes
  // `Subject::User("")` as the empty-sentinel. The hub must fall
  // back to the legacy `ownerId` rather than reject the row.
  it("backfilled empty-sentinel owner_subject falls back to legacy ownerId", async () => {
    const instance = {
      ...baseInstance,
      status: "online" as const,
      exposure: "private" as const,
      ownerId: 7,
      ownerSubject: { kind: "user" as const, id: "" } as Subject,
    };
    expect(await instanceService.canChat(instance, 7)).toBe(true);
  });
});
