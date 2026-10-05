import { readStudentCredentials } from "@/lib/student-credentials";
import { createServiceSupabaseClient } from "@/lib/service-supabase";
import { cardNamesFor } from "@/lib/card-names";
import { resultsAvailableForRound, summarizeStoredResults } from "@/lib/round-results";
import { serverMaxEnabledRound } from "@/lib/round-limits";

// Read-only restore of a finalized Round Results page. It never writes. It uses
// the service-only get_round_results RPC, which verifies the student's
// credentials, and returns only a student-safe summary.
export async function POST(request: Request) {
  if (process.env.ROUND_RESULTS_ENABLED !== "true") {
    return Response.json({ available: false, finalized: false });
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
  if (!body || !credentials || typeof body.round !== "number" || !Number.isInteger(body.round)) {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }
  if (!resultsAvailableForRound(body.round, serverMaxEnabledRound())) {
    return Response.json({ error: "Results are not available for this round yet." }, { status: 409 });
  }

  const supabase = createServiceSupabaseClient();
  if (!supabase) {
    return Response.json({ error: "Results storage is not configured yet." }, { status: 503 });
  }

  try {
    const { data, error } = await supabase.rpc("get_round_results", {
      p_player_id: credentials.playerId,
      p_resume_token_hash: credentials.resumeTokenHash,
      p_round_number: body.round,
    });
    if (error) {
      const unavailable = error.code === "PGRST202" || error.code === "42883";
      return Response.json(
        { error: unavailable ? "Results are not ready yet." : "Could not load your Results." },
        { status: unavailable ? 503 : error.message.includes("PLAYER_SETUP_NOT_AVAILABLE") ? 403 : 500 },
      );
    }
    const stored = data as { finalized?: boolean; inputs?: unknown } | null;
    if (stored?.finalized) {
      const results = summarizeStoredResults(stored);
      return results
        ? Response.json({ available: true, finalized: true, results, cardNames: cardNamesFor(results.cards.map((c) => c.cardId)) })
        : Response.json({ error: "Could not load your Results." }, { status: 500 });
    }
    return Response.json({ available: true, finalized: false, ready: stored?.inputs != null });
  } catch {
    return Response.json({ error: "Could not reach student progress storage." }, { status: 503 });
  }
}
