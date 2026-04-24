import { redirect } from "next/navigation";

import ClientSelector from "../../components/client-selector";
import { getAuthContext } from "@/lib/auth";
import { listClientsForUserEmail } from "@/lib/tenants/clients";

export default async function DashboardClientSelectPage() {
  const auth = await getAuthContext();
  if (!auth) {
    redirect("/login");
  }

  const clients = await listClientsForUserEmail(auth.email);

  return (
    <ClientSelector
      currentTenantId={auth.tenantId}
      clients={clients}
    />
  );
}
