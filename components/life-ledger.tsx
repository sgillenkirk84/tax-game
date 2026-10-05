"use client";

import { useEffect, useState } from "react";
import type { StoredResults } from "@/lib/round-results";
import { LEDGER_ROUNDS, lifeLedgerRows, loadEarlierLedgerRounds } from "@/lib/life-ledger";

export default function LifeLedger({ current, player }: {
  current: StoredResults;
  player: { id: string; resumeToken: string };
}) {
  const [history, setHistory] = useState<{ rounds: StoredResults[]; error: string; loading: boolean }>({
    rounds: [], error: "", loading: true,
  });
  const [retry, setRetry] = useState(0);
  const { id, resumeToken } = player;

  useEffect(() => {
    const controller = new AbortController();
    void loadEarlierLedgerRounds({ id, resumeToken }, current.roundNumber, controller.signal).then(
      (rounds) => {
        if (!controller.signal.aborted) {
          setHistory({ rounds, error: "", loading: false });
        }
      },
      (caught: unknown) => {
        if (!controller.signal.aborted) {
          setHistory({
            rounds: [], loading: false,
            error: caught instanceof Error ? caught.message : "Could not load your Life Ledger.",
          });
        }
      },
    );
    return () => controller.abort();
  }, [id, resumeToken, current.roundNumber, retry]);

  const rows = lifeLedgerRows([...history.rounds, current]);
  return (
    <section className="mt-6">
      <h3 id="life-ledger-heading" className="text-xl font-black">Life Ledger</h3>
      <p className="mt-2 text-sm">Saved completed rounds. A dash means no saved value is available.</p>
      {history.loading ? <p role="status" className="mt-2 text-sm">Loading earlier rounds...</p> : null}
      {history.error ? (
        <p role="alert" className="mt-2 text-sm text-red-800">
          {history.error}{" "}
          <button type="button" className="underline" onClick={() => setRetry((value) => value + 1)}>Try again</button>
        </p>
      ) : null}
      <div role="region" aria-labelledby="life-ledger-heading" tabIndex={0} className="mt-3 max-w-full overflow-x-auto rounded-xl border border-[var(--brand-navy)]/15">
        <table className="w-full min-w-[1050px] border-collapse text-sm">
          <caption className="sr-only">Life Ledger: categories by round</caption>
          <thead>
            <tr className="bg-[var(--brand-navy)] text-white">
              <th scope="col" className="p-3 text-left">Life Ledger</th>
              {LEDGER_ROUNDS.map((round) => <th key={round} scope="col" className="min-w-36 p-3 text-right">Round {round}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="border-t border-[var(--brand-navy)]/15 even:bg-[var(--brand-navy)]/5">
                <th scope="row" className="p-3 text-left font-semibold">{row.label}</th>
                {row.values.map((value, index) => <td key={LEDGER_ROUNDS[index]} className="p-3 text-right align-top">{value}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
