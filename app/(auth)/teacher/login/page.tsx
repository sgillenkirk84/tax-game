import Link from "next/link";
import TeacherLoginForm from "./login-form";
import { PRODUCT_NAME } from "@/lib/site-branding";

export default async function TeacherLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;
  const initialMessage = reason === "not-teacher"
    ? "This account is not registered as a teacher."
    : "";

  return (
    <main className="min-h-screen bg-[var(--brand-navy-deep)] px-6 py-12 text-[var(--brand-ivory)]">
      <div className="mx-auto max-w-md">
        <Link href="/" className="text-sm font-bold text-[var(--brand-gold)] hover:underline">
          Back to home
        </Link>

        <section className="mt-8 rounded-2xl border border-white/10 bg-white/5 p-8 shadow-[0_20px_50px_rgba(0,0,0,0.2)]">
          <p className="text-sm font-black uppercase tracking-[0.25em] text-[var(--brand-gold)]">
            {PRODUCT_NAME} · Teacher Access
          </p>
          <h1 className="mt-3 text-3xl font-black text-white">Sign in</h1>
          <p className="mt-3 text-sm leading-relaxed text-[var(--brand-ivory)]/75">
            Use the email and password for your registered teacher account.
          </p>
          <TeacherLoginForm initialMessage={initialMessage} />
        </section>
      </div>
    </main>
  );
}