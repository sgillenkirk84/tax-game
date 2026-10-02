import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen bg-[var(--brand-ivory)] text-[var(--brand-navy)]">
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col items-center justify-center px-6 text-center">
        <div className="w-full max-w-4xl rounded-[2rem] border border-[var(--brand-navy)]/20 bg-[var(--brand-white)] px-8 py-12 shadow-[0_20px_50px_rgba(15,29,82,0.08)] sm:px-12">
          <p className="mb-4 text-sm font-black uppercase tracking-[0.3em] text-[var(--brand-gold)]">
            An Educational Tax Simulation
          </p>

          <h1 className="text-5xl font-black tracking-tight text-[var(--brand-navy)] sm:text-7xl">
            My Tax Life
          </h1>

          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-[var(--brand-navy)]/80">
            Experience how income, family, housing, deductions, investments,
            taxes, and retirement can change throughout your financial life.
          </p>

          <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
            <Link
              href="/play"
              className="rounded-xl bg-[var(--brand-navy)] px-7 py-3.5 text-base font-bold text-white transition hover:bg-[var(--brand-navy-deep)]"
            >
              Join a Game
            </Link>

            <Link
              href="/teacher"
              className="rounded-xl border-2 border-[var(--brand-gold)] bg-[var(--brand-gold)] px-7 py-3.5 text-base font-bold text-[var(--brand-navy)] transition hover:brightness-105"
            >
              Teacher
            </Link>
          </div>

          <div className="mt-10 flex items-center justify-center gap-3 text-sm font-semibold uppercase tracking-[0.2em] text-[var(--brand-navy)]/70">
            <span className="h-px w-16 bg-[var(--brand-gold)]" />
            <span>Built for classroom learning</span>
            <span className="h-px w-16 bg-[var(--brand-gold)]" />
          </div>

          <p className="mt-8 text-sm text-[var(--brand-navy)]/65">
            Educational simulation — not personal tax advice.
          </p>
        </div>
      </div>
    </main>
  );
}