#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, readSecrets } from "./config.js";
import { GitHubClient, pullRequestFromEvent } from "./github.js";
import { runGate } from "./run.js";
import { ShopifyCli } from "./shopify/cli.js";
import { deleteQaTheme, qaThemeName } from "./shopify/qa-theme.js";

const HELP = `theme-qa — release gate for Shopify themes

Usage
  theme-qa check   [--config theme-qa.yml] [--pr N] [--base REF] [--theme-id ID] [--report-dir DIR] [--comment]
  theme-qa cleanup --pr N [--config theme-qa.yml]

check     Uploads the current code to the QA theme (or uses --theme-id), compares it with
          the live theme, and writes report.json and report.md. Exits 1 when blocked.
cleanup   Deletes the QA theme of a closed pull request.

Options
  --config      Path to theme-qa.yml (default: theme-qa.yml)
  --pr          Pull request number; read from the GitHub event when omitted
  --base        Git ref of the target branch; enables the Theme Check diff (CI uses HEAD^1)
  --theme-id    Existing unpublished theme to compare instead of uploading
  --report-dir  Output folder (default: theme-qa-report)
  --comment     Create or update the pull request comment (needs GITHUB_TOKEN)

Environment
  SHOPIFY_CLI_THEME_TOKEN  Theme Access password (required)
  STOREFRONT_PASSWORD      Storefront password, when the store is protected
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      config: { type: "string", default: "theme-qa.yml" },
      pr: { type: "string" },
      base: { type: "string" },
      "theme-id": { type: "string" },
      "report-dir": { type: "string", default: "theme-qa-report" },
      comment: { type: "boolean", default: false },
    },
  });
  const event = await pullRequestFromEvent();
  const pullRequest = values.pr ? Number(values.pr) : event?.number;
  const github = GitHubClient.fromEnv();

  if (command === "check") {
    const env = process.env;
    const reportUrl = env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;
    const { report, markdown } = await runGate({
      cwd: process.cwd(),
      configPath: values.config,
      reportDir: values["report-dir"],
      pullRequest,
      base: values.base,
      themeId: values["theme-id"] ? Number(values["theme-id"]) : undefined,
      reportUrl,
      isPullRequestOpen: github ? (number) => github.isPullRequestOpen(number) : undefined,
    });
    process.stdout.write(`${markdown}\n`);
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
    if (values.comment) {
      if (github && pullRequest) {
        await github.upsertReportComment(pullRequest, markdown).catch((error: unknown) => console.error(`[theme-qa] Could not post the comment: ${String(error)}`));
      } else {
        console.error("[theme-qa] --comment needs GITHUB_TOKEN, GITHUB_REPOSITORY, and a pull request number.");
      }
    }
    console.error(`[theme-qa] Verdict: ${report.verdict} — report written to ${path.resolve(values["report-dir"])}`);
    return report.verdict === "blocked" ? 1 : 0;
  }

  if (command === "cleanup") {
    if (!pullRequest) {
      console.error("[theme-qa] cleanup needs --pr or a pull request event.");
      return 2;
    }
    const config = await loadConfig(path.resolve(values.config));
    const { themeToken } = readSecrets();
    if (!themeToken) {
      console.error("[theme-qa] SHOPIFY_CLI_THEME_TOKEN is not set.");
      return 2;
    }
    const deleted = await deleteQaTheme(new ShopifyCli({ store: config.storeDomain, themeToken }), qaThemeName(pullRequest));
    console.error(`[theme-qa] ${deleted ? "Deleted" : "No"} QA theme for pull request #${pullRequest}.`);
    return 0;
  }

  process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error);
    process.exitCode = 2;
  },
);
