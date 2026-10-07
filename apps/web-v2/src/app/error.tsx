"use client";

import { useEffect } from "react";
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Unhandled application error:", error);
  }, [error]);

  return (
    <div className="flex h-[100vh] w-full flex-col items-center justify-center bg-background px-4">
      <div className="mx-auto flex max-w-sm flex-col items-center justify-center text-center">
        <div className="mb-4 rounded-full bg-destructive/10 p-3 text-destructive">
          <AlertCircle className="h-10 w-10" />
        </div>
        <h2 className="mb-2 text-2xl font-semibold tracking-tight">Something went wrong!</h2>
        <p className="mb-6 text-sm text-muted-foreground">
          {error.message || "An unexpected error occurred. Our team has been notified."}
        </p>
        <div className="flex space-x-4">
          <Button variant="outline" onClick={() => window.location.reload()}>
            Refresh Page
          </Button>
          <Button onClick={() => reset()}>Try Again</Button>
        </div>
      </div>
    </div>
  );
}
