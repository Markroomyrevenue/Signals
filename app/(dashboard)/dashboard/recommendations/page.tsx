import { notFound, redirect } from "next/navigation";

import RecsOverview from "../../../components/recs/recs-overview";
import { getAuthContext } from "@/lib/auth";
import { isInternalRecsUser } from "@/lib/recs/auth";
import { loadRecsOverview } from "@/lib/recs/data";

export const dynamic = "force-dynamic";

/**
 * Internal-only Pricing Recommendations overview. For anyone who is not an
 * internal recs user this page does not exist (404) — client-tenant admins
 * must never learn it is here.
 */
export default async function RecommendationsPage() {
  const auth = await getAuthContext();
  if (!auth) {
    redirect("/login");
  }
  if (!isInternalRecsUser(auth)) {
    notFound();
  }

  const clients = await loadRecsOverview();

  return <RecsOverview initialClients={clients} />;
}
