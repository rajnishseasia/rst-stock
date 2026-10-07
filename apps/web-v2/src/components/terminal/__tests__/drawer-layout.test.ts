import { describe, it, expect } from "bun:test";
import {
  balanceDrawerWidths,
  migrateLegacyRightDrawerWidth,
  shouldCommitRightDrawerMigration,
  parseStoredDrawerWidths,
  clampNumber,
  LEFT_DRAWER_MIN_WIDTH,
  LEFT_DRAWER_MAX_WIDTH,
  RIGHT_DRAWER_MIN_WIDTH,
  RIGHT_DRAWER_MAX_WIDTH,
  RIGHT_DRAWER_DEFAULT_WIDTH,
  LEGACY_RIGHT_DRAWER_DEFAULT_WIDTH,
  COLLAPSED_DRAWER_WIDTH,
  CHART_COLUMN_MIN_WIDTH,
} from "../drawer-layout";

describe("RIGHT_DRAWER_DEFAULT_WIDTH", () => {
  it("opens the Modules drawer at the width the workspace spec asks for", () => {
    // docs/superpowers/specs/2026-06-20-terminal-workspace-layout-design.md:
    // "Right drawer default width: approximately 340px". The terminal used to
    // open it at RIGHT_DRAWER_MAX_WIDTH instead, and the 220px difference came
    // out of the chart column, which hides Oracle, Position, 24h Vol and
    // Position P&L on container queries as it narrows.
    expect(RIGHT_DRAWER_DEFAULT_WIDTH).toBe(340);
  });

  it("is a width the drawer can actually be dragged to", () => {
    expect(RIGHT_DRAWER_DEFAULT_WIDTH).toBeGreaterThanOrEqual(RIGHT_DRAWER_MIN_WIDTH);
    expect(RIGHT_DRAWER_DEFAULT_WIDTH).toBeLessThan(RIGHT_DRAWER_MAX_WIDTH);
  });
});

describe("migrateLegacyRightDrawerWidth", () => {
  it("drops the old default so existing workspaces are not stuck at 560", () => {
    // Every workspace saved before RIGHT_DRAWER_DEFAULT_WIDTH existed holds the
    // maximum, because that is what the drawer opened at. Restoring it would
    // mean only brand new browsers ever saw the new default.
    expect(
      migrateLegacyRightDrawerWidth(LEGACY_RIGHT_DRAWER_DEFAULT_WIDTH, {
        alreadyMigrated: false,
      }),
    ).toBeNull();
  });

  it("keeps the maximum once the browser has migrated", () => {
    // The old default IS the maximum, which is also the easiest width to pick
    // on purpose: drag the splitter to the end and it clamps exactly there.
    // Treating it as unset forever would mean a fully opened drawer never
    // survived a reload.
    expect(
      migrateLegacyRightDrawerWidth(LEGACY_RIGHT_DRAWER_DEFAULT_WIDTH, {
        alreadyMigrated: true,
      }),
    ).toBe(RIGHT_DRAWER_MAX_WIDTH);
  });

  it("passes any other stored width straight through", () => {
    expect(migrateLegacyRightDrawerWidth(420, { alreadyMigrated: false })).toBe(420);
    expect(
      migrateLegacyRightDrawerWidth(RIGHT_DRAWER_MIN_WIDTH, { alreadyMigrated: false }),
    ).toBe(RIGHT_DRAWER_MIN_WIDTH);
  });

  it("reports no stored preference for a missing width", () => {
    expect(migrateLegacyRightDrawerWidth(null, { alreadyMigrated: false })).toBeNull();
    expect(
      migrateLegacyRightDrawerWidth(undefined, { alreadyMigrated: true }),
    ).toBeNull();
  });
});

describe("shouldCommitRightDrawerMigration", () => {
  it("records the migration for a signed-out browser", () => {
    // localStorage is the only store there is, and it was read, so nothing can
    // turn up later holding the legacy width.
    expect(
      shouldCommitRightDrawerMigration({
        isSignedIn: false,
        accountReadSucceeded: true,
      }),
    ).toBe(true);
  });

  it("records the migration once the account read succeeded", () => {
    expect(
      shouldCommitRightDrawerMigration({
        isSignedIn: true,
        accountReadSucceeded: true,
      }),
    ).toBe(true);
  });

  it("does NOT record it when a signed-in hydration fell back to localStorage", () => {
    // The account read failed, so the width being migrated is a guess about an
    // account we never saw. Spending the one shot here is what would strand the
    // browser: see the sequence below.
    expect(
      shouldCommitRightDrawerMigration({
        isSignedIn: true,
        accountReadSucceeded: false,
      }),
    ).toBe(false);
  });

  it("leaves the account's legacy width still migratable after a read fails and recovers", () => {
    // The hook's own recovery path, played through the two pure rules it uses.
    // The marker is a single localStorage flag, so a boolean stands in for it.
    let migrated = false;

    // 1. Signed in, account read failed. Hydration paints from localStorage.
    const fallbackCommits = shouldCommitRightDrawerMigration({
      isSignedIn: true,
      accountReadSucceeded: false,
    });
    const painted = migrateLegacyRightDrawerWidth(LEGACY_RIGHT_DRAWER_DEFAULT_WIDTH, {
      alreadyMigrated: migrated,
    });
    if (fallbackCommits) migrated = true;
    // The paint is corrected either way: null means "no stored preference", so
    // the drawer keeps RIGHT_DRAWER_DEFAULT_WIDTH.
    expect(painted).toBeNull();
    expect(migrated).toBe(false);

    // 2. The read recovers on focus, and the account still holds 560.
    const recoveryCommits = shouldCommitRightDrawerMigration({
      isSignedIn: true,
      accountReadSucceeded: true,
    });
    const recovered = migrateLegacyRightDrawerWidth(LEGACY_RIGHT_DRAWER_DEFAULT_WIDTH, {
      alreadyMigrated: migrated,
    });
    if (recoveryCommits) migrated = true;
    // Dropped again rather than reinstated, and only NOW is the browser marked,
    // so the corrective write can carry the new default up to the account.
    expect(recovered).toBeNull();
    expect(migrated).toBe(true);

    // 3. From here a deliberate 560 is a width like any other.
    expect(
      migrateLegacyRightDrawerWidth(LEGACY_RIGHT_DRAWER_DEFAULT_WIDTH, {
        alreadyMigrated: migrated,
      }),
    ).toBe(RIGHT_DRAWER_MAX_WIDTH);
  });
});

describe("clampNumber", () => {
  it("clamps into the range and tolerates inverted bounds", () => {
    expect(clampNumber(5, 1, 10)).toBe(5);
    expect(clampNumber(-5, 1, 10)).toBe(1);
    expect(clampNumber(50, 1, 10)).toBe(10);
    // min > max: the max wins upward so the result is never below min.
    expect(clampNumber(5, 10, 1)).toBe(10);
  });
});

describe("parseStoredDrawerWidths", () => {
  it("parses and clamps stored widths", () => {
    expect(parseStoredDrawerWidths(JSON.stringify({ left: 400, right: 500 }))).toEqual({
      left: 400,
      right: 500,
    });
    expect(parseStoredDrawerWidths(JSON.stringify({ left: 10, right: 9999 }))).toEqual({
      left: LEFT_DRAWER_MIN_WIDTH,
      right: RIGHT_DRAWER_MAX_WIDTH,
    });
  });

  it("ignores garbage without throwing", () => {
    expect(parseStoredDrawerWidths(null)).toEqual({});
    expect(parseStoredDrawerWidths("not json")).toEqual({});
    expect(parseStoredDrawerWidths(JSON.stringify({ left: "wide" }))).toEqual({});
    expect(parseStoredDrawerWidths(JSON.stringify(null))).toEqual({});
  });
});

describe("balanceDrawerWidths", () => {
  const base = {
    leftCollapsed: false,
    rightCollapsed: false,
    leftWidth: LEFT_DRAWER_MAX_WIDTH,
    rightWidth: RIGHT_DRAWER_MAX_WIDTH,
  };

  it("keeps requested widths on a wide viewport", () => {
    const out = balanceDrawerWidths({ ...base, viewportWidth: 2560 });
    expect(out).toEqual({ left: LEFT_DRAWER_MAX_WIDTH, right: RIGHT_DRAWER_MAX_WIDTH });
  });

  it("never lets the chart column drop below its minimum on narrow viewports", () => {
    const viewportWidth = 1280;
    const out = balanceDrawerWidths({ ...base, viewportWidth });
    expect(out.left + out.right).toBeLessThanOrEqual(viewportWidth - CHART_COLUMN_MIN_WIDTH + 1);
    expect(out.left).toBeGreaterThanOrEqual(LEFT_DRAWER_MIN_WIDTH);
    expect(out.right).toBeGreaterThanOrEqual(RIGHT_DRAWER_MIN_WIDTH);
  });

  it("shrinks the flexible space proportionally", () => {
    const viewportWidth = 1400; // budget = 760 for 1080 requested
    const out = balanceDrawerWidths({ ...base, viewportWidth });
    const leftFlex = LEFT_DRAWER_MAX_WIDTH - LEFT_DRAWER_MIN_WIDTH; // 280
    const rightFlex = RIGHT_DRAWER_MAX_WIDTH - RIGHT_DRAWER_MIN_WIDTH; // 260
    // Left has more flex, so it should give up more width.
    expect(LEFT_DRAWER_MAX_WIDTH - out.left).toBeGreaterThan(RIGHT_DRAWER_MAX_WIDTH - out.right);
    expect(leftFlex).toBeGreaterThan(rightFlex);
  });

  it("pins a collapsed drawer to the collapsed width and gives space to the other", () => {
    const out = balanceDrawerWidths({
      ...base,
      leftCollapsed: true,
      viewportWidth: 1280,
    });
    expect(out.left).toBe(COLLAPSED_DRAWER_WIDTH);
    expect(out.right).toBeGreaterThanOrEqual(RIGHT_DRAWER_MIN_WIDTH);
    expect(out.right).toBeLessThanOrEqual(RIGHT_DRAWER_MAX_WIDTH);
  });

  it("hands the chart column the width the right drawer no longer takes", () => {
    const viewportWidth = 1920; // wide enough that nothing is shrunk to fit
    const atOldDefault = balanceDrawerWidths({ ...base, viewportWidth });
    const atNewDefault = balanceDrawerWidths({
      ...base,
      rightWidth: RIGHT_DRAWER_DEFAULT_WIDTH,
      viewportWidth,
    });

    expect(atOldDefault.right).toBe(RIGHT_DRAWER_MAX_WIDTH);
    expect(atNewDefault.right).toBe(RIGHT_DRAWER_DEFAULT_WIDTH);
    // The left drawer is untouched, so every pixel goes to the chart column,
    // which is where the instrument strip's container queries buy back Oracle,
    // Position, 24h Vol and Position P&L.
    expect(atNewDefault.left).toBe(atOldDefault.left);
    expect(atOldDefault.right - atNewDefault.right).toBe(220);
  });

  it("returns minimums untouched when there is no flex to give", () => {
    const out = balanceDrawerWidths({
      leftCollapsed: false,
      rightCollapsed: false,
      leftWidth: LEFT_DRAWER_MIN_WIDTH,
      rightWidth: RIGHT_DRAWER_MIN_WIDTH,
      viewportWidth: 800, // impossibly narrow
    });
    expect(out).toEqual({ left: LEFT_DRAWER_MIN_WIDTH, right: RIGHT_DRAWER_MIN_WIDTH });
  });
});
