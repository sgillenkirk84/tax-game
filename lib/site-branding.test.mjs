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
  assert.equal(PRODUCT_NAME, "Money Moves™");
  assert.equal(PRODUCT_NAME.match(/™/g)?.length, 1);
});

test("the exact copyright and property disclaimer includes the required year and entity", () => {
  assert.equal(
    COPYRIGHT_NOTICE,
    "© 2026 Pittroe™ Business Services LLC. Money Moves™ and its cards, rules, and artwork are the property of Pittroe™ Business Services LLC. Do not copy, share, or distribute without written permission.",
  );
  assert.match(COPYRIGHT_NOTICE, /^© 2026 Pittroe™ Business Services LLC\./);
  assert.equal((COPYRIGHT_NOTICE.match(/Pittroe™ Business Services LLC/g) ?? []).length, 2);
});

test("the exact educational disclaimer identifies the 2025 tax year", () => {
  assert.equal(
    EDUCATIONAL_DISCLAIMER,
    "Money Moves™ is an educational game and is not tax, legal, investment, or financial advice. Tax rules are simplified for gameplay and learning purposes and are based on the game's Tax Year 2025 ruleset. Consult a qualified professional for advice about your individual circumstances.",
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
});

test("public branding contains no accidental duplicate trademark symbol", () => {
  assert.doesNotMatch(PRODUCT_NAME, /Money Moves™™/);
  assert.doesNotMatch(COPYRIGHT_NOTICE, /Money Moves™™/);
  assert.doesNotMatch(EDUCATIONAL_DISCLAIMER, /Money Moves™™/);
});

test("existing progression, post-game separation and five-round guard remain present", () => {
  const stages = read("./round-stages.ts");
  const rounds = read("./round-rules.ts");
  const dashboard = read("../components/round-dashboard.tsx");
  const results = read("../components/round-results.tsx");
  assert.match(stages, /"results-and-life-ledger"/);
  assert.match(rounds, /MAX_PLAYABLE_ROUND = 5/);
  assert.match(dashboard, /hidden=\{postGame\}/);
  assert.match(results, /View My Tax Life Recap/);
  assert.match(results, /onViewLedger=\{\(\) => changeView\("ledger"\)\}/);
  assert.match(read("./round-stages.ts"), /ACTIVE_ROUND_FLOW/);
});
