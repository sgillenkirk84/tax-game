import { cookies } from "next/headers";
import { getTeacherAuthorization } from "@/lib/teacher-auth";
import { createClient } from "@/utils/supabase/server";

type ImportInput = {
  id?: unknown;
  name?: unknown;
  code?: unknown;
  seatCount?: unknown;
};

type ValidSession = {
  id: string;
  name: string;
  code: string;
  seatCount: number;
};

type ImportResult = {
  index: number;
  id: string;
  name: string;
  code: string;
  seatCount: number | null;
  status: "imported" | "skipped" | "rejected";
  message: string;
};

function parseSession(value: unknown):
  | { session: ValidSession; input: ImportInput }
  | { errors: string[]; input: ImportInput } {
  const input =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as ImportInput)
      : {};
  const errors: string[] = [];
  const id = typeof input.id === "string" ? input.id.trim() : "";
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const originalCode = typeof input.code === "string" ? input.code.trim() : "";
  const code = originalCode.toUpperCase();
  const seatCount = input.seatCount;

  if (!/^[A-Za-z0-9-]{1,128}$/.test(id)) {
    errors.push("Session ID must contain 1–128 letters, digits, or hyphens.");
  }
  if (!name || name.length > 80) {
    errors.push("Session name must contain 1–80 characters.");
  }
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    errors.push("Session code must contain exactly six letters or digits.");
  }
  if (typeof seatCount !== "number" || !Number.isInteger(seatCount) || seatCount < 1 || seatCount > 200) {
    errors.push("Seat count must be an integer from 1 to 200.");
  }

  if (errors.length > 0) {
    return { errors, input };
  }

  return {
    session: { id, name, code, seatCount: seatCount as number },
    input,
  };
}

function toResultInput(input: ImportInput, index: number): ImportResult {
  return {
    index,
    id: typeof input.id === "string" ? input.id : "",
    name: typeof input.name === "string" ? input.name : "",
    code: typeof input.code === "string" ? input.code : "",
    seatCount: typeof input.seatCount === "number" ? input.seatCount : null,
    status: "rejected",
    message: "",
  };
}

export async function POST(request: Request) {
  const authorization = await getTeacherAuthorization();
  if (!authorization.ok) {
    return Response.json({ error: authorization.message }, { status: authorization.status });
  }

  let body: { sessions?: unknown };
  try {
    body = (await request.json()) as { sessions?: unknown };
  } catch {
    return Response.json({ error: "Invalid import details." }, { status: 400 });
  }

  if (!Array.isArray(body.sessions) || body.sessions.length === 0 || body.sessions.length > 100) {
    return Response.json({ error: "Provide between 1 and 100 sessions to import." }, { status: 400 });
  }

  const parsed = body.sessions.map(parseSession);
  const results = body.sessions.map(toResultInput);
  const idCounts = new Map<string, number>();
  const codeCounts = new Map<string, number>();

  for (const item of parsed) {
    const id = typeof item.input.id === "string" ? item.input.id.trim().toLowerCase() : "";
    const code = typeof item.input.code === "string" ? item.input.code.trim().toUpperCase() : "";
    if (/^[A-Za-z0-9-]{1,128}$/.test(id)) {
      idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
    }
    if (/^[A-Z0-9]{6}$/.test(code)) {
      codeCounts.set(code, (codeCounts.get(code) ?? 0) + 1);
    }
  }

  for (const [index, item] of parsed.entries()) {
    const result = results[index];
    if ("errors" in item) {
      result.message = item.errors.join(" ");
      continue;
    }

    if (idCounts.get(item.session.id.toLowerCase())! > 1) {
      result.message = "Duplicate session ID in the import list.";
      continue;
    }
    if (codeCounts.get(item.session.code)! > 1) {
      result.message = "Duplicate session code in the import list.";
      continue;
    }
  }

  const supabase = createClient(await cookies());
  const { data: existingSessions, error: fetchError } = await supabase
    .from("TEACHER_game_sessions")
    .select("id,session_code");

  if (fetchError) {
    return Response.json({ error: fetchError.message }, { status: 500 });
  }

  const existingIds = new Set(existingSessions.map((session) => String(session.id).toLowerCase()));
  const existingCodes = new Set(existingSessions.map((session) => String(session.session_code).toUpperCase()));

  for (const [index, item] of parsed.entries()) {
    const result = results[index];
    if (result.message) {
      continue;
    }
    if ("errors" in item) {
      continue;
    }

    if (existingIds.has(item.session.id.toLowerCase())) {
      result.status = "skipped";
      result.message = "A session with this ID already exists.";
      continue;
    }
    if (existingCodes.has(item.session.code)) {
      result.status = "skipped";
      result.message = "A session with this code already exists.";
      continue;
    }

    const { error } = await supabase.from("TEACHER_game_sessions").insert({
      id: item.session.id,
      session_code: item.session.code,
      session_name: item.session.name,
      seat_count: item.session.seatCount,
    });

    if (error) {
      if (error.code === "23505") {
        result.status = "skipped";
        result.message = "A session with this ID or code already exists.";
      } else {
        result.message = `Database rejected this session: ${error.message}`;
      }
      continue;
    }

    result.status = "imported";
    result.message = "Session imported.";
    existingIds.add(item.session.id.toLowerCase());
    existingCodes.add(item.session.code);
  }

  return Response.json({ results });
}
