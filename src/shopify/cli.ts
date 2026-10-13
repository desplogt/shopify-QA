import { spawn } from "node:child_process";
import path from "node:path";
import { retry, StageError } from "../errors.js";
import type { Observation } from "../types.js";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command without a shell. Injected in tests to simulate the Shopify CLI. */
export type CommandRunner = (command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }) => Promise<CommandResult>;

export const runCommand: CommandRunner = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

export interface RemoteTheme {
  id: number;
  name: string;
  role: string;
  previewUrl?: string;
}

const AUTH_FAILURE = /invalid (?:api )?(?:password|token)|unauthori[sz]ed|\b401\b|access denied|not authorized|forbidden|\b403\b/i;
const TRANSIENT_FAILURE = /ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|socket hang up|\b50[234]\b|service unavailable|too many requests|\b429\b|network/i;
const THEME_LIMIT = /theme limit|maximum number of themes|too many themes/i;

function tail(text: string, lines = 15): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}

/** Lines of CLI output that name a theme file, e.g. "sections/main.liquid: Liquid syntax error ...". */
export function fileErrorLines(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /(?:layout|sections|snippets|templates|blocks|config|locales|assets)\/[\w./-]+\.(?:liquid|json|js|css)/.test(line));
}

export function classifyCliFailure(stage: "theme" | "prepare", action: string, result: CommandResult): StageError {
  const output = `${result.stderr}\n${result.stdout}`;
  if (AUTH_FAILURE.test(output)) {
    return new StageError(stage, "config", `Shopify rejected the Theme Access password while trying to ${action}.`, "Regenerate the password in the Theme Access app and update the SHOPIFY_CLI_THEME_TOKEN secret.");
  }
  if (THEME_LIMIT.test(output)) {
    return new StageError(stage, "config", "The store has reached its theme limit.", "Delete unused themes in Shopify Admin → Online Store → Themes.");
  }
  if (TRANSIENT_FAILURE.test(output)) {
    return new StageError(stage, "infra", `Shopify was unreachable while trying to ${action}.\n${tail(output, 5)}`, "Re-run the job.");
  }
  const files = fileErrorLines(output);
  if (stage === "theme" && files.length > 0) {
    return new StageError(stage, "theme", `Shopify rejected theme files:\n${files.slice(0, 20).join("\n")}`, "Fix the listed files and push again.");
  }
  return new StageError(stage, "infra", `Shopify CLI failed to ${action} (exit ${result.code}).\n${tail(output)}`, "Re-run the job. If it repeats, check the log.");
}

export interface ShopifyCliOptions {
  store: string;
  themeToken: string;
  runner?: CommandRunner;
  /** Executable, overridable for tests. */
  binary?: string;
}

/**
 * Thin wrapper over the Shopify CLI. Credentials go through environment variables,
 * never command-line arguments, so they do not appear in process listings.
 */
export class ShopifyCli {
  private readonly runner: CommandRunner;
  private readonly binary: string;

  constructor(private readonly options: ShopifyCliOptions) {
    this.runner = options.runner ?? runCommand;
    this.binary = options.binary ?? "shopify";
  }

  private env(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      SHOPIFY_CLI_THEME_TOKEN: this.options.themeToken,
      SHOPIFY_FLAG_STORE: this.options.store,
      SHOPIFY_CLI_TTY: "0",
      SHOPIFY_CLI_NO_ANALYTICS: "1",
      NO_COLOR: "1",
    };
  }

  private async run(stage: "theme" | "prepare", action: string, args: string[], cwd?: string): Promise<string> {
    return retry(
      async () => {
        const result = await this.runner(this.binary, args, { cwd, env: this.env() });
        if (result.code !== 0) throw classifyCliFailure(stage, action, result);
        return result.stdout;
      },
      { attempts: 3, delayMs: 2_000, shouldRetry: (error) => error instanceof StageError && error.category === "infra" },
    );
  }

  async listThemes(): Promise<RemoteTheme[]> {
    const stdout = await this.run("prepare", "list themes", ["theme", "list", "--json", "--no-color"]);
    const parsed = parseJson(stdout, "theme list");
    const themes = Array.isArray(parsed) ? parsed : [];
    return themes.map((theme: Record<string, unknown>) => ({ id: Number(theme.id), name: String(theme.name ?? ""), role: String(theme.role ?? "") }));
  }

  /** Pushes `root` to an existing theme ID, or creates a new unpublished theme with `name`. */
  async push(root: string, target: { id: number } | { name: string }): Promise<RemoteTheme> {
    const args = ["theme", "push", "--json", "--no-color", "--path", root];
    if ("id" in target) args.push("--theme", String(target.id));
    else args.push("--unpublished", "--theme", target.name);
    const stdout = await this.run("theme", "upload the QA theme", args);
    const parsed = parseJson(stdout, "theme push") as { theme?: Record<string, unknown> };
    const theme = parsed.theme;
    if (!theme?.id) throw new StageError("theme", "infra", "Shopify CLI did not return the uploaded theme.", "Re-run the job.");
    return { id: Number(theme.id), name: String(theme.name ?? ""), role: String(theme.role ?? ""), previewUrl: theme.preview_url ? String(theme.preview_url) : undefined };
  }

  async deleteTheme(id: number): Promise<void> {
    await this.run("theme", "delete the QA theme", ["theme", "delete", "--theme", String(id), "--force", "--no-color"]);
  }

  /** Runs Theme Check locally (no store access) and returns offenses as observations. */
  async themeCheck(root: string): Promise<Observation[]> {
    const result = await this.runner(this.binary, ["theme", "check", "--output", "json", "--no-color", "--path", root], { env: { ...process.env, NO_COLOR: "1" } });
    // Theme Check exits non-zero when it finds offenses; only unparseable output is a failure.
    try {
      return parseThemeCheck(result.stdout, root);
    } catch {
      throw new StageError("checks", "internal", `Theme Check output could not be read (exit ${result.code}).\n${tail(result.stderr || result.stdout)}`);
    }
  }
}

function parseJson(stdout: string, label: string): unknown {
  // The CLI may print warnings before the JSON payload.
  const start = stdout.search(/[[{]/);
  try {
    return JSON.parse(stdout.slice(Math.max(start, 0)));
  } catch {
    throw new StageError("theme", "infra", `Unexpected output from Shopify CLI (${label}).\n${tail(stdout, 5)}`, "Re-run the job.");
  }
}

interface ThemeCheckFile {
  path: string;
  offenses: Array<{ check: string; severity: string | number; start_row?: number; message: string }>;
}

/** Theme Check JSON: absolute paths and 0-based rows; converted to theme-relative files and 1-based lines. */
export function parseThemeCheck(stdout: string, root: string): Observation[] {
  const files = JSON.parse(stdout.slice(Math.max(stdout.indexOf("["), 0))) as ThemeCheckFile[];
  const absoluteRoot = path.resolve(root);
  return files.flatMap((file) => {
    const relative = path.relative(absoluteRoot, path.resolve(absoluteRoot, file.path)).split(path.sep).join("/");
    return file.offenses.map((offense) => ({
      rule: `theme-check:${offense.check}`,
      message: offense.message,
      page: relative,
      file: relative,
      line: typeof offense.start_row === "number" ? offense.start_row + 1 : undefined,
      evidence: { check: offense.check, severity: offense.severity },
    }));
  });
}
