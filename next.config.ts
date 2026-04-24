import type { NextConfig } from "next";

function normalizeBasePath(value: string | null | undefined): string {
  const next = (value ?? "").trim();
  if (!next || next === "/") return "";

  const pathname = (() => {
    try {
      return new URL(next).pathname;
    } catch {
      return next;
    }
  })();

  const normalized = pathname.replace(/\/+$/, "");
  if (!normalized || normalized === "/") return "";
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function resolveBasePath(): string {
  const explicitBasePath = normalizeBasePath(process.env.APP_BASE_PATH);
  if (explicitBasePath) return explicitBasePath;

  return normalizeBasePath(process.env.APP_BASE_URL);
}

const basePath = resolveBasePath();
const distDir = process.env.ROOMY_NEXT_DIST_DIR?.trim();

const nextConfig: NextConfig = {
  basePath: basePath || undefined,
  distDir: distDir || undefined,
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath
  },
  reactStrictMode: true,
  typedRoutes: false
};

export default nextConfig;
