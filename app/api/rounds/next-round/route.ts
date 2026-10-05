import { serverMaxEnabledRound } from "@/lib/round-limits";
import { authorizeNextRound } from "@/lib/round-rules";
import type { RoundStateRow } from "@/lib/round-state";
import { readStudentCredentials } from "@/lib/student-credentials";
import { createStudentSupabaseClient } from "@/lib/student-supabase";
import { createServiceSupabaseClient } from "@/lib/service-supabase";

export const runtime = "nodejs";

type StartedRoundRow = RoundStateRow & {
  starting_decision_id: string;
  beginning_cash_resources: number | string;
  beginning_student_loan_debt: number | string;
  replayed: boolean;
};

const rpcErrors: Array<[string, number, string]> = [
  ["PLAYER_SETUP_NOT_AVAILABLE", 403, "Could not verify this player session."],
  ["GAME_LIFE_NOT_ACTIVE", 409, "Your game is not active."],
  ["NOT_CURRENT_STAGE", 409, "You have already moved on. Refresh to see your current round."],
  ["PREVIOUS_ROUND_NOT_FINALIZED", 409, "Finish your current round before starting the next round."],
  ["STAGE_NOT_SUPPORTED", 409, "This round is not supported yet."],
  ["ROUND_NOT_ENABLED", 409, "This round is not available yet."],
];

function mapError(message: string, code?: string) {
  const known = rpcErrors.find(([name]) => message.includes(name));
  if (known) {
    return Response.json({ error: known[2] }, { status: known[1] });
  }
  if (code === "PGRST202" || code === "42883") {
    return Response.json({ error: "Starting the next round is not ready yet." }, { status: 503 });
  }
  return Response.json({ error: "Could not start the next round." }, { status: 500 });
}

export async function POST(request: Request) {
  if (process.env.ROUND_ONE_ENABLED !== "true" || process.env.ROUND_RESULTS_ENABLED !== "true") {
    return Response.json({ error: "Starting the next round is not available yet." }, { status: 404 });
  }

  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await request.json();
    body = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }
  const credentials = body && readStudentCredentials(body);
  if (!body || !credentials || typeof body.round !== "number" || !Number.isInteger(body.round)) {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }
  const maxEnabledRound = serverMaxEnabledRound();
  if (body.round < 2 || body.round > 3) {
    return mapError("STAGE_NOT_SUPPORTED");
  }
  if (body.round > maxEnabledRound) {
    return mapError("ROUND_NOT_ENABLED");
  }

  const student = createStudentSupabaseClient();
  const service = createServiceSupabaseClient();
  if (!student || !service) {
    return Response.json({ error: "Student progress storage is not configured yet." }, { status: 503 });
  }

  const args = {
    p_player_id: credentials.playerId,
    p_resume_token_hash: credentials.resumeTokenHash,
  };
  try {
    // Read without the card-entry helper: finalized rounds must be accepted, not resumed or created.
    const current = await student.rpc("get_current_round_state", args);
    if (current.error) {
      return mapError(current.error.message, current.error.code);
    }
    const state = (current.data as RoundStateRow[] | null)?.[0];
    if (!state) {
      return Response.json({ error: "Could not check your current round." }, { status: 500 });
    }
    const target = authorizeNextRound(state, body.round, maxEnabledRound);
    if (!target.ok) {
      return mapError(target.code);
    }

    // The RPC locks and revalidates state, including concurrent requests and retries.
    const saved = await service.rpc("start_next_round", {
      ...args,
      p_round_number: target.roundNumber,
    });
    if (saved.error) {
      return mapError(saved.error.message, saved.error.code);
    }
    const row = (saved.data as StartedRoundRow[] | null)?.[0];
    if (!row || row.life_current_round !== target.roundNumber) {
      return Response.json({ error: "Could not start the next round." }, { status: 500 });
    }
    return Response.json({
      started: true,
      replayed: row.replayed,
      roundNumber: row.life_current_round,
      pathwayId: row.pathway_id,
      scenarioId: row.starting_decision_id,
      roundStatus: row.round_status,
      currentStage: row.round_current_stage,
      startingCash: Number(row.beginning_cash_resources),
      startingStudentLoanDebt: Number(row.beginning_student_loan_debt),
      totalRounds: 5,
    });
  } catch {
    return Response.json({ error: "Could not reach student progress storage." }, { status: 503 });
  }
}
