import { redirect } from "next/navigation";

import { getAuthContext } from "@/lib/auth";
import { listManageableClientsForUserEmail, listTeamUsersForManagerEmail } from "@/lib/team/team-access";

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

  const [users, clients] = await Promise.all([
    listTeamUsersForManagerEmail(auth.email),
    listManageableClientsForUserEmail(auth.email)
  ]);

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-6 flex items-baseline justify-between gap-3">
        <h1 className="font-display text-3xl sm:text-4xl">Team</h1>
        <span className="text-xs uppercase tracking-[0.28em] text-neutral-500">Settings</span>
      </header>

      <TeamManager
        currentUserEmail={auth.email.toLowerCase().trim()}
        currentTenantId={auth.tenantId}
        initialClients={clients}
        initialUsers={users}
      />
    </main>
  );
}
