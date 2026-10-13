import { normalizeText } from "./normalize.js";
import { isIgnored, isNoise, type IgnoreRule } from "./noise.js";
import type { Finding, FindingStatus, Observation, Severity } from "./types.js";

/**
 * Theme Check offenses use the rule `theme-check:<CheckName>`. Only checks that break
 * rendering or the theme editor block; everything else is advisory.
 */
export const DEFAULT_BLOCKING_THEME_CHECKS = [
  "LiquidHTMLSyntaxError",
  "JSONSyntaxError",
  "ValidJSON",
  "MissingTemplate",
  "MissingAsset",
  "UnknownFilter",
  "TranslationKeyExists",
  "ValidSchema",
  "ValidSchemaName",
  "UniqueSettingId",
  "JSONMissingBlock",
  "ValidBlockTarget",
  "ValidLocalBlocks",
  "ValidStaticBlockType",
  "ValidSettingsKey",
  "ValidVisibleIf",
  "RequiredLayoutThemeObject",
  "ValidContentForArguments",
] as const;

const BLOCKING_RULES = new Set(["liquid-error", "js-exception", "theme-asset-error", "page-status"]);

export interface ComparisonOptions {
  ignore?: readonly IgnoreRule[];
  blockingThemeChecks?: readonly string[];
}

/** Identity of an observation across themes. Line numbers are excluded because they shift. */
export function comparisonKey(observation: Observation, includeViewport = true): string {
  return JSON.stringify([
    observation.rule,
    observation.page,
    includeViewport ? (observation.viewport ?? null) : null,
    observation.section ?? null,
    observation.resource ?? null,
    observation.file ?? null,
    normalizeText(observation.message),
  ]);
}

export interface ObservationDiff {
  added: Observation[];
  existing: Observation[];
  resolved: Observation[];
}

/** Multiset comparison: two identical live errors and three in the preview means exactly one is new. */
export function diffObservations(live: readonly Observation[], preview: readonly Observation[]): ObservationDiff {
  const remaining = new Map<string, Observation[]>();
  for (const observation of live) {
    const key = comparisonKey(observation);
    remaining.set(key, [...(remaining.get(key) ?? []), observation]);
  }
  const added: Observation[] = [];
  const existing: Observation[] = [];
  for (const observation of preview) {
    const matches = remaining.get(comparisonKey(observation));
    if (matches?.length) {
      matches.pop();
      existing.push(observation);
    } else {
      added.push(observation);
    }
  }
  return { added, existing, resolved: [...remaining.values()].flat() };
}

export function severityFor(observation: Observation, status: FindingStatus, blockingThemeChecks: ReadonlySet<string>): Severity {
  if (status !== "new") return "info";
  if (BLOCKING_RULES.has(observation.rule)) return "block";
  if (observation.rule.startsWith("theme-check:")) {
    return blockingThemeChecks.has(observation.rule.slice("theme-check:".length)) ? "block" : "warn";
  }
  return "warn";
}

const SEVERITY_ORDER: Record<Severity, number> = { block: 0, warn: 1, info: 2 };
const STATUS_ORDER: Record<FindingStatus, number> = { new: 0, existing: 1, resolved: 2 };

/** Reports the same finding once when it appears on several viewports. */
export function mergeViewports(findings: readonly (Observation & { severity: Severity; status: FindingStatus })[]): Finding[] {
  const merged = new Map<string, Finding>();
  for (const { viewport, ...finding } of findings) {
    const key = `${finding.status}|${comparisonKey(finding, false)}`;
    const current = merged.get(key);
    if (!current) {
      merged.set(key, { ...finding, viewports: viewport ? [viewport] : [] });
      continue;
    }
    if (viewport && !current.viewports.includes(viewport)) current.viewports.push(viewport);
    if (SEVERITY_ORDER[finding.severity] < SEVERITY_ORDER[current.severity]) current.severity = finding.severity;
  }
  for (const finding of merged.values()) finding.viewports.sort();
  return [...merged.values()].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || STATUS_ORDER[a.status] - STATUS_ORDER[b.status],
  );
}

/** Filters noise and configured exceptions, compares live against preview, and classifies the result. */
export function buildFindings(live: readonly Observation[], preview: readonly Observation[], options: ComparisonOptions = {}): Finding[] {
  const ignore = options.ignore ?? [];
  const keep = (observation: Observation) => !isNoise(observation) && !isIgnored(observation, ignore);
  const blocking = new Set(options.blockingThemeChecks ?? DEFAULT_BLOCKING_THEME_CHECKS);
  const diff = diffObservations(live.filter(keep), preview.filter(keep));
  const classify = (status: FindingStatus) => (observation: Observation) => ({
    ...observation,
    status,
    severity: severityFor(observation, status, blocking),
  });
  return mergeViewports([
    ...diff.added.map(classify("new")),
    ...diff.existing.map(classify("existing")),
    ...diff.resolved.map(classify("resolved")),
  ]);
}
