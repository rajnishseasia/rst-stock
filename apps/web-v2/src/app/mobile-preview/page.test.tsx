import { describe, expect, test } from "bun:test";
import { isValidElement } from "react";

const { default: DashboardGuard } = await import("../app/page");
const {
  resolveDashboardVisibility,
  shouldRenderDashboard,
  syncDashboardRedirect,
} = await import("../app/dashboard-guard");

const { default: MobilePreviewPage, metadata } = await import("./page");

describe("authenticated functional mobile preview route", () => {
  test("delegates to the real /app guard as an alias without adding providers", () => {
    const routeElement = MobilePreviewPage();

    expect(isValidElement(routeElement)).toBe(true);
    if (!isValidElement(routeElement)) return;

    expect(routeElement.type).toBe(DashboardGuard);
    expect(routeElement.props).toEqual({});

    // The alias passes no fixture payload to the shared guard/component.
    const routeProps = JSON.stringify(routeElement.props);
    expect(routeProps).not.toContain("Demo data only");
    expect(routeProps).not.toContain("Future mobile concept");
    expect(routeProps).not.toContain("Preview only");
  });

  test("uses the shared guard contract for anonymous, pending, and SSR auth states", () => {
    expect(resolveDashboardVisibility(true, false)).toBe("loading");
    expect(resolveDashboardVisibility(false, false)).toBe("redirect");
    expect(resolveDashboardVisibility(false, true)).toBe("ready");

    // The signed-in server snapshot stays blank until the client mount effect.
    expect(shouldRenderDashboard(false, true, false)).toBe(false);
    expect(shouldRenderDashboard(false, true, true)).toBe(true);
    expect(shouldRenderDashboard(true, true, true)).toBe(false);
    expect(shouldRenderDashboard(false, false, true)).toBe(false);

    const replaceCalls: string[] = [];
    const router = { replace: (path: string) => replaceCalls.push(path) };
    expect(syncDashboardRedirect(router, true, false)).toBe("loading");
    expect(syncDashboardRedirect(router, false, true)).toBe("ready");
    expect(syncDashboardRedirect(router, false, false)).toBe("redirect");
    expect(replaceCalls).toEqual(["/"]);
  });

  test("describes the route as a functional mobile workspace", () => {
    expect(metadata.title).toBe("Mobile Trading Workspace | Ready Set Trade");
    expect(metadata.description).toBe(
      "A functional mobile trading workspace powered by the Ready Set Trade terminal.",
    );
  });
});
