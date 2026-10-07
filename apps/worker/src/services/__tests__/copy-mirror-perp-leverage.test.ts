import { describe, expect, it } from "bun:test";
import {
  COPY_PERP_MAX_LEVERAGE_MAX,
  COPY_PERP_MAX_LEVERAGE_MIN,
} from "@trade-bot/types";

import { resolveEffectivePerpLeverage } from "../copy-mirror-perp-leverage";

const BASE = {
  sourceLeverage: 10,
  stagedUserMaxLeverage: 8,
  stagedFollowMaxLeverage: 6,
  currentUserMaxLeverage: 7,
  currentFollowMaxLeverage: 5,
  venueMaxLeverage: 4,
} as const;

describe("resolveEffectivePerpLeverage", () => {
  it.each([
    { name: "source is the lowest ceiling", input: { sourceLeverage: 3 }, expected: 3 },
    { name: "staged user is the lowest ceiling", input: { stagedUserMaxLeverage: 2 }, expected: 2 },
    { name: "staged follow is the lowest ceiling", input: { stagedFollowMaxLeverage: 1 }, expected: 1 },
    { name: "current user is the lowest ceiling", input: { currentUserMaxLeverage: 2 }, expected: 2 },
    { name: "current follow is the lowest ceiling", input: { currentFollowMaxLeverage: 1 }, expected: 1 },
    { name: "venue is the lowest ceiling", input: { venueMaxLeverage: 2 }, expected: 2 },
  ])("uses the valid minimum when $name", ({ input, expected }) => {
    expect(resolveEffectivePerpLeverage({ ...BASE, ...input })).toBe(expected);
  });

  it.each([
    { field: "sourceLeverage", value: 3.9 },
    { field: "stagedUserMaxLeverage", value: 3.9 },
    { field: "currentUserMaxLeverage", value: 3.9 },
    { field: "venueMaxLeverage", value: 3.9 },
  ] as const)("floors a fractional required $field", ({ field, value }) => {
    expect(resolveEffectivePerpLeverage({ ...BASE, [field]: value })).toBe(3);
  });

  it.each([
    { name: "zero", value: 0 },
    { name: "negative", value: -3 },
    { name: "NaN", value: Number.NaN },
    { name: "missing", value: undefined },
  ])("fails down an invalid source leverage ($name)", ({ value }) => {
    expect(resolveEffectivePerpLeverage({ ...BASE, sourceLeverage: value })).toBe(1);
  });

  it.each([
    { name: "zero", value: 0 },
    { name: "negative", value: -3 },
    { name: "NaN", value: Number.NaN },
    { name: "missing", value: undefined },
  ])("fails down a missing or invalid staged user cap ($name)", ({ value }) => {
    expect(resolveEffectivePerpLeverage({ ...BASE, stagedUserMaxLeverage: value })).toBe(1);
  });

  it.each([
    { name: "null", value: null },
    { name: "undefined", value: undefined },
  ])("inherits the staged global cap when the staged follow cap is $name", ({ value }) => {
    expect(resolveEffectivePerpLeverage({ ...BASE, stagedFollowMaxLeverage: value })).toBe(4);
  });

  it.each([
    { name: "zero", value: 0 },
    { name: "negative", value: -3 },
    { name: "NaN", value: Number.NaN },
    { name: "fraction below one", value: 0.5 },
  ])("fails down an invalid non-null staged follow cap ($name)", ({ value }) => {
    expect(resolveEffectivePerpLeverage({ ...BASE, stagedFollowMaxLeverage: value })).toBe(1);
  });

  it.each([
    { name: "null", value: null },
    { name: "undefined", value: undefined },
  ])("inherits the current global cap when the current follow cap is $name", ({ value }) => {
    expect(resolveEffectivePerpLeverage({ ...BASE, currentFollowMaxLeverage: value })).toBe(4);
  });

  it.each([
    { field: "stagedFollowMaxLeverage", value: 0 },
    { field: "currentFollowMaxLeverage", value: -1 },
  ] as const)("treats an invalid current/staged follow value as a 1x ceiling ($field)", ({ field, value }) => {
    expect(resolveEffectivePerpLeverage({ ...BASE, [field]: value })).toBe(1);
  });

  it.each([
    { field: "stagedUserMaxLeverage", value: COPY_PERP_MAX_LEVERAGE_MAX + 1 },
    { field: "currentUserMaxLeverage", value: COPY_PERP_MAX_LEVERAGE_MAX + 1 },
    { field: "stagedFollowMaxLeverage", value: COPY_PERP_MAX_LEVERAGE_MAX + 1 },
    { field: "currentFollowMaxLeverage", value: COPY_PERP_MAX_LEVERAGE_MAX + 1 },
  ] as const)("fails down an over-max policy cap on $field", ({ field, value }) => {
    expect(resolveEffectivePerpLeverage({ ...BASE, [field]: value })).toBe(
      COPY_PERP_MAX_LEVERAGE_MIN,
    );
  });

  it("keeps source, venue, and stored-order values independent from the policy bound", () => {
    expect(resolveEffectivePerpLeverage({
      ...BASE,
      sourceLeverage: COPY_PERP_MAX_LEVERAGE_MAX + 25,
      stagedUserMaxLeverage: COPY_PERP_MAX_LEVERAGE_MIN,
      currentUserMaxLeverage: COPY_PERP_MAX_LEVERAGE_MIN,
      stagedFollowMaxLeverage: null,
      currentFollowMaxLeverage: null,
      venueMaxLeverage: COPY_PERP_MAX_LEVERAGE_MAX + 50,
      storedOrderLeverage: COPY_PERP_MAX_LEVERAGE_MAX + 75,
    })).toBe(COPY_PERP_MAX_LEVERAGE_MIN);
  });

  it.each([
    { name: "a lower persisted order leverage", value: 2, expected: 2 },
    { name: "a fractional persisted order leverage", value: 3.9, expected: 3 },
    { name: "an invalid persisted order leverage", value: 0, expected: 1 },
  ])("applies $name as a non-escalating ceiling", ({ value, expected }) => {
    expect(resolveEffectivePerpLeverage({ ...BASE, storedOrderLeverage: value })).toBe(expected);
  });

  it("never raises a persisted order when current policy values increase", () => {
    expect(resolveEffectivePerpLeverage({
      ...BASE,
      sourceLeverage: 50,
      stagedUserMaxLeverage: 40,
      stagedFollowMaxLeverage: null,
      currentUserMaxLeverage: 35,
      currentFollowMaxLeverage: null,
      venueMaxLeverage: 30,
      storedOrderLeverage: 4,
    })).toBe(4);
  });
});
