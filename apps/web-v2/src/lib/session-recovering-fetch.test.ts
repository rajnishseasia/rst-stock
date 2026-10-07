import { describe, expect, test } from "bun:test";

import { createSessionRecoveringFetch } from "./session-recovering-fetch";

describe("createSessionRecoveringFetch", () => {
  test("refreshes the session and replays one unauthorized request", async () => {
    let requests = 0;
    let refreshes = 0;
    const recoveringFetch = createSessionRecoveringFetch({
      fetch: (async () => {
        requests += 1;
        return new Response(null, { status: requests === 1 ? 401 : 200 });
      }),
      refreshSession: async () => {
        refreshes += 1;
      },
    });

    const response = await recoveringFetch("/trpc/positions.listPerps");

    expect(response.status).toBe(200);
    expect(requests).toBe(2);
    expect(refreshes).toBe(1);
  });

  test("does not loop when the replay is also unauthorized", async () => {
    let requests = 0;
    const recoveringFetch = createSessionRecoveringFetch({
      fetch: (async () => {
        requests += 1;
        return new Response(null, { status: 401 });
      }),
      refreshSession: async () => undefined,
    });

    const response = await recoveringFetch("/trpc/positions.listPerps");

    expect(response.status).toBe(401);
    expect(requests).toBe(2);
  });

  test("shares one refresh across simultaneous polling failures", async () => {
    let refreshes = 0;
    let releaseRefresh!: () => void;
    const refreshBlocked = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const attempts = new Map<string, number>();
    const recoveringFetch = createSessionRecoveringFetch({
      fetch: (async (input: RequestInfo | URL) => {
        const key = String(input);
        const attempt = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, attempt);
        return new Response(null, { status: attempt === 1 ? 401 : 200 });
      }),
      refreshSession: async () => {
        refreshes += 1;
        await refreshBlocked;
      },
    });

    const first = recoveringFetch("/trpc/positions.listPerps");
    const second = recoveringFetch("/trpc/balances.get");
    await Promise.resolve();
    await Promise.resolve();
    releaseRefresh();

    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(refreshes).toBe(1);
  });
});
