import { describe, expect, test } from "bun:test";
import { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { click, flattenElements } from "@/testing/element-tree";

const {
  DashboardAuthUnavailable,
  resolveDashboardVisibility,
  shouldRenderDashboard,
  syncDashboardRedirect,
} = await import("./dashboard-guard");

describe("dashboard hydration gate", () => {
  test("keeps an authenticated dashboard blank until the client has mounted", () => {
    expect(shouldRenderDashboard(false, true, false)).toBe(false);
    expect(shouldRenderDashboard(false, true, true)).toBe(true);
  });

  test("stays blank while auth is pending or settled without a user", () => {
    expect(shouldRenderDashboard(true, true, true)).toBe(false);
    expect(shouldRenderDashboard(false, false, true)).toBe(false);
  });

  test("does not redirect or render the dashboard when the session read errors", () => {
    expect(resolveDashboardVisibility(false, false, true)).toBe("error");

    const calls: string[] = [];
    const router = { replace: (path: string) => calls.push(path) };
    expect(syncDashboardRedirect(router, false, false, true)).toBe("error");
    expect(calls).toEqual([]);

    expect(shouldRenderDashboard(false, true, true, true)).toBe(false);
  });

  test("renders a small auth-unavailable state with a working retry control", () => {
    let retries = 0;
    const tree = DashboardAuthUnavailable({
      onRetry: () => {
        retries += 1;
      },
    });
    expect(isValidElement(tree)).toBe(true);
    if (!isValidElement(tree)) return;

    const markup = renderToStaticMarkup(tree);
    expect(markup).toContain("Authentication temporarily unavailable");
    expect(markup).toContain("Try again");

    const retry = flattenElements(tree).find(
      (element) => element.props["aria-label"] === "Retry session check",
    );
    click(retry);
    expect(retries).toBe(1);
  });
});
