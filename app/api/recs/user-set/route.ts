import { NextResponse } from "next/server";

import { addUtcDays, fromDateOnly, toDateOnly } from "@/lib/metrics/helpers";
import { defaultClientKey } from "@/lib/observe/config";
import { prisma } from "@/lib/prisma";
import { getInternalRecsAuth } from "@/lib/recs/auth";
import { CALENDAR_SETTABLE_DAYS, londonToday } from "@/lib/recs/calendar-data";

export const dynamic = "force-dynamic";

/**
 * POST /api/recs/user-set — the operator sets a price on an OPEN calendar
 * date that has no recommendation. Creates a pending "recs-night" Suggestion
 * indistinguishable from a generator row wherever the pipeline cares, so the
 * normal approve(editedPrice)→push flow carries the operator's number: same
 * clientKey source as the generator (defaultClientKey = tenantId), same
 * engineListingId stamp (Listing.hostawayId), oldValue = the LIVE rate.
 *
 * Nothing is pushed from here — this only stages a pending row; the push
 * still requires an explicit approval through /api/recs/action.
 *
 * detail.typedPrice is stamped at creation: a user-set price IS an
 * operator-typed number, so the push gate's below-floor clamp must not
 * silently skip it (same Mark 2026-07-20 rule approveSuggestion applies to
 * edited prices — the fat-finger bound below is the remaining guard).
 */

type UserSetBody = { tenantId: string; listingId: string; date: string; price: number };

function parseBody(raw: unknown): { body?: UserSetBody; error?: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "Invalid request body" };
  const { tenantId, listingId, date, price } = raw as Record<string, unknown>;
  if (typeof tenantId !== "string" || tenantId.trim() === "") return { error: "tenantId is required" };
  if (typeof listingId !== "string" || listingId.trim() === "") return { error: "listingId is required" };
  if (typeof date !== "string" || date.trim() === "") return { error: "date is required" };
  if (typeof price !== "number") return { error: "price must be a number" };
  return { body: { tenantId: tenantId.trim(), listingId: listingId.trim(), date: date.trim(), price } };
}

function bad(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 400 });
}

export async function POST(request: Request): Promise<NextResponse> {
  // Guard 1 — internal auth: the route does not exist for anyone else.
  const auth = await getInternalRecsAuth();
  if (!auth) return new NextResponse("Not found", { status: 404 });

  const raw = await request.json().catch(() => null);
  const { body, error } = parseBody(raw);
  if (!body) return bad(error ?? "Invalid request body");

  try {
    // Guard 2 — tenant exists; listing exists AND belongs to that tenant
    // (tenantId in the where — never trust a listing id on its own).
    const tenant = await prisma.tenant.findUnique({ where: { id: body.tenantId }, select: { id: true } });
    if (!tenant) return bad("that client no longer exists");
    const listing = await prisma.listing.findFirst({
      where: { id: body.listingId, tenantId: body.tenantId },
      select: { id: true, hostawayId: true }
    });
    if (!listing) return bad("that listing does not belong to this client");

    // Guard 3 — the date parses and sits inside the SETTABLE window (today..
    // today+settableDays-1). This is the recs surfacing/tracking window, NOT
    // the wider context window: a price set beyond it would push live yet never
    // re-appear on the calendar (loadRecsClientView only returns that far), so
    // it could silently double-push. Days past it are read-only context.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date)) return bad("date must look like YYYY-MM-DD");
    const night = fromDateOnly(body.date);
    if (toDateOnly(night) !== body.date) return bad("that is not a real calendar date");
    const today = londonToday(new Date());
    if (night.getTime() < today.getTime()) {
      return bad("that date has already passed — prices can only be set from today onwards");
    }
    if (night.getTime() >= addUtcDays(today, CALENDAR_SETTABLE_DAYS).getTime()) {
      return bad(
        `that date is beyond the ${CALENDAR_SETTABLE_DAYS}-night window the calendar tracks — prices can only be set within it`
      );
    }

    // Guard 4 — a booked night's price can't be changed (any occupied fact,
    // owner blocks included: there is nothing left to sell either way).
    const booked = await prisma.nightFact.findFirst({
      where: { tenantId: body.tenantId, listingId: body.listingId, date: night, isOccupied: true },
      select: { factKey: true }
    });
    if (booked) return bad("that night is already booked — its price can't be set from here");

    // Guard 5 — an existing pending suggestion for the night is REUSED, never
    // duplicated: the operator edits-then-approves that row instead.
    const existing = await prisma.suggestion.findFirst({
      where: { tenantId: body.tenantId, listingId: body.listingId, dateFrom: night, type: "recs-night", status: "pending" },
      select: { id: true }
    });
    if (existing) return NextResponse.json({ ok: true, suggestionId: existing.id, reused: true });

    // Guard 6 — a live rate is REQUIRED: it is the oldValue basis the push
    // verify and the fat-finger bound both hang off. No live rate, no row.
    const calendarRate = await prisma.calendarRate.findUnique({
      where: { tenantId_listingId_date: { tenantId: body.tenantId, listingId: body.listingId, date: night } },
      select: { available: true, rate: true }
    });
    const live = calendarRate?.available ? Number(calendarRate.rate) : null;
    if (live === null || !Number.isFinite(live) || live <= 0) return bad("no live rate known for that date");

    // Guard 7 — the price itself: positive, and never under half the current
    // rate (the same fat-finger bound approveSuggestion applies to edits).
    if (!Number.isFinite(body.price) || body.price <= 0) return bad("price must be a positive number");
    if (body.price < live * 0.5) {
      return bad(
        `price ${body.price} is under half the current rate ${Math.round(live)} — refusing (fat-finger guard)`
      );
    }

    // Floor context for the row: latest engine snapshot min, else honestly
    // unknown — mirrors how generator rows label their floor.
    const snapshot = await prisma.engineSnapshot.findFirst({
      where: { tenantId: body.tenantId, listingId: body.listingId },
      orderBy: { capturedAt: "desc" },
      select: { min: true }
    });
    const floor = snapshot?.min !== null && snapshot?.min !== undefined ? Math.round(Number(snapshot.min)) : null;

    const created = await prisma.suggestion.create({
      data: {
        tenantId: body.tenantId,
        clientKey: defaultClientKey(body.tenantId),
        listingId: body.listingId,
        engineListingId: listing.hostawayId ? String(listing.hostawayId) : null,
        dateFrom: night,
        dateTo: night,
        lever: "price",
        type: "recs-night",
        reason: "price set by operator on the calendar",
        oldValue: live,
        proposedValue: body.price,
        status: "pending",
        provenance: "user-set",
        provisional: false,
        detail: {
          recsPage: true,
          userSet: true,
          typedPrice: true,
          hold: false,
          whyShort: "price set by you",
          ...(floor !== null ? { floor } : { floorUnknown: true })
        }
      },
      select: { id: true }
    });

    return NextResponse.json({ ok: true, suggestionId: created.id, reused: false });
  } catch {
    return NextResponse.json({ error: "Failed to set the price" }, { status: 500 });
  }
}
