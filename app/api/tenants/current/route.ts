import { NextResponse } from "next/server";

import { getAuthContext } from "@/lib/auth";
import { listClientsForUserEmail } from "@/lib/tenants/clients";

export async function GET() {
  const auth = await getAuthContext();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clients = await listClientsForUserEmail(auth.email);

  const currentClient =
    clients.find((client) => client.id === auth.tenantId) ??
    null;

  return NextResponse.json({
    tenant: {
      id: auth.tenantId,
      name: currentClient?.name ?? auth.tenantName
    },
    clients,
    user: {
      id: auth.userId,
      email: auth.email
    }
  });
}
