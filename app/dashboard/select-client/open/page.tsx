import { redirect } from "next/navigation";

import ClientOpenSyncScreen from "../../../components/client-open-sync-screen";
import { getAuthContext } from "@/lib/auth";
import { SyncScope, syncScopeForDashboardTab } from "@/lib/sync/stages";

function normalizeTargetTab(value: string | undefined): string {
  return value?.trim() || "overview";
}

function normalizeRequiredScope(value: string | undefined, tab: string): SyncScope {
  return value === "extended" ? "extended" : syncScopeForDashboardTab(tab);
}

export default async function DashboardOpenClientPage({
  searchParams
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const auth = await getAuthContext();
  if (!auth) {
    redirect("/login");
  }

  const params = (await searchParams) ?? {};
  const rawClient = params.client;
  const rawTab = params.tab;
  const rawScope = params.scope;
  const rawView = params.view;
  const clientName = Array.isArray(rawClient) ? rawClient[0] ?? "" : rawClient ?? "";
  const targetTab = normalizeTargetTab(Array.isArray(rawTab) ? rawTab[0] : rawTab);
  const requiredScope = normalizeRequiredScope(Array.isArray(rawScope) ? rawScope[0] : rawScope, targetTab);
  const targetView = Array.isArray(rawView) ? rawView[0] ?? null : rawView ?? null;

  return (
    <ClientOpenSyncScreen
      tenantId={auth.tenantId}
      clientName={clientName}
      targetTab={targetTab}
      requiredScope={requiredScope}
      targetView={targetView}
    />
  );
}
