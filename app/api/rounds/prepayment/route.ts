import { lookupCard } from "@/lib/card-lookup";
import { readStudentCredentials } from "@/lib/student-credentials";
import { createServiceSupabaseClient } from "@/lib/service-supabase";
import { summarizePrepayment } from "@/lib/tax-prepayment";
import { serverRoundEnabled } from "@/lib/round-limits";

// Read-only recovery of the Tax Prepayment state after a refresh. It never
// writes. It uses the service-only get_round_prepayment RPC, which verifies the
// student's credentials, and returns only a student-safe summary.
export async function POST(request: Request) {
  if (process.env.TAX_PREPAYMENT_ENABLED !== "true") {
    return Response.json({ available: false, state: null });
  }

  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await request.json();
    body = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    body = null;
  }

  const credentials = body && readStudentCredentials(body);
  if (!body || !credentials || typeof body.round !== "number" || !Number.isInteger(body.round)) {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }
  if (!serverRoundEnabled(body.round) || body.round > 5) {
    return Response.json({ error: "Tax Prepayment is not available for this round yet." }, { status: 409 });
  }

  const supabase = createServiceSupabaseClient();
  if (!supabase) {
    return Response.json({ error: "Tax Prepayment storage is not configured yet." }, { status: 503 });
  }

  try {
    const { data, error } = await supabase.rpc("get_round_prepayment", {
      p_player_id: credentials.playerId,
      p_resume_token_hash: credentials.resumeTokenHash,
    });
    if (error) {
      const unavailable = error.code === "PGRST202" || error.code === "42883";
      return Response.json(
        { error: unavailable ? "Tax Prepayment is not ready yet." : "Could not load your Tax Prepayment." },
        { status: unavailable ? 503 : error.message.includes("PLAYER_SETUP_NOT_AVAILABLE") ? 403 : 500 },
      );
    }
    if ((data as { round_number?: number } | null)?.round_number !== body.round) {
      return Response.json({ available: true, state: null });
    }
    const state = summarizePrepayment(data);
    // Card names and descriptions come from the approved dataset, not the browser.
    const details: Record<string, { name: string; description: string }> = {};
    for (const id of new Set(state?.cards.map((item) => item.cardId) ?? [])) {
      const found = lookupCard(id, "Tax Prepayment");
      if (found.ok) {
        details[id] = { name: found.card.name, description: found.card.description };
      }
    }
    return Response.json({ available: true, state, details });
  } catch {
    return Response.json({ error: "Could not reach student progress storage." }, { status: 503 });
  }
}
