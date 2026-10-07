import { vi } from "bun:test";

export const mockOrder = {
  id: "test-order-id",
  userId: "test-user-id",
  symbol: "AAPL",
  assetType: "EQUITY" as const,
  orderType: "Market" as const,
  tradeAction: "Buy" as const,
  direction: "long" as const,
  quantity: 100,
  status: "SUBMITTED" as const,
  brokerOrderId: "broker-123",
  createdAt: new Date(),
  updatedAt: new Date(),
};

export const mockCredentials = {
  credentialId: "test-credential-id",
  username: "test-key-id",
  accessToken: "test-secret",
  accountType: "PAPER" as const,
  baseUrl: undefined,
};

export const createMockDb = () => {
  const orders: any[] = [];
  
  return {
    query: {
      orders: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
      },
      signals: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    },
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([mockOrder]),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue({}),
      }),
    }),
    orders,
  };
};

export const createMockAlpacaClient = () => {
  return {
    createOrder: vi.fn().mockResolvedValue({
      id: "alpaca-order-123",
      status: "accepted",
    }),
    getOrder: vi.fn(),
    cancelOrder: vi.fn(),
    getOrders: vi.fn().mockResolvedValue([]),
    getPosition: vi.fn(),
    getPositions: vi.fn().mockResolvedValue([]),
    getAccount: vi.fn(),
    getSnapshot: vi.fn(),
  };
};

export const mockCtx = {
  db: createMockDb(),
  userId: "test-user-id",
};
