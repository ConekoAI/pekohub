import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDbInsert = vi.fn();
const mockDbSelect = vi.fn();

vi.mock("../../db/index.js", () => ({
  db: {
    insert: mockDbInsert.mockReturnValue({
      values: vi.fn().mockReturnThis(),
    }),
    select: mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      offset: vi.fn().mockReturnThis(),
    }),
  },
}));

// Import after mocks are declared
const { AuditService } = await import("../audit.js");

describe("AuditService", () => {
  let service: InstanceType<typeof AuditService>;

  beforeEach(() => {
    service = new AuditService();
    mockDbInsert.mockClear();
    mockDbSelect.mockClear();
  });

  describe("logPush", () => {
    it("inserts a push audit log", async () => {
      mockDbInsert.mockImplementation(() => ({
        values: vi.fn().mockReturnThis(),
      }));

      await service.logPush("acme", 1, "my-bundle", "1.0.0", "sha256:abc", {
        size: 42,
      });

      expect(mockDbInsert).toHaveBeenCalled();
      const valuesCall = mockDbInsert.mock.results[0].value.values;
      expect(valuesCall).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: "acme",
          userId: 1,
          action: "push",
          resource: "acme/my-bundle:1.0.0",
          details: { digest: "sha256:abc", size: 42 },
        }),
      );
    });

    it("handles undefined userId", async () => {
      mockDbInsert.mockImplementation(() => ({
        values: vi.fn().mockReturnThis(),
      }));

      await service.logPush(
        "acme",
        undefined,
        "my-bundle",
        "1.0.0",
        "sha256:abc",
      );

      const valuesCall = mockDbInsert.mock.results[0].value.values;
      expect(valuesCall).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: null,
        }),
      );
    });

    it("does not throw when db insert fails", async () => {
      mockDbInsert.mockImplementation(() => {
        throw new Error("db down");
      });

      await expect(
        service.logPush("acme", 1, "my-bundle", "1.0.0", "sha256:abc"),
      ).resolves.toBeUndefined();
    });
  });

  describe("logPull", () => {
    it("inserts a pull audit log", async () => {
      mockDbInsert.mockImplementation(() => ({
        values: vi.fn().mockReturnThis(),
      }));

      await service.logPull("acme", 2, "my-bundle", "1.0.0", "sha256:def");

      expect(mockDbInsert).toHaveBeenCalled();
      const valuesCall = mockDbInsert.mock.results[0].value.values;
      expect(valuesCall).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: "acme",
          userId: 2,
          action: "pull",
          resource: "acme/my-bundle:1.0.0",
          details: { digest: "sha256:def" },
        }),
      );
    });

    it("does not throw when db insert fails", async () => {
      mockDbInsert.mockImplementation(() => {
        throw new Error("db down");
      });

      await expect(
        service.logPull("acme", 1, "my-bundle", "1.0.0", "sha256:def"),
      ).resolves.toBeUndefined();
    });
  });

  describe("logDelete", () => {
    it("inserts a delete audit log", async () => {
      mockDbInsert.mockImplementation(() => ({
        values: vi.fn().mockReturnThis(),
      }));

      await service.logDelete("acme", 3, "acme/my-bundle:1.0.0", {
        reason: "cleanup",
      });

      const valuesCall = mockDbInsert.mock.results[0].value.values;
      expect(valuesCall).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: "acme",
          userId: 3,
          action: "delete",
          resource: "acme/my-bundle:1.0.0",
          details: { reason: "cleanup" },
        }),
      );
    });

    it("does not throw when db insert fails", async () => {
      mockDbInsert.mockImplementation(() => {
        throw new Error("db down");
      });

      await expect(
        service.logDelete("acme", 1, "acme/my-bundle:1.0.0"),
      ).resolves.toBeUndefined();
    });
  });

  describe("logPermissionChange", () => {
    it("inserts a permission_change audit log", async () => {
      mockDbInsert.mockImplementation(() => ({
        values: vi.fn().mockReturnThis(),
      }));

      await service.logPermissionChange("acme", 4, "acme/my-bundle", {
        role: "admin",
      });

      const valuesCall = mockDbInsert.mock.results[0].value.values;
      expect(valuesCall).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: "acme",
          userId: 4,
          action: "permission_change",
          resource: "acme/my-bundle",
          details: { role: "admin" },
        }),
      );
    });

    it("does not throw when db insert fails", async () => {
      mockDbInsert.mockImplementation(() => {
        throw new Error("db down");
      });

      await expect(
        service.logPermissionChange("acme", 1, "acme/my-bundle"),
      ).resolves.toBeUndefined();
    });
  });

  describe("listByNamespace", () => {
    it("returns paginated audit logs", async () => {
      const mockLogs = [
        {
          id: 1,
          namespace: "acme",
          userId: 1,
          action: "push",
          resource: "acme/bundle:1.0.0",
          details: null,
          createdAt: new Date("2024-01-01"),
        },
        {
          id: 2,
          namespace: "acme",
          userId: 2,
          action: "pull",
          resource: "acme/bundle:1.0.0",
          details: null,
          createdAt: new Date("2024-01-02"),
        },
      ];

      const chain = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        offset: vi.fn().mockResolvedValue(mockLogs),
      };

      const countChain = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([{ count: 2 }]),
      };

      mockDbSelect.mockImplementation((arg?: unknown) => {
        if (arg && typeof arg === "object" && "count" in (arg as object)) {
          return countChain;
        }
        return chain;
      });

      const result = await service.listByNamespace("acme", {
        page: 1,
        perPage: 10,
      });

      expect(result.logs).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.perPage).toBe(10);
    });

    it("filters by action when provided", async () => {
      const mockLogs = [
        {
          id: 1,
          namespace: "acme",
          userId: 1,
          action: "push",
          resource: "acme/bundle:1.0.0",
          details: null,
          createdAt: new Date(),
        },
      ];

      const chain = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        offset: vi.fn().mockResolvedValue(mockLogs),
      };

      const countChain = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([{ count: 1 }]),
      };

      mockDbSelect.mockImplementation((arg?: unknown) => {
        if (arg && typeof arg === "object" && "count" in (arg as object)) {
          return countChain;
        }
        return chain;
      });

      const result = await service.listByNamespace("acme", {
        action: "push",
        page: 1,
        perPage: 10,
      });

      expect(result.logs).toHaveLength(1);
      expect(result.total).toBe(1);
    });
  });
});
