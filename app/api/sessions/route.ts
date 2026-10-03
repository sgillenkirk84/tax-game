import { cookies } from "next/headers";
import { getTeacherAuthorization } from "@/lib/teacher-auth";
import { createClient } from "@/utils/supabase/server";

type SessionRow = {
  id: string;
  session_name: string;
  session_code: string;
  seat_count: number;
  created_at: string;
};

function toSessionResponse(row: SessionRow) {
  return {
    id: row.id,
    name: row.session_name,
    code: row.session_code,
    seat_count: row.seat_count,
    created_at: row.created_at,
  };
}

function toCreatedSessionResponse(row: SessionRow) {
  return {
    id: row.id,
    name: row.session_name,
    code: row.session_code,
    seatCount: row.seat_count,
    createdAt: row.created_at,
  };
}

function generateCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const numbers = "23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));

  return Array.from(bytes, (byte, index) => {
    const alphabet = index < 3 ? letters : numbers;
    return alphabet[byte % alphabet.length];
  }).join("");
}

export async function GET(request: Request) {
  const authorization = await getTeacherAuthorization();
  if (!authorization.ok) {
    return Response.json({ error: authorization.message }, { status: authorization.status });
  }

  const code = new URL(request.url).searchParams.get("code")?.trim().toUpperCase();

  const supabase = createClient(await cookies());
  const sessionsQuery = supabase
    .from("TEACHER_game_sessions")
    .select("id,session_name,session_code,seat_count,created_at");

  if (!code) {
    const { data: sessions, error } = await sessionsQuery.order("created_at", { ascending: false });

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json((sessions as SessionRow[]).map(toSessionResponse));
  }

  const { data: session, error } = await sessionsQuery.eq("session_code", code).maybeSingle();

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  if (!session) {
    return Response.json({ error: "That session code does not exist." }, { status: 404 });
  }

  return Response.json(toSessionResponse(session as SessionRow));
}

export async function POST(request: Request) {
  const authorization = await getTeacherAuthorization();
  if (!authorization.ok) {
    return Response.json({ error: authorization.message }, { status: authorization.status });
  }

  let body: { name?: unknown; seatCount?: unknown };
  try {
    body = (await request.json()) as { name?: unknown; seatCount?: unknown };
  } catch {
    return Response.json({ error: "Invalid session details." }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const seatCount = Number(body.seatCount);
  if (!name || name.length > 80 || !Number.isInteger(seatCount) || seatCount < 1 || seatCount > 200) {
    return Response.json({ error: "Enter a session name and between 1 and 200 seats." }, { status: 400 });
  }

  const supabase = createClient(await cookies());
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { data: session, error } = await supabase
      .from("TEACHER_game_sessions")
      .insert({
        session_name: name,
        session_code: generateCode(),
        seat_count: seatCount,
      })
      .select("id,session_name,session_code,seat_count,created_at")
      .single();

    if (!error) {
      return Response.json(toCreatedSessionResponse(session as SessionRow), { status: 201 });
    }

    if (error.code !== "23505" || attempt === 3) {
      return Response.json(
        { error: error.message },
        { status: error.code === "23505" ? 409 : 500 }
      );
    }
  }

  return Response.json({ error: "Could not create a unique session code. Try again." }, { status: 500 });
}