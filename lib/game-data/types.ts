export type SourceValue = string | number | null;

export type WorkbookSource = {
  sheet: string;
  row: number;
  formulas?: Record<string, string>;
};

export type IncomeComponent = {
  type: string;
  originalType?: string;
  normalizationNote?: string;
  amount: number;
  sourceDescription: string;
};

export type GameCard = {
  id: SourceValue;
  cardTypeNo: SourceValue;
  deck: SourceValue;
  subcategory: SourceValue;
  color: SourceValue;
  name: SourceValue;
  description: SourceValue;
  amount: SourceValue;
  effectType: SourceValue;
  effectValue: SourceValue;
  durationRounds: SourceValue;
  taxCategory: SourceValue;
  taxRule: SourceValue;
  auditRisk: SourceValue;
  pathwayRule: SourceValue;
  roundRule: SourceValue;
  playerChoiceRequired: SourceValue;
  physicalReminder: SourceValue;
  educationConcept: SourceValue;
  educationMessage: SourceValue;
  resultMessage: SourceValue;
  graphic: SourceValue;
  developerNotes: SourceValue;
  active: SourceValue;
  incomeComponents?: IncomeComponent[];
  investment?: {
    assetValue: number;
    recurringIncomePerEligibleRound: number;
    recurringIncomeActivation: string;
  };
  source: WorkbookSource;
};

export type Pathway = {
  id: SourceValue;
  number: SourceValue;
  name: SourceValue;
  shortDescription: SourceValue;
  startingIncomeType: SourceValue;
  startingCondition: SourceValue;
  advantageName: SourceValue;
  advantageRule: SourceValue;
  challengeName: SourceValue;
  challengeRule: SourceValue;
  incomeRule: SourceValue;
  lifeEventRule: SourceValue;
  deductionRule: SourceValue;
  prepaymentRule: SourceValue;
  wildcardRule: SourceValue;
  auditRule: SourceValue;
  retirementRule: SourceValue;
  physicalReminder: SourceValue;
  educationFocus: SourceValue;
  educationMessage: SourceValue;
  resultMessage: SourceValue;
  graphic: SourceValue;
  developerNotes: SourceValue;
  active: SourceValue;
  source: WorkbookSource;
};

export type WorkbookRuleRow = {
  fields: Record<string, SourceValue>;
  source: WorkbookSource;
};

export type DeveloperNote = {
  id: SourceValue;
  area: SourceValue;
  text: SourceValue;
  relatedData: SourceValue;
  priority: SourceValue;
  source: WorkbookSource;
};

export type StartingDecision = {
  id: string;
  name: string;
  startingCash: number;
  startingDebt: number;
};

export type ApprovedGameRules = {
  startingDecisions: StartingDecision[];
  studentLoan: {
    principalPaymentPerRound: number;
    paymentTiming: string;
    capAtOutstandingBalance: boolean;
    interest: number;
    automaticTaxDeduction: boolean;
  };
  homeownerStatus: {
    persistsUntilQualifyingLifeEvent: boolean;
  };
  taxPrepayment: {
    fixedAtApplication: boolean;
    auditChangesFinalLiabilityNotOriginalPayment: boolean;
  };
  physicalDeck: {
    sharedAcrossStudents: boolean;
    draw: string;
    uniqueDeckPerStudentRequired: boolean;
  };
  roundCount: number;
  retirement: {
    standardRetirementStartRound: number;
    earlyRetirementPathwayId: string;
    earlyRetirementStartRound: number;
    earlyRetirementIncomeGuarantee: {
      annualAmount: number;
      socialSecurity: number;
      pensionAndInvestment: number;
    };
    protectedIncomeRule: string;
    increaseClassification: string;
    increaseClassificationStatus: string;
    separatelyAcquiredInvestmentsAreAdditional: boolean;
    duplicateInvestmentIncomeRule: string;
  };
  stageOrder: string[];
  betaTaxYear: number;
  businessIncome: {
    entityTreatment: string;
    adjustmentPercentage: number;
    status: string;
  };
  socialSecurity: {
    taxableFractionWhenRetirementOrInvestmentIncomeExists: number;
    nontaxableWhenOnlyIncome: boolean;
  };
  audit: {
    adjustmentCardId: string;
    omittedIncomeAmount: number;
    penaltyPercentage: number;
  };
  educationBenefit: {
    pathwayId: string;
    enhancementAmount: number;
    maximumBenefit: number;
  };
  medicalDeduction: {
    adjustedIncomeThresholdPercentage: number;
  };
  credits: {
    applyCardIndicatedCreditWithoutExternalComplexThresholds: boolean;
    retainCardApplicabilityValidation: boolean;
  };
  incomeClassification: string[];
  auditPenaltyPercentage: number;
  livingCostBands: Array<{
    lowerBound: number;
    upperBound: number | null;
    rate: number;
  }>;
  cardApplicability: Array<{
    cardIds: string[];
    condition: string;
    onIneligible: string;
    source: string[];
  }>;
  taxCardTreatment: Array<{
    treatment: string;
    cardIds: string[];
    percentage?: number | null;
    status: string;
    [key: string]: unknown;
  }>;
};

export type GameDataSourceIssue = Record<
  string,
  string | number | boolean | string[] | null | undefined
>;

export type GameDataset = {
  schemaVersion: number;
  sourceWorkbook: string;
  sourceSheets: string[];
  workbookReferences: {
    cardProcessingFlow: string[];
    roundResultsFields: string[];
    lifeLedgerColumns: string[];
    outputsAreIllustrative: boolean;
  };
  cards: GameCard[];
  pathways: Pathway[];
  taxRules: {
    filingStatuses: WorkbookRuleRow[];
    brackets: WorkbookRuleRow[];
    credits: WorkbookRuleRow[];
    livingCostExamples: WorkbookRuleRow[];
  };
  developerNotes: DeveloperNote[];
  gameRules: {
    approved: ApprovedGameRules;
    workbook: Record<string, string[]>;
    sourceIssues: GameDataSourceIssue[];
    taxTreatmentCardIds: Record<string, string[]>;
  };
};
