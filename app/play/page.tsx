"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";

type PlayerSession = {
  sessionCode: string;
  displayName: string;
  joinedAt: string;
};

type SessionRecord = {
  id: string;
  name: string;
  code: string;
  seatCount: number;
  createdAt: string;
};

type StudentEntry = {
  id: string;
  name: string;
  sessionCode: string;
  joinedAt: string;
};

const PLAYER_STORAGE_KEY = "my-tax-life-player";
const SESSIONS_KEY = "my-tax-life-sessions";
const STUDENT_STORAGE_KEY = "my-tax-life-students";
const LEGACY_SESSION_KEY = "my-tax-life-session";

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

export default function PlayPage() {
  const [sessionCode, setSessionCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [message, setMessage] = useState("");
  const [joined, setJoined] = useState(false);

  useEffect(() => {
    const savedPlayer = window.localStorage.getItem(PLAYER_STORAGE_KEY);
    const savedSessions = getSessionsFromStorage();

    if (savedPlayer) {
      try {
        const parsedPlayer = JSON.parse(savedPlayer) as PlayerSession;

        if (parsedPlayer.sessionCode && parsedPlayer.displayName) {
          setSessionCode(parsedPlayer.sessionCode);
          setDisplayName(parsedPlayer.displayName);
          setJoined(true);
          setMessage(
            `Welcome back, ${parsedPlayer.displayName}. You are joined to session ${parsedPlayer.sessionCode}.`
          );
        }
      } catch {
        window.localStorage.removeItem(PLAYER_STORAGE_KEY);
      }
    }

    if (savedSessions.length > 0 && !sessionCode) {
      setSessionCode(savedSessions[0].code);
    }
  }, [sessionCode]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const cleanedSessionCode = sessionCode.trim().toUpperCase();
    const cleanedDisplayName = displayName.trim();

    if (!cleanedSessionCode || !cleanedDisplayName) {
      setMessage("Please enter both a session code and your display name.");
      return;
    }

    const savedSessions = getSessionsFromStorage();
    const matchingSession = savedSessions.find((session) => session.code === cleanedSessionCode);

    if (!matchingSession) {
      setMessage("That session code does not exist yet. Please ask the teacher to create one first.");
      return;
    }

    const savedStudents = window.localStorage.getItem(STUDENT_STORAGE_KEY);
    const currentStudents = savedStudents ? (JSON.parse(savedStudents) as StudentEntry[]) : [];
    const matchingStudents = currentStudents.filter(
      (student) => student.sessionCode === cleanedSessionCode
    );

    if (
      !matchingStudents.some(
        (student) => student.name.toLowerCase() === cleanedDisplayName.toLowerCase()
      )
    ) {
      if (matchingStudents.length >= matchingSession.seatCount) {
        setMessage("This session is full. Please ask the teacher for a new code.");
        return;
      }

      const nextStudent: StudentEntry = {
        id: Date.now().toString(),
        name: cleanedDisplayName,
        sessionCode: cleanedSessionCode,
        joinedAt: new Date().toISOString(),
      };

      const updatedStudents = [...currentStudents, nextStudent];
      window.localStorage.setItem(STUDENT_STORAGE_KEY, JSON.stringify(updatedStudents));
    }

    const playerSession: PlayerSession = {
      sessionCode: cleanedSessionCode,
      displayName: cleanedDisplayName,
      joinedAt: new Date().toISOString(),
    };

    window.localStorage.setItem(PLAYER_STORAGE_KEY, JSON.stringify(playerSession));
    setJoined(true);
    setMessage(
      `${cleanedDisplayName} is now joined to session ${cleanedSessionCode}.`
    );
  }

  return (
    <main className="min-h-screen bg-[var(--brand-ivory)] px-6 py-10 text-[var(--brand-navy)]">
      <div className="mx-auto max-w-2xl">
        <div className="mb-8">
          <Link href="/" className="text-sm font-bold text-[var(--brand-navy)] hover:text-[var(--brand-navy-deep)]">
            ← Back to home
          </Link>
        </div>

        <div className="rounded-[2rem] border border-[var(--brand-navy)]/20 bg-[var(--brand-white)] p-8 shadow-[0_20px_50px_rgba(15,29,82,0.08)] sm:p-10">
          <p className="mb-3 text-sm font-black uppercase tracking-[0.25em] text-[var(--brand-gold)]">
            Student Access
          </p>

          <h1 className="text-3xl font-black text-[var(--brand-navy)] sm:text-4xl">Join a Session</h1>

          <p className="mt-3 text-[var(--brand-navy)]/75">
            Enter the session code provided by your teacher, then add your name or initials to join.
          </p>

          <form onSubmit={handleSubmit} className="mt-8 space-y-5">
            <div>
              <label htmlFor="sessionCode" className="mb-2 block text-sm font-bold text-[var(--brand-navy)]">
                Session Code
              </label>
              <input
                id="sessionCode"
                type="text"
                value={sessionCode}
                onChange={(event) => setSessionCode(event.target.value)}
                placeholder="EX: ABC123"
                className="w-full rounded-xl border border-[var(--brand-navy)]/30 bg-[var(--brand-ivory)] px-4 py-3 text-[var(--brand-navy)] outline-none transition focus:border-[var(--brand-gold)] focus:ring-2 focus:ring-[var(--brand-gold)]/40"
              />
            </div>

            <div>
              <label htmlFor="displayName" className="mb-2 block text-sm font-bold text-[var(--brand-navy)]">
                Display Name or Initials
              </label>
              <input
                id="displayName"
                type="text"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="Enter your name or initials"
                className="w-full rounded-xl border border-[var(--brand-navy)]/30 bg-[var(--brand-ivory)] px-4 py-3 text-[var(--brand-navy)] outline-none transition focus:border-[var(--brand-gold)] focus:ring-2 focus:ring-[var(--brand-gold)]/40"
              />
            </div>

            <button
              type="submit"
              className="w-full rounded-xl bg-[var(--brand-navy)] px-6 py-3.5 font-bold text-white transition hover:bg-[var(--brand-navy-deep)]"
            >
              Join Game
            </button>
          </form>

          {message ? (
            <div className="mt-6 rounded-xl border border-[var(--brand-gold)]/40 bg-[var(--brand-ivory)] p-4 text-sm text-[var(--brand-navy)]">
              {message}
            </div>
          ) : null}

          {joined ? (
            <div className="mt-6 rounded-xl border border-[var(--brand-navy)]/20 bg-[var(--brand-gold)]/15 p-4 text-sm font-semibold text-[var(--brand-navy)]">
              Your player record has been saved for this browser.
            </div>
          ) : null}
        </div>
      </div>
    </main>
  );
}
