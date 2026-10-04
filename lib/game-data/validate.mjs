const expectedDeckCounts = {
  Income: 16,
  Retirement: 10,
  "Life Event": 10,
  Deduction: 10,
  "Tax Prepayment": 10,
  Wildcard: 10,
  "Audit Result": 8,
};

function valueFor(row, key) {
  return row?.fields?.[key];
}

export function validateGameDataset(dataset) {
  const issues = [];
  const add = (severity, code, message, source) => {
    issues.push({ severity, code, message, source });
  };
  const cards = dataset?.cards;
  const pathways = dataset?.pathways;

  if (!Array.isArray(cards) || cards.length !== 74) {
    add("error", "CARD_COUNT", `Expected 74 gameplay cards; found ${cards?.length ?? "no card array"}.`);
  }
  if (!Array.isArray(pathways) || pathways.length !== 8) {
    add("error", "PATHWAY_COUNT", `Expected 8 Pathways; found ${pathways?.length ?? "no Pathway array"}.`);
  }
  if (!Array.isArray(cards) || !Array.isArray(pathways)) {
    return { valid: false, issues };
  }

  const ids = new Map();
  const trimmedIds = new Map();
  const deckCounts = new Map();
  for (const card of cards) {
    if (typeof card.id !== "string" || !card.id.trim()) {
      add("error", "CARD_ID_REQUIRED", "Every card needs a source Card ID.", card.source);
      continue;
    }

    if (ids.has(card.id)) {
      add("error", "DUPLICATE_CARD_ID", `Duplicate source Card ID ${JSON.stringify(card.id)}.`, card.source);
    }
    ids.set(card.id, card.source);
    const trimmedId = card.id.trim();
    if (trimmedId !== card.id) {
      add("warning", "CARD_ID_WHITESPACE", `Card ID has outer whitespace and was preserved: ${JSON.stringify(card.id)}.`, card.source);
    }
    if (trimmedIds.has(trimmedId)) {
      add("error", "DUPLICATE_NORMALIZED_CARD_ID", `Card IDs collide after trimming: ${trimmedId}.`, card.source);
    }
    trimmedIds.set(trimmedId, card.source);

    const deck = typeof card.deck === "string" ? card.deck.trim() : "";
    if (!deck || typeof card.name !== "string" || !card.name.trim() || typeof card.effectType !== "string") {
      add("error", "CARD_REQUIRED_FIELDS", `Card ${JSON.stringify(card.id)} is missing a deck, name, or effect type.`, card.source);
    }
    deckCounts.set(deck, (deckCounts.get(deck) ?? 0) + 1);

    const paddedFields = Object.entries(card)
      .filter(([key, value]) => key !== "source" && typeof value === "string" && value !== value.trim())
      .map(([key]) => key);
    if (paddedFields.length) {
      add(
        "warning",
        "CARD_FIELD_WHITESPACE",
        `Card ${JSON.stringify(card.id)} has outer whitespace in: ${paddedFields.join(", ")}. Values were not normalized.`,
        card.source
      );
    }

    if (deck === "Income" && card.effectType?.trim() === "Income") {
      if (typeof card.effectValue !== "number" || typeof card.amount !== "number") {
        add("error", "INCOME_EFFECT_NOT_NUMERIC", `Income card ${card.id} needs numeric Amount and Effect Value.`, card.source);
      } else if (card.effectValue !== card.amount) {
        add("error", "INCOME_AMOUNT_MISMATCH", `Income card ${card.id} has different Amount and Effect Value.`, card.source);
      }
    }
    if (card.active?.trim() !== "Yes") {
      add("error", "CARD_NOT_ACTIVE", `Card ${card.id} is not marked active in the source.`, card.source);
    }
    if (deck === "Retirement") {
      const total = card.incomeComponents?.reduce((sum, component) => sum + component.amount, 0);
      if (!Array.isArray(card.incomeComponents) || total !== card.amount) {
        add("error", "RETIREMENT_COMPONENTS", `Retirement card ${card.id} needs components totaling its card amount.`, card.source);
      }
      if (
        card.incomeComponents?.some(
          (component) =>
            component.type === "retirement-or-investment-income" &&
            component.originalType &&
            !component.normalizationNote
        )
      ) {
        add("error", "RETIREMENT_COMPONENT_NORMALIZATION", `Retirement card ${card.id} has a normalized component without a provenance note.`, card.source);
      }
      if (card.incomeComponents?.some((component) => component.type.includes("or-"))) {
        add("warning", "RETIREMENT_COMPONENT_CLASSIFICATION", `Retirement card ${card.id} combines source categories in the workbook.`, card.source);
      }
    }
    if (deck === "Wildcard" && /^WILD-00[7-9]$|^WILD-010$/.test(trimmedId)) {
      if (
        card.investment?.assetValue !== card.amount ||
        card.investment?.recurringIncomePerEligibleRound !== card.effectValue
      ) {
        add("error", "INVESTMENT_COMPONENTS", `Investment card ${card.id} has inconsistent asset or recurring-income values.`, card.source);
      }
    }
  }

  for (const [deck, expected] of Object.entries(expectedDeckCounts)) {
    const actual = deckCounts.get(deck) ?? 0;
    if (actual !== expected) {
      add("error", "DECK_COUNT", `Expected ${expected} ${deck} cards; found ${actual}.`);
    }
  }

  const pathwayIds = new Set();
  for (const pathway of pathways) {
    if (typeof pathway.id !== "string" || !pathway.id.trim() || pathwayIds.has(pathway.id)) {
      add("error", "PATHWAY_ID", `Pathway ID is missing or duplicated: ${String(pathway.id)}.`, pathway.source);
    }
    pathwayIds.add(pathway.id);
    if (pathway.active?.trim() !== "Yes") {
      add("error", "PATHWAY_NOT_ACTIVE", `Pathway ${pathway.id} is not marked active.`, pathway.source);
    }
  }

  const taxRows = [
    ...(dataset.taxRules?.filingStatuses ?? []),
    ...(dataset.taxRules?.brackets ?? []),
    ...(dataset.taxRules?.credits ?? []),
  ];
  for (const row of taxRows) {
    if (valueFor(row, "Tax Year") !== 2025) {
      add("error", "TAX_YEAR", "Beta tax rows must use tax year 2025.", row.source);
    }
  }

  for (const status of dataset.taxRules?.filingStatuses ?? []) {
    const statusCode = valueFor(status, "Filing Status Code");
    const brackets = (dataset.taxRules?.brackets ?? []).filter(
      (row) => valueFor(row, "Filing Status Code") === statusCode
    );
    const numbers = brackets.map((row) => valueFor(row, "Bracket No")).sort((a, b) => a - b);
    if (brackets.length !== 7 || numbers.some((number, index) => number !== index + 1)) {
      add("error", "BRACKET_COVERAGE", `Filing status ${statusCode} must have seven ordered brackets.`, status.source);
    }
  }

  const approved = dataset.gameRules?.approved;
  if (
    approved?.businessIncome?.adjustmentPercentage !== 0.09 ||
    approved?.auditPenaltyPercentage !== 0.2 ||
    approved?.audit?.penaltyPercentage !== 0.2 ||
    approved?.educationBenefit?.enhancementAmount !== 500 ||
    approved?.educationBenefit?.maximumBenefit !== 3000 ||
    approved?.medicalDeduction?.adjustedIncomeThresholdPercentage !== 0.075 ||
    approved?.socialSecurity?.taxableFractionWhenRetirementOrInvestmentIncomeExists !== 0.5
  ) {
    add("error", "APPROVED_TAX_RULES", "Approved simplified tax rates or amounts are missing or inconsistent.");
  }
  if (approved?.roundCount !== 5 || approved?.betaTaxYear !== 2025) {
    add("error", "APPROVED_GAME_RULES", "Expected the approved five-round 2025 beta configuration.");
  }
  const retirementRules = approved?.retirement;
  const retirementGuarantee = retirementRules?.earlyRetirementIncomeGuarantee;
  if (
    retirementRules?.standardRetirementStartRound !== 5 ||
    retirementRules?.earlyRetirementPathwayId !== "PATH-008" ||
    retirementRules?.earlyRetirementStartRound !== 4 ||
    !pathwayIds.has(retirementRules?.earlyRetirementPathwayId) ||
    retirementGuarantee?.annualAmount !== 42000 ||
    retirementGuarantee?.socialSecurity !== 12000 ||
    retirementGuarantee?.pensionAndInvestment !== 30000 ||
    retirementGuarantee.socialSecurity + retirementGuarantee.pensionAndInvestment !==
      retirementGuarantee.annualAmount ||
    retirementRules?.protectedIncomeRule !== "highest-annual-retirement-income-through-round-5" ||
    retirementRules?.increaseClassification !== "preserve-original-card-income-components" ||
    retirementRules?.increaseClassificationStatus !== "approved" ||
    retirementRules?.separatelyAcquiredInvestmentsAreAdditional !== true ||
    retirementRules?.duplicateInvestmentIncomeRule !== "count-each-investment-event-once-per-round"
  ) {
    add(
      "error",
      "APPROVED_RETIREMENT_RULES",
      "Approved retirement timing, PATH-008 guaranteed income, or conflict handling is missing or inconsistent."
    );
  }
  const retirementCards = cards.filter((card) => card.deck === "Retirement");
  if (
    retirementCards.length !== 10 ||
    retirementCards.some(
      (card) =>
        card.effectType !== "Retirement Income" ||
        card.durationRounds !== 1 ||
        typeof card.amount !== "number" ||
        card.effectValue !== card.amount
    )
  ) {
    add(
      "error",
      "RETIREMENT_CARD_ANNUAL_OUTCOME",
      "All ten Retirement cards must define a single consistent round of income."
    );
  }
  const cardIdSet = new Set(cards.map((card) => card.id?.trim()).filter(Boolean));
  for (const treatment of approved?.taxCardTreatment ?? []) {
    for (const cardId of treatment.cardIds ?? []) {
      if (!cardIdSet.has(cardId.trim())) {
        add("error", "TAX_CARD_REFERENCE", `Tax treatment ${treatment.treatment} references unknown card ${cardId}.`);
      }
    }
    if (
      (treatment.treatment === "business-income-adjustment" ||
        treatment.treatment === "audit-penalty") &&
      treatment.percentage !==
        (treatment.treatment === "business-income-adjustment" ? 0.09 : 0.2)
    ) {
      add("error", "TAX_TREATMENT_PERCENTAGE", `${treatment.treatment} does not match its approved percentage.`);
    }
  }
  for (const applicability of approved?.cardApplicability ?? []) {
    for (const cardId of applicability.cardIds ?? []) {
      if (!cardIdSet.has(cardId.trim()) && !pathwayIds.has(cardId.trim())) {
        add("error", "APPLICABILITY_CARD_REFERENCE", `Applicability rule references unknown card ${cardId}.`);
      }
    }
  }

  for (const issue of dataset.gameRules?.sourceIssues ?? []) {
    if (issue.status === "unresolved-source-error") {
      add(
        "error",
        "UNRESOLVED_SOURCE_VALUE",
        `${issue.id} ${issue.field} is ${JSON.stringify(issue.rawValue)}; workbook note expects ${JSON.stringify(issue.expectedByCardAmount)}.`,
        { sheet: "Card Deck", row: 9 }
      );
    }
  }

  const correctedW2Card = cards.find((card) => card.id === "INC-W2-007");
  const documentedW2Correction = dataset.sourceCorrections?.find(
    (correction) => correction.id === "INC-W2-007"
  );
  if (
    correctedW2Card?.effectValue !== 90000 ||
    correctedW2Card?.source?.originalValues?.effectValue !== "Income" ||
    !documentedW2Correction?.fields?.effectValue ||
    documentedW2Correction.fields.effectValue.originalValue !== "Income" ||
    documentedW2Correction.fields.effectValue.normalizedValue !== 90000
  ) {
    add(
      "error",
      "W2_CORRECTION_PROVENANCE",
      "INC-W2-007 must use 90000 and retain the original workbook value plus correction provenance.",
      correctedW2Card?.source
    );
  }

  return { valid: !issues.some((issue) => issue.severity === "error"), issues };
}
