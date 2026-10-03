"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

type PlayerSession = {
  id: string;
  resumeToken: string;
  sessionCode: string;
  displayName: string;
  joinedAt: string;
};

const PLAYER_STORAGE_KEY = "my-tax-life-player";

export default function PlayPage() {
  const router = useRouter();
  const [sessionCode, setSessionCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [message, setMessage] = useState("");
  const [joined, setJoined] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const cleanedSessionCode = sessionCode.trim().toUpperCase();
    const cleanedDisplayName = displayName.trim();

    if (!cleanedSessionCode || !cleanedDisplayName) {
      setMessage("Please enter both a session code and your display name.");
      return;
    }

    try {
      const response = await fetch("/api/students", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionCode: cleanedSessionCode,
          name: cleanedDisplayName,
        }),
      });
      const result = (await response.json()) as {
        error?: string;
        id?: string;
        resumeToken?: string;
        joinedAt?: string;
      };

      if (!response.ok) {
        setMessage(result.error ?? "Registration failed. Please try again.");
        return;
      }
      if (!result.id || !result.resumeToken) {
        setMessage("Registration did not return the secure player session details. Please try again.");
        return;
      }

      const playerSession: PlayerSession = {
        id: result.id,
        resumeToken: result.resumeToken,
        sessionCode: cleanedSessionCode,
        displayName: cleanedDisplayName,
        joinedAt: result.joinedAt ?? new Date().toISOString(),
      };

      window.localStorage.setItem(PLAYER_STORAGE_KEY, JSON.stringify(playerSession));
      setJoined(true);
      setMessage(`${cleanedDisplayName} is now joined to session ${cleanedSessionCode}. Redirecting...`);
      router.push("/play/game");
    } catch {
      setMessage("Could not reach shared registration storage. Check your connection and try again.");
    }
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
                onChange={(event) => setSessionCode(event.target.value.toUpperCase())}
                placeholder="EX: ABC123"
                maxLength={6}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                className="w-full rounded-xl border border-[var(--brand-navy)]/30 bg-[var(--brand-ivory)] px-4 py-3 text-[var(--brand-navy)] outline-none transition focus:border-[var(--brand-gold)] focus:ring-2 focus:ring-[var(--brand-gold)]/40"
              />
              {sessionCode ? (
                <button
                  type="button"
                  onClick={() => setSessionCode("")}
                  className="mt-2 text-sm font-bold text-[var(--brand-navy)] underline underline-offset-2"
                >
                  Clear code
                </button>
              ) : null}
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
