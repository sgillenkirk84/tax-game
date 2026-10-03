"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { createClient } from "@/utils/supabase/client";
import { useTeacherName } from "./teacher-identity";

type ApiSessionRecord = {
  id: string;
  name: string;
  code: string;
  seat_count: number;
  created_at: string;
};

type StudentEntry = {
  id: string;
  name: string;
  sessionCode: string;
  joinedAt: string;
};

type SessionRecord = {
  id: string;
  name: string;
  code: string;
  seatCount: number;
  createdAt: string;
};

async function fetchSessionsFromApi(): Promise<SessionRecord[]> {
  const response = await fetch("/api/sessions", { cache: "no-store" });
  const result = (await response.json()) as ApiSessionRecord[] | { error?: string };

  if (!response.ok) {
    throw new Error(
      (result as { error?: string }).error ?? "Could not load classroom sessions."
    );
  }

  if (!Array.isArray(result)) {
    throw new Error("The session list response was invalid.");
  }

  return result.map((session) => ({
    id: session.id,
    name: session.name,
    code: session.code,
    seatCount: session.seat_count,
    createdAt: session.created_at,
  }));
}

function chooseSession(sessionList: SessionRecord[], preferredSessionId?: string): SessionRecord | undefined {
  return (
    sessionList.find((session) => session.id === preferredSessionId) ??
    sessionList.find((session) => session.name.trim().toLowerCase() === "beta 2026") ??
    sessionList[0]
  );
}

export default function TeacherPage() {
  const router = useRouter();
  const teacherName = useTeacherName();
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [sessionName, setSessionName] = useState("Beta 2026");
  const [seatCount, setSeatCount] = useState(30);
  const [sessionCode, setSessionCode] = useState("");
  const [students, setStudents] = useState<StudentEntry[]>([]);
  const [message, setMessage] = useState("Create a session to get a shareable code.");
  const [sessionsError, setSessionsError] = useState("");

  useEffect(() => {
    let isCurrent = true;

    async function loadSessions() {
      try {
        const sessionList = await fetchSessionsFromApi();
        if (!isCurrent) {
          return;
        }

        const selectedSession = chooseSession(sessionList);
        setSessions(sessionList);
        setSessionsError("");

        if (selectedSession) {
          setActiveSessionId(selectedSession.id);
          setSessionName(selectedSession.name);
          setSeatCount(selectedSession.seatCount);
          setSessionCode(selectedSession.code);
        } else {
          setActiveSessionId("");
          setSessionCode("");
          setStudents([]);
        }
      } catch (error) {
        if (isCurrent) {
          setSessionsError(
            `Could not load classroom sessions. ${
              error instanceof Error ? error.message : "Check your connection and try again."
            }`
          );
        }
      }
    }

    void loadSessions();
    return () => {
      isCurrent = false;
    };
  }, []);

  useEffect(() => {
    if (!sessionCode) {
      return;
    }

    let isCurrent = true;
    async function refreshStudents() {
      try {
        const response = await fetch(`/api/students?sessionCode=${encodeURIComponent(sessionCode)}`);
        const result = (await response.json()) as StudentEntry[] | { error?: string };

        if (!isCurrent) {
          return;
        }
        if (!response.ok) {
          setMessage((result as { error?: string }).error ?? "Could not load this session roster.");
          return;
        }

        setStudents(result as StudentEntry[]);
      } catch {
        if (isCurrent) {
          setMessage("Could not reach shared registration storage.");
        }
      }
    }

    void refreshStudents();
    const refreshTimer = window.setInterval(refreshStudents, 5000);

    return () => {
      isCurrent = false;
      window.clearInterval(refreshTimer);
    };
  }, [sessionCode]);

  async function handleCreateSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedSessionName = sessionName.trim() || "Beta 2026";
    const cleanedSeatCount = Math.max(1, Number(seatCount) || 30);
    let createdSession: SessionRecord | null = null;

    try {
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmedSessionName, seatCount: cleanedSeatCount }),
      });
      const result = (await response.json()) as SessionRecord | { error?: string };

      if (!response.ok) {
        setMessage((result as { error?: string }).error ?? "Could not create this session.");
        return;
      }

      createdSession = result as SessionRecord;
    } catch {
      setMessage("Could not reach shared registration storage. Check your connection and try again.");
      return;
    }

    try {
      const sessionList = await fetchSessionsFromApi();
      const selectedSession = chooseSession(sessionList, createdSession.id);
      setSessions(sessionList);
      setSessionsError("");

      if (!selectedSession) {
        throw new Error("The created session was not returned by the session list.");
      }

      setActiveSessionId(selectedSession.id);
      setSessionName(selectedSession.name);
      setSeatCount(selectedSession.seatCount);
      setSessionCode(selectedSession.code);
      setStudents([]);
      setMessage(`Session ${trimmedSessionName} created. Share code ${createdSession.code} with students.`);
    } catch (error) {
      setSessionsError(
        `Session was created, but the session list could not be refreshed. ${
          error instanceof Error ? error.message : "Check your connection and try again."
        }`
      );
    }
  }

  function selectSession(sessionId: string) {
    const selected = sessions.find((session) => session.id === sessionId);

    if (!selected) {
      return;
    }

    setActiveSessionId(sessionId);
    setSessionName(selected.name);
    setSeatCount(selected.seatCount);
    setSessionCode(selected.code);
    setMessage(`Viewing session ${selected.name}.`);
  }

  async function handleLogout() {
    const { error } = await createClient().auth.signOut();

    if (error) {
      setMessage("Could not log out. Please try again.");
      return;
    }

    router.replace("/teacher/login");
    router.refresh();
  }

  const currentSessionStudents = students.filter((student) => student.sessionCode === sessionCode);
  const filledSeats = currentSessionStudents.length;
  const remainingSeats = activeSessionId ? Math.max(seatCount - filledSeats, 0) : 0;

  return (
    <main className="min-h-screen bg-[var(--brand-navy-deep)] text-[var(--brand-ivory)]">
      <div className="mx-auto max-w-7xl px-6 py-10">
        <div className="mb-8 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-black uppercase tracking-[0.25em] text-[var(--brand-gold)]">
              Money Moves · Teacher Dashboard
            </p>
            <h1 className="mt-2 text-3xl font-black text-white sm:text-4xl">
              Beta Session Control
            </h1>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-3">
            <span className="text-sm text-[var(--brand-ivory)]/80">Signed in as {teacherName}</span>
            <button
              type="button"
              onClick={handleLogout}
              className="rounded-xl border border-[var(--brand-gold)]/60 bg-[var(--brand-navy)] px-4 py-2 font-bold text-[var(--brand-ivory)] transition hover:bg-[var(--brand-navy)]/80"
            >
              Log Out
            </button>
            <Link
              href="/"
              className="rounded-xl border border-[var(--brand-gold)]/60 bg-[var(--brand-navy)] px-4 py-2 font-bold text-[var(--brand-ivory)] transition hover:bg-[var(--brand-navy)]/80"
            >
              Back to Home
            </Link>
          </div>
        </div>

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-[0_10px_30px_rgba(0,0,0,0.18)]">
            <div className="text-sm uppercase tracking-[0.2em] text-[var(--brand-gold)]/80">
              Session Name
            </div>
            <div className="mt-3 text-2xl font-black text-white">
              {activeSessionId ? sessionName : "No session selected"}
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-[0_10px_30px_rgba(0,0,0,0.18)]">
            <div className="text-sm uppercase tracking-[0.2em] text-[var(--brand-gold)]/80">
              Students Joined
            </div>
            <div className="mt-3 text-3xl font-black text-white">{filledSeats}</div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-[0_10px_30px_rgba(0,0,0,0.18)]">
            <div className="text-sm uppercase tracking-[0.2em] text-[var(--brand-gold)]/80">
              Seats Left
            </div>
            <div className="mt-3 text-3xl font-black text-white">{remainingSeats}</div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-[0_10px_30px_rgba(0,0,0,0.18)]">
            <div className="text-sm uppercase tracking-[0.2em] text-[var(--brand-gold)]/80">
              Total Seats
            </div>
            <div className="mt-3 text-3xl font-black text-white">{activeSessionId ? seatCount : 0}</div>
          </div>
        </section>

        <section className="mt-8 grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
            <h2 className="text-xl font-black text-white">Create Session</h2>

            <div className="mt-5 mb-5">
              <label htmlFor="sessionSelect" className="mb-2 block text-sm font-bold text-[var(--brand-ivory)]">
                Select Session
              </label>
              <select
                id="sessionSelect"
                value={activeSessionId}
                onChange={(event) => selectSession(event.target.value)}
                className="w-full rounded-xl border border-white/15 bg-[var(--brand-navy)] px-4 py-3 text-white outline-none transition focus:border-[var(--brand-gold)]"
              >
                {sessions.length === 0 ? (
                  <option value="" disabled>
                    No saved sessions yet
                  </option>
                ) : null}
                {sessions.map((session) => (
                  <option key={session.id} value={session.id}>
                    {session.name}
                  </option>
                ))}
              </select>
            </div>

            {sessionsError ? (
              <div className="mb-5 rounded-xl border border-red-400/50 bg-red-950/40 p-4 text-sm text-red-100">
                {sessionsError}
              </div>
            ) : null}

            <form onSubmit={handleCreateSession} className="space-y-5">
              <div>
                <label htmlFor="sessionName" className="mb-2 block text-sm font-bold text-[var(--brand-ivory)]">
                  New Session Name
                </label>
                <input
                  id="sessionName"
                  type="text"
                  value={sessionName}
                  onChange={(event) => setSessionName(event.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-[var(--brand-navy)] px-4 py-3 text-white outline-none transition focus:border-[var(--brand-gold)]"
                />
              </div>

              <div>
                <label htmlFor="seatCount" className="mb-2 block text-sm font-bold text-[var(--brand-ivory)]">
                  Number of Seats
                </label>
                <input
                  id="seatCount"
                  type="number"
                  min={1}
                  max={200}
                  value={seatCount}
                  onChange={(event) => setSeatCount(Number(event.target.value) || 1)}
                  className="w-full rounded-xl border border-white/15 bg-[var(--brand-navy)] px-4 py-3 text-white outline-none transition focus:border-[var(--brand-gold)]"
                />
              </div>

              <button
                type="submit"
                className="w-full rounded-xl bg-[var(--brand-gold)] px-4 py-3 font-black text-[var(--brand-navy)] transition hover:brightness-105"
              >
                Create Session
              </button>
            </form>

            {message ? (
              <div className="mt-5 rounded-xl border border-[var(--brand-gold)]/40 bg-[var(--brand-navy)]/70 p-4 text-sm text-[var(--brand-ivory)]">
                {message}
              </div>
            ) : null}
          </div>

          <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
            <h2 className="text-xl font-black text-white">Session Code</h2>
            <div className="mt-6 rounded-2xl border border-[var(--brand-gold)]/50 bg-[var(--brand-navy)] p-6 text-center shadow-[0_10px_25px_rgba(216,184,102,0.2)]">
              <p className="text-xs font-black uppercase tracking-[0.25em] text-[var(--brand-gold)]">
                Active Code
              </p>
              <div className="mt-4 text-4xl font-black tracking-[0.18em] text-white">
                {sessionCode}
              </div>
            </div>

            <div className="mt-6 rounded-xl border border-white/10 bg-black/10 p-4 text-sm text-[var(--brand-ivory)]/85">
              <div className="font-bold text-white">Session access code</div>
              <div className="mt-2">
                This is the private join code. Students enter it to access the session, like a password for their assigned classroom license.
              </div>
            </div>
          </div>
        </section>

        <section className="mt-8 rounded-2xl border border-white/10 bg-white/5 p-6">
          <div className="mb-5 flex items-center justify-between">
            <h2 className="text-xl font-black text-white">Student Roster</h2>
            <span className="rounded-full border border-[var(--brand-gold)]/50 bg-[var(--brand-gold)]/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.15em] text-[var(--brand-gold)]">
              {activeSessionId ? sessionName : "No session selected"}
            </span>
          </div>

          <div className="overflow-hidden rounded-xl border border-white/10">
            <table className="w-full border-collapse text-left text-sm">
              <thead className="bg-[var(--brand-navy)] text-[var(--brand-ivory)]">
                <tr>
                  <th className="px-4 py-3 font-bold">Student</th>
                  <th className="px-4 py-3 font-bold">Session</th>
                  <th className="px-4 py-3 font-bold">Joined</th>
                </tr>
              </thead>
              <tbody>
                {currentSessionStudents.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-4 py-6 text-center text-[var(--brand-ivory)]/70">
                      No students have joined this session yet.
                    </td>
                  </tr>
                ) : (
                  currentSessionStudents.map((student) => (
                    <tr key={student.id} className="border-t border-white/10 bg-transparent text-[var(--brand-ivory)]">
                      <td className="px-4 py-3">{student.name}</td>
                      <td className="px-4 py-3">{student.sessionCode}</td>
                      <td className="px-4 py-3">{new Date(student.joinedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}
