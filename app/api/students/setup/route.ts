import { createHash } from "node:crypto";
import { createStudentSupabaseClient } from "@/lib/student-supabase";

type SetupRow = {
  pathway_id: string | null;
  starting_decision_id: string | null;
  status: "joined" | "playing";
};

const roleIds = new Set([
  "PATH-001",
  "PATH-002",
  "PATH-003",
  "PATH-004",
  "PATH-005",
  "PATH-006",
  "PATH-007",
  "PATH-008",
]);
const decisionIds = new Set(["take-opportunity", "play-safe", "adapt-quickly"]);
const playerIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const resumeTokenPattern = /^[A-Za-z0-9_-]{43}$/;

function readPlayerCredentials(body: Record<string, unknown>) {
  if (
    typeof body.id !== "string" ||
    !playerIdPattern.test(body.id) ||
    typeof body.resumeToken !== "string" ||
    !resumeTokenPattern.test(body.resumeToken)
  ) {
    return null;
  }

  return {
    playerId: body.id,
    resumeTokenHash: createHash("sha256").update(body.resumeToken).digest("hex"),
  };
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function setupResponse(row: SetupRow | undefined) {
  if (!row) {
    return Response.json({ error: "Could not verify this player session." }, { status: 500 });
  }

  return Response.json({
    pathwayId: row.pathway_id,
    startingDecisionId: row.starting_decision_id,
    status: row.status,
  });
}

function handleSetupError(error: { code?: string; message: string }, operation: "load" | "save") {
  if (error.message.includes("PLAYER_SETUP_NOT_AVAILABLE")) {
    return Response.json({ error: "Could not verify this player session." }, { status: 403 });
  }
  if (error.message.includes("PATHWAY_ALREADY_SET") || error.message.includes("STARTING_DECISION_ALREADY_SET")) {
    return Response.json({ error: "This starting choice has already been saved." }, { status: 409 });
  }
  if (error.message.includes("SETUP_INCOMPLETE")) {
    return Response.json({ error: "Choose a role and draw a starting decision before continuing." }, { status: 400 });
  }
  if (error.code === "PGRST202" || error.code === "42883") {
    return Response.json({ error: "Student progress storage is not ready yet." }, { status: 503 });
  }
  return Response.json(
    { error: operation === "load" ? "Could not load this player's saved setup." : "Could not save this player's setup." },
    { status: 500 }
  );
}

export async function POST(request: Request) {
  const body = await readBody(request);
  const credentials = body && readPlayerCredentials(body);
  if (!credentials) {
    return Response.json({ error: "Invalid player session." }, { status: 400 });
  }

  const supabase = createStudentSupabaseClient();
  if (!supabase) {
    return Response.json({ error: "Student progress storage is not configured yet." }, { status: 503 });
  }

  try {
    const { data, error } = await supabase.rpc("load_student_setup", {
      p_player_id: credentials.playerId,
      p_resume_token_hash: credentials.resumeTokenHash,
    });
    if (error) {
      return handleSetupError(error, "load");
    }

    return setupResponse((data as SetupRow[] | null)?.[0]);
  } catch {
    return Response.json({ error: "Could not reach student progress storage." }, { status: 503 });
  }
}

export async function PUT(request: Request) {
  const body = await readBody(request);
  const credentials = body && readPlayerCredentials(body);
  if (!credentials) {
    return Response.json({ error: "Invalid player session." }, { status: 400 });
  }

  const pathwayId = body.pathwayId;
  const startingDecisionId = body.startingDecisionId;
  const setupComplete = body.setupComplete;
  if (
    (pathwayId !== null && (typeof pathwayId !== "string" || !roleIds.has(pathwayId))) ||
    (startingDecisionId !== null &&
      (typeof startingDecisionId !== "string" || !decisionIds.has(startingDecisionId))) ||
    typeof setupComplete !== "boolean"
  ) {
    return Response.json({ error: "Invalid starting setup details." }, { status: 400 });
  }

  const supabase = createStudentSupabaseClient();
  if (!supabase) {
    return Response.json({ error: "Student progress storage is not configured yet." }, { status: 503 });
  }

  try {
    const { data, error } = await supabase.rpc("save_student_setup", {
      p_player_id: credentials.playerId,
      p_resume_token_hash: credentials.resumeTokenHash,
      p_pathway_id: pathwayId,
      p_starting_decision_id: startingDecisionId,
      p_setup_complete: setupComplete,
    });
    if (error) {
      return handleSetupError(error, "save");
    }

    return setupResponse((data as SetupRow[] | null)?.[0]);
  } catch {
    return Response.json({ error: "Could not reach student progress storage." }, { status: 503 });
  }
}
