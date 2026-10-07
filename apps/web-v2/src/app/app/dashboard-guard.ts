import { createElement } from "react";

/**
 * Pure decision for the top-level dashboard route guard (page.tsx's default
 * export). An anonymous or still-resolving visitor must never see the
 * authenticated terminal, and must be sent back to the public landing page
 * only after a successful session read confirms there is no user.
 *
 * Extracted (audit H7: pure logic first) so the redirect rule is checkable
 * directly, instead of only by reading page.tsx as a string. `syncDashboardRedirect`
 * takes the router as a plain argument (dependency injection) so a test can
 * assert the real side effect - that `router.replace("/")` is actually called,
 * and only in the redirect case - without needing a DOM or a rendered React
 * tree, neither of which this app's test environment has for effects.
 */

export type DashboardVisibility = "loading" | "error" | "redirect" | "ready";

/**
 * `isPending`: the session read has not settled yet.
 * `hasUser`: the settled session carries a signed-in user.
 * `hasError`: the session read failed before it could confirm an identity.
 */
export function resolveDashboardVisibility(
  isPending: boolean,
  hasUser: boolean,
  hasError = false,
): DashboardVisibility {
  if (hasError) {
    // A failed request is not evidence that the visitor is anonymous. Keep the
    // dashboard fail-closed while allowing the caller to offer a retry.
    return "error";
  }
  if (isPending || !hasUser) {
    // A still-pending read and a settled "no user" read are painted
    // identically (nothing), so a signed-out flash never shows before the
    // redirect effect fires. Only settled+successful+no-user actually
    // redirects.
    return isPending ? "loading" : "redirect";
  }
  return "ready";
}

/**
 * Whether the authenticated terminal may be painted.
 *
 * The server and the first client render do not share the Better Auth session
 * atom. In particular, navigating from a signed-in landing page can leave the
 * browser atom settled while the new /app server render still sees its
 * pending, empty snapshot. Keep the terminal hidden until the mount effect
 * has run so both trees have the same output. Auth state remains fail-closed:
 * a pending or anonymous session never renders the terminal.
 */
export function shouldRenderDashboard(
  isPending: boolean,
  hasUser: boolean,
  hasMounted: boolean,
  hasError = false,
): boolean {
  return (
    hasMounted &&
    resolveDashboardVisibility(isPending, hasUser, hasError) === "ready"
  );
}

export interface DashboardAuthUnavailableProps {
  onRetry: () => void | Promise<void>;
}

/**
 * Small, recoverable fail-closed state for a session read that could not
 * complete. Kept next to the decision so the route and its alias share the
 * same user-facing error contract without mounting the terminal.
 */
export function DashboardAuthUnavailable({
  onRetry,
}: DashboardAuthUnavailableProps) {
  return createElement(
    "main",
    {
      role: "alert",
      "aria-live": "polite",
      className:
        "flex min-h-[40vh] items-center justify-center bg-background px-6 py-10 text-foreground",
    },
    createElement(
      "section",
      {
        className:
          "flex max-w-sm flex-col items-center gap-3 rounded-lg border border-border bg-card p-6 text-center shadow-sm",
      },
      createElement(
        "h1",
        { className: "text-base font-semibold" },
        "Authentication temporarily unavailable",
      ),
      createElement(
        "p",
        { className: "text-sm text-muted-foreground" },
        "We could not verify your session. Try again to continue.",
      ),
      createElement(
        "button",
        {
          type: "button",
          "aria-label": "Retry session check",
          className:
            "rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90",
          onClick: () => {
            void Promise.resolve(onRetry()).catch(() => undefined);
          },
        },
        "Try again",
      ),
    ),
  );
}

export interface RedirectRouter {
  // METHOD syntax, not a property with a function type, and that is the whole
  // point. next.config.ts sets typedRoutes: true, so the build retypes
  // AppRouterInstance.replace as <RouteType>(href: RouteImpl<RouteType>, ...).
  // Under strictFunctionTypes a function-typed PROPERTY is checked
  // contravariantly and the real router is not assignable; a METHOD is checked
  // bivariantly and it is. This keeps the module free of a next/navigation
  // import while still being satisfiable by the router the page actually passes.
  replace(path: string, options?: unknown): void;
}

/**
 * Resolves visibility and performs the redirect side effect when needed.
 * Called from the guard's effect body; returns the same visibility the
 * render path uses so the two can never disagree.
 */
export function syncDashboardRedirect(
  router: RedirectRouter,
  isPending: boolean,
  hasUser: boolean,
  hasError = false,
): DashboardVisibility {
  const visibility = resolveDashboardVisibility(isPending, hasUser, hasError);
  if (visibility === "redirect") {
    router.replace("/");
  }
  return visibility;
}
