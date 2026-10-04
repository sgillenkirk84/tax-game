import { expectedCategoryFor, isCardStage } from "@/lib/card-entry";
import { listDeckCards } from "@/lib/card-lookup";
import { readStudentCredentials } from "@/lib/student-credentials";
import { createStudentSupabaseClient } from "@/lib/student-supabase";

type RoundStateRow = {
  pathway_id: string;
  life_status: string;
  life_current_round: number;
  round_status: string;
  round_current_stage: string;
};

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

  const supabase = createStudentSupabaseClient();
  if (!supabase) {
    return Response.json({ error: "Student progress storage is not configured yet." }, { status: 503 });
  }

  let state: RoundStateRow | undefined;
  try {
    const { data, error } = await supabase.rpc("start_or_resume_round_one", {
      p_player_id: credentials.playerId,
      p_resume_token_hash: credentials.resumeTokenHash,
    });
    if (error) {
      if (error.message.includes("PLAYER_SETUP_NOT_AVAILABLE")) {
        return Response.json({ error: "Could not verify this player session." }, { status: 403 });
      }
      if (error.message.includes("SETUP_INCOMPLETE")) {
        return Response.json({ error: "Finish your starting setup first." }, { status: 400 });
      }
      if (error.code === "PGRST202" || error.code === "42883") {
        return Response.json({ error: "Round 1 is not ready yet." }, { status: 503 });
      }
      return Response.json({ error: "Could not check your round." }, { status: 500 });
    }
    state = (data as RoundStateRow[] | null)?.[0];
  } catch {
    return Response.json({ error: "Could not reach student progress storage." }, { status: 503 });
  }

  if (!state) {
    return Response.json({ error: "Could not check your round." }, { status: 500 });
  }

  // That RPC reports Round 1 only; later rounds need a dedicated state RPC.
  if (state.life_status !== "in_progress" || state.round_status !== "in_progress" || state.life_current_round !== 1) {
    return Response.json({ error: "Card entry is not open for your current round yet." }, { status: 409 });
  }
  if (body.round !== state.life_current_round || body.stage !== state.round_current_stage) {
    return Response.json({ error: "That is not the current stage of your round." }, { status: 409 });
  }

  const category = expectedCategoryFor(body.stage, state.pathway_id, state.life_current_round);
  return Response.json({ category, cards: listDeckCards(category) });
}
