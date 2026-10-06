import type { HighlightResult } from "@/lib/highlight-reel";
import type { Ref } from "react";

export default function HighlightReel({ result, loading, onRetry, onBack, onViewLedger, headingRef }: {
  result: HighlightResult | null;
  loading: boolean;
  onRetry: () => void;
  onBack: () => void;
  onViewLedger: () => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  return (
    <section aria-labelledby="highlight-reel-heading" className="mb-6 rounded-2xl bg-[var(--brand-navy)]/5 p-4">
      <h2 ref={headingRef} tabIndex={-1} id="highlight-reel-heading" className="text-2xl font-black">My Tax Life &mdash; Highlight Reel</h2>
      <p className="mt-2 text-sm">A factual recap of your saved simulated life, not a score.</p>
      {loading ? (
        <p role="status" className="mt-3 text-sm">Your game is finalized. Loading saved history for your recap...</p>
      ) : result && !result.ok ? (
        <div role="alert" className="mt-3 text-sm text-red-800">
          <p>Your game remains finalized. Your recap could not be loaded: {result.error}</p>
          <button type="button" className="mt-2 underline" onClick={onRetry}>Try loading history again</button>
        </div>
      ) : result?.ok ? (
        <ol className="mt-4 grid gap-3 sm:grid-cols-2">
          {result.highlights.map((highlight) => (
            <li key={highlight.id} className="rounded-xl border border-[var(--brand-navy)]/15 bg-white p-4">
              <h4 className="text-sm font-bold">{highlight.title}</h4>
              <p className="mt-2 font-black">{highlight.value}</p>
              <p className="mt-2 text-sm leading-relaxed">{highlight.explanation}</p>
            </li>
          ))}
        </ol>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center gap-4 text-sm font-bold">
        <button type="button" onClick={onViewLedger} className="rounded-xl bg-[var(--brand-navy)] px-6 py-3 text-white">View Full Life Ledger</button>
        <button type="button" onClick={onBack} className="underline">Back to Round 5 Results</button>
      </div>
    </section>
  );
}
