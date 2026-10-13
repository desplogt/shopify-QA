/**
 * Normalization makes observations from two different themes comparable.
 * Shopify serves each theme from theme-numbered paths and generates
 * theme-specific identifiers; without this, every finding would look new.
 */

const VOLATILE_PARAMS = new Set([
  "v",
  "preview_theme_id",
  "preview_token",
  "_ab",
  "_bt",
  "_fd",
  "_fid",
  "_pos",
  "_psq",
  "_sc",
  "_sid",
  "_ss",
  "oseid",
  "pr_prod_strat",
  "pr_rec_id",
  "pr_rec_pid",
  "pr_ref_pid",
  "pr_seq",
]);

const SENSITIVE_PARAMS = ["preview_token", "_bt", "key", "password", "token", "access_token", "signature"];
const SENSITIVE_PARAM_PATTERN = new RegExp(`([?&](?:${SENSITIVE_PARAMS.join("|")})=)[^&\\s"'<>]+`, "gi");

// `/cdn/shop/t/12/assets/x.js` and `.../s/files/1/0001/t/12/assets/x.js` both become `/t/*/assets/x.js`.
const THEME_NUMBER_IN_PATH = /\/t\/\d+\/(?=(?:compiled_)?assets\/)/g;
const URL_IN_TEXT = /https?:\/\/[^\s"'<>()]+/g;
const LINE_COLUMN_SUFFIX = /:\d+(?::\d+)?$/;

export function normalizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (VOLATILE_PARAMS.has(key) || key.startsWith("utm_")) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  url.pathname = url.pathname.replace(THEME_NUMBER_IN_PATH, "/t/*/");
  return url.toString();
}

/** Normalizes every URL inside free text and drops `:line:column` suffixes that shift between themes. */
export function normalizeText(text: string): string {
  return text.replace(URL_IN_TEXT, (match) => normalizeUrl(match.replace(LINE_COLUMN_SUFFIX, "")));
}

/** Storefront path used to identify a page across themes, e.g. "/products/shirt". */
export function pagePath(raw: string): string {
  try {
    const url = new URL(normalizeUrl(raw));
    return `${url.pathname.replace(/\/+$/, "") || "/"}${url.search}`;
  } catch {
    return raw;
  }
}

/**
 * `shopify-section-template--16754345869410__main` → `main`.
 * The numeric part is the template's ID, which differs between duplicated themes.
 */
export function sectionKey(id: string): string {
  return id
    .replace(/^shopify-section-/, "")
    .replace(/^(?:template|sections)--\d+__/, "")
    .trim();
}

export function normalizeSelector(selector: string): string {
  return selector
    .replace(/shopify-section-(?:template|sections)--\d+__/g, "shopify-section-")
    .replace(/(?:template|sections)--\d+__/g, "")
    .replace(/\d{6,}/g, "#");
}

/** Removes literal secret values and sensitive query parameters from text. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let output = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) output = output.split(secret).join("[REDACTED]");
  }
  return output.replace(SENSITIVE_PARAM_PATTERN, "$1[REDACTED]");
}

export function redactDeep<T>(value: T, secrets: readonly string[] = []): T {
  if (typeof value === "string") return redact(value, secrets) as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, secrets)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item, secrets)])) as T;
  }
  return value;
}
