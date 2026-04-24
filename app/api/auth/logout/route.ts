import { NextResponse } from "next/server";

import { clearSessionCookie, clearSessionFromRequest } from "@/lib/auth";

export async function POST() {
  await clearSessionFromRequest();
  const response = NextResponse.json({ success: true });
  clearSessionCookie(response);
  return response;
}
