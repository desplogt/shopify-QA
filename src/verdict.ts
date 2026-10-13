import type { CheckId, CheckResult, CheckStatus, Finding, StageFailure, Verdict } from "./types.js";

export const MANDATORY_CHECKS: readonly CheckId[] = ["technical", "purchase"];

export function statusFromFindings(findings: readonly Finding[], mandatory: boolean): CheckStatus {
  if (findings.some((finding) => finding.severity === "block")) return mandatory ? "fail" : "warn";
  if (findings.some((finding) => finding.severity === "warn")) return "warn";
  return "pass";
}

/**
 * Fails closed: a stage failure, a mandatory check that failed or could not run,
 * or a mandatory check that is missing from the run all block the merge.
 */
export function computeVerdict(stageFailure: StageFailure | undefined, checks: readonly CheckResult[]): Verdict {
  if (stageFailure) return "blocked";
  for (const id of MANDATORY_CHECKS) {
    const check = checks.find((candidate) => candidate.id === id);
    if (!check || check.status === "fail" || check.status === "error") return "blocked";
  }
  return checks.some((check) => check.status !== "pass") ? "warnings" : "passed";
}
