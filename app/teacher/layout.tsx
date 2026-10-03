import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getTeacherAuthorization } from "@/lib/teacher-auth";
import { TeacherIdentityProvider } from "./teacher-identity";

export const dynamic = "force-dynamic";

export default async function TeacherLayout({ children }: { children: ReactNode }) {
  const authorization = await getTeacherAuthorization();

  if (!authorization.ok) {
    if (authorization.status === 401) {
      redirect("/teacher/login");
    }
    if (authorization.status === 403) {
      redirect("/teacher/login?reason=not-teacher");
    }

    throw new Error(authorization.message);
  }

  return (
    <TeacherIdentityProvider teacherName={authorization.teacherName}>
      {children}
    </TeacherIdentityProvider>
  );
}