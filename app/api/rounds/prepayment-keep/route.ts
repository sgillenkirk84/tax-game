import { readStudentCredentials } from "@/lib/student-credentials";
import { createStudentSupabaseClient } from "@/lib/student-supabase";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const rpcErrors: Array<[string, number, string]> = [
  ["PLAYER_SETUP_NOT_AVAILABLE", 403, "Could not verify this player session."],
  ["INVALID_CARD_REQUEST", 400, "Invalid request."],
  ["GAME_LIFE_NOT_ACTIVE", 409, "Your game is not open for this step."],
  ["NOT_CURRENT_STAGE", 409, "That is not the current stage of your round."],
  ["STAGE_NOT_SUPPORTED", 409, "Tax Prepayment is not available for this round yet."],
  ["PREPAYMENT_ALREADY_FIXED", 409, "Your Tax Prepayment card is already final."],
  ["REDRAW_NOT_ALLOWED", 409, "You have no redraw decision to make."],
  ["IDEMPOTENCY_KEY_REUSED", 409, "This request was already used for something else. Try again."],
];

// Lets an eligible Corporate Climber keep the first Tax Prepayment card. The
// browser sends only the round and a retry key; the database verifies
// eligibility and fixes the prepayment from the saved tax and the card's rate.
export async function POST(request: Request) {
  if (
    process.env.CARD_ENTRY_ENABLED !== "true" ||
    process.env.CARD_SAVE_ENABLED !== "true" ||
    process.env.TAX_PREPAYMENT_ENABLED !== "true"
  ) {
    return Response.json({ error: "Tax Prepayment is not available yet." }, { status: 404 });
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

  const supabase = createStudentSupabaseClient();
  if (!supabase) {
    return Response.json({ error: "Student progress storage is not configured yet." }, { status: 503 });
  }

  try {
    const { data, error } = await supabase.rpc("keep_round_prepayment_card", {
      p_player_id: credentials.playerId,
      p_resume_token_hash: credentials.resumeTokenHash,
      p_round_number: body.round,
      p_idempotency_key: body.idempotencyKey.toLowerCase(),
    });

    if (error) {
      const known = rpcErrors.find(([code]) => error.message.includes(code));
      if (known) {
        return Response.json({ error: known[2] }, { status: known[1] });
      }
      if (error.code === "PGRST202" || error.code === "42883") {
        return Response.json({ error: "Tax Prepayment is not ready yet." }, { status: 503 });
      }
      return Response.json({ error: "Could not keep your card." }, { status: 500 });
    }

    const result = data as { replayed?: boolean } | null;
    return Response.json({ kept: true, replayed: result?.replayed === true });
  } catch {
    return Response.json({ error: "Could not reach student progress storage." }, { status: 503 });
  }
}
