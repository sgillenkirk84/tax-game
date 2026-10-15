export const startingScenarios = {
  "financial-head-start": {
    name: "Financial Head Start",
    description: "You begin with a cash cushion and no student debt.",
    cash: 10000,
    debt: 0,
  },
  "starting-from-scratch": {
    name: "Starting From Scratch",
    description: "You begin with no extra cash and no student debt.",
    cash: 0,
    debt: 0,
  },
  "student-loan-debt": {
    name: "Student Debt",
    description: "You begin with no extra cash and $20,000 in student debt to pay down.",
    cash: 0,
    debt: 20000,
  },
};

export type StartingScenario = {
  scenarioId: keyof typeof startingScenarios;
  startingCash: number;
  startingStudentLoanDebt: number;
};

export function readStartingScenario(value: unknown): StartingScenario {
  if (!value || typeof value !== "object" ||
    !("scenarioId" in value) || typeof value.scenarioId !== "string" ||
    !Object.hasOwn(startingScenarios, value.scenarioId)) {
    throw new Error("The saved starting scenario is invalid. Please contact your teacher.");
  }
  const scenarioId = value.scenarioId as keyof typeof startingScenarios;
  const expected = startingScenarios[scenarioId];
  if (!("startingCash" in value) || value.startingCash !== expected.cash ||
    !("startingStudentLoanDebt" in value) || value.startingStudentLoanDebt !== expected.debt) {
    throw new Error("The saved starting balances do not match the scenario. Please contact your teacher.");
  }
  return { scenarioId, startingCash: value.startingCash, startingStudentLoanDebt: value.startingStudentLoanDebt };
}
