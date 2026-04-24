import crypto from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { env } from "@/lib/env";
import { sessionCookiePath } from "@/lib/base-path";
import { prisma } from "@/lib/prisma";

const SESSION_COOKIE = "ha_session";
const SESSION_DAYS = 14;

export type UserRole = "admin" | "viewer";

export type AuthContext = {
  userId: string;
  tenantId: string;
  email: string;
  tenantName: string;
  role: UserRole;
  displayName: string | null;
};

function normalizeRole(role: string | null | undefined): UserRole {
  return role === "admin" ? "admin" : "viewer";
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function shouldUseSecureCookies(): boolean {
  if (process.env.NODE_ENV !== "production") return false;

  try {
    return new URL(env.appBaseUrl).protocol === "https:";
  } catch {
    return false;
  }
}

export async function createSession(userId: string, tenantId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);

  await prisma.session.create({
    data: {
      userId,
      tenantId,
      tokenHash,
      expiresAt: new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000)
    }
  });

  return token;
}

export async function getAuthContextFromSessionToken(token: string | null | undefined): Promise<AuthContext | null> {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const session = await prisma.session.findUnique({
    where: { tokenHash },
    include: {
      user: true,
      tenant: true
    }
  });

  if (!session) return null;
  if (session.expiresAt < new Date()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }

  return {
    userId: session.userId,
    tenantId: session.tenantId,
    email: session.user.email,
    tenantName: session.tenant.name,
    role: normalizeRole(session.user.role),
    displayName: session.user.displayName ?? null
  };
}

export async function getAuthContext(): Promise<AuthContext | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  return getAuthContextFromSessionToken(token);
}

export function setSessionCookie(response: NextResponse, token: string): void {
  response.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    secure: shouldUseSecureCookies(),
    sameSite: "lax",
    path: sessionCookiePath(),
    maxAge: SESSION_DAYS * 24 * 60 * 60
  });
}

export async function clearSessionFromRequest(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return;

  await prisma.session.deleteMany({
    where: {
      tokenHash: hashToken(token)
    }
  });
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set({
    name: SESSION_COOKIE,
    value: "",
    httpOnly: true,
    secure: shouldUseSecureCookies(),
    sameSite: "lax",
    path: sessionCookiePath(),
    maxAge: 0
  });
}

export async function requireAuthContext(): Promise<AuthContext> {
  const auth = await getAuthContext();
  if (!auth) {
    throw new Error("UNAUTHORIZED");
  }
  return auth;
}

export class ForbiddenError extends Error {
  constructor(message = "FORBIDDEN") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/**
 * Return the authenticated context only if the user has the admin role.
 * Callers should treat `null` as 401, and a thrown ForbiddenError as 403.
 */
export async function getAdminAuthContext(): Promise<AuthContext | null> {
  const auth = await getAuthContext();
  if (!auth) return null;
  if (auth.role !== "admin") {
    throw new ForbiddenError();
  }
  return auth;
}

export function isAdmin(auth: AuthContext | null | undefined): boolean {
  return !!auth && auth.role === "admin";
}
