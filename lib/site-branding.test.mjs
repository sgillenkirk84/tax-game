import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  COPYRIGHT_NOTICE,
  EDUCATIONAL_DISCLAIMER,
  PRODUCT_NAME,
} from "./site-branding.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const footer = read("../components/site-footer.tsx");
const rootLayout = read("../app/layout.tsx");

test("the canonical public product name has one trademark symbol", () => {
  assert.equal(PRODUCT_NAME, "The Ledger Draw™");
  assert.equal(PRODUCT_NAME.match(/™/g)?.length, 1);
});

test("the exact copyright and property disclaimer includes the required year and entity", () => {
  assert.equal(
    COPYRIGHT_NOTICE,
    "© 2026 Pittroe™ Business Services LLC. The Ledger Draw™ and its cards, rules, and artwork are the property of Pittroe™ Business Services LLC. Do not copy, share, or distribute without written permission.",
  );
  assert.match(COPYRIGHT_NOTICE, /^© 2026 Pittroe™ Business Services LLC\./);
  assert.equal((COPYRIGHT_NOTICE.match(/Pittroe™ Business Services LLC/g) ?? []).length, 2);
});

test("the exact educational disclaimer identifies the 2025 tax year", () => {
  assert.equal(
    EDUCATIONAL_DISCLAIMER,
    "The Ledger Draw™ is an educational game and is not tax, legal, investment, or financial advice. Tax rules are simplified for gameplay and learning purposes and are based on the game's Tax Year 2025 ruleset. Consult a qualified professional for advice about your individual circumstances.",
  );
  assert.match(EDUCATIONAL_DISCLAIMER, /Tax Year 2025 ruleset/);
});

test("one shared footer renders both exact disclaimers in distinct paragraphs", () => {
  assert.match(footer, /<footer\b/);
  assert.match(footer, /<p>\{COPYRIGHT_NOTICE\}<\/p>/);
  assert.match(footer, /<p>\{EDUCATIONAL_DISCLAIMER\}<\/p>/);
  assert.equal((footer.match(/<p>/g) ?? []).length, 2);
});

test("the footer is presentation-only and independent of gameplay state", () => {
  assert.doesNotMatch(footer, /useState|useEffect|useRouter|fetch\(|player|round|stage|onClick/);
  assert.doesNotMatch(footer, /<button\b|<a\b|<Link\b/);
  assert.match(rootLayout, /\{children\}[\s\S]*<SiteFooter\s*\/>/);
});

test("the shared footer is responsive, readable and naturally positioned", () => {
  assert.match(footer, /border-t/);
  assert.match(footer, /max-w-3xl/);
  assert.match(footer, /text-sm leading-relaxed/);
  assert.match(footer, /px-6 py-6/);
  assert.doesNotMatch(footer, /fixed|sticky|whitespace-nowrap|w-\[\d+px\]/);
});

test("public home, teacher, metadata and in-game educational copy share the trademarked name", () => {
  assert.match(read("../app/page.tsx"), /PRODUCT_NAME/);
  assert.match(read("../app/teacher/page.tsx"), /PRODUCT_NAME/);
  assert.match(read("../app/(auth)/teacher/login/page.tsx"), /PRODUCT_NAME/);
  assert.equal((rootLayout.match(/title: PRODUCT_NAME/g) ?? []).length, 3);
  assert.match(read("./card-entry.ts"), /PRODUCT_NAME/);
  for (const path of [
    "../app/play/page.tsx",
    "../app/play/game/page.tsx",
    "../app/play/round-1/page.tsx",
    "../components/highlight-reel.tsx",
    "../components/round-results.tsx",
  ]) {
    const source = read(path);
    assert.match(source, /import \{ PRODUCT_NAME \} from "@\/lib\/site-branding"/);
    assert.match(source, /\{PRODUCT_NAME\}/);
    assert.doesNotMatch(source, /Money Moves|My Tax Life|Tax Game/);
  }
});

test("public branding contains no accidental duplicate trademark symbol", () => {
  assert.doesNotMatch(PRODUCT_NAME, /™™/);
  assert.doesNotMatch(COPYRIGHT_NOTICE, /™™/);
  assert.doesNotMatch(EDUCATIONAL_DISCLAIMER, /™™/);
});

test("existing progression, post-game separation and five-round guard remain present", () => {
  const stages = read("./round-stages.ts");
  const rounds = read("./round-rules.ts");
  const dashboard = read("../components/round-dashboard.tsx");
  const results = read("../components/round-results.tsx");
  assert.match(stages, /"results-and-life-ledger"/);
  assert.match(rounds, /MAX_PLAYABLE_ROUND = 5/);
  assert.match(dashboard, /hidden=\{postGame\}/);
  assert.match(results, /View \{PRODUCT_NAME\} Recap/);
  assert.match(results, /onViewLedger=\{\(\) => changeView\("ledger"\)\}/);
  assert.match(read("./round-stages.ts"), /ACTIVE_ROUND_FLOW/);
});

test("branding preserves legacy storage keys and persisted-game identifiers", () => {
  for (const path of ["../app/play/page.tsx", "../app/play/game/page.tsx", "../app/play/round-1/page.tsx"]) {
    assert.match(read(path), /const PLAYER_STORAGE_KEY = "my-tax-life-player"/);
  }
  assert.match(read("../app/play/game/page.tsx"), /const SESSIONS_KEY = "my-tax-life-sessions"/);
  assert.match(read("../app/teacher/import-sessions/page.tsx"), /getItem\("my-tax-life-sessions"\)/);
  assert.match(read("../components/tax-calculation.tsx"), /`money-moves:tax-key:\$\{player.id\}:\$\{round\}`/);
  const api = read("../app/api/rounds/one/route.ts");
  assert.match(api, /rpc\("start_or_resume_round_one"/);
  assert.match(api, /scenarioId: current.starting_decision_id/);
  assert.match(api, /startingCash: Number\(current.beginning_cash_resources\)/);
  assert.match(api, /startingStudentLoanDebt: Number\(current.beginning_student_loan_debt\)/);
});
