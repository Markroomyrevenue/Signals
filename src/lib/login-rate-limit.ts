type LoginAttemptState = {
  blockedUntil: number;
  count: number;
  windowStartedAt: number;
};

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;

declare global {
  // eslint-disable-next-line no-var
  var __roomyLoginRateLimitStore: Map<string, LoginAttemptState> | undefined;
}

function store(): Map<string, LoginAttemptState> {
  globalThis.__roomyLoginRateLimitStore ??= new Map<string, LoginAttemptState>();
  return globalThis.__roomyLoginRateLimitStore;
}

function cleanup(now: number) {
  for (const [key, state] of store()) {
    const windowExpired = state.windowStartedAt + LOGIN_WINDOW_MS <= now;
    const blockExpired = state.blockedUntil <= now;

    if (windowExpired && blockExpired) {
      store().delete(key);
    }
  }
}

function parseClientIp(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0]?.trim() || "unknown";
  }

  const realIp = request.headers.get("x-real-ip");
  if (realIp) {
    return realIp.trim();
  }

  const forwarded = request.headers.get("forwarded");
  if (forwarded) {
    const match = forwarded.match(/for="?([^;,"\s]+)"?/i);
    if (match?.[1]) {
      return match[1];
    }
  }

  return "unknown";
}

export function loginRateLimitKey(request: Request): string {
  return parseClientIp(request);
}

export function getLoginRateLimitStatus(key: string): {
  allowed: boolean;
  retryAfterSeconds: number;
} {
  const now = Date.now();
  cleanup(now);

  const state = store().get(key);
  if (!state || state.blockedUntil <= now) {
    return { allowed: true, retryAfterSeconds: 0 };
  }

  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((state.blockedUntil - now) / 1000))
  };
}

export function recordFailedLogin(key: string): {
  blocked: boolean;
  retryAfterSeconds: number;
} {
  const now = Date.now();
  cleanup(now);

  const current = store().get(key);
  const windowExpired = !current || current.windowStartedAt + LOGIN_WINDOW_MS <= now;

  const nextState: LoginAttemptState = windowExpired
    ? {
        blockedUntil: 0,
        count: 1,
        windowStartedAt: now
      }
    : {
        blockedUntil: current.blockedUntil,
        count: current.count + 1,
        windowStartedAt: current.windowStartedAt
      };

  if (nextState.count >= MAX_LOGIN_ATTEMPTS) {
    nextState.blockedUntil = now + LOGIN_BLOCK_MS;
  }

  store().set(key, nextState);

  return {
    blocked: nextState.blockedUntil > now,
    retryAfterSeconds:
      nextState.blockedUntil > now ? Math.max(1, Math.ceil((nextState.blockedUntil - now) / 1000)) : 0
  };
}

export function clearFailedLogins(key: string) {
  store().delete(key);
}
