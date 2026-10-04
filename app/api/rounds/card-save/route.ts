import {
  cardIdPattern,
  isCardStage,
  normalizeCardId,
} from "@/lib/card-entry";
import { readStudentCredentials } from "@/lib/student-credentials";
import { createStudentSupabaseClient } from "@/lib/student-supabase";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SavedCardRow = {
  card_history_id: string;
  card_id: string;
  deck: string;
  stage: string;
  round_number: number;
  order_in_stage: number;
  replayed: boolean;
};

const rpcErrors: Array<[string, number, string]> = [
  ["PLAYER_SETUP_NOT_AVAILABLE", 403, "Could not verify this player session."],
  ["INVALID_CARD_REQUEST", 400, "Invalid card entry."],
  ["GAME_LIFE_NOT_ACTIVE", 409, "Card entry is not open for your game."],
  ["NOT_CURRENT_STAGE", 409, "That is not the current stage of your round."],
  ["STAGE_NOT_SUPPORTED", 409, "Saving cards is not available for this stage yet."],
  ["STAGE_CARD_LIMIT_REACHED", 409, "A card has already been saved for this stage."],
  ["CARD_NOT_FOUND", 422, "That card ID was not found. Check the ID printed on your card."],
  ["CARD_WRONG_DECK", 422, "That card is from a different deck. Draw from the deck for this stage."],
  ["IDEMPOTENCY_KEY_REUSED", 409, "This save request was already used for a different card. Try again."],
];

// Authenticated save of a physical card. The browser sends only the card ID,
// the stage it believes it is on and a retry key; the database validates the
// round, stage, deck and card, and no amounts are accepted or stored here.
export async function POST(request: Request) {
  if (process.env.CARD_ENTRY_ENABLED !== "true" || process.env.CARD_SAVE_ENABLED !== "true") {
    return Response.json({ error: "Saving cards is not available yet." }, { status: 404 });
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
    typeof body.cardId !== "string" ||
    typeof body.expectedCategory !== "string" ||
    !isCardStage(body.stage) ||
    typeof body.round !== "number" ||
    !Number.isInteger(body.round) ||
    typeof body.idempotencyKey !== "string" ||
    !uuidPattern.test(body.idempotencyKey)
  ) {
    return Response.json({ error: "Invalid card entry." }, { status: 400 });
  }

  const cardId = normalizeCardId(body.cardId);
  if (!cardIdPattern.test(cardId)) {
    return Response.json({ error: "Card IDs use letters, numbers and dashes, like INC-W2-001." }, { status: 400 });
  }

  const supabase = createStudentSupabaseClient();
  if (!supabase) {
    return Response.json({ error: "Student progress storage is not configured yet." }, { status: 503 });
  }

  try {
    const { data, error } = await supabase.rpc("record_round_card", {
      p_player_id: credentials.playerId,
      p_resume_token_hash: credentials.resumeTokenHash,
      p_round_number: body.round,
      p_stage: body.stage,
      p_expected_deck: body.expectedCategory,
      p_card_id: cardId,
      p_idempotency_key: body.idempotencyKey.toLowerCase(),
    });

    if (error) {
      const known = rpcErrors.find(([code]) => error.message.includes(code));
      if (known) {
        return Response.json({ error: known[2] }, { status: known[1] });
      }
      if (error.code === "PGRST202" || error.code === "42883") {
        return Response.json({ error: "Saving cards is not ready yet." }, { status: 503 });
      }
      return Response.json({ error: "Could not save your card." }, { status: 500 });
    }

    const saved = (data as SavedCardRow[] | null)?.[0];
    if (!saved) {
      return Response.json({ error: "Could not save your card." }, { status: 500 });
    }

    return Response.json({
      saved: {
        id: saved.card_id,
        category: saved.deck,
        stage: saved.stage,
        round: saved.round_number,
        orderInStage: saved.order_in_stage,
        replayed: saved.replayed,
      },
    });
  } catch {
    return Response.json({ error: "Could not reach student progress storage." }, { status: 503 });
  }
}
