import { serverRoundEnabled } from "@/lib/round-limits";
import type { createStudentSupabaseClient } from "@/lib/student-supabase";

export type RoundStateRow = {
  pathway_id: string;
  life_status: string;
  life_current_round: number;
  round_status: string;
  round_current_stage: string;
};

type StudentSupabase = NonNullable<ReturnType<typeof createStudentSupabaseClient>>;

export type RoundStateResult =
  | { ok: true; state: RoundStateRow }
  | { ok: false; response: Response };

// Authoritative round state for a verified student. Authentication, the active
// life and the current round and stage all come from the database, never from
// the browser. get_current_round_state reports the current round (1 to 3); when it
// is not installed yet, or the student has no life yet, the Round 1 start RPC is used.
export async function loadRoundState(
  supabase: StudentSupabase,
  credentials: { playerId: string; resumeTokenHash: string },
): Promise<RoundStateResult> {
  const fail = (error: string, status: number): RoundStateResult => ({
    ok: false,
    response: Response.json({ error }, { status }),
  });

  let state: RoundStateRow | undefined;
  const args = { p_player_id: credentials.playerId, p_resume_token_hash: credentials.resumeTokenHash };
  try {
    let result = await supabase.rpc("get_current_round_state", args);
    if (
      result.error &&
      (result.error.code === "PGRST202" ||
        result.error.code === "42883" ||
        result.error.message.includes("GAME_LIFE_NOT_ACTIVE"))
    ) {
      result = await supabase.rpc("start_or_resume_round_one", args);
    }
    const { data, error } = result;
    if (error) {
      if (error.message.includes("PLAYER_SETUP_NOT_AVAILABLE")) {
        return fail("Could not verify this player session.", 403);
      }
      if (error.message.includes("SETUP_INCOMPLETE")) {
        return fail("Finish your starting setup first.", 400);
      }
      if (error.code === "PGRST202" || error.code === "42883") {
        return fail("Round 1 is not ready yet.", 503);
      }
      return fail("Could not check your round.", 500);
    }
    state = (data as RoundStateRow[] | null)?.[0];
  } catch {
    return fail("Could not reach student progress storage.", 503);
  }

  if (!state) {
    return fail("Could not check your round.", 500);
  }
  if (!serverRoundEnabled(state.life_current_round)) {
    return fail("This round is not open yet.", 409);
  }
  if (state.life_status !== "in_progress" || state.round_status !== "in_progress") {
    return fail("Card entry is not open for your current round yet.", 409);
  }
  return { ok: true, state };
}