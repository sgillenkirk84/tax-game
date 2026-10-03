import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { getTeacherAuthorization } from "@/lib/teacher-auth";
import { createStudentSupabaseClient } from "@/lib/student-supabase";
import { createClient } from "@/utils/supabase/server";

type PlayerRow = {
  id: string;
  display_name: string;
  created_at: string;
};

type RegistrationResult = {
  id: string;
  name: string;
  session_code: string;
  joined_at: string;
};

function toStudent(row: PlayerRow, sessionCode: string) {
  return {
    id: row.id,
    name: row.display_name,
    sessionCode,
    joinedAt: row.created_at,
  };
}

export async function GET(request: Request) {
  const authorization = await getTeacherAuthorization();
  if (!authorization.ok) {
    return Response.json({ error: authorization.message }, { status: authorization.status });
  }

  const sessionCode = new URL(request.url).searchParams.get("sessionCode")?.trim().toUpperCase();
  if (!sessionCode) {
    return Response.json({ error: "A session code is required." }, { status: 400 });
  }

  const supabase = createClient(await cookies());
  const { data: session, error: sessionError } = await supabase
    .from("TEACHER_game_sessions")
    .select("id")
    .eq("session_code", sessionCode)
    .maybeSingle();

  if (sessionError) {
    return Response.json({ error: "Could not retrieve this classroom." }, { status: 500 });
  }
  if (!session) {
    return Response.json({ error: "That session code does not exist." }, { status: 404 });
  }

  const { data: players, error: playersError } = await supabase
    .from("00_players")
    .select("id,display_name,created_at")
    .eq("session_id", session.id)
    .order("created_at", { ascending: true })
    .limit(200);

  if (playersError) {
    return Response.json({ error: "Could not retrieve this classroom roster." }, { status: 500 });
  }

  return Response.json((players as PlayerRow[]).map((player) => toStudent(player, sessionCode)));
}

export async function POST(request: Request) {
  let body: { sessionCode?: unknown; name?: unknown };
  try {
    body = (await request.json()) as { sessionCode?: unknown; name?: unknown };
  } catch {
    return Response.json({ error: "Invalid registration details." }, { status: 400 });
  }

  const sessionCode = typeof body.sessionCode === "string" ? body.sessionCode.trim().toUpperCase() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!sessionCode || !name) {
    return Response.json({ error: "Enter a classroom code and display name." }, { status: 400 });
  }

  const supabase = createStudentSupabaseClient();
  if (!supabase) {
    return Response.json({ error: "Student registration is not configured yet." }, { status: 503 });
  }

  const resumeToken = randomBytes(32).toString("base64url");
  const resumeTokenHash = createHash("sha256").update(resumeToken).digest("hex");

  try {
    const { data, error } = await supabase.rpc("register_student", {
      p_session_code: sessionCode,
      p_name: name,
      p_resume_token_hash: resumeTokenHash,
    });

    if (error) {
      if (error.code === "22023") {
        return Response.json({ error: "Enter a valid classroom code and a name of 1 to 80 characters." }, { status: 400 });
      }
      if (error.message.includes("SESSION_NOT_FOUND")) {
        return Response.json({ error: "That session code does not exist." }, { status: 404 });
      }
      if (error.message.includes("SESSION_NOT_OPEN")) {
        return Response.json({ error: "This classroom is not open for registration." }, { status: 409 });
      }
      if (error.message.includes("SESSION_FULL")) {
        return Response.json({ error: "This classroom is full. Please ask the teacher for a new code." }, { status: 409 });
      }
      return Response.json({ error: "Could not register for this classroom." }, { status: 500 });
    }

    const player = (data as RegistrationResult[] | null)?.[0];
    if (!player) {
      return Response.json({ error: "Registration did not return a player record." }, { status: 500 });
    }

    return Response.json(
      {
        id: player.id,
        name: player.name,
        sessionCode: player.session_code,
        joinedAt: player.joined_at,
        resumeToken,
      },
      { status: 201 }
    );
  } catch {
    return Response.json({ error: "Could not reach student registration storage." }, { status: 503 });
  }
}
