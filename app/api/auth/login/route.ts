import { NextResponse } from "next/server";
import { z } from "zod";

import { createSession, setSessionCookie } from "@/lib/auth";
import { clearFailedLogins, getLoginRateLimitStatus, loginRateLimitKey, recordFailedLogin } from "@/lib/login-rate-limit";
import { verifyPassword } from "@/lib/password";
import { prisma } from "@/lib/prisma";

const bodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(8)
});

export async function POST(req: Request) {
  const rateLimitKey = loginRateLimitKey(req);
  const rateLimit = getLoginRateLimitStatus(rateLimitKey);

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many login attempts. Try again in 15 minutes." },
      {
        status: 429,
        headers: {
          "Retry-After": String(rateLimit.retryAfterSeconds)
        }
      }
    );
  }

  try {
    const body = bodySchema.parse(await req.json());

    const users = await prisma.user.findMany({
      where: {
        email: body.email.toLowerCase().trim()
      },
      orderBy: {
        createdAt: "asc"
      },
      take: 50
    });

    let authenticatedUser: (typeof users)[number] | null = null;
    for (const candidate of users) {
      const valid = await verifyPassword(body.password, candidate.passwordHash);
      if (!valid) continue;
      authenticatedUser = candidate;
      break;
    }

    if (!authenticatedUser) {
      const failedAttempt = recordFailedLogin(rateLimitKey);
      return NextResponse.json(
        {
          error: failedAttempt.blocked ? "Too many login attempts. Try again in 15 minutes." : "Invalid credentials"
        },
        {
          status: failedAttempt.blocked ? 429 : 401,
          headers: failedAttempt.retryAfterSeconds
            ? {
                "Retry-After": String(failedAttempt.retryAfterSeconds)
              }
            : undefined
        }
      );
    }

    clearFailedLogins(rateLimitKey);
    const sessionToken = await createSession(authenticatedUser.id, authenticatedUser.tenantId);
    // Record the login so the admin can see who's actually using the tool.
    // Fire-and-forget — a write failure here shouldn't block sign-in.
    prisma.user
      .update({
        where: { id: authenticatedUser.id },
        data: { lastLoginAt: new Date() }
      })
      .catch(() => undefined);
    const response = NextResponse.json({ success: true });
    setSessionCookie(response, sessionToken);
    return response;
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.flatten() }, { status: 400 });
    }

    return NextResponse.json({ error: "Failed to login" }, { status: 500 });
  }
}
