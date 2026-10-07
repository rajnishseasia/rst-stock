"use client";

import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";

/**
 * App-wide toast host. Follows the active next-themes theme and uses Sonner's
 * rich colors so success/error toasts read at a glance (important for order
 * confirmations). Mounted once in Providers.
 */
export function Toaster(props: ToasterProps) {
  const { theme = "system" } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      position="bottom-right"
      richColors
      closeButton
      {...props}
    />
  );
}
