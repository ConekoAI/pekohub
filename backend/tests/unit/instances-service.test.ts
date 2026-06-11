import { describe, it, expect } from "vitest";
import { instanceService } from "../../src/services/instances.js";

describe("instanceService.canChat", () => {
  const baseInstance = {
    id: "test-id",
    type: "chat" as const,
    name: "Test Instance",
    ownerId: 1,
    runtimeId: "runtime-1",
    runtimeDisplayName: null,
    bundleRef: null,
    status: "online" as const,
    exposure: "private" as const,
    allowedUsers: [] as string[],
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

  it("returns false when instance is offline", () => {
    const instance = { ...baseInstance, status: "offline" as const };
    expect(instanceService.canChat(instance, 1)).toBe(false);
  });

  it("returns false when instance is unexposed", () => {
    const instance = { ...baseInstance, exposure: "unexposed" as const };
    expect(instanceService.canChat(instance, 1)).toBe(false);
  });

  it("returns true when instance is public and online", () => {
    const instance = {
      ...baseInstance,
      status: "online" as const,
      exposure: "public" as const,
    };
    expect(instanceService.canChat(instance, 999)).toBe(true);
  });

  it("returns false when private instance and no userId provided", () => {
    const instance = {
      ...baseInstance,
      status: "online" as const,
      exposure: "private" as const,
    };
    expect(instanceService.canChat(instance, undefined)).toBe(false);
    expect(instanceService.canChat(instance, null)).toBe(false);
  });

  it("returns true when private instance and user is owner", () => {
    const instance = {
      ...baseInstance,
      status: "online" as const,
      exposure: "private" as const,
      ownerId: 42,
    };
    expect(instanceService.canChat(instance, 42)).toBe(true);
  });

  it("returns true when private instance and user is in allowedUsers", () => {
    const instance = {
      ...baseInstance,
      status: "online" as const,
      exposure: "private" as const,
      ownerId: 1,
      allowedUsers: ["7", "99"],
    };
    expect(instanceService.canChat(instance, 7)).toBe(true);
    expect(instanceService.canChat(instance, 99)).toBe(true);
  });

  it("returns false when private instance and user is not authorized", () => {
    const instance = {
      ...baseInstance,
      status: "online" as const,
      exposure: "private" as const,
      ownerId: 1,
      allowedUsers: ["7"],
    };
    expect(instanceService.canChat(instance, 2)).toBe(false);
  });

  it("returns true when busy status and public exposure", () => {
    const instance = {
      ...baseInstance,
      status: "busy" as const,
      exposure: "public" as const,
    };
    expect(instanceService.canChat(instance, 123)).toBe(true);
  });
});
