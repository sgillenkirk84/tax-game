import {
  cardIdPattern,
  expectedCategoryFor,
  isCardStage,
  isRoundCardStageAvailable,
  normalizeCardId,
} from "@/lib/card-entry";
import { lookupCard } from "@/lib/card-lookup";
import { loadRoundState } from "@/lib/round-state";
import { readStudentCredentials } from "@/lib/student-credentials";
import { createStudentSupabaseClient } from "@/lib/student-supabase";

// Authenticated, read-only preview of an approved card. It saves nothing and
// returns only card-face information. The round, stage and pathway come from
// the database, never from the client.
export async function POST(request: Request) {
  if (process.env.CARD_ENTRY_ENABLED !== "true") {
    return Response.json({ error: "Card entry is not available yet." }, { status: 404 });
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
    !isCardStage(body.stage) ||
    typeof body.round !== "number" ||
    !Number.isInteger(body.round)
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

  const loaded = await loadRoundState(supabase, credentials);
  if (!loaded.ok) {
    return loaded.response;
  }
  const state = loaded.state;
  if (body.round !== state.life_current_round || body.stage !== state.round_current_stage) {
    return Response.json({ error: "That is not the current stage of your round." }, { status: 409 });
  }
  if (!isRoundCardStageAvailable(body.stage, state.life_current_round)) {
    return Response.json({ error: "Card entry is not available for this stage yet." }, { status: 409 });
  }

  const expectedCategory = expectedCategoryFor(body.stage, state.pathway_id, state.life_current_round);
  if (body.expectedCategory !== expectedCategory) {
    return Response.json({ error: "That is not the current stage of your round." }, { status: 409 });
  }

  const result = lookupCard(cardId, expectedCategory);
  if (!result.ok) {
    const article = /^[AEIOU]/.test(expectedCategory) ? "an" : "a";
    return Response.json(
      {
        error:
          result.reason === "not-found"
            ? "That card ID was not found. Check the ID printed on your card."
            : `That is not ${article} ${expectedCategory} card. Draw from the ${expectedCategory} deck.`,
      },
      { status: 422 }
    );
  }

  return Response.json({ card: result.card });
}