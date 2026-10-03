import "server-only";

import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";

export type TeacherAuthorization =
  | { ok: true; userId: string; teacherName: string }
  | { ok: false; status: 401 | 403 | 500; message: string };

export async function getTeacherAuthorization(): Promise<TeacherAuthorization> {
  try {
    const supabase = createClient(await cookies());
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return { ok: false, status: 401, message: "Sign in with a teacher account." };
    }

    const { data: teacher, error: teacherError } = await supabase
      .from("teacher_admins")
      .select("teacher_name")
      .eq("user_id", user.id)
      .maybeSingle();

    if (teacherError) {
      return { ok: false, status: 500, message: "Could not verify teacher access." };
    }

    if (!teacher?.teacher_name) {
      return { ok: false, status: 403, message: "This account is not registered as a teacher." };
    }

    return { ok: true, userId: user.id, teacherName: teacher.teacher_name };
  } catch {
    return { ok: false, status: 500, message: "Could not verify teacher access." };
  }
}