import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

function getUrlHost(value: string | undefined): string | null {
  if (!value) return null;

  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return null;

  try {
    return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`)
      .host;
  } catch {
    return null;
  }
}

function resolveApiUrl(): string {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL?.trim();

  if (!apiUrl && process.env.VERCEL === "1") {
    throw new Error(
      "NEXT_PUBLIC_API_URL is required for Vercel web deployments. Set it to the deployed apps/api URL, not the web app URL.",
    );
  }

  const normalizedApiUrl = (apiUrl || "http://localhost:3001").replace(
    /\/+$/,
    "",
  );
  const apiHost = getUrlHost(normalizedApiUrl);

  if (!apiHost) {
    throw new Error(
      `NEXT_PUBLIC_API_URL must be a valid URL. Received: ${normalizedApiUrl}`,
    );
  }

  if (process.env.VERCEL === "1") {
    const webHosts = [
      getUrlHost(process.env.VERCEL_URL),
      getUrlHost(process.env.VERCEL_PROJECT_PRODUCTION_URL),
    ].filter(Boolean);

    if (webHosts.includes(apiHost)) {
      throw new Error(
        "NEXT_PUBLIC_API_URL points to this web deployment. Set it to the separate apps/api Vercel URL to avoid /trpc and /api/auth redirect loops.",
      );
    }
  }

  return normalizedApiUrl;
}

/**
 * The custom domain every production visitor should end up on. The apex
 * (readysettrade.app) is configured in Vercel to 308 to this host, so pointing
 * anything at the apex would cost an extra hop.
 */
const CANONICAL_ORIGIN = "https://www.readysettrade.app";

/**
 * Vercel assigns this project several *.vercel.app hosts (currently
 * rst-stock-site-web-v2-olive, rst-stock-site-web-v2, and the
 * -napindc1s-projects alias). Matching them by suffix covers all of them, plus
 * any alias Vercel adds later.
 *
 * Next.js anchors `has` values, so this never matches the canonical domain and
 * cannot loop.
 */
const VERCEL_HOST_PATTERN = ".*\\.vercel\\.app";

const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const LEGACY_ROUTE_REDIRECTS = [
  {
    source: "/leaderboard/:path*",
    destination: "/lb/:path*",
    permanent: false,
  },
];

/**
 * Next.js configuration for web-v2 app.
 * Transpiles workspace packages for monorepo compatibility.
 *
 * Exported so its options can be asserted directly in tests.
 */
export const baseNextConfig: NextConfig = {
  // Do not let an unrelated lockfile above this checkout make Next trace and
  // compile the user's entire profile. Turbo launches this config from the app
  // directory, but the repository root is stable relative to this file.
  outputFileTracingRoot: REPOSITORY_ROOT,
  pageExtensions: ["ts", "tsx"],
  typedRoutes: true,
  reactCompiler: true,
  transpilePackages: [
    "@trade-bot/types",
    "@trade-bot/api",
    "@trade-bot/db",
    "@trade-bot/utils",
    "@trade-bot/logger",
    "@trade-bot/redis",
  ],
  // Turbopack config (for dev mode - Next.js 16 default)
  // Empty config silences the warning about webpack config with Turbopack
  turbopack: { root: REPOSITORY_ROOT },
  // Webpack config (for build mode and when --webpack flag is used)
  webpack: (config) => {
    // Resolve .js imports to .ts files for workspace packages
    // This allows TypeScript files with .js extensions in imports to be resolved correctly
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
  images: {
    remotePatterns: [
      {
        // Polymarket profile images from S3
        protocol: "https",
        hostname: "polymarket-upload.s3.us-east-2.amazonaws.com",
        pathname: "/**",
      },
      {
        // DiceBear avatar fallback
        protocol: "https",
        hostname: "api.dicebear.com",
        pathname: "/**",
      },
    ],
  },
  // Funnel the Vercel-assigned hosts to the custom domain.
  //
  // The VERCEL_ENV gate is load-bearing: preview deployments are served from
  // *.vercel.app too, so without it every preview would bounce to production
  // the moment it was opened. Preview builds get VERCEL_ENV=preview and never
  // compile the rule in.
  //
  // Deliberately a 307, not a 308: permanent redirects get cached hard by
  // browsers and are painful to undo. Promote it once the domain is settled.
  async redirects() {
    if (process.env.VERCEL_ENV !== "production") return LEGACY_ROUTE_REDIRECTS;

    return [
      {
        source: "/:path*",
        has: [{ type: "host" as const, value: VERCEL_HOST_PATTERN }],
        destination: `${CANONICAL_ORIGIN}/:path*`,
        permanent: false,
      },
      ...LEGACY_ROUTE_REDIRECTS,
    ];
  },
  // Proxy API routes to the API server
  async rewrites() {
    const apiUrl = resolveApiUrl();
    return [
      {
        source: "/api/auth/:path*",
        destination: `${apiUrl}/api/auth/:path*`,
      },
      {
        source: "/api/chat/:path*",
        destination: `${apiUrl}/api/chat/:path*`,
      },
      {
        source: "/trpc/:path*",
        destination: `${apiUrl}/trpc/:path*`,
      },
    ];
  },
};

export default baseNextConfig;
