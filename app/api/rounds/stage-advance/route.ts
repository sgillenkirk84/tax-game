import { isCardStage } from "@/lib/card-entry";
import { readStudentCredentials } from "@/lib/student-credentials";
import { createStudentSupabaseClient } from "@/lib/student-supabase";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type AdvanceRow = {
  result_round_number: number;
  result_from_stage: string;
  result_current_stage: string;
  replayed: boolean;
};

const rpcErrors: Array<[string, number, string]> = [
  ["PLAYER_SETUP_NOT_AVAILABLE", 403, "Could not verify this player session."],
  ["INVALID_STAGE_REQUEST", 400, "Invalid request."],
  ["GAME_LIFE_NOT_ACTIVE", 409, "Your game is not open for this step."],
  ["NOT_CURRENT_STAGE", 409, "You have already moved on from this stage. Refresh to see where you are."],
  ["STAGE_NOT_SUPPORTED", 409, "Moving on from this stage is not available yet."],
  ["STAGE_CARDS_INCOMPLETE", 409, "Save your card before you continue."],
  ["IDEMPOTENCY_KEY_REUSED", 409, "This request was already used for something else. Try again."],
];

// Authenticated, idempotent stage advance. The browser sends only the round,
// the stage it is leaving and a retry key. The database verifies credentials,
// the active life, the current round and stage and the saved-card minimum, and
// it alone chooses the next stage. Nothing is advanced automatically.
export async function POST(request: Request) {
  if (
    process.env.CARD_ENTRY_ENABLED !== "true" ||
    process.env.CARD_SAVE_ENABLED !== "true" ||
    process.env.STAGE_ADVANCE_ENABLED !== "true"
  ) {
    return Response.json({ error: "Moving to the next stage is not available yet." }, { status: 404 });
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
    !isCardStage(body.stage) ||
    typeof body.round !== "number" ||
    !Number.isInteger(body.round) ||
    typeof body.idempotencyKey !== "string" ||
    !uuidPattern.test(body.idempotencyKey)
  ) {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  const supabase = createStudentSupabaseClient();
  if (!supabase) {
    return Response.json({ error: "Student progress storage is not configured yet." }, { status: 503 });
  }

  try {
    const { data, error } = await supabase.rpc("advance_round_stage", {
      p_player_id: credentials.playerId,
      p_resume_token_hash: credentials.resumeTokenHash,
      p_round_number: body.round,
      p_from_stage: body.stage,
      p_idempotency_key: body.idempotencyKey.toLowerCase(),
    });

    if (error) {
      const known = rpcErrors.find(([code]) => error.message.includes(code));
      if (known) {
        return Response.json({ error: known[2] }, { status: known[1] });
      }
      if (error.code === "PGRST202" || error.code === "42883") {
        return Response.json({ error: "Moving to the next stage is not ready yet." }, { status: 503 });
      }
      return Response.json({ error: "Could not move to the next stage." }, { status: 500 });
    }

    const row = (data as AdvanceRow[] | null)?.[0];
    if (!row) {
      return Response.json({ error: "Could not move to the next stage." }, { status: 500 });
    }

    return Response.json({
      advanced: {
        round: row.result_round_number,
        fromStage: row.result_from_stage,
        currentStage: row.result_current_stage,
        replayed: row.replayed,
      },
    });
  } catch {
    return Response.json({ error: "Could not reach student progress storage." }, { status: 503 });
  }
}