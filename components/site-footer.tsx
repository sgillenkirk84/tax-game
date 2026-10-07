import { COPYRIGHT_NOTICE, EDUCATIONAL_DISCLAIMER } from "@/lib/site-branding";

export default function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-[var(--brand-navy)]/15 bg-[var(--brand-ivory)] px-6 py-6 text-[var(--brand-navy)]/75">
      <div className="mx-auto max-w-3xl space-y-3 text-sm leading-relaxed">
        <p>{COPYRIGHT_NOTICE}</p>
        <p>{EDUCATIONAL_DISCLAIMER}</p>
      </div>
    </footer>
  );
}
