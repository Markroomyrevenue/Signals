import { NextResponse } from "next/server";

import { approveSuggestion, rejectSuggestion, revertSuggestionPush } from "@/lib/recs/actions";
import { getInternalRecsAuth } from "@/lib/recs/auth";

export const dynamic = "force-dynamic";

const ACTIONS = ["approve", "reject", "revert"] as const;
type RecsAction = (typeof ACTIONS)[number];

type ActionBody = {
  tenantId: string;
  suggestionId: string;
  action: RecsAction;
  editedPrice: number | null;
};

function parseBody(raw: unknown): { body?: ActionBody; error?: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "Invalid request body" };
  const { tenantId, suggestionId, action, editedPrice } = raw as Record<string, unknown>;
  if (typeof tenantId !== "string" || tenantId.trim() === "") return { error: "tenantId is required" };
  if (typeof suggestionId !== "string" || suggestionId.trim() === "") return { error: "suggestionId is required" };
  if (typeof action !== "string" || !ACTIONS.includes(action as RecsAction)) {
    return { error: "action must be approve, reject, or revert" };
  }
  if (editedPrice !== undefined && editedPrice !== null) {
    if (action !== "approve") return { error: "editedPrice is only valid with approve" };
    if (typeof editedPrice !== "number" || !Number.isFinite(editedPrice) || editedPrice <= 0) {
      return { error: "editedPrice must be a positive number" };
    }
  }
  return {
    body: {
      tenantId: tenantId.trim(),
      suggestionId: suggestionId.trim(),
      action: action as RecsAction,
      editedPrice: typeof editedPrice === "number" ? editedPrice : null
    }
  };
}

/**
 * POST /api/recs/action — approve / reject / revert a single night.
 * Internal-only; the acting email is always the gated session's email.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const auth = await getInternalRecsAuth();
  if (!auth) return new NextResponse("Not found", { status: 404 });

  const raw = await request.json().catch(() => null);
  const { body, error } = parseBody(raw);
  if (!body) return NextResponse.json({ error: error ?? "Invalid request body" }, { status: 400 });

  try {
    const args = { tenantId: body.tenantId, suggestionId: body.suggestionId, actorEmail: auth.email };
    const result =
      body.action === "approve"
        ? await approveSuggestion({ ...args, editedPrice: body.editedPrice })
        : body.action === "reject"
          ? await rejectSuggestion(args)
          : await revertSuggestionPush(args);
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: "Action failed" }, { status: 500 });
  }
}
