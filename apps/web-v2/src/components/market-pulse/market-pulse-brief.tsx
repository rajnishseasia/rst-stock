import { ExternalLink, Newspaper } from "lucide-react";
import type { MarketPulseOverview } from "./market-pulse-types";
import { getExternalSourceUrl } from "./market-pulse-utils";

type MarketPulseBriefProps = {
  brief: MarketPulseOverview["brief"];
};

function formatPublishedAt(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function MarketPulseBrief({ brief }: MarketPulseBriefProps) {
  const sources = brief.sources.flatMap((source) => {
    const href = getExternalSourceUrl(source.url);
    return href ? [{ ...source, href }] : [];
  });

  return (
    <section aria-labelledby="market-pulse-brief-heading" className="border-b border-border/70">
      <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.42fr)]">
        <div className="min-w-0 px-3 py-4 sm:px-4 lg:border-r lg:border-border/70 lg:px-5">
          <div className="mb-2 flex items-center gap-2 text-3xs font-semibold uppercase text-primary">
            <Newspaper className="size-3" aria-hidden="true" />
            Sourced brief
          </div>
          <h2
            id="market-pulse-brief-heading"
            className="max-w-4xl text-base font-semibold leading-snug text-foreground sm:text-lg"
          >
            {brief.headline}
          </h2>
          <p className="mt-2 max-w-4xl text-xs leading-5 text-muted-foreground sm:text-sm">
            {brief.summary}
          </p>
        </div>

        <div className="min-w-0 px-3 py-3 sm:px-4 lg:px-5">
          <h3 className="mb-2 text-3xs font-semibold uppercase text-muted-foreground">
            Sources
          </h3>
          {sources.length > 0 ? (
            <ol className="divide-y divide-border/60">
              {sources.slice(0, 4).map((source, index) => (
                <li key={source.id}>
                  <a
                    href={source.href}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="group grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-start gap-1.5 py-2 text-xs outline-none focus-visible:text-primary"
                  >
                    <span className="font-data tabular-nums text-muted-foreground">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="min-w-0">
                      <span className="line-clamp-1 font-medium text-foreground group-hover:text-primary">
                        {source.title}
                      </span>
                      <span className="mt-0.5 block text-3xs text-muted-foreground">
                        {source.provider}
                        {formatPublishedAt(source.publishedAt)
                          ? ` / ${formatPublishedAt(source.publishedAt)}`
                          : ""}
                      </span>
                    </span>
                    <ExternalLink className="mt-0.5 size-3 text-muted-foreground group-hover:text-primary" aria-hidden="true" />
                  </a>
                </li>
              ))}
            </ol>
          ) : (
            <p className="py-2 text-xs text-muted-foreground">No external sources were returned.</p>
          )}
        </div>
      </div>
    </section>
  );
}
