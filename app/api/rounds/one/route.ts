import { createHash } from "node:crypto";
import { createStudentSupabaseClient } from "@/lib/student-supabase";

type RoundOneRow = {
  pathway_id: string;
  starting_decision_id: string;
  round_status: string;
  round_current_stage: string;
  beginning_cash_resources: number | string;
  beginning_student_loan_debt: number | string;
};

const playerIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const resumeTokenPattern = /^[A-Za-z0-9_-]{43}$/;

export async function POST(request: Request) {
  // Gameplay is only available where the RPC is installed and this flag is set explicitly.
  if (process.env.ROUND_ONE_ENABLED !== "true") {
    return Response.json({ error: "Round 1 is not available yet." }, { status: 404 });
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

  if (
    !body ||
    typeof body.id !== "string" ||
    !playerIdPattern.test(body.id) ||
    typeof body.resumeToken !== "string" ||
    !resumeTokenPattern.test(body.resumeToken)
  ) {
    return Response.json({ error: "Invalid player session." }, { status: 400 });
  }

  const supabase = createStudentSupabaseClient();
  if (!supabase) {
    return Response.json({ error: "Student progress storage is not configured yet." }, { status: 503 });
  }

  try {
    const { data, error } = await supabase.rpc("start_or_resume_round_one", {
      p_player_id: body.id,
      p_resume_token_hash: createHash("sha256").update(body.resumeToken).digest("hex"),
    });

    if (error) {
      if (error.message.includes("PLAYER_SETUP_NOT_AVAILABLE")) {
        return Response.json({ error: "Could not verify this player session." }, { status: 403 });
      }
      if (error.message.includes("SETUP_INCOMPLETE")) {
        return Response.json({ error: "Finish your starting setup before starting Round 1." }, { status: 400 });
      }
      if (error.code === "PGRST202" || error.code === "42883") {
        return Response.json({ error: "Round 1 is not ready yet." }, { status: 503 });
      }
      return Response.json({ error: "Could not start Round 1." }, { status: 500 });
    }

    const row = (data as RoundOneRow[] | null)?.[0];
    if (!row) {
      return Response.json({ error: "Could not start Round 1." }, { status: 500 });
    }

    return Response.json({
      pathwayId: row.pathway_id,
      scenarioId: row.starting_decision_id,
      roundStatus: row.round_status,
      currentStage: row.round_current_stage,
      roundNumber: 1,
      totalRounds: 5,
      startingCash: Number(row.beginning_cash_resources),
      startingStudentLoanDebt: Number(row.beginning_student_loan_debt),
    });
  } catch {
    return Response.json({ error: "Could not reach student progress storage." }, { status: 503 });
  }
}
