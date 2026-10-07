import { describe, expect, test } from "bun:test";
import { MAX_RETRY_ATTEMPTS, createLayoutSaveQueue } from "./layout-save-queue";

type Layout = { id: string };

interface Harness {
  queue: ReturnType<typeof createLayoutSaveQueue<Layout>>;
  saved: Layout[];
  cleared: number;
  failed: number;
  retries: Array<() => void>;
  /** Release the pending save/reset request in FIFO order. */
  settleNext: (outcome: "ok" | "throw") => void;
  inFlight: () => number;
}

/**
 * Drives the queue with manually-released requests, which is the whole point of
 * extracting it: the outcome of a write is only observable while it is in
 * flight, and a component test cannot hold one there.
 */
function harness(): Harness {
  const gates: Array<(outcome: "ok" | "throw") => void> = [];
  const state = { saved: [] as Layout[], cleared: 0, failed: 0 };
  const retries: Array<() => void> = [];

  const request = () =>
    new Promise<void>((resolve, reject) => {
      gates.push((outcome) =>
        outcome === "ok" ? resolve() : reject(new Error("network")),
      );
    });

  const queue = createLayoutSaveQueue<Layout>({
    save: request,
    reset: request,
    onSaved: (payload) => state.saved.push(payload),
    onCleared: () => {
      state.cleared += 1;
    },
    onFailed: () => {
      state.failed += 1;
    },
    scheduleRetry: (run) => retries.push(run),
  });

  return {
    queue,
    get saved() {
      return state.saved;
    },
    get cleared() {
      return state.cleared;
    },
    get failed() {
      return state.failed;
    },
    retries,
    settleNext: (outcome) => gates.shift()?.(outcome),
    inFlight: () => gates.length,
  } as Harness;
}

/** Let queued microtasks run. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("reset reports its real outcome", () => {
  test("resolves false when the reset request fails", async () => {
    // The bug this exists for. The queue empties its slot BEFORE awaiting and
    // swallows the error to keep its retry loop alive, so a caller inspecting
    // the queue afterwards sees the same state either way: every failed reset
    // reported success, and the user was told their layout was cleared while the
    // account still held it, ready to come back on the next load.
    const h = harness();
    const pending = h.queue.requestReset();
    await tick();
    h.settleNext("throw");

    expect(await pending).toBe(false);
    expect(h.cleared).toBe(0);
    expect(h.failed).toBe(1);
  });

  test("resolves true only when the account copy was actually cleared", async () => {
    const h = harness();
    const pending = h.queue.requestReset();
    await tick();
    h.settleNext("ok");

    expect(await pending).toBe(true);
    expect(h.cleared).toBe(1);
  });

  test("a failed reset is not retried behind the user's back", async () => {
    // The handler has already told the user the layout may come back. Clearing
    // the account later would wipe a workspace they have since rebuilt.
    const h = harness();
    const pending = h.queue.requestReset();
    await tick();
    h.settleNext("throw");
    await pending;

    expect(h.retries).toHaveLength(0);
    expect(h.inFlight()).toBe(0);
  });

  test("a reset displaced before it ran resolves false rather than hanging", async () => {
    const h = harness();
    h.queue.enqueueSave({ id: "first" });
    await tick();

    const displaced = h.queue.requestReset();
    h.queue.enqueueSave({ id: "second" });

    // Never silently dropped: the caller must be able to toast something.
    expect(await displaced).toBe(false);
  });
});

describe("writes are serialized", () => {
  test("a second write does not start until the first settles", async () => {
    const h = harness();
    h.queue.enqueueSave({ id: "a" });
    await tick();
    expect(h.inFlight()).toBe(1);

    h.queue.enqueueSave({ id: "b" });
    await tick();
    // Still one: overlapping writes could land out of order and leave the OLDER
    // layout on the account for the next browser to restore.
    expect(h.inFlight()).toBe(1);

    h.settleNext("ok");
    await tick();
    expect(h.inFlight()).toBe(1);
    h.settleNext("ok");
    await tick();

    expect(h.saved).toEqual([{ id: "a" }, { id: "b" }]);
  });

  test("rapid changes coalesce to the newest pending payload", async () => {
    const h = harness();
    h.queue.enqueueSave({ id: "a" });
    await tick();
    h.queue.enqueueSave({ id: "b" });
    h.queue.enqueueSave({ id: "c" });

    h.settleNext("ok");
    await tick();
    h.settleNext("ok");
    await tick();

    // "b" is superseded before it is ever sent.
    expect(h.saved).toEqual([{ id: "a" }, { id: "c" }]);
  });

  test("a reset queued behind an in-flight save still runs, and wins", async () => {
    // The ordering guarantee reset depends on: a save must never land after the
    // reset and resurrect the layout it just cleared.
    const h = harness();
    h.queue.enqueueSave({ id: "a" });
    await tick();
    const pending = h.queue.requestReset();

    h.settleNext("ok"); // the save
    await tick();
    h.settleNext("ok"); // the reset

    expect(await pending).toBe(true);
    expect(h.saved).toEqual([{ id: "a" }]);
    expect(h.cleared).toBe(1);
  });
});

describe("failure handling", () => {
  test("a failed save forgets what was saved so a retry is not suppressed", async () => {
    const h = harness();
    h.queue.enqueueSave({ id: "a" });
    await tick();
    h.settleNext("throw");
    await tick();

    expect(h.saved).toEqual([]);
    expect(h.failed).toBe(1);
  });

  test("a lone failed save is retried, not abandoned", async () => {
    // This case used to assert the BUG. The old queue re-armed only for a NEWER
    // pending payload, so a single save that failed with nothing behind it was
    // dropped: the debounce timer had fired and `onFailed` only touches a ref,
    // which schedules no render and no effect, so nothing would ever call the
    // queue again. localStorage already had the change, so the next mount gave
    // the older account copy precedence and the user's change appeared to
    // revert.
    const h = harness();
    h.queue.enqueueSave({ id: "a" });
    await tick();
    h.settleNext("throw");
    await tick();

    expect(h.retries).toHaveLength(1);
    h.retries[0]!();
    await tick();
    h.settleNext("ok");
    await tick();

    expect(h.saved).toEqual([{ id: "a" }]);
  });

  test("a newer payload supersedes the failed one rather than both retrying", async () => {
    const h = harness();
    h.queue.enqueueSave({ id: "a" });
    await tick();
    h.queue.enqueueSave({ id: "b" });
    h.settleNext("throw");
    await tick();

    h.retries[0]!();
    await tick();
    h.settleNext("ok");
    await tick();

    // "a" is stale the moment "b" exists; retrying it would write it after "b".
    expect(h.saved).toEqual([{ id: "b" }]);
  });

  test("gives up after a bounded number of rounds", async () => {
    // A persistently failing endpoint must not have the page retrying for the
    // whole session. The layout is safe in localStorage meanwhile.
    const h = harness();
    h.queue.enqueueSave({ id: "a" });
    await tick();

    let rounds = 0;
    for (let i = 0; i < 10; i += 1) {
      if (h.inFlight() === 0) break;
      h.settleNext("throw");
      await tick();
      rounds += 1;
      const retry = h.retries.shift();
      if (!retry) break;
      retry();
      await tick();
    }

    expect(rounds).toBe(MAX_RETRY_ATTEMPTS);
    expect(h.retries).toHaveLength(0);
    expect(h.inFlight()).toBe(0);
  });

  test("a later deliberate change gets a fresh retry budget", async () => {
    const h = harness();
    h.queue.enqueueSave({ id: "a" });
    await tick();
    for (let i = 0; i < MAX_RETRY_ATTEMPTS; i += 1) {
      h.settleNext("throw");
      await tick();
      h.retries.shift()?.();
      await tick();
    }
    expect(h.inFlight()).toBe(0);

    // The user is still here and just moved something: try again.
    h.queue.enqueueSave({ id: "b" });
    await tick();
    h.settleNext("ok");
    await tick();

    expect(h.saved).toEqual([{ id: "b" }]);
  });

  test("the re-armed retry actually drains the queue", async () => {
    const h = harness();
    h.queue.enqueueSave({ id: "a" });
    await tick();
    h.queue.enqueueSave({ id: "b" });
    h.settleNext("throw");
    await tick();

    expect(h.retries).toHaveLength(1);
    h.retries[0]!();
    await tick();
    h.settleNext("ok");
    await tick();

    expect(h.saved).toEqual([{ id: "b" }]);
  });
});

describe("a reset displaced by another reset shares its outcome", () => {
  // Displacement only happens while something ELSE is in flight: with an idle
  // queue the first reset is taken immediately and is never displaced.
  test("both report success when the second reset succeeds", async () => {
    // Double-tapping Reset used to toast "your layout may come back on your
    // next visit" for the first tap, about a reset that in fact stuck: the two
    // are the same intent and clear the same account copy.
    const h = harness();
    h.queue.enqueueSave({ id: "a" });
    await tick();

    const first = h.queue.requestReset();
    const second = h.queue.requestReset();

    h.settleNext("ok"); // the save
    await tick();
    h.settleNext("ok"); // the surviving reset

    expect(await second).toBe(true);
    expect(await first).toBe(true);
    expect(h.cleared).toBe(1);
  });

  test("both report failure when the surviving reset fails", async () => {
    const h = harness();
    h.queue.enqueueSave({ id: "a" });
    await tick();

    const first = h.queue.requestReset();
    const second = h.queue.requestReset();

    h.settleNext("ok"); // the save
    await tick();
    h.settleNext("throw"); // the surviving reset

    expect(await second).toBe(false);
    expect(await first).toBe(false);
  });

  test("a reset displaced by a SAVE still reports failure", async () => {
    // Different intent: that reset never ran and never will, so its caller has
    // to hear so rather than inherit an unrelated write's outcome.
    const h = harness();
    h.queue.enqueueSave({ id: "a" });
    await tick();

    const displaced = h.queue.requestReset();
    h.queue.enqueueSave({ id: "b" });

    expect(await displaced).toBe(false);
  });
});

describe("the queue calls whatever its deps object currently points at", () => {
  test("a rebound dependency takes effect on the NEXT write", async () => {
    // Why the deps object is module-scoped alongside the queue. The queue is
    // built once and captures its callbacks forever, so a per-mount ref meant a
    // remount created a new one the queue never saw: a completed save updated
    // the UNMOUNTED instance's mirror, the live mirror stayed stale, and a user
    // returning the layout to that stale value had the write suppressed as a
    // no-op while the account still held the intermediate layout.
    const gates: Array<() => void> = [];
    const firstMount: Array<{ id: string }> = [];
    const secondMount: Array<{ id: string }> = [];
    const deps = {
      current: {
        onSaved: (p: { id: string }) => firstMount.push(p),
      },
    };

    const queue = createLayoutSaveQueue<{ id: string }>({
      save: () => new Promise<void>((resolve) => gates.push(resolve)),
      reset: async () => {},
      // Indirection through `deps.current`, exactly as the page wires it.
      onSaved: (payload) => deps.current.onSaved(payload),
      onCleared: () => {},
      onFailed: () => {},
      scheduleRetry: () => {},
    });

    queue.enqueueSave({ id: "a" });
    await new Promise<void>((r) => setTimeout(r, 0));
    gates.shift()!();
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(firstMount).toEqual([{ id: "a" }]);

    // A remount rebinds the deps; the same queue must now report to it.
    deps.current = { onSaved: (p) => secondMount.push(p) };
    queue.enqueueSave({ id: "b" });
    await new Promise<void>((r) => setTimeout(r, 0));
    gates.shift()!();
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(secondMount).toEqual([{ id: "b" }]);
    // And the old mount hears nothing further.
    expect(firstMount).toEqual([{ id: "a" }]);
  });
});

describe("dispose: one user's queue must not write to another's account", () => {
  test("a disposed queue starts nothing new", async () => {
    const h = harness();
    h.queue.dispose();
    h.queue.enqueueSave({ id: "a" });
    await tick();

    expect(h.inFlight()).toBe(0);
    expect(h.saved).toEqual([]);
  });

  test("a completion that lands AFTER dispose is not reported", async () => {
    // The identity-switch case. The dependencies have been rebound to the new
    // user by the time this resolves, so reporting it would record the previous
    // user's payload as the new account's saved state.
    const h = harness();
    h.queue.enqueueSave({ id: "a" });
    await tick();
    h.queue.dispose();
    h.settleNext("ok");
    await tick();

    expect(h.saved).toEqual([]);
  });

  test("no retry is scheduled after dispose", async () => {
    // A retry would send the OLD user's layout through the NEW user's mutation.
    const h = harness();
    h.queue.enqueueSave({ id: "a" });
    await tick();
    h.queue.enqueueSave({ id: "b" });
    h.queue.dispose();
    h.settleNext("throw");
    await tick();

    expect(h.retries).toHaveLength(0);
  });

  test("a reset awaiting a disposed queue is answered, not left hanging", async () => {
    const h = harness();
    h.queue.enqueueSave({ id: "a" });
    await tick();
    const pending = h.queue.requestReset();
    h.queue.dispose();

    expect(await pending).toBe(false);
    // And one requested after disposal settles immediately too.
    expect(await h.queue.requestReset()).toBe(false);
  });
});
