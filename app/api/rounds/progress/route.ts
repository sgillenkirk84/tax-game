import { expectedCategoryFor, isCardStage, recordedChoiceFrom, type CardPreview, type CardStage } from "@/lib/card-entry";
import { lookupCard } from "@/lib/card-lookup";
import { loadRoundState } from "@/lib/round-state";
import { ROUND_FLOW } from "@/lib/round-stages";
import { readStudentCredentials } from "@/lib/student-credentials";
import { createStudentSupabaseClient } from "@/lib/student-supabase";

type ProgressRow = { card_id: string; stage: string; order_in_stage: number; choices: unknown };

// Authenticated, read-only dashboard state: the current stage from the
// database and the cards already saved in each stage of the current round.
// Saved-card records are the only source; nothing is calculated or written.
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
  if (!credentials) {
    return Response.json({ error: "Invalid player session." }, { status: 400 });
  }

  const supabase = createStudentSupabaseClient();
  if (!supabase) {
    return Response.json({ error: "Student progress storage is not configured yet." }, { status: 503 });
  }

  const loaded = await loadRoundState(supabase, credentials);
  if (!loaded.ok) {
    return loaded.response;
  }
  const { state } = loaded;

  const saved = new Map<CardStage, CardPreview[]>();
  try {
    const { data, error } = await supabase.rpc("get_round_progress", {
      p_player_id: credentials.playerId,
      p_resume_token_hash: credentials.resumeTokenHash,
    });
    if (error) {
      // If the read RPC is not installed yet, show the stage with no history.
      if (error.code !== "PGRST202" && error.code !== "42883") {
        return Response.json({ error: "Could not load your progress." }, { status: 500 });
      }
    } else {
      const rows = ((data as ProgressRow[] | null) ?? []).sort((a, b) => a.order_in_stage - b.order_in_stage);
      for (const row of rows) {
        if (!isCardStage(row.stage)) {
          continue;
        }
        const category = expectedCategoryFor(row.stage, state.pathway_id, state.life_current_round);
        const found = lookupCard(row.card_id, category);
        if (found.ok) {
          const card = { ...found.card, recordedChoice: recordedChoiceFrom(row.card_id, row.choices) };
          saved.set(row.stage, [...(saved.get(row.stage) ?? []), card]);
        }
      }
    }
  } catch {
    return Response.json({ error: "Could not reach student progress storage." }, { status: 503 });
  }

  const stages = ROUND_FLOW.flatMap((step) =>
    isCardStage(step.id) && saved.has(step.id) ? [{ stage: step.id, cards: saved.get(step.id) ?? [] }] : [],
  );

  return Response.json({
    roundNumber: state.life_current_round,
    currentStage: state.round_current_stage,
    stages,
  });
}