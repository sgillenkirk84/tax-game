"use client";

import { createContext, useContext, type ReactNode } from "react";

const TeacherIdentityContext = createContext<string | null>(null);

export function TeacherIdentityProvider({
  teacherName,
  children,
}: {
  teacherName: string;
  children: ReactNode;
}) {
  return (
    <TeacherIdentityContext.Provider value={teacherName}>
      {children}
    </TeacherIdentityContext.Provider>
  );
}

export function useTeacherName() {
  const teacherName = useContext(TeacherIdentityContext);
  if (!teacherName) {
    throw new Error("Teacher identity is not available.");
  }
  return teacherName;
}