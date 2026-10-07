type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

interface SessionRecoveringFetchOptions {
  fetch: FetchLike;
  refreshSession: () => Promise<unknown>;
}

/**
 * Retry one request after asking Better Auth to refresh its cookie.
 *
 * A tab that has been idle can make several polling requests at once, so the
 * refresh is shared. The original requests are each replayed at most once;
 * a genuinely expired session therefore still settles as a 401 without a
 * retry loop.
 */
export function createSessionRecoveringFetch({
  fetch: fetchImpl,
  refreshSession,
}: SessionRecoveringFetchOptions): FetchLike {
  let refreshInFlight: Promise<void> | null = null;

  const recoverSession = () => {
    if (!refreshInFlight) {
      refreshInFlight = Promise.resolve(refreshSession())
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => {
          refreshInFlight = null;
        });
    }
    return refreshInFlight;
  };

  return async (input, init) => {
    const response = await fetchImpl(input, init);
    if (response.status !== 401) return response;

    await recoverSession();
    return fetchImpl(input, init);
  };
}
