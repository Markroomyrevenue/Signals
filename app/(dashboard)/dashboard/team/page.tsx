import { redirect } from "next/navigation";

import { getAuthContext } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

import TeamManager from "./team-manager";

export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const auth = await getAuthContext();
  if (!auth) {
    redirect("/login");
  }
  // Viewers can't see this page at all — bounce them back to reports.
  if (auth.role !== "admin") {
    redirect("/dashboard");
  }

  const users = await prisma.user.findMany({
    where: { tenantId: auth.tenantId },
    orderBy: [{ role: "asc" }, { email: "asc" }],
    select: {
      id: true,
      email: true,
      role: true,
      displayName: true,
      lastLoginAt: true,
      createdAt: true
    }
  });

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-8">
        <p className="text-xs font-semibold uppercase tracking-[0.32em] text-neutral-500">Settings</p>
        <h1 className="font-display mt-2 text-4xl">Team</h1>
        <p className="mt-2 max-w-2xl text-sm text-neutral-600">
          Invite teammates to Signals. Reviewers see every report except Calendar / dynamic
          pricing. Admins see everything and can manage this page.
        </p>
      </header>

      <TeamManager currentUserId={auth.userId} initialUsers={users.map((u) => ({ ...u, lastLoginAt: u.lastLoginAt?.toISOString() ?? null, createdAt: u.createdAt.toISOString() }))} />
    </main>
  );
}
