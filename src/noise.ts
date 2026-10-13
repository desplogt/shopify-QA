import type { Observation } from "./types.js";

export interface IgnoreRule {
  rule?: string;
  /** Case-insensitive substring matched against the message, resource, and file. */
  match?: string;
  /** Exact storefront path; omit to apply to every page. */
  page?: string;
  reason: string;
}

const NOISY_CONSOLE_MESSAGES = [
  /^Failed to load resource/i, // duplicates the network observation
  /frame-ancestors|X-Frame-Options/i,
  /\[Report Only\]/i,
  /Framing ['"]?https:\/\/shop\.app/i,
];

const NOISY_REQUEST_FAILURES = [/ERR_ABORTED/i, /ERR_BLOCKED_BY_CLIENT/i, /blockedbyclient/i];

function isAnalyticsEndpoint(resource: string | undefined): boolean {
  if (!resource) return false;
  try {
    const url = new URL(resource);
    return (
      url.hostname.endsWith("shopifysvc.com") ||
      url.pathname.startsWith("/.well-known/shopify/monorail") ||
      url.pathname.startsWith("/api/collect")
    );
  } catch {
    return false;
  }
}

/** Known browser and Shopify infrastructure noise that never indicates a theme defect. */
export function isNoise(observation: Observation): boolean {
  const location = String(observation.evidence?.location ?? "");
  switch (observation.rule) {
    case "console-error":
      return NOISY_CONSOLE_MESSAGES.some((pattern) => pattern.test(observation.message)) || /preview[-_]?bar/i.test(location);
    case "request-failed":
    case "theme-asset-error": {
      const failure = String(observation.evidence?.failure ?? "");
      return NOISY_REQUEST_FAILURES.some((pattern) => pattern.test(failure)) || isAnalyticsEndpoint(observation.resource);
    }
    case "resource-error": {
      const status = Number(observation.evidence?.status);
      return [401, 403, 429].includes(status) || isAnalyticsEndpoint(observation.resource);
    }
    default:
      return false;
  }
}

export function isIgnored(observation: Observation, rules: readonly IgnoreRule[]): boolean {
  return rules.some((rule) => {
    if (rule.rule && rule.rule !== observation.rule) return false;
    if (rule.page && rule.page !== observation.page) return false;
    if (rule.match) {
      const haystack = [observation.message, observation.resource, observation.file].filter(Boolean).join("\n").toLowerCase();
      if (!haystack.includes(rule.match.toLowerCase())) return false;
    }
    return Boolean(rule.rule || rule.match || rule.page);
  });
}
