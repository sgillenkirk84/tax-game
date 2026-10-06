import type { HighlightResult } from "@/lib/highlight-reel";

export default function HighlightReel({ result, loading, onRetry }: {
  result: HighlightResult | null;
  loading: boolean;
  onRetry: () => void;
}) {
  return (
    <section aria-labelledby="highlight-reel-heading" className="mb-6 rounded-2xl bg-[var(--brand-navy)]/5 p-4">
      <h3 id="highlight-reel-heading" className="text-xl font-black">My Tax Life &mdash; Highlight Reel</h3>
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
      <a href="#life-ledger-heading" className="mt-4 inline-block text-sm font-bold underline">View Full Life Ledger</a>
    </section>
  );
}
