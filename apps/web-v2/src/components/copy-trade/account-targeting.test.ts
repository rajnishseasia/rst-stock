import { describe, expect, it } from "bun:test";
import {
  armingDestination,
  autoMirrorSwitchState,
  accountOptionLabel,
  accountForDestination,
  buildAutoMirrorPatch,
  selectedAccountProvider,
  toAccountOptions,
  type AlpacaAccountOption,
  type ArmingFollowRow,
} from "./account-targeting";

const paper: AlpacaAccountOption = {
  id: "paper-credential",
  provider: "alpaca",
  accountId: "PA-1234",
  accountType: "PAPER",
};
const live: AlpacaAccountOption = {
  id: "live-credential",
  provider: "alpaca",
  accountId: "LIVE-9876",
  accountType: "LIVE",
};
const perps: AlpacaAccountOption = {
  id: "hyperliquid-credential",
  provider: "hyperliquid",
  accountId: "0x1234",
  accountType: "LIVE",
};

describe("auto-mirror account targeting", () => {
  it("labels saved Paper and Live accounts without credential keys", () => {
    expect(accountOptionLabel(paper)).toBe("Paper account PA-1234");
    expect(accountOptionLabel(live)).toBe("Live account LIVE-9876");
    expect(accountOptionLabel(perps)).toBe("Hyperliquid perps");
  });

  it("preserves the server's exact Hyperliquid network label in selectable accounts", () => {
    const options = toAccountOptions([
      {
        id: "hyperliquid-mainnet",
        provider: "hyperliquid",
        accountId: null,
        accountType: "LIVE",
        credentialAccountLabel: "Hyperliquid mainnet perps",
      },
      {
        id: "hyperliquid-testnet",
        provider: "hyperliquid",
        accountId: null,
        accountType: "LIVE",
        credentialAccountLabel: "Hyperliquid testnet perps",
      },
    ]);

    expect(options.map(accountOptionLabel)).toEqual([
      "Hyperliquid mainnet perps",
      "Hyperliquid testnet perps",
    ]);
  });

  it("excludes only Alpaca accounts needing key re-entry from mirror selection and arming", () => {
    const options = toAccountOptions([
      {
        id: "alpaca-needs-reentry",
        provider: "alpaca",
        accountId: "PAPER-401",
        accountType: "PAPER",
        needsReentry: true,
      },
      {
        id: "healthy-alpaca",
        provider: "alpaca",
        accountId: "LIVE-402",
        accountType: "LIVE",
        needsReentry: false,
      },
      {
        id: "hyperliquid",
        provider: "hyperliquid",
        accountId: null,
        accountType: "LIVE",
        needsReentry: true,
      },
    ]);

    expect(options.map(({ id }) => id)).toEqual(["healthy-alpaca", "hyperliquid"]);
    expect(accountForDestination("stock", "alpaca-needs-reentry", options)).toBeNull();
    expect(accountForDestination("stock", "healthy-alpaca", options)?.id).toBe(
      "healthy-alpaca",
    );
    expect(accountForDestination("perp", "hyperliquid", options)?.id).toBe(
      "hyperliquid",
    );

    const blockedFromArming = autoMirrorSwitchState({
      supported: true,
      pending: false,
      autoMirror: false,
      credentialId: "alpaca-needs-reentry",
      credentialAvailable:
        accountForDestination("stock", "alpaca-needs-reentry", options) !== null,
    });
    expect(blockedFromArming).toEqual({
      interactive: false,
      reason:
        "That mirror account is unavailable. Choose a user-owned account for this destination before arming.",
    });

    const canOnlyStopExistingFollow = autoMirrorSwitchState({
      supported: true,
      pending: false,
      autoMirror: true,
      credentialId: "alpaca-needs-reentry",
      credentialAvailable:
        accountForDestination("stock", "alpaca-needs-reentry", options) !== null,
    });
    expect(canOnlyStopExistingFollow.interactive).toBe(true);
    expect(canOnlyStopExistingFollow.reason).toContain("mirror account is unavailable");
  });

  it("does not enable auto-mirror without a selected account", () => {
    expect(buildAutoMirrorPatch(true, null)).toBeNull();
    expect(autoMirrorSwitchState({
      supported: true,
      pending: false,
      autoMirror: false,
      credentialId: null,
    }).interactive).toBe(false);
  });

  it("blocks an unarmed Hyperliquid follow until a valid global cap has loaded", () => {
    for (const globalPerpMaxLeverage of [null, undefined, 0, 1.5, 101, Number.NaN]) {
      const state = autoMirrorSwitchState({
        supported: true,
        pending: false,
        autoMirror: false,
        credentialId: perps.id,
        destinationProvider: "hyperliquid",
        globalPerpMaxLeverage,
      });

      expect(state.interactive).toBe(false);
      expect(state.reason).toContain("global copy-trading leverage cap");
    }
  });

  it("keeps an armed Hyperliquid follow switchable off while its cap is unavailable", () => {
    const state = autoMirrorSwitchState({
      supported: true,
      pending: false,
      autoMirror: true,
      credentialId: perps.id,
      destinationProvider: "hyperliquid",
      globalPerpMaxLeverage: null,
    });

    expect(state.interactive).toBe(true);
    expect(state.reason).toBeNull();
  });

  it("does not make the global perp cap a prerequisite for Alpaca arming", () => {
    const state = autoMirrorSwitchState({
      supported: true,
      pending: false,
      autoMirror: false,
      credentialId: live.id,
      destinationProvider: "alpaca",
      globalPerpMaxLeverage: null,
    });

    expect(state).toEqual({ interactive: true, reason: null });
  });

  it("binds enablement to the exact selected credential", () => {
    expect(buildAutoMirrorPatch(true, live.id)).toEqual({
      autoMirror: true,
      credentialId: live.id,
    });
  });

  it("resolves the destination venue from the live account list", () => {
    // Drives the perp disclosure: it must appear as soon as a Hyperliquid
    // account is picked, before the follow row round-trips through the API.
    const accounts = [paper, live, perps];
    expect(
      selectedAccountProvider({ credentialId: perps.id, accounts, fallback: "alpaca" }),
    ).toBe("hyperliquid");
    expect(
      selectedAccountProvider({ credentialId: live.id, accounts, fallback: "hyperliquid" }),
    ).toBe("alpaca");
  });

  it("falls back to the server-recorded venue while accounts are still loading", () => {
    expect(
      selectedAccountProvider({
        credentialId: perps.id,
        accounts: [],
        fallback: "hyperliquid",
      }),
    ).toBe("hyperliquid");
  });

  it("reports an unknown destination as null rather than guessing a venue", () => {
    expect(
      selectedAccountProvider({ credentialId: null, accounts: [perps], fallback: "hyperliquid" }),
    ).toBeNull();
    expect(
      selectedAccountProvider({ credentialId: "gone", accounts: [], fallback: null }),
    ).toBeNull();
  });

  it("allows an invalid legacy row to be switched off without a credential", () => {
    expect(buildAutoMirrorPatch(false, null)).toEqual({ autoMirror: false });
    expect(autoMirrorSwitchState({
      supported: true,
      pending: false,
      autoMirror: true,
      credentialId: null,
    }).interactive).toBe(true);
  });

  it("warns instead of falsely claiming automation is live when an armed follow's credential is gone", () => {
    // Deleting a saved credential sets the follow's credentialId to null via
    // the FK's onDelete: "set null" while autoMirror stays true (the API's own
    // invariant forbids creating this state, but it can still be reached this
    // way). The switch must stay switchable off (never trap the user) but it
    // must stop asserting the neutral "on your confirmation" caption, because
    // the worker is silently refusing every delivery for this follow.
    const state = autoMirrorSwitchState({
      supported: true,
      pending: false,
      autoMirror: true,
      credentialId: null,
    });
    expect(state.interactive).toBe(true);
    expect(state.reason).not.toBeNull();
  });

  it("keeps the neutral caption for a normally armed follow with a live credential", () => {
    const state = autoMirrorSwitchState({
      supported: true,
      pending: false,
      autoMirror: true,
      credentialId: live.id,
    });
    expect(state.interactive).toBe(true);
    expect(state.reason).toBeNull();
  });
});

/**
 * Where the feed panel's inline Mirror switch is allowed to arm a follow.
 *
 * The panel has ONE dialog, the plain "arm" variant. It cannot say "Moving
 * from", it cannot name the venue being left, and it does not carry
 * REPOINT_STOP_CAVEAT, so a destination change made through it would be a
 * re-point with none of the disclosure a re-point requires (see
 * `buildArmingSummary`'s "repoint" variant, raised by Manage follows). The
 * product states the same rule outright in copy-trade-info-dialog.tsx:
 * "Changing the terminal's Paper/Live mode does not retarget an existing
 * Mirror." So the panel arms a follow where the follow already points, and
 * borrows the terminal's account only when there is nothing to move off.
 */
describe("inline mirror switch arming destination", () => {
  const accounts: AlpacaAccountOption[] = [paper, live, perps];

  /** A follow the user pointed at Paper in Manage follows, not yet armed. */
  const savedToPaper: ArmingFollowRow = {
    autoMirror: false,
    credentialId: paper.id,
    credentialAccountLabel: "Paper account PA-1234",
    credentialAccountType: "PAPER",
  };

  it("arms a Paper-pointed follow at Paper while the terminal is on Live", () => {
    // The reported failure: the user leaves @whale on Paper until they trust
    // it, the terminal header is later switched to LIVE, and one tap on the
    // feed row's switch used to send the follow, and every mirror after it, to
    // the live account with real money.
    const destination = armingDestination({
      follow: savedToPaper,
      accounts,
      activeCredentialId: live.id,
      activeAccountLabel: "920123456",
      activeAccountType: "LIVE",
    });

    expect(destination.credentialId).toBe(paper.id);
    expect(destination.accountType).toBe("PAPER");
    expect(destination.accountLabel).toBe("Paper account PA-1234");
  });

  it("keeps a saved Hyperliquid destination instead of the terminal's Alpaca account", () => {
    // The panel's active credential comes from a `{provider: "alpaca"}` query,
    // so re-pointing here also swapped the venue: the perp disclosure was
    // dropped from a follow the user believed was aimed at perps.
    const destination = armingDestination({
      follow: {
        autoMirror: false,
        credentialId: perps.id,
        credentialAccountLabel: null,
        credentialAccountType: null,
      },
      accounts,
      activeCredentialId: live.id,
      activeAccountLabel: "920123456",
      activeAccountType: "LIVE",
    });

    expect(destination.credentialId).toBe(perps.id);
    expect(selectedAccountProvider({
      credentialId: destination.credentialId,
      accounts,
      fallback: null,
    })).toBe("hyperliquid");
  });

  it("names the borrowed terminal account with its Paper or Live wording", () => {
    // Only reachable for a follow that has never been pointed anywhere. The
    // panel's own label is a bare account number (`accountId || username ||
    // "Connected"`), which reads identically for a paper and a live account,
    // so the accounts list is what names it.
    const destination = armingDestination({
      follow: {
        autoMirror: false,
        credentialId: null,
        credentialAccountLabel: null,
        credentialAccountType: null,
      },
      accounts,
      activeCredentialId: live.id,
      activeAccountLabel: "920123456",
      activeAccountType: "LIVE",
    });

    expect(destination.credentialId).toBe(live.id);
    expect(destination.accountLabel).toBe("Live account LIVE-9876");
    expect(destination.accountType).toBe("LIVE");
  });

  it("describes an armed follow from its own row, not the terminal", () => {
    const destination = armingDestination({
      follow: { ...savedToPaper, autoMirror: true },
      accounts,
      activeCredentialId: live.id,
      activeAccountLabel: "920123456",
      activeAccountType: "LIVE",
    });

    expect(destination.credentialId).toBe(paper.id);
    expect(destination.accountLabel).toBe("Paper account PA-1234");
  });

  it("reports no destination when neither the follow nor the terminal has one", () => {
    // `buildAutoMirrorPatch` refuses a null credential and
    // `autoMirrorSwitchState` blocks the switch, so the switch stays unusable
    // rather than arming somewhere unnamed.
    const destination = armingDestination({
      follow: {
        autoMirror: false,
        credentialId: null,
        credentialAccountLabel: null,
        credentialAccountType: null,
      },
      accounts,
      activeCredentialId: null,
      activeAccountLabel: null,
      activeAccountType: null,
    });

    expect(destination.credentialId).toBeNull();
    expect(buildAutoMirrorPatch(true, destination.credentialId)).toBeNull();
  });
});
