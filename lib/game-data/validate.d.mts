export type DatasetValidationIssue = {
  severity: "error" | "warning";
  code: string;
  message: string;
  source?: unknown;
};

export function validateGameDataset(dataset: unknown): {
  valid: boolean;
  issues: DatasetValidationIssue[];
};
