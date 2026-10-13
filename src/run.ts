import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { StoreSession } from "./browser/session.js";
import { runPurchaseCheck } from "./checks/purchase.js";
import { runTechnicalCheck, type ThemeCheckDiffResult } from "./checks/technical.js";
import { loadConfig, readSecrets, type ThemeQaConfig } from "./config.js";
import { StageError, toStageFailure } from "./errors.js";
import { changedThemeFiles, currentCommit, withWorktree } from "./git.js";
import { redactDeep } from "./normalize.js";
import { renderMarkdown } from "./report/markdown.js";
import { runCommand, ShopifyCli, type CommandRunner, type RemoteTheme } from "./shopify/cli.js";
import { isLive, prepareQaTheme, qaThemeName } from "./shopify/qa-theme.js";
import type { CheckFailure, CheckResult, RunMeta, RunReport, StageFailure, StageId, ThemeSide } from "./types.js";
import { computeVerdict } from "./verdict.js";

const THEME_DIRECTORIES = new Set(["assets", "blocks", "config", "layout", "locales", "sections", "snippets", "templates"]);

export function isThemeFile(file: string): boolean {
  return THEME_DIRECTORIES.has(file.split("/", 1)[0] ?? "");
}

export interface RunOptions {
  cwd: string;
  configPath: string;
  reportDir: string;
  pullRequest?: number;
  /** Git ref of the target branch. Enables the Theme Check diff and the no-theme-changes shortcut. */
  base?: string;
  /** Use an existing unpublished theme instead of uploading one (local runs). */
  themeId?: number;
  /** Link included in the report, e.g. the GitHub Actions run with the artifacts. */
  reportUrl?: string;
  env?: NodeJS.ProcessEnv;
  runner?: CommandRunner;
  shopifyBinary?: string;
  isPullRequestOpen?: (pullRequest: number) => Promise<boolean>;
  launchBrowser?: () => Promise<Browser>;
  log?: (message: string) => void;
}

export interface RunOutput {
  report: RunReport;
  markdown: string;
}

async function runBuild(command: string, cwd: string, runner: CommandRunner): Promise<void> {
  const result = await runner("sh", ["-c", command], { cwd, env: process.env });
  if (result.code !== 0) {
    const output = `${result.stdout}\n${result.stderr}`.trim().split("\n").slice(-20).join("\n");
    throw new StageError("build", "theme", `The build command failed (exit ${result.code}):\n${output}`, `Run \`${command}\` locally and fix the error.`);
  }
}

async function themeCheckDiff(
  cli: ShopifyCli,
  cwd: string,
  config: ThemeQaConfig,
  base: string,
  changed: readonly string[],
  runner: CommandRunner,
): Promise<ThemeCheckDiffResult | { failure: CheckFailure }> {
  const changedFiles = new Set(changed);
  const inChangedFiles = <T extends { file?: string }>(offense: T) => Boolean(offense.file && changedFiles.has(offense.file));
  try {
    const head = (await cli.themeCheck(path.resolve(cwd, config.themeRoot))).filter(inChangedFiles);
    const baseOffenses = await withWorktree(cwd, base, (directory) => cli.themeCheck(path.resolve(directory, config.themeRoot)), runner);
    return { base: baseOffenses.filter(inChangedFiles), head };
  } catch (error) {
    const failure = toStageFailure(error, "checks");
    return { failure: { category: failure.category, message: failure.message, hint: failure.hint } };
  }
}

function skippedChecks(reason: string): CheckResult[] {
  return [
    { id: "technical", title: "Technical errors", mandatory: true, status: "pass", summary: reason, findings: [] },
    { id: "purchase", title: "Purchase flow", mandatory: true, status: "pass", summary: reason, findings: [] },
  ];
}

async function resolveThemes(cli: ShopifyCli, config: ThemeQaConfig, options: RunOptions): Promise<{ theme: RemoteTheme; live: RemoteTheme }> {
  if (!options.themeId) {
    return prepareQaTheme(cli, { root: path.resolve(options.cwd, config.themeRoot), name: qaThemeName(options.pullRequest), isPullRequestOpen: options.isPullRequestOpen });
  }
  const themes = await cli.listThemes();
  const live = themes.find(isLive);
  const theme = themes.find((candidate) => candidate.id === options.themeId);
  if (!live) throw new StageError("theme", "infra", "Shopify did not report a live theme for this store.", "Re-run the job.");
  if (!theme) throw new StageError("theme", "config", `Theme ${options.themeId} does not exist in ${config.storeDomain}.`, "Pass the ID of an unpublished theme.");
  if (isLive(theme)) throw new StageError("theme", "config", `Theme ${options.themeId} is the live theme; comparing it with itself proves nothing.`, "Pass the ID of an unpublished theme.");
  return { theme, live };
}

/** Runs the whole gate. Never throws: every failure ends up in the report. */
export async function runGate(options: RunOptions): Promise<RunOutput> {
  const started = Date.now();
  const runner = options.runner ?? runCommand;
  const log = options.log ?? ((message: string) => console.error(`[theme-qa] ${message}`));
  const secrets = readSecrets(options.env ?? process.env);
  const secretValues = [secrets.themeToken, secrets.storefrontPassword].filter((value): value is string => Boolean(value));
  const meta: RunMeta = { store: "", startedAt: new Date(started).toISOString(), durationMs: 0, pullRequest: options.pullRequest, pages: [], viewports: [] };
  const checks: CheckResult[] = [];
  const sessions: StoreSession[] = [];
  let stageFailure: StageFailure | undefined;
  let stage: StageId = "prepare";
  let browser: Browser | undefined;

  try {
    const config = await loadConfig(path.resolve(options.cwd, options.configPath));
    meta.store = config.storeDomain;
    meta.pages = config.pages;
    meta.viewports = config.viewports;
    meta.commit = await currentCommit(options.cwd, runner);
    if (!secrets.themeToken) {
      throw new StageError("prepare", "config", "SHOPIFY_CLI_THEME_TOKEN is not set.", "Add the Theme Access password as the SHOPIFY_CLI_THEME_TOKEN secret.");
    }

    let changed: string[] | undefined;
    if (options.base) {
      changed = await changedThemeFiles(options.cwd, options.base, config.themeRoot, runner);
      if (!config.build && !changed.some(isThemeFile)) {
        log("No theme files changed; skipping the storefront checks.");
        checks.push(...skippedChecks("No theme files changed in this pull request"));
        return await finish();
      }
    }

    if (config.build) {
      stage = "build";
      log(`Building: ${config.build}`);
      await runBuild(config.build, options.cwd, runner);
    }

    stage = "theme";
    const cli = new ShopifyCli({ store: config.storeDomain, themeToken: secrets.themeToken, runner, binary: options.shopifyBinary });
    log(options.themeId ? `Using existing theme ${options.themeId}` : `Uploading to "${qaThemeName(options.pullRequest)}"`);
    const { theme, live } = await resolveThemes(cli, config, options);
    meta.theme = { id: theme.id, name: theme.name, previewUrl: theme.previewUrl ?? `${config.storeUrl}/?preview_theme_id=${theme.id}` };
    meta.liveThemeId = live.id;

    stage = "verify";
    log("Opening storefront sessions and verifying themes");
    browser = await (options.launchBrowser ?? (() => chromium.launch({ headless: true })))();
    const sides: Array<[ThemeSide, number]> = [["live", live.id], ["preview", theme.id]];
    const plan = sides.flatMap(([side, themeId]) => config.viewports.map((viewport) => ({ side, themeId, viewport })));
    const base = { storeUrl: config.storeUrl, storefrontPassword: secrets.storefrontPassword, blockHosts: config.block };
    // The storefront password is sent once; the other sessions reuse the unlocked cookies.
    const first = await StoreSession.open(browser, { ...base, ...plan[0]! });
    sessions.push(first);
    const storageState = await first.context.storageState();
    const opened = await Promise.allSettled(plan.slice(1).map((entry) => StoreSession.open(browser!, { ...base, ...entry, storageState })));
    for (const result of opened) if (result.status === "fulfilled") sessions.push(result.value);
    const rejected = opened.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (rejected) throw rejected.reason;
    await Promise.all(sessions.map((session) => session.verifyTheme()));

    stage = "checks";
    const themeCheck = config.themeCheck.enabled && options.base && changed ? await themeCheckDiff(cli, options.cwd, config, options.base, changed, runner) : undefined;
    // The purchase flow runs first: it matters most and must not inherit throttling from link checks.
    log("Running the purchase flow");
    const purchase = await runPurchaseCheck({
      sessions,
      products: config.purchase.products,
      selectors: config.purchase.selectors,
      artifactDir: path.resolve(options.cwd, options.reportDir, "artifacts"),
    });
    log("Checking technical errors");
    checks.push(await runTechnicalCheck({ sessions, pages: config.pages, ignore: config.ignore, blockingThemeChecks: config.themeCheck.blocking, themeCheck }), purchase);
  } catch (error) {
    stageFailure = toStageFailure(error, stage);
  } finally {
    await Promise.all(sessions.map((session) => session.close().catch(() => undefined)));
    await browser?.close().catch(() => undefined);
  }
  return finish();

  async function finish(): Promise<RunOutput> {
    meta.durationMs = Date.now() - started;
    const report = redactDeep<RunReport>({ verdict: computeVerdict(stageFailure, checks), stageFailure, checks, meta }, secretValues);
    const markdown = renderMarkdown(report, { secrets: secretValues, reportUrl: options.reportUrl });
    const directory = path.resolve(options.cwd, options.reportDir);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(path.join(directory, "report.md"), `${markdown}\n`);
    return { report, markdown };
  }
}
