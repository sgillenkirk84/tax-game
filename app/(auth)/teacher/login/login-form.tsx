"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";

export default function TeacherLoginForm({ initialMessage }: { initialMessage: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState(initialMessage);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setMessage("");

    const { error } = await createClient().auth.signInWithPassword({ email, password });

    if (error) {
      setMessage("Sign-in failed. Check your email and password, then try again.");
      setIsSubmitting(false);
      return;
    }

    router.replace("/teacher");
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="mt-8 space-y-5">
      <div>
        <label htmlFor="teacher-email" className="mb-2 block text-sm font-bold text-[var(--brand-ivory)]">
          Email
        </label>
        <input
          id="teacher-email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="w-full rounded-xl border border-white/20 bg-[var(--brand-navy)] px-4 py-3 text-white outline-none transition focus:border-[var(--brand-gold)]"
        />
      </div>

      <div>
        <label htmlFor="teacher-password" className="mb-2 block text-sm font-bold text-[var(--brand-ivory)]">
          Password
        </label>
        <input
          id="teacher-password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="w-full rounded-xl border border-white/20 bg-[var(--brand-navy)] px-4 py-3 text-white outline-none transition focus:border-[var(--brand-gold)]"
        />
      </div>

      {message ? (
        <p role="alert" className="rounded-xl border border-[var(--brand-gold)]/40 bg-[var(--brand-navy)]/70 p-3 text-sm text-[var(--brand-ivory)]">
          {message}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={isSubmitting}
        className="w-full rounded-xl bg-[var(--brand-gold)] px-6 py-3.5 font-black text-[var(--brand-navy)] transition hover:brightness-105 disabled:cursor-wait disabled:opacity-60"
      >
        {isSubmitting ? "Signing in..." : "Sign In"}
      </button>
    </form>
  );
}