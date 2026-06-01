import { NextResponse } from "next/server";

import { buildMonthlySignalsSummary } from "@/lib/signals/summary";

/**
 * Read-only monthly Signals summary, fetched by a Cowork scheduled task.
 *
 * Access control is a single secret query key: `?key=` must equal
 * `process.env.SIGNALS_SUMMARY_KEY`. When the env var is unset or the key does
 * not match we return 404 (not 401) so the route's existence is not advertised.
 * `SIGNALS_SUMMARY_KEY` must not be read anywhere else in the app.
 *
 * SELECT-only: delegates to `buildMonthlySignalsSummary`, which reads only the
 * four signals tables (+ tenant names) and never writes.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const expectedKey = process.env.SIGNALS_SUMMARY_KEY;
  const { searchParams } = new URL(request.url);
  const providedKey = searchParams.get("key");

  // Disabled when unset; 404 (not 401) on any mismatch so we don't advertise it.
  if (!expectedKey || providedKey !== expectedKey) {
    return new NextResponse("Not found", { status: 404 });
  }

  const monthParam = searchParams.get("month") ?? undefined;

  try {
    const summary = await buildMonthlySignalsSummary({ month: monthParam });
    return NextResponse.json(summary);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to build signals summary" },
      { status: 500 }
    );
  }
}
