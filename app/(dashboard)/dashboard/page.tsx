import { redirect } from "next/navigation";

import AnalyticsDashboard from "../../components/analytics-dashboard";
import AutoSyncManager from "../../components/auto-sync-manager";
import { getAuthContext } from "@/lib/auth";
import { liveMarketRefreshEnabled } from "@/lib/features";
import { prisma } from "@/lib/prisma";

export default async function DashboardPage() {
  const auth = await getAuthContext();
  if (!auth) {
    redirect("/login");
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: auth.tenantId },
    select: { defaultCurrency: true }
  });

  return (
    <>
      <AutoSyncManager tenantId={auth.tenantId} />
      <AnalyticsDashboard
        key={auth.tenantId}
        userEmail={auth.email}
        userRole={auth.role}
        defaultCurrency={tenant?.defaultCurrency ?? "GBP"}
        initialTenantId={auth.tenantId}
        initialTenantName={auth.tenantName}
        allowLiveMarketRefresh={liveMarketRefreshEnabled()}
      />
    </>
  );
}
