import { serverRoundEnabled } from "@/lib/round-limits";
import type { CardPreview } from "@/lib/card-entry";
import { expectedCategoryFor, isCardStage, recordedChoiceFrom, stageCardRules } from "@/lib/card-entry";
import { listDeckCards, lookupCard } from "@/lib/card-lookup";
import { loadRoundState } from "@/lib/round-state";
import { readStudentCredentials } from "@/lib/student-credentials";
import { createStudentSupabaseClient } from "@/lib/student-supabase";

// Authenticated, read-only list of the approved cards in the student's current
// deck, so they can pick the card they physically drew. The round, stage and
// deck come from the database, never from the client, and nothing is saved.
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
    !isCardStage(body.stage) ||
    typeof body.round !== "number" ||
    !Number.isInteger(body.round)
  ) {
    return Response.json({ error: "Invalid card entry." }, { status: 400 });
  }

  if (!serverRoundEnabled(body.round as number)) {
    return Response.json({ error: "This round is not available yet." }, { status: 409 });
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

  const category = expectedCategoryFor(body.stage, state.pathway_id, state.life_current_round);
  // Cards already saved for this round and stage (with any recorded choice),
  // read through the same credential check. If the read RPC is not installed
  // yet, show none; the save RPC still enforces the stage limit.
  const savedCards: CardPreview[] = [];
  let savedCount = 0;
  try {
    const { data, error } = await supabase.rpc("get_round_progress", {
      p_player_id: credentials.playerId,
      p_resume_token_hash: credentials.resumeTokenHash,
    });
    if (error) {
      if (error.code !== "PGRST202" && error.code !== "42883") {
        return Response.json({ error: "Could not load your saved card." }, { status: 500 });
      }
    } else {
      const rows = ((data as { card_id: string; stage: string; order_in_stage: number; choices: unknown }[] | null) ?? [])
        .filter((row) => row.stage === state.round_current_stage)
        .sort((a, b) => a.order_in_stage - b.order_in_stage);
      savedCount = rows.length;
      for (const row of rows) {
        const found = lookupCard(row.card_id, category);
        if (found.ok) {
          savedCards.push({ ...found.card, recordedChoice: recordedChoiceFrom(row.card_id, row.choices) });
        }
      }
    }
  } catch {
    return Response.json({ error: "Could not load your saved card." }, { status: 503 });
  }

  const rules = stageCardRules(body.stage, state.pathway_id, state.life_current_round);
  return Response.json({
    category,
    cards: listDeckCards(category),
    savedCards,
    minCards: rules.min,
    maxCards: rules.max,
    limitReached: rules.max > 0 && savedCount >= rules.max,
  });
}
