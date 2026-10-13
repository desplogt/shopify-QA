import { mergeViewports } from "../compare.js";
import { PURCHASE_STEPS, runPurchaseFlow, type PurchaseOptions, type PurchaseOutcome } from "../browser/purchase.js";
import { BOT_CHALLENGE_HINT, type StoreSession } from "../browser/session.js";
import type { CheckResult, FindingStatus, Observation, Severity, Viewport } from "../types.js";
import { statusFromFindings } from "../verdict.js";

type Classified = Observation & { severity: Severity; status: FindingStatus };

const stepName = (step: number | undefined) => (step ? PURCHASE_STEPS[step - 1] ?? `step ${step}` : "unknown step");

function describe(outcome: PurchaseOutcome): string {
  return `fails at step ${outcome.failedStep} "${stepName(outcome.failedStep)}": ${outcome.message}`;
}

function evidence(outcome: PurchaseOutcome, live?: PurchaseOutcome): Record<string, unknown> {
  return {
    step: outcome.failedStep,
    stepName: stepName(outcome.failedStep),
    product: outcome.product,
    diagnosis: outcome.diagnosis,
    jsErrors: outcome.jsErrors,
    screenshot: outcome.screenshot,
    trace: outcome.trace,
    notes: outcome.notes,
    live: live ? (live.status === "passed" ? "passes on live" : `live ${describe(live)}`) : undefined,
  };
}

/**
 * Compares the flow on live (control) and preview for one viewport:
 * live ✅ preview ❌ blocks; both ❌ at the same or a later step warns; preview ❌ earlier blocks.
 */
export function comparePurchase(live: PurchaseOutcome, preview: PurchaseOutcome): Classified | undefined {
  const page = preview.product ?? live.product ?? "/products";
  const base = { rule: "purchase-flow", page, viewport: preview.viewport };
  if (live.status === "passed" && preview.status === "passed") return undefined;
  if (live.status === "passed") {
    return { ...base, message: `The purchase flow ${describe(preview)}`, severity: "block", status: "new", evidence: evidence(preview, live) };
  }
  if (preview.status === "passed") {
    return { ...base, message: `The purchase flow is fixed (live ${describe(live)}).`, severity: "info", status: "resolved", evidence: evidence(live) };
  }
  if ((preview.failedStep ?? 0) < (live.failedStep ?? 0)) {
    return { ...base, message: `The purchase flow ${describe(preview)} — earlier than on live`, severity: "block", status: "new", evidence: evidence(preview, live) };
  }
  return { ...base, message: `The purchase flow ${describe(preview)} (also broken on live, not caused by this pull request)`, severity: "warn", status: "existing", evidence: evidence(preview, live) };
}

export interface PurchaseCheckInput extends PurchaseOptions {
  sessions: readonly StoreSession[];
}

export async function runPurchaseCheck(input: PurchaseCheckInput): Promise<CheckResult> {
  const result: CheckResult = { id: "purchase", title: "Purchase flow", mandatory: true, status: "pass", summary: "", findings: [] };
  // Live and preview run together per viewport; viewports run one after another to avoid the
  // request bursts that make Shopify answer 429.
  const viewports = [...new Set(input.sessions.map((session) => session.options.viewport))] as Viewport[];
  const outcomes: PurchaseOutcome[] = [];
  for (const viewport of viewports) {
    const sessions = input.sessions.filter((session) => session.options.viewport === viewport);
    outcomes.push(...(await Promise.all(sessions.map((session) => runPurchaseFlow(session, input)))));
  }

  const errors = outcomes.filter((outcome) => outcome.status === "error");
  if (errors.length > 0) {
    const configError = errors.find((outcome) => outcome.category === "config");
    result.status = "error";
    result.summary = "Could not be verified";
    result.failure = {
      category: configError ? "config" : (errors[0]!.category ?? "internal"),
      message: errors.map((outcome) => `${outcome.side} ${outcome.viewport}: ${outcome.message}`).join("\n"),
      hint: configError
        ? "List a product with stock under purchase.products in theme-qa.yml."
        : errors.some((outcome) => /bot protection/.test(outcome.message ?? ""))
          ? BOT_CHALLENGE_HINT
          : "Re-run the job.",
    };
    return result;
  }

  const classified = viewports.flatMap((viewport) => {
    const live = outcomes.find((outcome) => outcome.side === "live" && outcome.viewport === viewport);
    const preview = outcomes.find((outcome) => outcome.side === "preview" && outcome.viewport === viewport);
    const finding = live && preview ? comparePurchase(live, preview) : undefined;
    return finding ? [finding] : [];
  });
  result.findings = mergeViewports(classified);
  result.status = statusFromFindings(result.findings, true);
  const failing = result.findings.filter((finding) => finding.severity !== "info");
  result.summary =
    failing.length === 0
      ? `Add to cart → checkout works on ${viewports.join(" and ")}${
          outcomes.some((outcome) => outcome.notes.some((note) => /bot protection/.test(note)))
            ? " (the cart reached checkout; Shopify's bot protection kept the checkout page itself from loading)"
            : ""
        }`
      : failing
          .map((finding) => `${finding.severity === "warn" ? "Also broken on live: f" : "F"}ails at step ${finding.evidence?.step} "${finding.evidence?.stepName}" (${finding.viewports.join(", ")})`)
          .join("; ");
  return result;
}
