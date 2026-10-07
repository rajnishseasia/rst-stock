import type { Metadata } from "next";

// The /app page is the shared authenticated dashboard guard. It mounts the
// production TradingAppContent once the session has settled, so this route is
// an alias rather than a second provider/query/controller tree.
import DashboardGuard from "../app/page";

export const metadata: Metadata = {
  title: "Mobile Trading Workspace | Ready Set Trade",
  description:
    "A functional mobile trading workspace powered by the Ready Set Trade terminal.",
};

export default function MobilePreviewPage() {
  return <DashboardGuard />;
}
