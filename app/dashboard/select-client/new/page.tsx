import { redirect } from "next/navigation";

import ClientCreateForm from "../../../components/client-create-form";
import { getAuthContext } from "@/lib/auth";

export default async function DashboardNewClientPage() {
  const auth = await getAuthContext();
  if (!auth) {
    redirect("/login");
  }

  return <ClientCreateForm />;
}
