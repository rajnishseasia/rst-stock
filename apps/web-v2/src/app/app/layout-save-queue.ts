/**
 * Serialized write queue for the saved terminal layout.
 *
 * Extracted from the app page because it kept producing the same CLASS of bug:
 * every failure mode here is invisible from the outside. The queue swallows
 * request errors so its retry loop survives an outage, and it empties its slot
 * before awaiting, so a caller cannot learn an outcome by inspecting it
 * afterwards. Inline in a component that is impossible to drive from a test,
 * that meant each fix was verified by reading it. Here it can be driven.
 *
 * Two invariants the callers depend on:
 *
 * 1. ONE write in flight at a time. Sequence-checking is not enough: ignoring a
 *    late response only fixes the local cache, it cannot undo a write the server
 *    already applied, so two overlapping saves could still land out of order and
 *    leave the OLDER layout on the account for the next browser to restore.
 * 2. A reset REPORTS ITS OUTCOME. Clearing the account copy is the whole point
 *    of reset, and a reset that silently failed leaves the old workspace to come
 *    back on the next load, so the confirmation must not be guessed.
 */

/**
 * Consecutive retry rounds before the queue gives up on the current payload.
 *
 * Bounded so a persistently failing endpoint cannot have the page retrying for
 * the whole session. Giving up is safe: localStorage still holds the layout, and
 * the user's next change enqueues fresh.
 */
export const MAX_RETRY_ATTEMPTS = 3;

export type LayoutWrite<TLayout> =
  | { kind: "save"; payload: TLayout }
  | { kind: "reset"; settle: (cleared: boolean) => void };

export interface LayoutSaveQueueDeps<TLayout> {
  /** Persist a layout. Rejects on failure. */
  save: (payload: TLayout) => Promise<void>;
  /** Clear the account copy. Rejects on failure. */
  reset: () => Promise<void>;
  /** A save completed. Only now may the layout be recorded as saved. */
  onSaved: (payload: TLayout) => void;
  /** The account copy was cleared. */
  onCleared: () => void;
  /**
   * A write failed. The caller uses this to forget what it believed was saved,
   * so a later retry of the same payload is not suppressed as a no-op.
   */
  onFailed: () => void;
  /**
   * Re-arm the queue after a failure, but only when something is still pending.
   * Delayed by the caller: a persistent outage would otherwise spin this as fast
   * as the network can reject.
   */
  scheduleRetry: (run: () => void) => void;
}

export interface LayoutSaveQueue<TLayout> {
  /** Queue a layout write. Replaces any write not yet started. */
  enqueueSave: (payload: TLayout) => void;
  /**
   * Queue a reset and resolve with whether the account copy was actually
   * cleared. Resolves false if the request failed, or if a later write displaced
   * this reset before it ran.
   */
  requestReset: () => Promise<boolean>;
  /** Drain the queue. Returns once nothing more can be attempted right now. */
  flush: () => Promise<void>;
  /**
   * Permanently stop this queue.
   *
   * For an identity change without a page reload: the previous user's queue is
   * still referenced by an in-flight request and any scheduled retry, and its
   * callbacks reach shared dependencies that now belong to the NEW user. A
   * retry would send the old user's layout through the new user's mutation, and
   * a late completion would report the old user's payload as the new user's
   * saved state. After this, nothing is started, no retry fires, and no result
   * is reported.
   *
   * A request ALREADY on the wire cannot be recalled from here; it was issued
   * under the previous session and its effects are simply ignored.
   */
  dispose: () => void;
}

export function createLayoutSaveQueue<TLayout>(
  deps: LayoutSaveQueueDeps<TLayout>,
): LayoutSaveQueue<TLayout> {
  let pending: LayoutWrite<TLayout> | null = null;
  let inFlight = false;
  let disposed = false;
  // Consecutive failed rounds for whatever is currently queued. Reset on any
  // success or on a fresh enqueue, so it bounds an OUTAGE, not a user's session.
  let attempts = 0;

  // Whatever a new write displaces must still be answered. A displaced reset
  // that is never settled leaves its caller awaiting forever, showing neither
  // the success nor the failure toast.
  function enqueue(next: LayoutWrite<TLayout>): void {
    if (disposed) {
      // Answer a reset rather than leaving its caller awaiting forever.
      if (next.kind === "reset") next.settle(false);
      return;
    }
    const displaced = pending;
    pending = next;
    // A deliberate new write earns a fresh budget: the user is still here, and
    // whatever failed before is superseded.
    attempts = 0;
    if (displaced && displaced.kind === "reset" && displaced !== next) {
      if (next.kind === "reset") {
        // A reset displaced by ANOTHER reset shares its outcome. They are the
        // same intent, and the second one clears the same account copy, so
        // reporting the first as a failure told the user their layout "may come
        // back on your next visit" about a reset that in fact stuck.
        const first = displaced;
        const second = next.settle;
        next.settle = (cleared) => {
          second(cleared);
          first.settle(cleared);
        };
        return;
      }
      // Displaced by a SAVE, which is a different intent: this reset never ran
      // and never will, so its caller has to hear that.
      displaced.settle(false);
    }
  }

  async function flush(): Promise<void> {
    // Already draining. The running loop re-reads `pending` each iteration, so
    // anything queued now is picked up by it. There is no gap to lose a write
    // in: the loop's last await happens before its condition check, and the
    // condition check and the `inFlight = false` that follows it run in one
    // synchronous stretch that nothing can interleave with.
    if (inFlight || disposed) return;
    inFlight = true;
    try {
      while (pending && !disposed) {
        const next = pending;
        pending = null;
        try {
          if (next.kind === "reset") {
            await deps.reset();
            if (disposed) {
              next.settle(false);
              return;
            }
            deps.onCleared();
            attempts = 0;
            next.settle(true);
            continue;
          }
          await deps.save(next.payload);
          // Disposed WHILE this was in flight: the dependencies now belong to
          // someone else, so reporting this result would write one user's
          // payload into another user's mirror and cache.
          if (disposed) return;
          deps.onSaved(next.payload);
          attempts = 0;
        } catch {
          if (disposed) return;
          // A failed reset is REPORTED, not retried. The handler has already
          // told the user the old layout may come back; silently clearing the
          // account later would wipe a workspace they have since rebuilt.
          if (next.kind === "reset") next.settle(false);
          deps.onFailed();

          // Put the FAILED SAVE back. Retrying only a newer pending payload was
          // the common case backwards: a single save that fails with nothing
          // behind it left the account stale until the user happened to make
          // another layout change, and since localStorage had already recorded
          // the change, the next mount handed precedence to the older account
          // copy and the user's change appeared to revert. Nothing else would
          // ever call the queue: the debounce timer has fired, and `onFailed`
          // touches a ref, which schedules no render and no effect.
          //
          // A newer payload always wins, since it supersedes this one anyway.
          if (next.kind === "save" && !pending) pending = next;

          if (pending) {
            attempts += 1;
            if (attempts >= MAX_RETRY_ATTEMPTS) {
              // Stop rather than retry a broken endpoint for the whole session.
              // The layout is safe in localStorage, and the next deliberate
              // change enqueues fresh and resets the count.
              pending = null;
              attempts = 0;
            } else {
              deps.scheduleRetry(() => void flush());
            }
          }
          break;
        }
      }
    } finally {
      inFlight = false;
    }
  }

  return {
    enqueueSave(payload) {
      enqueue({ kind: "save", payload });
      void flush();
    },
    requestReset() {
      return new Promise<boolean>((resolve) => {
        enqueue({ kind: "reset", settle: resolve });
        void flush();
      });
    },
    flush,
    dispose() {
      disposed = true;
      const abandoned = pending;
      pending = null;
      // Never leave a caller awaiting a promise that can no longer settle.
      if (abandoned?.kind === "reset") abandoned.settle(false);
    },
  };
}
