import { describe, it, expect } from "vitest";
import { instanceService } from "../../src/services/instances.js";
import type { Subject } from "@pekohub/shared";

describe("instanceService.canChat", () => {
  const baseInstance = {
    id: "test-id",
    type: "principal" as const,
    name: "Test Instance",
    ownerSubject: { kind: "user" as const, id: "1" } as Subject,
    runtimeId: "runtime-1",
    runtimeDisplayName: null,
    bundleRef: null,
    status: "online" as const,
    exposure: "private" as const,
    // Post-H4: allowedPrincipals removed from the record.
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
    expect(await instanceService.canChat(instance, "1")).toBe(false);
  });

  it("returns false when instance is unexposed", async () => {
    const instance = { ...baseInstance, exposure: "unexposed" as const };
    expect(await instanceService.canChat(instance, "1")).toBe(false);
  });

  it("returns true when instance is public and online", async () => {
    const instance = {
      ...baseInstance,
      status: "online" as const,
      exposure: "public" as const,
    };
    expect(await instanceService.canChat(instance, "999")).toBe(true);
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
      ownerSubject: { kind: "user" as const, id: "42" } as Subject,
    };
    expect(await instanceService.canChat(instance, "42")).toBe(true);
  });

  // Post-H4: with `allowedPrincipals` gone, the only way a non-owner
  // can chat against a private instance is if the runtime's
  // PrincipalConfig.permissions grants them. pekohub itself only
  // recognises the owner. We assert that a different user is denied.
  it("returns false when private instance and user is not the owner (post-H4)", async () => {
    const instance = {
      ...baseInstance,
      status: "online" as const,
      exposure: "private" as const,
      ownerSubject: { kind: "user" as const, id: "1" } as Subject,
    };
    expect(await instanceService.canChat(instance, "2")).toBe(false);
  });

  it("returns true when busy status and public exposure", async () => {
    const instance = {
      ...baseInstance,
      status: "busy" as const,
      exposure: "public" as const,
    };
    expect(await instanceService.canChat(instance, "123")).toBe(true);
  });

  // Issue #11: Principal-kind caller against a Principal-owned instance.
  it("allows a Principal-kind caller against a Principal-owned instance", async () => {
    const instance = {
      ...baseInstance,
      status: "online" as const,
      exposure: "private" as const,
      ownerSubject: { kind: "principal" as const, id: "helper" } as Subject,
    };
    expect(
      await instanceService.canChat(instance, {
        kind: "principal",
        id: "helper",
      }),
    ).toBe(true);
  });

  // Post-H1: the runtime migration backfilled empty-sentinel
  // `Subject::User("")` on legacy rows. With `owner_id` gone there
  // is no longer a fallback column, so the row becomes ownerless and
  // the access check must deny everyone (even legacy user 7).
  it("empty-sentinel owner_subject makes the row ownerless (post-H1)", async () => {
    const instance = {
      ...baseInstance,
      status: "online" as const,
      exposure: "private" as const,
      ownerSubject: { kind: "user" as const, id: "" } as Subject,
    };
    expect(await instanceService.canChat(instance, "7")).toBe(false);
    expect(await instanceService.canChat(instance, "99")).toBe(false);
  });
});
