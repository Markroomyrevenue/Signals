import { SyncScope, syncScopeForDashboardTab } from "@/lib/sync/stages";

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
  const explicitBasePath = normalizeBasePath(process.env.NEXT_PUBLIC_BASE_PATH);
  if (explicitBasePath) return explicitBasePath;

  const appBasePath = normalizeBasePath(process.env.APP_BASE_PATH);
  if (appBasePath) return appBasePath;

  return normalizeBasePath(process.env.APP_BASE_URL);
}

export const basePath = resolveBasePath();

export function withBasePath(path: string): string {
  if (!path) {
    return basePath || "/";
  }

  if (/^(?:[a-z]+:)?\/\//i.test(path)) {
    return path;
  }

  if (!path.startsWith("/")) {
    return path;
  }

  if (!basePath) {
    return path;
  }

  if (path === "/") {
    return basePath;
  }

  if (path === basePath || path.startsWith(`${basePath}/`)) {
    return path;
  }

  return `${basePath}${path}`;
}

export function sessionCookiePath(): string {
  return basePath || "/";
}

export function buildDashboardViewHref(tab: string, encodedView?: string | null): string {
  const normalizedEncodedView = encodedView?.trim();
  if (normalizedEncodedView) {
    return withBasePath(`/dashboard?view=${encodeURIComponent(normalizedEncodedView)}`);
  }

  if (typeof window === "undefined") {
    return withBasePath("/dashboard");
  }

  const encoded = window.btoa(JSON.stringify({ tab }));
  return withBasePath(`/dashboard?view=${encodeURIComponent(encoded)}`);
}

export function buildClientOpenHref(
  clientName: string,
  options?: {
    tab?: string;
    scope?: SyncScope;
    view?: string | null;
  }
): string {
  const tab = options?.tab ?? "overview";
  const scope = options?.scope ?? syncScopeForDashboardTab(tab);
  const searchParams = new URLSearchParams({
    client: clientName,
    tab,
    scope
  });
  const encodedView = options?.view?.trim();
  if (encodedView) {
    searchParams.set("view", encodedView);
  }
  return withBasePath(`/dashboard/select-client/open?${searchParams.toString()}`);
}
