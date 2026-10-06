import { serverRoundEnabled } from "@/lib/round-limits";
import { readStudentCredentials } from "@/lib/student-credentials";
import { createServiceSupabaseClient } from "@/lib/service-supabase";
import { buildRoundTaxCalculation, type RoundTaxSnapshot } from "@/lib/round-tax";
import { summarizeTaxCalculation } from "@/lib/tax-summary";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const rpcErrors: Array<[string, number, string]> = [
  ["PLAYER_SETUP_NOT_AVAILABLE", 403, "Could not verify this player session."],
  ["GAME_LIFE_NOT_ACTIVE", 409, "Your game is not active."],
  ["NOT_CURRENT_STAGE", 409, "Tax is calculated after the Deduction stage."],
  ["STAGE_NOT_SUPPORTED", 409, "Tax calculation is not available for this round yet."],
  ["INCOMPLETE_ROUND", 409, "Your round is missing a saved card."],
  ["IDEMPOTENCY_KEY_REUSED", 409, "This request was already used for a different calculation."],
];

// Backend-only shared tax calculation. The browser sends credentials, the round
// and a retry key; every amount is rebuilt server-side from saved gameplay history.
// Disabled by default; it does not change the stage or finalize the round.
export async function POST(request: Request) {
  if (process.env.TAX_CALCULATION_ENABLED !== "true") {
    return Response.json({ error: "Tax calculation is not available yet." }, { status: 404 });
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
  if (
    !body ||
    !credentials ||
    typeof body.round !== "number" ||
    !Number.isInteger(body.round) ||
    typeof body.idempotencyKey !== "string" ||
    !uuidPattern.test(body.idempotencyKey)
  ) {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  if (!serverRoundEnabled(body.round) || body.round > 5) {
    return Response.json({ error: "This round is not available yet." }, { status: 409 });
  }

  const supabase = createServiceSupabaseClient();
  if (!supabase) {
    return Response.json({ error: "Tax calculation storage is not configured yet." }, { status: 503 });
  }

  const mapError = (message: string, code?: string) => {
    const known = rpcErrors.find(([name]) => message.includes(name));
    if (known) {
      return Response.json({ error: known[2] }, { status: known[1] });
    }
    if (code === "PGRST202" || code === "42883") {
      return Response.json({ error: "Tax calculation is not ready yet." }, { status: 503 });
    }
    return Response.json({ error: "Could not calculate your tax." }, { status: 500 });
  };

  try {
    const inputs = await supabase.rpc("get_round_tax_inputs", {
      p_player_id: credentials.playerId,
      p_resume_token_hash: credentials.resumeTokenHash,
    });
    if (inputs.error) {
      return mapError(inputs.error.message, inputs.error.code);
    }
    const snapshot = inputs.data as RoundTaxSnapshot | null;
    if (!snapshot || snapshot.round.round_number !== body.round) {
      return Response.json({ error: "That is not the current round." }, { status: 409 });
    }

    // A stored calculation is returned as-is; it is never recomputed or applied twice.
    if (snapshot.round.calculation) {
      const stored = summarizeTaxCalculation(snapshot.round.calculation);
      return stored
        ? Response.json({ summary: stored, replayed: true })
        : Response.json({ error: "Could not calculate your tax." }, { status: 500 });
    }

    const built = buildRoundTaxCalculation(snapshot);
    if (!built.ok) {
      return Response.json({ error: "Your round is not ready to calculate.", code: built.code }, { status: 422 });
    }

    const saved = await supabase.rpc("save_round_tax_result", {
      p_player_id: credentials.playerId,
      p_resume_token_hash: credentials.resumeTokenHash,
      p_round_number: body.round,
      p_idempotency_key: body.idempotencyKey.toLowerCase(),
      p_calculation: built.calculation,
    });
    if (saved.error) {
      return mapError(saved.error.message, saved.error.code);
    }

    const response = saved.data as { replayed: boolean; calculation: unknown } | null;
    if (!response) {
      return Response.json({ error: "Could not calculate your tax." }, { status: 500 });
    }
    const summary = summarizeTaxCalculation(response.calculation);
    if (!summary) {
      return Response.json({ error: "Could not calculate your tax." }, { status: 500 });
    }
    return Response.json({ summary, replayed: response.replayed });
  } catch {
    return Response.json({ error: "Could not reach student progress storage." }, { status: 503 });
  }
}
