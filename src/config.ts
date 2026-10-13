import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { DEFAULT_BLOCKING_THEME_CHECKS } from "./compare.js";
import { StageError } from "./errors.js";

const storePath = z
  .string()
  .trim()
  .refine((value) => value.startsWith("/") && !value.startsWith("//"), "must be a storefront path starting with /");

const ignoreRule = z
  .object({
    rule: z.string().optional(),
    match: z.string().optional(),
    page: z.string().optional(),
    reason: z.string().min(3, "explain why the exception is safe"),
  })
  .refine((rule) => Boolean(rule.rule || rule.match || rule.page), "needs at least one of rule, match, or page");

const schema = z.object({
  store: z.string().trim().min(1),
  build: z.string().trim().min(1).nullable().default(null),
  themeRoot: z.string().trim().min(1).default("."),
  pages: z.array(storePath).min(1).max(10),
  purchase: z.object({
    products: z
      .array(storePath.refine((value) => value.startsWith("/products/"), "must be a /products/ path"))
      .min(1, "configure at least one product with stock"),
    selectors: z
      .object({
        addToCart: z.string().optional(),
        quantity: z.string().optional(),
        update: z.string().optional(),
        checkout: z.string().optional(),
      })
      .default({}),
  }),
  viewports: z.array(z.enum(["desktop", "mobile"])).min(1).default(["desktop", "mobile"]),
  block: z.array(z.string().trim().min(1)).default([]),
  ignore: z.array(ignoreRule).default([]),
  themeCheck: z
    .object({
      enabled: z.boolean().default(true),
      blocking: z.array(z.string()).default([...DEFAULT_BLOCKING_THEME_CHECKS]),
    })
    .default({ enabled: true, blocking: [...DEFAULT_BLOCKING_THEME_CHECKS] }),
  concurrency: z.number().int().min(1).max(8).default(4),
});

export type ThemeQaConfig = z.infer<typeof schema> & {
  /** Origin used for every storefront request, e.g. https://example.myshopify.com */
  storeUrl: string;
  /** Store domain passed to the Shopify CLI, e.g. example.myshopify.com */
  storeDomain: string;
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function resolveStore(store: string): { storeUrl: string; storeDomain: string } {
  const withScheme = /^https?:\/\//i.test(store) ? store : `https://${store.includes(".") ? store : `${store}.myshopify.com`}`;
  const url = new URL(withScheme);
  // Plain HTTP is only accepted for local test servers.
  if (url.protocol === "http:" && !LOCAL_HOSTS.has(url.hostname)) {
    throw new StageError("prepare", "config", `store must use HTTPS: ${store}`);
  }
  return { storeUrl: url.origin, storeDomain: url.host };
}

export function parseConfig(raw: unknown): ThemeQaConfig {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
    throw new StageError("prepare", "config", `Invalid theme-qa.yml — ${details}`, "Fix the listed fields in theme-qa.yml.");
  }
  const pages = [...new Set(result.data.pages)];
  return { ...result.data, pages, ...resolveStore(result.data.store) };
}

export async function loadConfig(path: string): Promise<ThemeQaConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new StageError("prepare", "config", `Config file not found: ${path}`, "Add a theme-qa.yml file at the root of the theme repository.");
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new StageError("prepare", "config", `theme-qa.yml is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseConfig(raw);
}

export interface Secrets {
  themeToken?: string;
  storefrontPassword?: string;
}

export function readSecrets(env: NodeJS.ProcessEnv = process.env): Secrets {
  return {
    themeToken: env.SHOPIFY_CLI_THEME_TOKEN?.trim() || undefined,
    storefrontPassword: env.STOREFRONT_PASSWORD?.trim() || undefined,
  };
}
