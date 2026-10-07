/**
 * Root Layout
 *
 * Main application layout with providers.
 */

import type { Metadata, Viewport } from "next";
import "./globals.css";
import "@/lib/localStorage-polyfill";
import { Providers } from "@/components/providers";

export const viewport: Viewport = {
  viewportFit: "cover",
  colorScheme: "dark",
  themeColor: "#040d14",
  // The mobile shell is a 100dvh flex column with an in-flow bottom nav, and
  // the trade ticket is a bottom sheet with a sticky submit footer. With the
  // default (resizes-visual) the on-screen keyboard overlays the layout
  // viewport, so on Android the ticket's lower fields and its Submit sit
  // behind the keyboard and the only way to them is panning the visual
  // viewport. resizes-content shrinks the layout viewport instead: 100dvh
  // follows the keyboard, the frame's scroller keeps the focused field in
  // view, and the footer stays above the keys. iOS ignores the key.
  interactiveWidget: "resizes-content",
};

export const metadata: Metadata = {
  title: "Ready Set Trade",
  description: "Ready Set Trade - automated trading platform",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
