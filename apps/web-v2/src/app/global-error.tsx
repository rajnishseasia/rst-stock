"use client";

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html>
      <body>
        <div style={{ padding: "2rem", fontFamily: "sans-serif" }}>
          <h2>Something went wrong</h2>
          <p>An unexpected error occurred.</p>
          <button onClick={reset}>Try again</button>
        </div>
      </body>
    </html>
  );
}
