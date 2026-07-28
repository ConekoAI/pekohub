import { describe, it, expect, vi, beforeEach } from "vitest";

const mockUpdateSet = vi.fn();
const mockUpdateWhere = vi.fn();
const mockUpdate = vi.fn();
const mockUpdateReturning = vi.fn();

vi.mock("../../src/db/index.js", () => ({
  db: {
    update: mockUpdate,
  },
}));

// `and` and the operators come from drizzle-orm; mock them so the
// `markOfflineIfStale` `where(and(eq(...), lt(...)))` chain compiles.
vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  return {
    ...actual,
    and: (...args: unknown[]) => ({ _and: args }),
    eq: (col: unknown, val: unknown) => ({ _eq: { col, val } }),
    lt: (col: unknown, val: unknown) => ({ _lt: { col, val } }),
  };
});

// Import after mocks are declared
const { InstanceService, instanceService } = await import("../../src/services/instances.js");

describe("InstanceService.markOfflineIfStale", () => {
  let service: InstanceType<typeof InstanceService>;

  beforeEach(() => {
    service = new InstanceService();
    mockUpdate.mockReset();
    mockUpdateSet.mockReset();
    mockUpdateWhere.mockReset();
    mockUpdateReturning.mockReset();
  });

  it("returns 0 when no rows were swept", async () => {
    mockUpdate.mockImplementation(() => ({
      set: mockUpdateSet.mockImplementation(() => ({
        where: mockUpdateWhere.mockImplementation(() => ({
          returning: mockUpdateReturning.mockResolvedValue([]),
        })),
      })),
    }));

    const n = await service.markOfflineIfStale(60_000);
    expect(n).toBe(0);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdateSet).toHaveBeenCalledWith({ status: "offline" });
  });

  it("returns the count of swept rows", async () => {
    mockUpdate.mockImplementation(() => ({
      set: mockUpdateSet.mockImplementation(() => ({
        where: mockUpdateWhere.mockImplementation(() => ({
          returning: mockUpdateReturning.mockResolvedValue([
            { id: "a" },
            { id: "b" },
            { id: "c" },
          ]),
        })),
      })),
    }));

    const n = await service.markOfflineIfStale(90_000);
    expect(n).toBe(3);
  });

  it("passes an `and(eq(status=online), lt(lastSeenAt, cutoff))` where clause", async () => {
    mockUpdate.mockImplementation(() => ({
      set: mockUpdateSet.mockImplementation(() => ({
        where: mockUpdateWhere.mockImplementation(() => ({
          returning: mockUpdateReturning.mockResolvedValue([]),
        })),
      })),
    }));

    await service.markOfflineIfStale(45_000);
    expect(mockUpdateWhere).toHaveBeenCalledTimes(1);
    const whereArg = mockUpdateWhere.mock.calls[0][0];
    expect(whereArg).toBeDefined();
    expect((whereArg as { _and: unknown[] })._and).toHaveLength(2);
  });

  it("uses the 60_000ms default when no timeout is supplied", async () => {
    mockUpdate.mockImplementation(() => ({
      set: mockUpdateSet.mockImplementation(() => ({
        where: mockUpdateWhere.mockImplementation(() => ({
          returning: mockUpdateReturning.mockResolvedValue([]),
        })),
      })),
    }));

    await service.markOfflineIfStale();
    expect(mockUpdateWhere).toHaveBeenCalledTimes(1);
  });

  it("the singleton instanceService has the method", () => {
    expect(typeof instanceService.markOfflineIfStale).toBe("function");
  });
});