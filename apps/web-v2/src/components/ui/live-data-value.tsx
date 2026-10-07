"use client";

import {
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";

export type LiveDataDirection = "up" | "down" | null;

export function getLiveDataDirection(
  previous: number | null | undefined,
  next: number | null | undefined,
): LiveDataDirection {
  if (
    previous == null ||
    next == null ||
    !Number.isFinite(previous) ||
    !Number.isFinite(next) ||
    previous === next
  ) {
    return null;
  }

  return next > previous ? "up" : "down";
}

export interface LiveDataValueProps
  extends Omit<ComponentPropsWithoutRef<"span">, "children"> {
  value: number | null | undefined;
  format?: (value: number) => ReactNode;
  fallback?: ReactNode;
}

/** A tabular numeric value that briefly flashes when its value changes. */
export function LiveDataValue({
  value,
  format,
  fallback = null,
  className,
  ...props
}: LiveDataValueProps) {
  const previousValue = useRef(value);
  const [flash, setFlash] = useState<{
    direction: Exclude<LiveDataDirection, null>;
    revision: number;
  } | null>(null);

  useEffect(() => {
    const direction = getLiveDataDirection(previousValue.current, value);
    previousValue.current = value;

    if (direction == null) return;

    setFlash((current) => ({
      direction,
      revision: (current?.revision ?? 0) + 1,
    }));
  }, [value]);

  const content = value == null ? fallback : format ? format(value) : value;

  return (
    <span
      {...props}
      data-slot="live-data-value"
      className={cn("tabular-nums", className)}
    >
      <span
        key={flash?.revision ?? 0}
        className="live-data-value"
        data-direction={flash?.direction ?? "steady"}
      >
        {content}
      </span>
    </span>
  );
}
