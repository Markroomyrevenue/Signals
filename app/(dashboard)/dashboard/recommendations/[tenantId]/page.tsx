import { notFound, redirect } from "next/navigation";

import RecsClientView from "../../../../components/recs/recs-client-view";
import { getAuthContext } from "@/lib/auth";
import { isInternalRecsUser } from "@/lib/recs/auth";
import { loadRecsClientView } from "@/lib/recs/data";

export const dynamic = "force-dynamic";

/**
 * Internal-only per-client approval surface. 404 for non-internal users and
 * for unknown tenants.
 */
export default async function RecommendationsClientPage({
  params
}: {
  params: Promise<{ tenantId: string }>;
}) {
  const auth = await getAuthContext();
  if (!auth) {
    redirect("/login");
  }
  if (!isInternalRecsUser(auth)) {
    notFound();
  }

  const { tenantId } = await params;
  const view = await loadRecsClientView(tenantId);
  if (!view) {
    notFound();
  }

  return <RecsClientView initialData={view} />;
}
