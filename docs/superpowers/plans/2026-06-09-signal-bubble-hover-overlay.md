# Signal Bubble Hover Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open chart signal details on hover, keep the overlay open while the pointer moves into it, and preserve click access for touch devices.

**Architecture:** Add a small close-delay controller to `signal-bubble-overlay.tsx` and use it from the bubble and overlay pointer handlers. Pointer hover behavior will run for mouse and pen input only; the existing click toggle remains the touch fallback.

**Tech Stack:** React 19, TypeScript, Lightweight Charts, Bun test runner

---

### Task 1: Add the hover dismissal controller

**Files:**
- Modify: `apps/web-v2/src/components/charts/__tests__/signal-bubble-overlay.test.ts`
- Modify: `apps/web-v2/src/components/charts/signal-bubble-overlay.tsx`

- [ ] **Step 1: Write the failing controller tests**

Extend the existing overlay test with:

```typescript
import {
  createSignalTooltipCloseController,
  isHoverPointer,
  nextSignalTooltipOpenMode,
  projectSignalPosition,
} from "../signal-bubble-overlay";

test("keeps the tooltip open when a pending close is cancelled", async () => {
  let closeCount = 0;
  const controller = createSignalTooltipCloseController(
    () => closeCount++,
    5
  );

  controller.scheduleClose();
  controller.cancelClose();
  await Bun.sleep(10);

  expect(closeCount).toBe(0);
  controller.dispose();
});

test("closes the tooltip after the pointer leaves", async () => {
  let closeCount = 0;
  const controller = createSignalTooltipCloseController(
    () => closeCount++,
    5
  );

  controller.scheduleClose();
  await Bun.sleep(10);

  expect(closeCount).toBe(1);
  controller.dispose();
});

test("uses hover behavior for mouse and pen but not touch", () => {
  expect(isHoverPointer("mouse")).toBe(true);
  expect(isHoverPointer("pen")).toBe(true);
  expect(isHoverPointer("touch")).toBe(false);
});

test("pins a hover-opened tooltip on click before toggling it closed", () => {
  expect(nextSignalTooltipOpenMode("hover", "click", true)).toBe("click");
  expect(nextSignalTooltipOpenMode("click", "click", true)).toBeNull();
  expect(nextSignalTooltipOpenMode("click", "click", false)).toBe("click");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
bun test apps/web-v2/src/components/charts/__tests__/signal-bubble-overlay.test.ts
```

Expected: FAIL because `createSignalTooltipCloseController` and `isHoverPointer` are not exported.

- [ ] **Step 3: Implement the minimal controller**

Add an exported pointer predicate and close controller:

```typescript
const TOOLTIP_CLOSE_DELAY_MS = 120;
type SignalTooltipOpenMode = "hover" | "click" | null;

export function isHoverPointer(pointerType: string): boolean {
  return pointerType === "mouse" || pointerType === "pen";
}

export function nextSignalTooltipOpenMode(
  currentMode: SignalTooltipOpenMode,
  interaction: Exclude<SignalTooltipOpenMode, null>,
  isSameSignal: boolean
): SignalTooltipOpenMode {
  if (interaction === "hover") {
    return currentMode === "click" ? "click" : "hover";
  }

  return currentMode === "click" && isSameSignal ? null : "click";
}

export function createSignalTooltipCloseController(
  onClose: () => void,
  delayMs = TOOLTIP_CLOSE_DELAY_MS
) {
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const cancelClose = () => {
    if (closeTimer === null) return;
    clearTimeout(closeTimer);
    closeTimer = null;
  };

  const scheduleClose = () => {
    cancelClose();
    closeTimer = setTimeout(() => {
      closeTimer = null;
      onClose();
    }, delayMs);
  };

  return {
    cancelClose,
    scheduleClose,
    closeNow: () => {
      cancelClose();
      onClose();
    },
    dispose: cancelClose,
  };
}
```

- [ ] **Step 4: Run the focused tests**

Run:

```bash
bun test apps/web-v2/src/components/charts/__tests__/signal-bubble-overlay.test.ts
```

Expected: all signal overlay tests pass.

### Task 2: Wire hover behavior into the overlay

**Files:**
- Modify: `apps/web-v2/src/components/charts/signal-bubble-overlay.tsx`

- [ ] **Step 1: Create one controller for the component lifecycle**

Use refs for the interaction mode and close controller so the controller always closes current state, and dispose it on unmount:

```typescript
const openModeRef = useRef<SignalTooltipOpenMode>(null);
const closeControllerRef = useRef<ReturnType<
  typeof createSignalTooltipCloseController
> | null>(null);

if (!closeControllerRef.current) {
  closeControllerRef.current = createSignalTooltipCloseController(() => {
    openModeRef.current = null;
    setTooltip(null);
  });
}

useEffect(() => {
  const closeController = closeControllerRef.current;
  return () => closeController?.dispose();
}, []);
```

- [ ] **Step 2: Add pointer and click callbacks**

Open immediately for mouse/pen, delay closure across the bubble-to-overlay gap, and retain click toggle:

```typescript
const handlePointerEnter = useCallback(
  (event: React.PointerEvent, item: ProjectedSignal) => {
    if (!isHoverPointer(event.pointerType)) return;
    closeControllerRef.current?.cancelClose();
    const nextMode = nextSignalTooltipOpenMode(
      openModeRef.current,
      "hover",
      false
    );
    if (nextMode === "click") return;
    openModeRef.current = nextMode;
    setTooltip({ ...item });
  },
  []
);

const handlePointerLeave = useCallback((event: React.PointerEvent) => {
  if (
    !isHoverPointer(event.pointerType) ||
    openModeRef.current === "click"
  ) {
    return;
  }
  closeControllerRef.current?.scheduleClose();
}, []);

const handleClick = useCallback((item: ProjectedSignal) => {
  closeControllerRef.current?.cancelClose();
  setTooltip((prev) => {
    const isSameSignal = prev?.signals[0]?.id === item.signals[0]?.id;
    const nextMode = nextSignalTooltipOpenMode(
      openModeRef.current,
      "click",
      isSameSignal
    );
    openModeRef.current = nextMode;
    return nextMode === null ? null : { ...item };
  });
}, []);
```

- [ ] **Step 3: Wire the bubble and overlay events**

Add these handlers to each signal bubble:

```tsx
onPointerEnter={(event) => handlePointerEnter(event, item)}
onPointerLeave={handlePointerLeave}
onClick={() => handleClick(item)}
```

Add these handlers to the tooltip:

```tsx
onPointerEnter={(event) => {
  if (isHoverPointer(event.pointerType)) {
    closeControllerRef.current?.cancelClose();
  }
}}
onPointerLeave={handlePointerLeave}
```

Use `closeControllerRef.current?.closeNow()` for the close button and backdrop.

- [ ] **Step 4: Run complete verification**

Run:

```bash
bun test apps/web-v2/src/components/charts/__tests__/signal-bubble-overlay.test.ts
bun --filter @trade-bot/web typecheck
git diff --check
```

Expected: tests pass, TypeScript exits successfully, and the diff has no whitespace errors.
