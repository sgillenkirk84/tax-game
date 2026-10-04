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
// the browser. That RPC reports Round 1 only; later rounds need a dedicated
// state RPC.
export async function loadRoundState(
  supabase: StudentSupabase,
  credentials: { playerId: string; resumeTokenHash: string },
): Promise<RoundStateResult> {
  const fail = (error: string, status: number): RoundStateResult => ({
    ok: false,
    response: Response.json({ error }, { status }),
  });

  let state: RoundStateRow | undefined;
  try {
    const { data, error } = await supabase.rpc("start_or_resume_round_one", {
      p_player_id: credentials.playerId,
      p_resume_token_hash: credentials.resumeTokenHash,
    });
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
  if (state.life_status !== "in_progress" || state.round_status !== "in_progress" || state.life_current_round !== 1) {
    return fail("Card entry is not open for your current round yet.", 409);
  }
  return { ok: true, state };
}