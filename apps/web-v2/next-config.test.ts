import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import nextConfig, { baseNextConfig } from "./next.config";

const managedEnvKeys = [
  "NEXT_PUBLIC_API_URL",
  "VERCEL",
  "VERCEL_ENV",
  "VERCEL_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
] as const;

const originalEnv = new Map(
  managedEnvKeys.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("Next.js configuration", () => {
  test("uses the TypeScript config as the single source of truth", () => {
    expect(existsSync(new URL("./next.config.mjs", import.meta.url))).toBeFalse();
    expect(nextConfig.pageExtensions).toEqual(["ts", "tsx"]);
    expect(nextConfig.typedRoutes).toBeTrue();
    expect(nextConfig.reactCompiler).toBeTrue();
    const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
    expect(nextConfig.turbopack).toEqual({ root: repositoryRoot });
    expect(nextConfig.outputFileTracingRoot).toBe(repositoryRoot);
    expect(nextConfig.transpilePackages).toEqual([
      "@trade-bot/types",
      "@trade-bot/api",
      "@trade-bot/db",
      "@trade-bot/utils",
      "@trade-bot/logger",
      "@trade-bot/redis",
    ]);
  });

  test("preserves image host policy", () => {
    expect(nextConfig.images?.remotePatterns).toEqual([
      {
        protocol: "https",
        hostname: "polymarket-upload.s3.us-east-2.amazonaws.com",
        pathname: "/**",
      },
      {
        protocol: "https",
        hostname: "api.dicebear.com",
        pathname: "/**",
      },
    ]);
  });

  test("preserves workspace extension aliases in webpack builds", () => {
    const webpackConfig = baseNextConfig.webpack?.(
      { resolve: {} },
      {} as Parameters<NonNullable<typeof baseNextConfig.webpack>>[1],
    );

    expect(webpackConfig?.resolve.extensionAlias).toEqual({
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".mjs": [".mts", ".mjs"],
    });
  });

  test("the shipped config carries the workspace webpack hook", () => {
    expect(typeof nextConfig.webpack).toBe("function");
  });

  test("preserves every API proxy rewrite", async () => {
    process.env.NEXT_PUBLIC_API_URL = "https://api.example.com/";

    await expect(nextConfig.rewrites!()).resolves.toEqual([
      {
        source: "/api/auth/:path*",
        destination: "https://api.example.com/api/auth/:path*",
      },
      {
        source: "/api/chat/:path*",
        destination: "https://api.example.com/api/chat/:path*",
      },
      {
        source: "/trpc/:path*",
        destination: "https://api.example.com/trpc/:path*",
      },
    ]);
  });

  test("requires NEXT_PUBLIC_API_URL on Vercel", async () => {
    process.env.VERCEL = "1";
    delete process.env.NEXT_PUBLIC_API_URL;

    await expect(nextConfig.rewrites!()).rejects.toThrow(
      "NEXT_PUBLIC_API_URL is required",
    );
  });

  test("rejects self-referential API URLs on Vercel", async () => {
    process.env.VERCEL = "1";
    process.env.VERCEL_URL = "rst-stock-site-web-v2-olive.vercel.app";
    process.env.NEXT_PUBLIC_API_URL =
      "https://rst-stock-site-web-v2-olive.vercel.app";

    await expect(nextConfig.rewrites!()).rejects.toThrow(
      "points to this web deployment",
    );
  });
});

describe("canonical domain redirect", () => {
  test("funnels Vercel-assigned hosts to the canonical domain in production", async () => {
    process.env.VERCEL_ENV = "production";

    await expect(nextConfig.redirects!()).resolves.toEqual([
      {
        source: "/:path*",
        has: [{ type: "host", value: ".*\\.vercel\\.app" }],
        destination: "https://www.readysettrade.app/:path*",
        permanent: false,
      },
      {
        source: "/leaderboard/:path*",
        destination: "/lb/:path*",
        permanent: false,
      },
    ]);
  });

  test("leaves preview deployments reachable on their own hosts", async () => {
    process.env.VERCEL_ENV = "preview";

    await expect(nextConfig.redirects!()).resolves.toEqual([
      {
        source: "/leaderboard/:path*",
        destination: "/lb/:path*",
        permanent: false,
      },
    ]);
  });

  test("adds no redirect outside Vercel", async () => {
    delete process.env.VERCEL_ENV;

    await expect(nextConfig.redirects!()).resolves.toEqual([
      {
        source: "/leaderboard/:path*",
        destination: "/lb/:path*",
        permanent: false,
      },
    ]);
  });

  test("matches every Vercel host for this project but never the canonical domain", async () => {
    process.env.VERCEL_ENV = "production";

    const [rule] = await nextConfig.redirects!();
    // Next.js anchors `has` values before matching them against the host.
    const hostPattern = new RegExp(`^${rule!.has![0]!.value}$`);

    for (const host of [
      "rst-stock-site-web-v2-olive.vercel.app",
      "rst-stock-site-web-v2.vercel.app",
      "rst-stock-site-web-v2-napindc1s-projects.vercel.app",
    ]) {
      expect(hostPattern.test(host)).toBeTrue();
    }

    // Matching the destination host would make the redirect loop forever.
    expect(hostPattern.test("www.readysettrade.app")).toBeFalse();
    expect(hostPattern.test("readysettrade.app")).toBeFalse();
  });
});
