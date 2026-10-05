import { readStudentCredentials } from "@/lib/student-credentials";
import { createServiceSupabaseClient } from "@/lib/service-supabase";
import { cardNamesFor } from "@/lib/card-names";
import { computeRoundResults, summarizeStoredResults, toFinalizePayload } from "@/lib/round-results";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const rpcErrors: Array<[string, number, string]> = [
  ["PLAYER_SETUP_NOT_AVAILABLE", 403, "Could not verify this player session."],
  ["GAME_LIFE_NOT_ACTIVE", 409, "Your game is not active."],
  ["NOT_CURRENT_STAGE", 409, "Your round is not at Results yet."],
  ["STAGE_NOT_SUPPORTED", 409, "Results are not available for this round yet."],
  ["TAX_CALCULATION_REQUIRED", 409, "Calculate your taxes first."],
  ["PREPAYMENT_REQUIRED", 409, "Fix your Tax Prepayment first."],
  ["IDEMPOTENCY_KEY_REUSED", 409, "This request was already used for something else. Try again."],
  ["RESULTS_MISMATCH", 409, "Your Results could not be verified. Please refresh and try again."],
  ["INCONSISTENT_ROUND_STATE", 409, "Your round could not be verified. Please ask your teacher for help."],
];

const num = (value: unknown): number => Number(value);

// Finalizes Round 1. The browser sends credentials, the round and a retry key.
// Every amount is rebuilt from saved round data on the server and the database
// verifies it again before changing anything. A finalized round is returned
// unchanged, so refreshing or retrying can never apply the Results twice.
export async function POST(request: Request) {
  if (process.env.ROUND_RESULTS_ENABLED !== "true") {
    return Response.json({ error: "Results are not available yet." }, { status: 404 });
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

  const supabase = createServiceSupabaseClient();
  if (!supabase) {
    return Response.json({ error: "Results storage is not configured yet." }, { status: 503 });
  }

  const mapError = (message: string, code?: string) => {
    const known = rpcErrors.find(([name]) => message.includes(name));
    if (known) {
      return Response.json({ error: known[2] }, { status: known[1] });
    }
    if (code === "PGRST202" || code === "42883") {
      return Response.json({ error: "Results are not ready yet." }, { status: 503 });
    }
    return Response.json({ error: "Could not finish your round." }, { status: 500 });
  };

  try {
    const read = await supabase.rpc("get_round_results", {
      p_player_id: credentials.playerId,
      p_resume_token_hash: credentials.resumeTokenHash,
      p_round_number: body.round,
    });
    if (read.error) {
      return mapError(read.error.message, read.error.code);
    }
    const current = read.data as {
      finalized?: boolean;
      inputs?: Record<string, unknown> | null;
    } | null;

    if (current?.finalized) {
      const results = summarizeStoredResults(current);
      return results
        ? Response.json({ results, replayed: true, cardNames: cardNamesFor(results.cards.map((c) => c.cardId)) })
        : Response.json({ error: "Could not finish your round." }, { status: 500 });
    }
    const inputs = current?.inputs;
    if (!inputs) {
      return Response.json({ error: "Your round is not ready for Results." }, { status: 409 });
    }

    let payload: Record<string, number>;
    try {
      payload = toFinalizePayload(
        computeRoundResults({
          beginningCash: num(inputs.beginning_cash),
          beginningDebt: num(inputs.beginning_student_loan_debt),
          grossIncome: num(inputs.gross_income),
          adjustedGrossIncome: num(inputs.adjusted_gross_income),
          finalTax: num(inputs.final_tax_liability),
          fixedPrepayment: num(inputs.fixed_tax_prepayment),
          pendingEffects: inputs.pending_effects,
        }),
      );
    } catch {
      return Response.json({ error: "Your round is not ready for Results." }, { status: 422 });
    }

    const saved = await supabase.rpc("finalize_round_results", {
      p_player_id: credentials.playerId,
      p_resume_token_hash: credentials.resumeTokenHash,
      p_round_number: body.round,
      p_idempotency_key: body.idempotencyKey.toLowerCase(),
      p_results: payload,
    });
    if (saved.error) {
      return mapError(saved.error.message, saved.error.code);
    }
    const response = saved.data as { replayed?: boolean } | null;
    const results = summarizeStoredResults(response);
    if (!results) {
      return Response.json({ error: "Could not finish your round." }, { status: 500 });
    }
    return Response.json({ results, replayed: response?.replayed === true, cardNames: cardNamesFor(results.cards.map((c) => c.cardId)) });
  } catch {
    return Response.json({ error: "Could not reach student progress storage." }, { status: 503 });
  }
}
