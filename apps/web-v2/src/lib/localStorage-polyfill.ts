/**
 * localStorage polyfill for server-side rendering
 *
 * Prevents errors when code tries to access localStorage during SSR.
 * This is a no-op on the server - actual localStorage is only available in the browser.
 */

// Polyfill localStorage for server-side rendering
// Prevents "localStorage.getItem is not a function" errors during SSR
if (typeof window === "undefined" && typeof globalThis !== "undefined") {
  // Server-side: create a minimal localStorage polyfill
  const storage = new Map<string, string>();

  // Only set if localStorage doesn't already exist
  if (!globalThis.localStorage) {
    globalThis.localStorage = {
      getItem: (key: string) => {
        return storage.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
      clear: () => {
        storage.clear();
      },
      get length() {
        return storage.size;
      },
      key: (index: number) => {
        const keys = Array.from(storage.keys());
        return keys[index] ?? null;
      },
    } as Storage;
  }
}
