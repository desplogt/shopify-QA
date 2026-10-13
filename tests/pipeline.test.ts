/**
 * End-to-end runs of the whole gate: real git and browser, a fake Shopify CLI, and the
 * local fake store. Nothing touches Shopify.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runGate } from "../src/run.js";
import { runCommand, type CommandRunner } from "../src/shopify/cli.js";
import { fakeTheme, startFakeStore, type Fault } from "./fixtures/fake-store.js";

const TOKEN = "shptka_0123456789abcdef";
const STOREFRONT_PASSWORD = "letmein-2026";

async function git(cwd: string, ...args: string[]) {
  const result = await runCommand("git", args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  assert.equal(result.code, 0, result.stderr);
}

/** A theme repository with two commits: base, then a change described by `change`. */
async function themeRepo(storeUrl: string, change: "section" | "readme"): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "theme-qa-repo-"));
  await mkdir(path.join(cwd, "sections"), { recursive: true });
  await mkdir(path.join(cwd, "snippets"), { recursive: true });
  await writeFile(
    path.join(cwd, "theme-qa.yml"),
    [`store: ${storeUrl}`, "pages: ['/', '/products/shirt']", "purchase:", "  products: ['/products/shirt']", "viewports: [desktop]"].join("\n"),
  );
  await writeFile(path.join(cwd, "sections", "main.liquid"), "<div>{{ 'hello' }}</div>\n");
  await writeFile(path.join(cwd, "snippets", "old.liquid"), "<p>old</p>\n");
  await writeFile(path.join(cwd, "README.md"), "# Theme\n");
  await git(cwd, "init", "-q", "-b", "main");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-q", "-m", "base");
  if (change === "section") await writeFile(path.join(cwd, "sections", "main.liquid"), "<div>{% if x %}{{ 'hello' }}</div>\n");
  else await writeFile(path.join(cwd, "README.md"), "# Theme\n\nDocs only.\n");
  await git(cwd, "commit", "-q", "-am", "change");
  return cwd;
}

interface FakeShopifyOptions {
  pushFailure?: string;
}

/** Fake Shopify CLI; git and the build shell run for real. */
function fakeShopify(calls: string[][], options: FakeShopifyOptions = {}): CommandRunner {
  return async (command, args, runOptions) => {
    if (command !== "shopify") return runCommand(command, args, runOptions);
    calls.push(args);
    const action = args[1];
    if (action === "list") return { code: 0, stdout: JSON.stringify([{ id: 1001, name: "Live theme", role: "live" }]), stderr: "" };
    if (action === "push") {
      if (options.pushFailure) return { code: 1, stdout: "", stderr: options.pushFailure };
      return { code: 0, stdout: JSON.stringify({ theme: { id: 2002, name: "theme-qa PR #42", role: "unpublished", preview_url: "https://shop.test/?preview_theme_id=2002" } }), stderr: "" };
    }
    if (action === "check") {
      const root = args[args.indexOf("--path") + 1]!;
      const isBase = root.includes("theme-qa-base-");
      const offense = (check: string, message: string) => ({ check, severity: "error", start_row: 0, start_column: 0, end_row: 0, end_column: 1, message });
      const files = [
        { path: path.join(root, "sections/main.liquid"), offenses: [offense("ImgWidthAndHeight", "Missing width and height"), ...(isBase ? [] : [offense("LiquidHTMLSyntaxError", "Attempting to end parsing before LiquidBranch 'if' was closed")])] },
        { path: path.join(root, "snippets/old.liquid"), offenses: [offense("UnknownFilter", "Unknown filter in an untouched file")] },
      ];
      return { code: 1, stdout: JSON.stringify(files), stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected shopify ${args.join(" ")}` };
  };
}

async function run(cwd: string, runner: CommandRunner, env: NodeJS.ProcessEnv = { SHOPIFY_CLI_THEME_TOKEN: TOKEN, STOREFRONT_PASSWORD }) {
  const output = await runGate({ cwd, configPath: "theme-qa.yml", reportDir: "theme-qa-report", pullRequest: 42, base: "HEAD~1", env, runner, log: () => undefined });
  const json = await readFile(path.join(cwd, "theme-qa-report", "report.json"), "utf8");
  const markdown = await readFile(path.join(cwd, "theme-qa-report", "report.md"), "utf8");
  return { ...output, json, markdownFile: markdown };
}

async function withStore<T>(previewFaults: Fault[], action: (url: string) => Promise<T>): Promise<T> {
  const store = await startFakeStore([fakeTheme("live"), fakeTheme("unpublished", previewFaults)], { password: STOREFRONT_PASSWORD, secret: STOREFRONT_PASSWORD });
  try {
    return await action(store.url);
  } finally {
    await store.close();
  }
}

test("a new Theme Check syntax error in a changed file blocks; untouched files are ignored", async () => {
  await withStore([], async (url) => {
    const cwd = await themeRepo(url, "section");
    const calls: string[][] = [];
    const { report, markdown } = await run(cwd, fakeShopify(calls));
    assert.equal(report.verdict, "blocked", markdown);
    const technical = report.checks.find((check) => check.id === "technical")!;
    const syntax = technical.findings.find((finding) => finding.rule === "theme-check:LiquidHTMLSyntaxError");
    assert.equal(syntax?.severity, "block");
    assert.equal(syntax?.file, "sections/main.liquid");
    assert.equal(technical.findings.find((finding) => finding.rule === "theme-check:ImgWidthAndHeight")?.status, "existing");
    assert.ok(!technical.findings.some((finding) => finding.file === "snippets/old.liquid"), "offenses in untouched files are not reported");
    assert.equal(report.checks.find((check) => check.id === "purchase")?.status, "pass");
    assert.match(markdown, /Theme Check · LiquidHTMLSyntaxError/);
    assert.ok(calls.some((args) => args.includes("--unpublished")));
  });
});

test("a pull request without theme changes passes in seconds without touching Shopify", async () => {
  await withStore([], async (url) => {
    const cwd = await themeRepo(url, "readme");
    const calls: string[][] = [];
    const { report } = await run(cwd, fakeShopify(calls));
    assert.equal(report.verdict, "passed");
    assert.deepEqual(calls, [], "no Shopify CLI calls");
  });
});

test("storefront defects block, and secrets never reach the report", async () => {
  await withStore(["broken-add-to-cart", "liquid-error", "leak-secret"], async (url) => {
    const cwd = await themeRepo(url, "section");
    const { report, markdown, json, markdownFile } = await run(cwd, fakeShopify([]));
    assert.equal(report.verdict, "blocked");
    assert.match(markdown, /What blocks/);
    assert.match(markdown, /Purchase flow/);
    assert.match(markdown, /Liquid error/);
    for (const output of [markdown, json, markdownFile]) {
      assert.ok(!output.includes(STOREFRONT_PASSWORD), "storefront password redacted");
      assert.ok(!output.includes(TOKEN), "theme token redacted");
    }
    assert.match(json, /\[REDACTED\]/);
  });
});

test("Shopify rejecting a file stops the run as a theme error", async () => {
  await withStore([], async (url) => {
    const cwd = await themeRepo(url, "section");
    const runner = fakeShopify([], { pushFailure: "sections/main.liquid: Liquid syntax error (line 1): 'if' tag was never closed" });
    const { report, markdown } = await run(cwd, runner);
    assert.equal(report.verdict, "blocked");
    assert.equal(report.stageFailure?.stage, "theme");
    assert.equal(report.stageFailure?.category, "theme");
    assert.match(markdown, /sections\/main\.liquid/);
    assert.deepEqual(report.checks, [], "no check runs on a theme that failed to upload");
  });
});

test("a missing Theme Access secret is a config error before anything runs", async () => {
  await withStore([], async (url) => {
    const cwd = await themeRepo(url, "section");
    const calls: string[][] = [];
    const { report } = await run(cwd, fakeShopify(calls), {});
    assert.equal(report.stageFailure?.category, "config");
    assert.match(report.stageFailure?.message ?? "", /SHOPIFY_CLI_THEME_TOKEN/);
    assert.deepEqual(calls, []);
  });
});
