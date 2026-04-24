import { redirect } from "next/navigation";

import { getAuthContext } from "@/lib/auth";
import HostawaySettingsPage from "../../components/hostaway-settings";

export default async function DashboardSettingsPage() {
  const auth = await getAuthContext();
  if (!auth) {
    redirect("/login");
  }

  return <HostawaySettingsPage />;
}
