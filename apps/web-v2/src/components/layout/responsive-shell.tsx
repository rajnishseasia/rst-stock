import type { ReactNode } from "react";

export type ResponsiveShellMode = "mobile" | "desktop" | null;

export function ResponsiveShell({
  mode,
  mobile,
  desktop,
}: {
  mode: ResponsiveShellMode;
  mobile: ReactNode;
  desktop: ReactNode;
}) {
  if (mode === null) return null;
  return mode === "desktop" ? desktop : mobile;
}
