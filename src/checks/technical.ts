import { buildFindings } from "../compare.js";
import type { IgnoreRule } from "../noise.js";
import { brokenLinkObservations, checkLinks, scanPage, type PageScan } from "../browser/scan.js";
import type { StoreSession } from "../browser/session.js";
import type { CheckFailure, CheckResult, Finding, Observation } from "../types.js";
import { statusFromFindings } from "../verdict.js";

export interface ThemeCheckDiffResult {
  base: Observation[];
  head: Observation[];
}

export interface TechnicalCheckInput {
  sessions: readonly StoreSession[];
  pages: readonly string[];
  ignore: readonly IgnoreRule[];
  blockingThemeChecks: readonly string[];
  /** Offenses in files changed by the pull request; a failure makes the check unverifiable. */
  themeCheck?: ThemeCheckDiffResult | { failure: CheckFailure };
}

async function scanWithRetry(session: StoreSession, path: string): Promise<PageScan> {
  const first = await scanPage(session, path);
  return first.loadError ? scanPage(session, path) : first;
}

function summarize(findings: readonly Finding[]): string {
  const count = (predicate: (finding: Finding) => boolean) => findings.filter(predicate).length;
  const parts = [
    `${count((finding) => finding.severity === "block")} blocking`,
    `${count((finding) => finding.severity === "warn")} warnings`,
    `${count((finding) => finding.status === "existing" && finding.severity === "info")} pre-existing`,
  ];
  const resolved = count((finding) => finding.status === "resolved");
  if (resolved > 0) parts.push(`${resolved} resolved`);
  return parts.join(" · ");
}

export async function runTechnicalCheck(input: TechnicalCheckInput): Promise<CheckResult> {
  const result: CheckResult = { id: "technical", title: "Technical errors", mandatory: true, status: "pass", summary: "", findings: [] };
  const scans = (
    await Promise.all(
      input.sessions.map(async (session) => {
        const sessionScans: PageScan[] = [];
        for (const path of input.pages) sessionScans.push(await scanWithRetry(session, path));
        return sessionScans;
      }),
    )
  ).flat();

  const failures: string[] = [];
  const live: Observation[] = [];
  const preview: Observation[] = [];
  const extra: Finding[] = [];

  const linkSession = input.sessions.find((session) => session.options.side === "live") ?? input.sessions[0];
  const linkResults = linkSession ? await checkLinks(linkSession.context.request, scans.flatMap((scan) => scan.links)) : new Map();

  for (const scan of scans) {
    const session = input.sessions.find((candidate) => candidate.options.side === scan.side && candidate.options.viewport === scan.viewport)!;
    const target = scan.side === "live" ? live : preview;
    if (scan.loadError) {
      if (scan.side === "live") failures.push(`Could not load ${scan.path} on the live theme (${scan.viewport}): ${scan.loadError}`);
      else target.push({ rule: "page-status", page: scan.path, viewport: scan.viewport, message: `Page failed to load: ${scan.loadError}` });
      continue;
    }
    if (scan.themeId !== session.options.themeId) {
      failures.push(`${scan.path} (${scan.side}, ${scan.viewport}) rendered theme ${scan.themeId ?? "unknown"} instead of ${session.options.themeId}.`);
      continue;
    }
    if (scan.side === "live" && scan.status === 404) {
      extra.push({ rule: "page-not-found-on-live", page: scan.path, message: `${scan.path} returns 404 on the live theme; update the pages list in theme-qa.yml.`, severity: "warn", status: "existing", viewports: [scan.viewport] });
    }
    target.push(...scan.observations, ...brokenLinkObservations(scan, linkResults));
  }

  if (input.themeCheck && "failure" in input.themeCheck) failures.push(`Theme Check could not run: ${input.themeCheck.failure.message}`);
  const themeCheck = input.themeCheck && "base" in input.themeCheck ? input.themeCheck : { base: [], head: [] };

  result.findings = [
    ...buildFindings([...live, ...themeCheck.base], [...preview, ...themeCheck.head], { ignore: input.ignore, blockingThemeChecks: input.blockingThemeChecks }),
    ...dedupe(extra),
  ];
  if (failures.length > 0) {
    result.status = "error";
    result.failure = { category: "infra", message: failures.join("\n"), hint: "Re-run the job. If a page is gone from the store, update theme-qa.yml." };
    result.summary = "Could not be verified";
    return result;
  }
  result.status = statusFromFindings(result.findings, true);
  result.summary = summarize(result.findings);
  return result;
}

function dedupe(findings: Finding[]): Finding[] {
  const merged = new Map<string, Finding>();
  for (const finding of findings) {
    const key = `${finding.rule}|${finding.page}`;
    const current = merged.get(key);
    if (current) current.viewports = [...new Set([...current.viewports, ...finding.viewports])].sort();
    else merged.set(key, { ...finding });
  }
  return [...merged.values()];
}
