export type Viewport = "desktop" | "mobile";
export type ThemeSide = "live" | "preview";
export type Severity = "block" | "warn" | "info";
export type CheckStatus = "pass" | "warn" | "fail" | "error";
export type ErrorCategory = "theme" | "config" | "infra" | "internal";
export type Verdict = "passed" | "warnings" | "blocked";

/** A raw fact collected from one page load or one tool run, before comparison. */
export interface Observation {
  rule: string;
  message: string;
  /** Storefront path such as "/products/shirt", or a theme file for code findings. */
  page: string;
  viewport?: Viewport;
  /** Normalized Shopify section key, e.g. "main-product". */
  section?: string;
  /** Normalized resource URL for network findings. */
  resource?: string;
  file?: string;
  line?: number;
  evidence?: Record<string, unknown>;
}

export type FindingStatus = "new" | "existing" | "resolved";

export interface Finding extends Observation {
  severity: Severity;
  status: FindingStatus;
  /** Viewports where the same finding was observed; empty for code findings. */
  viewports: Viewport[];
}

export type CheckId = "technical" | "purchase" | "performance" | "visual";

export interface CheckFailure {
  category: ErrorCategory;
  message: string;
  hint?: string;
}

export interface CheckResult {
  id: CheckId;
  title: string;
  mandatory: boolean;
  status: CheckStatus;
  summary: string;
  findings: Finding[];
  /** Set when status is "error": the check could not run. */
  failure?: CheckFailure;
}

export type StageId = "prepare" | "build" | "theme" | "verify" | "checks" | "report";

export interface StageFailure extends CheckFailure {
  stage: StageId;
}

export interface RunMeta {
  store: string;
  startedAt: string;
  durationMs: number;
  commit?: string;
  pullRequest?: number;
  theme?: { id: number; name: string; previewUrl: string };
  liveThemeId?: number;
  pages: string[];
  viewports: Viewport[];
}

export interface RunReport {
  verdict: Verdict;
  stageFailure?: StageFailure;
  checks: CheckResult[];
  meta: RunMeta;
}
