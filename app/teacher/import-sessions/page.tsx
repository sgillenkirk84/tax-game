"use client";

import Link from "next/link";
import { useState } from "react";

type ApiSessionRecord = {
  id: string;
  name: string;
  code: string;
  seat_count: number;
  created_at: string;
};

type ImportRecord = {
  id: unknown;
  name: unknown;
  code: unknown;
  seatCount: unknown;
};

type PreviewRow = {
  index: number;
  source: ImportRecord;
  id: string;
  name: string;
  originalCode: string;
  normalizedCode: string;
  seatCount: string;
  status: "ready" | "skipped" | "rejected";
  message: string;
};

type ImportResult = {
  index: number;
  id: string;
  name: string;
  code: string;
  seatCount: number | null;
  status: "imported" | "skipped" | "rejected";
  message: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default function ImportSessionsPage() {
  const [previewRows, setPreviewRows] = useState<PreviewRow[]>([]);
  const [results, setResults] = useState<ImportResult[]>([]);
  const [hasPreviewed, setHasPreviewed] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [error, setError] = useState("");

  async function previewSessions() {
    setIsPreviewing(true);
    setError("");
    setResults([]);
    setHasPreviewed(false);

    try {
      const storedValue = window.localStorage.getItem("my-tax-life-sessions");
      if (!storedValue) {
        setPreviewRows([]);
        setHasPreviewed(true);
        return;
      }

      const legacyData: unknown = JSON.parse(storedValue);
      if (!Array.isArray(legacyData)) {
        throw new Error("The saved session data is not a list.");
      }

      const existingResponse = await fetch("/api/sessions");
      const existingResult = (await existingResponse.json()) as ApiSessionRecord[] | { error?: string };
      if (!existingResponse.ok || !Array.isArray(existingResult)) {
        throw new Error(
          (existingResult as { error?: string }).error ?? "Could not compare with database sessions."
        );
      }

      const existingIds = new Set(existingResult.map((session) => session.id.toLowerCase()));
      const existingCodes = new Set(existingResult.map((session) => session.code.toUpperCase()));
      const prepared = legacyData.map((value, index) => {
        const source = isRecord(value)
          ? {
              id: value.id,
              name: value.name,
              code: value.code,
              seatCount: value.seatCount,
            }
          : { id: undefined, name: undefined, code: undefined, seatCount: undefined };
        const id = typeof source.id === "string" ? source.id.trim() : "";
        const name = typeof source.name === "string" ? source.name.trim() : "";
        const originalCode = typeof source.code === "string" ? source.code : "";
        const normalizedCode = originalCode.trim().toUpperCase();
        const seatCount =
          typeof source.seatCount === "number" ? String(source.seatCount) : String(source.seatCount ?? "");
        const issues: string[] = [];

        if (!/^[A-Za-z0-9-]{1,128}$/.test(id)) {
          issues.push("Invalid ID.");
        }
        if (!name || name.length > 80) {
          issues.push("Name must contain 1–80 characters.");
        }
        if (!/^[A-Z0-9]{6}$/.test(normalizedCode)) {
          issues.push("Code must contain exactly six letters or digits.");
        }
        if (
          typeof source.seatCount !== "number" ||
          !Number.isInteger(source.seatCount) ||
          source.seatCount < 1 ||
          source.seatCount > 200
        ) {
          issues.push("Seat count must be an integer from 1 to 200.");
        }

        return {
          index,
          source,
          id,
          name,
          originalCode,
          normalizedCode,
          seatCount,
          status: issues.length > 0 ? ("rejected" as const) : ("ready" as const),
          message: issues.join(" "),
        };
      });

      const idCounts = new Map<string, number>();
      const codeCounts = new Map<string, number>();
      for (const row of prepared) {
        if (/^[A-Za-z0-9-]{1,128}$/.test(row.id)) {
          const key = row.id.toLowerCase();
          idCounts.set(key, (idCounts.get(key) ?? 0) + 1);
        }
        if (/^[A-Z0-9]{6}$/.test(row.normalizedCode)) {
          codeCounts.set(row.normalizedCode, (codeCounts.get(row.normalizedCode) ?? 0) + 1);
        }
      }

      const rows = prepared.map((row) => {
        const issues = [row.message];
        if (idCounts.get(row.id.toLowerCase()) && idCounts.get(row.id.toLowerCase())! > 1) {
          issues.push("Duplicate ID in saved sessions.");
        }
        if (codeCounts.get(row.normalizedCode) && codeCounts.get(row.normalizedCode)! > 1) {
          issues.push("Duplicate code in saved sessions.");
        }
        if (row.id && existingIds.has(row.id.toLowerCase())) {
          issues.push("ID already exists in Supabase.");
        }
        if (/^[A-Z0-9]{6}$/.test(row.normalizedCode) && existingCodes.has(row.normalizedCode)) {
          issues.push("Code already exists in Supabase.");
        }

        const blockingIssues = issues.filter(Boolean);
        const hasExistingConflict = blockingIssues.some((issue) => issue.includes("already exists in Supabase"));
        return {
          ...row,
          status: blockingIssues.length
            ? hasExistingConflict && row.status !== "rejected"
              ? ("skipped" as const)
              : ("rejected" as const)
            : ("ready" as const),
          message: blockingIssues.join(" "),
        };
      });

      setPreviewRows(rows);
      setHasPreviewed(true);
    } catch (previewError) {
      setError(
        previewError instanceof Error
          ? previewError.message
          : "Could not preview saved sessions. Check your connection and try again."
      );
    } finally {
      setIsPreviewing(false);
    }
  }

  async function confirmImport() {
    setIsImporting(true);
    setError("");
    setResults([]);

    try {
      const response = await fetch("/api/sessions/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessions: previewRows.map((row) => row.source) }),
      });
      const result = (await response.json()) as { error?: string; results?: ImportResult[] };
      if (!response.ok || !Array.isArray(result.results)) {
        throw new Error(result.error ?? "Could not import saved sessions.");
      }

      setResults(result.results);
    } catch (importError) {
      setError(
        importError instanceof Error
          ? importError.message
          : "Could not import saved sessions. Check your connection and try again."
      );
    } finally {
      setIsImporting(false);
    }
  }

  const readyCount = previewRows.filter((row) => row.status === "ready").length;

  return (
    <main className="min-h-screen bg-[var(--brand-navy-deep)] text-[var(--brand-ivory)]">
      <div className="mx-auto max-w-6xl px-6 py-10">
        <div className="mb-8 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-black uppercase tracking-[0.25em] text-[var(--brand-gold)]">
              Teacher Tools
            </p>
            <h1 className="mt-2 text-3xl font-black text-white sm:text-4xl">Import Old Sessions</h1>
            <p className="mt-3 max-w-3xl text-sm text-[var(--brand-ivory)]/80">
              Preview reads this browser&apos;s saved sessions without changing them. Nothing is imported until you confirm.
            </p>
          </div>
          <Link
            href="/teacher"
            className="rounded-xl border border-[var(--brand-gold)]/60 bg-[var(--brand-navy)] px-4 py-2 font-bold text-[var(--brand-ivory)] transition hover:bg-[var(--brand-navy)]/80"
          >
            Back to Dashboard
          </Link>
        </div>

        <section className="rounded-2xl border border-white/10 bg-white/5 p-6">
          <button
            type="button"
            onClick={previewSessions}
            disabled={isPreviewing || isImporting}
            className="rounded-xl bg-[var(--brand-gold)] px-5 py-3 font-black text-[var(--brand-navy)] transition hover:brightness-105 disabled:opacity-60"
          >
            {isPreviewing ? "Loading Preview..." : "Preview Saved Sessions"}
          </button>

          {error ? (
            <div role="alert" className="mt-5 rounded-xl border border-red-400/50 bg-red-950/40 p-4 text-sm text-red-100">
              {error}
            </div>
          ) : null}

          {hasPreviewed ? (
            <>
              {previewRows.length === 0 ? (
                <p className="mt-6 rounded-xl border border-white/10 bg-black/10 p-4 text-sm">
                  No saved sessions were found in this browser.
                </p>
              ) : (
                <>
                  <p className="mt-6 text-sm text-[var(--brand-ivory)]/80">
                    {readyCount} session{readyCount === 1 ? "" : "s"} ready to import. Existing or invalid records will not be imported.
                  </p>
                  <div className="mt-4 overflow-x-auto rounded-xl border border-white/10">
                    <table className="w-full min-w-[760px] border-collapse text-left text-sm">
                      <thead className="bg-[var(--brand-navy)] text-[var(--brand-ivory)]">
                        <tr>
                          <th className="px-4 py-3 font-bold">Name</th>
                          <th className="px-4 py-3 font-bold">Code</th>
                          <th className="px-4 py-3 font-bold">Seats</th>
                          <th className="px-4 py-3 font-bold">ID</th>
                          <th className="px-4 py-3 font-bold">Preview status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {previewRows.map((row) => (
                          <tr key={`${row.index}-${row.id}`} className="border-t border-white/10">
                            <td className="px-4 py-3">{row.name || "(missing or invalid)"}</td>
                            <td className="px-4 py-3 font-mono">
                              {row.originalCode || "(missing)"}
                              {row.normalizedCode && row.originalCode !== row.normalizedCode ? (
                                <span className="block text-xs text-[var(--brand-gold)]">
                                  Will normalize to {row.normalizedCode}
                                </span>
                              ) : null}
                            </td>
                            <td className="px-4 py-3">{row.seatCount || "(missing)"}</td>
                            <td className="max-w-56 break-all px-4 py-3 font-mono">{row.id || "(missing)"}</td>
                            <td className="px-4 py-3">
                              <span className="font-bold uppercase">{row.status}</span>
                              {row.message ? <span className="mt-1 block text-xs">{row.message}</span> : null}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <button
                    type="button"
                    onClick={confirmImport}
                    disabled={readyCount === 0 || isImporting || isPreviewing}
                    className="mt-6 rounded-xl bg-[var(--brand-gold)] px-5 py-3 font-black text-[var(--brand-navy)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isImporting ? "Importing..." : `Confirm Import (${readyCount} ready)`}
                  </button>
                </>
              )}
            </>
          ) : null}

          {results.length > 0 ? (
            <div className="mt-8">
              <h2 className="text-xl font-black text-white">Import results</h2>
              <ul className="mt-4 space-y-3">
                {results.map((result) => (
                  <li key={`${result.index}-${result.id}`} className="rounded-xl border border-white/10 bg-black/10 p-4">
                    <span className="font-bold uppercase">{result.status}</span>
                    <span className="ml-2">{result.name || "(unnamed session)"}</span>
                    <span className="ml-2 font-mono">{result.code}</span>
                    <span className="mt-1 block text-sm text-[var(--brand-ivory)]/75">{result.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}
