import { serverRoundEnabled } from "@/lib/round-limits";
import { readStudentCredentials } from "@/lib/student-credentials";
import { createServiceSupabaseClient } from "@/lib/service-supabase";
import { summarizeTaxCalculation } from "@/lib/tax-summary";

// Read-only recovery of an already saved Round tax calculation after a refresh.
// It never calculates or writes. It reuses the student-authenticated, service-only
// get_round_tax_inputs RPC and returns only the student-safe summary.
export async function POST(request: Request) {
  if (process.env.TAX_CALCULATION_ENABLED !== "true") {
    return Response.json({ available: false, summary: null });
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

  if (!serverRoundEnabled(body.round) || body.round > 4) {
    return Response.json({ error: "This round is not available yet." }, { status: 409 });
  }

  const supabase = createServiceSupabaseClient();
  if (!supabase) {
    return Response.json({ error: "Tax calculation storage is not configured yet." }, { status: 503 });
  }

  try {
    const { data, error } = await supabase.rpc("get_round_tax_inputs", {
      p_player_id: credentials.playerId,
      p_resume_token_hash: credentials.resumeTokenHash,
    });
    if (error) {
      const unavailable = error.code === "PGRST202" || error.code === "42883";
      return Response.json(
        { error: unavailable ? "Tax calculation is not ready yet." : "Could not load your tax result." },
        { status: unavailable ? 503 : 500 },
      );
    }
    const round = (data as { round?: { round_number?: number; calculation?: unknown } } | null)?.round;
    if (!round || round.round_number !== body.round) {
      return Response.json({ available: true, summary: null });
    }
    return Response.json({ available: true, summary: summarizeTaxCalculation(round.calculation) });
  } catch {
    return Response.json({ error: "Could not reach student progress storage." }, { status: 503 });
  }
}
