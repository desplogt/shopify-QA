import { redact } from "../normalize.js";
import type { CheckResult, CheckStatus, ErrorCategory, Finding, RunReport } from "../types.js";

/** Hidden marker used to find and update the single sticky comment on a pull request. */
export const COMMENT_MARKER = "<!-- theme-qa-report -->";

const RULE_LABELS: Record<string, string> = {
  "liquid-error": "Liquid error",
  "js-exception": "JavaScript exception",
  "theme-asset-error": "Theme asset failed",
  "page-status": "Page error",
  "console-error": "Console error",
  "resource-error": "Third-party resource error",
  "request-failed": "Request failed",
  "broken-image": "Broken image",
  "broken-link": "Broken link",
  "purchase-flow": "Purchase flow",
  "page-not-found-on-live": "Configured page missing on live",
};

const STATUS_ICONS: Record<CheckStatus, string> = { pass: "✅", warn: "⚠️", fail: "❌", error: "❌" };

const NEXT_STEPS: Record<ErrorCategory, string> = {
  theme: "Fix the issue and push: the check runs again automatically.",
  config: "Fix `theme-qa.yml` or the named secret, then re-run the job.",
  infra: "Re-run the job in GitHub Actions. If it keeps failing, check Shopify's status.",
  internal: "Re-run the job. If it repeats, report this log to the Theme QA maintainers.",
};

function ruleLabel(rule: string): string {
  if (rule.startsWith("theme-check:")) return `Theme Check · ${rule.slice("theme-check:".length)}`;
  return RULE_LABELS[rule] ?? rule;
}

function where(finding: Finding): string {
  const parts: string[] = [];
  if (finding.file) parts.push(`\`${finding.file}${finding.line ? `:${finding.line}` : ""}\``);
  else parts.push(`\`${finding.page}\``);
  if (finding.viewports.length > 0) parts.push(finding.viewports.join(" + "));
  if (finding.section) parts.push(`section \`${finding.section}\``);
  return parts.join(" · ");
}

function details(finding: Finding): string[] {
  const lines: string[] = [];
  const evidence = finding.evidence ?? {};
  if (finding.resource) lines.push(`Resource: \`${finding.resource}\``);
  if (typeof evidence.live === "string") lines.push(`Control: ${evidence.live}`);
  for (const problem of (evidence.diagnosis as string[] | undefined) ?? []) lines.push(`Diagnosis: ${problem}`);
  const jsErrors = (evidence.jsErrors as string[] | undefined) ?? [];
  if (jsErrors.length > 0) lines.push(`JavaScript errors at that moment: ${jsErrors.slice(0, 3).map((error) => `\`${error.slice(0, 200)}\``).join(", ")}`);
  for (const note of (evidence.notes as string[] | undefined) ?? []) lines.push(`Note: ${note}`);
  if (typeof evidence.stack === "string") lines.push(`Stack: \`${evidence.stack.split("\n")[1]?.trim() ?? ""}\``);
  return lines;
}

function findingItem(finding: Finding, index: number): string {
  const head = `${index + 1}. **${ruleLabel(finding.rule)}** — ${where(finding)}\n   ${finding.message}`;
  const extra = details(finding).map((line) => `   - ${line}`);
  return [head, ...extra].join("\n");
}

function checkLine(check: CheckResult): string {
  const label = check.mandatory ? check.title : `${check.title} (advisory)`;
  const result = check.status === "error" ? `Could not run — ${check.failure?.message.split("\n")[0] ?? "unknown error"}` : check.summary;
  return `| ${label} | ${STATUS_ICONS[check.status]} ${result.replace(/\|/g, "\\|")} |`;
}

function headline(report: RunReport, blocking: number, warnings: number): string {
  if (report.verdict === "passed") return "## ✅ Theme QA: passed";
  if (report.verdict === "warnings") return `## ⚠️ Theme QA: passed with warnings (${warnings})`;
  if (report.stageFailure) return `## ❌ Theme QA: blocked — ${report.stageFailure.stage} stage failed (${report.stageFailure.category})`;
  return blocking > 0 ? `## ❌ Theme QA: blocked (${blocking} new ${blocking === 1 ? "issue" : "issues"})` : "## ❌ Theme QA: blocked (a mandatory check could not be verified)";
}

function metaLine(report: RunReport): string {
  const { meta } = report;
  const parts: string[] = [];
  if (meta.theme) parts.push(`Theme: [${meta.theme.name}](${meta.theme.previewUrl}) (#${meta.theme.id})`);
  if (meta.commit) parts.push(`commit \`${meta.commit.slice(0, 7)}\``);
  parts.push(`${Math.max(1, Math.round(meta.durationMs / 1000))} s`);
  parts.push(`${meta.pages.length} pages × ${meta.viewports.join("/")}`);
  return parts.join(" · ");
}

export interface MarkdownOptions {
  secrets?: readonly string[];
  reportUrl?: string;
}

export function renderMarkdown(report: RunReport, options: MarkdownOptions = {}): string {
  const findings = report.checks.flatMap((check) => check.findings);
  const blocking = findings.filter((finding) => finding.severity === "block");
  const warnings = findings.filter((finding) => finding.severity === "warn");
  const existing = findings.filter((finding) => finding.status === "existing" && finding.severity === "info");
  const resolved = findings.filter((finding) => finding.status === "resolved");

  const sections: string[] = [COMMENT_MARKER, headline(report, blocking.length, warnings.length), metaLine(report)];

  if (report.stageFailure) {
    const failure = report.stageFailure;
    sections.push(`### What happened\n${failure.message}${failure.hint ? `\n\n**Next step:** ${failure.hint}` : ""}`);
  }

  if (report.checks.length > 0) {
    sections.push(["| Check | Result |", "|---|---|", ...report.checks.map(checkLine)].join("\n"));
  }

  const unverified = report.checks.filter((check) => check.status === "error" && check.failure);
  for (const check of unverified) {
    sections.push(`### ${check.title} could not be verified\n${check.failure!.message}${check.failure!.hint ? `\n\n**Next step:** ${check.failure!.hint}` : ""}`);
  }

  if (blocking.length > 0) sections.push(`### What blocks\n${blocking.slice(0, 10).map(findingItem).join("\n")}${blocking.length > 10 ? `\n\n…and ${blocking.length - 10} more in the full report.` : ""}`);
  if (warnings.length > 0) {
    sections.push(`<details><summary>⚠️ Warnings (${warnings.length})</summary>\n\n${warnings.slice(0, 20).map(findingItem).join("\n")}\n\n</details>`);
  }
  if (existing.length > 0 || resolved.length > 0) {
    const lines = [
      ...resolved.slice(0, 10).map((finding) => `- ✅ Resolved: **${ruleLabel(finding.rule)}** — ${where(finding)}: ${finding.message}`),
      ...existing.slice(0, 10).map((finding) => `- ℹ️ Pre-existing: **${ruleLabel(finding.rule)}** — ${where(finding)}: ${finding.message}`),
    ];
    sections.push(`<details><summary>ℹ️ Pre-existing (${existing.length}) and resolved (${resolved.length})</summary>\n\n${lines.join("\n")}\n\n</details>`);
  }

  const category = report.stageFailure?.category ?? unverified[0]?.failure?.category ?? (blocking.length > 0 ? "theme" : undefined);
  const next = category ? NEXT_STEPS[category] : report.verdict === "warnings" ? "Review the warnings before merging." : "Ready to merge.";
  sections.push(`### Next steps\n${next}${options.reportUrl ? ` Full report: ${options.reportUrl}` : ""}`);

  return redact(sections.join("\n\n"), options.secrets);
}
