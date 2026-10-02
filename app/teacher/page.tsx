"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";

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

const SESSIONS_KEY = "my-tax-life-sessions";
const ACTIVE_SESSION_KEY = "my-tax-life-active-session";
const STUDENT_STORAGE_KEY = "my-tax-life-students";
const LEGACY_SESSION_KEY = "my-tax-life-session";

function generateCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const numbers = "23456789";
  const chars: string[] = [];

  for (let index = 0; index < 3; index += 1) {
    chars.push(letters[Math.floor(Math.random() * letters.length)]);
  }

  for (let index = 0; index < 3; index += 1) {
    chars.push(numbers[Math.floor(Math.random() * numbers.length)]);
  }

  return chars.join("");
}

function getSessionsFromStorage(): SessionRecord[] {
  const savedSessions = window.localStorage.getItem(SESSIONS_KEY);

  if (savedSessions) {
    try {
      const parsed = JSON.parse(savedSessions) as SessionRecord[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    } catch {
      window.localStorage.removeItem(SESSIONS_KEY);
    }
  }

  const legacySession = window.localStorage.getItem(LEGACY_SESSION_KEY);

  if (legacySession) {
    try {
      const parsed = JSON.parse(legacySession) as SessionRecord;
      const migrated = [parsed];
      window.localStorage.setItem(SESSIONS_KEY, JSON.stringify(migrated));
      window.localStorage.removeItem(LEGACY_SESSION_KEY);
      return migrated;
    } catch {
      window.localStorage.removeItem(LEGACY_SESSION_KEY);
    }
  }

  return [];
}

export default function TeacherPage() {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [sessionName, setSessionName] = useState("Beta 2026");
  const [seatCount, setSeatCount] = useState(30);
  const [sessionCode, setSessionCode] = useState("BETA2026");
  const [students, setStudents] = useState<StudentEntry[]>([]);
  const [message, setMessage] = useState("This beta session is ready for testing.");

  useEffect(() => {
    const sessionList = getSessionsFromStorage();

    if (sessionList.length === 0) {
      const starterSession: SessionRecord = {
        id: Date.now().toString(),
        name: "Beta 2026",
        code: generateCode(),
        seatCount: 30,
        createdAt: new Date().toISOString(),
      };

      window.localStorage.setItem(SESSIONS_KEY, JSON.stringify([starterSession]));
      window.localStorage.setItem(ACTIVE_SESSION_KEY, starterSession.id);
      setSessions([starterSession]);
      setActiveSessionId(starterSession.id);
      setSessionName(starterSession.name);
      setSeatCount(starterSession.seatCount);
      setSessionCode(starterSession.code);
      return;
    }

    const savedActiveId = window.localStorage.getItem(ACTIVE_SESSION_KEY) ?? sessionList[0].id;
    const selectedSession = sessionList.find((item) => item.id === savedActiveId) ?? sessionList[0];

    setSessions(sessionList);
    setActiveSessionId(selectedSession.id);
    setSessionName(selectedSession.name);
    setSeatCount(selectedSession.seatCount);
    setSessionCode(selectedSession.code);

    const savedStudents = window.localStorage.getItem(STUDENT_STORAGE_KEY);

    if (savedStudents) {
      try {
        setStudents(JSON.parse(savedStudents) as StudentEntry[]);
      } catch {
        window.localStorage.removeItem(STUDENT_STORAGE_KEY);
        setStudents([]);
      }
    }
  }, []);

  useEffect(() => {
    const handleStorage = () => {
      const storedSessions = getSessionsFromStorage();

      if (storedSessions.length > 0) {
        setSessions(storedSessions);
        const savedActiveId = window.localStorage.getItem(ACTIVE_SESSION_KEY) ?? storedSessions[0].id;
        const selectedSession = storedSessions.find((item) => item.id === savedActiveId) ?? storedSessions[0];
        setActiveSessionId(selectedSession.id);
        setSessionName(selectedSession.name);
        setSeatCount(selectedSession.seatCount);
        setSessionCode(selectedSession.code);
      }

      const savedStudents = window.localStorage.getItem(STUDENT_STORAGE_KEY);
      setStudents(savedStudents ? (JSON.parse(savedStudents) as StudentEntry[]) : []);
    };

    window.addEventListener("storage", handleStorage);

    return () => {
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  function handleCreateSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedSessionName = sessionName.trim() || "Beta 2026";
    const cleanedSeatCount = Math.max(1, Number(seatCount) || 30);
    const nextSession: SessionRecord = {
      id: Date.now().toString(),
      name: trimmedSessionName,
      code: generateCode(),
      seatCount: cleanedSeatCount,
      createdAt: new Date().toISOString(),
    };

    const updatedSessions = [...sessions, nextSession];
    window.localStorage.setItem(SESSIONS_KEY, JSON.stringify(updatedSessions));
    window.localStorage.setItem(ACTIVE_SESSION_KEY, nextSession.id);
    window.localStorage.setItem(STUDENT_STORAGE_KEY, JSON.stringify([]));
    setSessions(updatedSessions);
    setActiveSessionId(nextSession.id);
    setSessionName(nextSession.name);
    setSeatCount(nextSession.seatCount);
    setSessionCode(nextSession.code);
    setStudents([]);
    setMessage(
      `Session ${trimmedSessionName} created. Share code ${nextSession.code} with students.`
    );
  }

  function selectSession(sessionId: string) {
    const selected = sessions.find((session) => session.id === sessionId);

    if (!selected) {
      return;
    }

    window.localStorage.setItem(ACTIVE_SESSION_KEY, sessionId);
    setActiveSessionId(sessionId);
    setSessionName(selected.name);
    setSeatCount(selected.seatCount);
    setSessionCode(selected.code);
    setMessage(`Viewing session ${selected.name}.`);
  }

  const currentSessionStudents = students.filter((student) => student.sessionCode === sessionCode);
  const filledSeats = currentSessionStudents.length;
  const remainingSeats = Math.max(seatCount - filledSeats, 0);

  return (
    <main className="min-h-screen bg-[var(--brand-navy-deep)] text-[var(--brand-ivory)]">
      <div className="mx-auto max-w-7xl px-6 py-10">
        <div className="mb-8 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-black uppercase tracking-[0.25em] text-[var(--brand-gold)]">
              Teacher Dashboard
            </p>
            <h1 className="mt-2 text-3xl font-black text-white sm:text-4xl">
              Beta Session Control
            </h1>
          </div>

          <Link
            href="/"
            className="rounded-xl border border-[var(--brand-gold)]/60 bg-[var(--brand-navy)] px-4 py-2 font-bold text-[var(--brand-ivory)] transition hover:bg-[var(--brand-navy)]/80"
          >
            Back to Home
          </Link>
        </div>

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-[0_10px_30px_rgba(0,0,0,0.18)]">
            <div className="text-sm uppercase tracking-[0.2em] text-[var(--brand-gold)]/80">
              Session Name
            </div>
            <div className="mt-3 text-2xl font-black text-white">{sessionName}</div>
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
            <div className="mt-3 text-3xl font-black text-white">{seatCount}</div>
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
                {sessions.map((session) => (
                  <option key={session.id} value={session.id}>
                    {session.name}
                  </option>
                ))}
              </select>
            </div>

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
              {sessionName}
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
