import { createHash } from "node:crypto";

const playerIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const resumeTokenPattern = /^[A-Za-z0-9_-]{43}$/;

// Same validation and SHA-256 hashing used by the student setup and Round 1 routes.
export function readStudentCredentials(body: Record<string, unknown>) {
  if (
    typeof body.id !== "string" ||
    !playerIdPattern.test(body.id) ||
    typeof body.resumeToken !== "string" ||
    !resumeTokenPattern.test(body.resumeToken)
  ) {
    return null;
  }

  return {
    playerId: body.id,
    resumeTokenHash: createHash("sha256").update(body.resumeToken).digest("hex"),
  };
}