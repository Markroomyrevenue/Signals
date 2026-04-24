import { redirect } from "next/navigation";

import ClientProvisioningScreen from "../../../../components/client-provisioning-screen";
import { getAuthContext } from "@/lib/auth";

export default async function DashboardNewClientProvisioningPage({
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
  const clientName = Array.isArray(rawClient) ? rawClient[0] ?? "" : rawClient ?? "";

  return <ClientProvisioningScreen tenantId={auth.tenantId} clientName={clientName} />;
}
