import assert from "node:assert/strict";
import { test } from "node:test";
import { StageError } from "../src/errors.js";
import { classifyCliFailure, parseThemeCheck, ShopifyCli, type CommandRunner, type RemoteTheme } from "../src/shopify/cli.js";
import { deleteQaTheme, isQaTheme, prepareQaTheme, qaThemeName } from "../src/shopify/qa-theme.js";

/** Records CLI calls and answers `theme list`, `push`, and `delete` from an in-memory store. */
function fakeCli(initial: RemoteTheme[]) {
  const themes = [...initial];
  const calls: string[][] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  let nextId = 5000;
  const runner: CommandRunner = async (_command, args, options) => {
    calls.push(args);
    envs.push(options.env ?? {});
    const [, action] = args;
    if (action === "list") return { code: 0, stdout: JSON.stringify(themes), stderr: "" };
    if (action === "push") {
      const target = args[args.indexOf("--theme") + 1]!;
      let theme = themes.find((candidate) => String(candidate.id) === target);
      if (!theme) {
        theme = { id: nextId++, name: target, role: "unpublished" };
        themes.push(theme);
      }
      return { code: 0, stdout: JSON.stringify({ theme: { ...theme, preview_url: `https://shop.test/?preview_theme_id=${theme.id}` } }), stderr: "" };
    }
    if (action === "delete") {
      const id = Number(args[args.indexOf("--theme") + 1]);
      themes.splice(themes.findIndex((theme) => theme.id === id), 1);
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unexpected command" };
  };
  return { cli: new ShopifyCli({ store: "shop.test", themeToken: "shptka_secret", runner }), calls, envs, themes };
}

const LIVE: RemoteTheme = { id: 1, name: "Dawn", role: "live" };

test("creates an unpublished QA theme the first time and reuses it afterwards", async () => {
  const { cli, calls, themes } = fakeCli([LIVE]);
  const first = await prepareQaTheme(cli, { root: ".", name: qaThemeName(42) });
  assert.equal(first.theme.name, "theme-qa PR #42");
  assert.equal(first.live.id, 1);
  assert.ok(calls.some((args) => args.includes("--unpublished")));

  calls.length = 0;
  const second = await prepareQaTheme(cli, { root: ".", name: qaThemeName(42) });
  assert.equal(second.theme.id, first.theme.id);
  assert.ok(!calls.some((args) => args.includes("--unpublished")), "reuses the existing theme");
  assert.equal(themes.length, 2);
});

test("never passes --allow-live or --publish and keeps credentials out of arguments", async () => {
  const { cli, calls, envs } = fakeCli([LIVE]);
  await prepareQaTheme(cli, { root: ".", name: qaThemeName(7) });
  for (const args of calls) {
    assert.ok(!args.includes("--allow-live") && !args.includes("--publish") && !args.includes("--password"));
    assert.ok(!args.join(" ").includes("shptka_secret"));
  }
  assert.ok(envs.every((env) => env.SHOPIFY_CLI_THEME_TOKEN === "shptka_secret" && env.SHOPIFY_FLAG_STORE === "shop.test"));
});

test("refuses to upload when the QA theme name belongs to the live theme", async () => {
  const { cli } = fakeCli([{ id: 1, name: "theme-qa PR #42", role: "live" }]);
  await assert.rejects(prepareQaTheme(cli, { root: ".", name: qaThemeName(42) }), (error: unknown) => error instanceof StageError && error.category === "config");
});

test("at the theme limit, deletes only QA themes of closed pull requests", async () => {
  const initial: RemoteTheme[] = [
    LIVE,
    { id: 2, name: "theme-qa PR #10", role: "unpublished" },
    { id: 3, name: "theme-qa PR #11", role: "unpublished" },
    { id: 4, name: "Client backup", role: "unpublished" },
    { id: 5, name: "Dev theme", role: "development" },
  ];
  const { cli, themes } = fakeCli(initial);
  const open = new Set([11]);
  await prepareQaTheme(cli, { root: ".", name: qaThemeName(12), themeLimit: 4, isPullRequestOpen: async (number) => open.has(number) });
  const names = themes.map((theme) => theme.name);
  assert.ok(!names.includes("theme-qa PR #10"), "closed pull request theme deleted");
  assert.ok(names.includes("theme-qa PR #11"), "open pull request theme kept");
  assert.ok(names.includes("Client backup") && names.includes("Dawn"), "non-QA themes untouched");
  assert.ok(names.includes("theme-qa PR #12"));
});

test("cleanup deletes the QA theme and nothing else", async () => {
  const { cli, themes } = fakeCli([LIVE, { id: 9, name: "theme-qa PR #42", role: "unpublished" }]);
  assert.equal(await deleteQaTheme(cli, qaThemeName(42)), true);
  assert.equal(await deleteQaTheme(cli, qaThemeName(42)), false);
  assert.deepEqual(themes, [LIVE]);
  assert.equal(isQaTheme({ name: "theme-qa PR #1", role: "live" }), false);
});

test("classifies CLI failures into config, infra, and theme errors", () => {
  const auth = classifyCliFailure("theme", "upload", { code: 1, stdout: "", stderr: "Error: Invalid API password or access token (401)" });
  assert.equal(auth.category, "config");
  assert.match(auth.hint ?? "", /Theme Access/);

  const network = classifyCliFailure("theme", "upload", { code: 1, stdout: "", stderr: "request to https://shop.test failed, reason: getaddrinfo ENOTFOUND" });
  assert.equal(network.category, "infra");

  const rejected = classifyCliFailure("theme", "upload", { code: 1, stdout: "", stderr: "sections/main-product.liquid: Liquid syntax error (line 12): 'endfor' is not a valid delimiter\nUpload failed" });
  assert.equal(rejected.category, "theme");
  assert.match(rejected.message, /sections\/main-product\.liquid/);
});

test("retries transient Shopify failures before giving up", async () => {
  let attempts = 0;
  const runner: CommandRunner = async () => {
    attempts += 1;
    return attempts < 2 ? { code: 1, stdout: "", stderr: "503 Service Unavailable" } : { code: 0, stdout: "[]", stderr: "" };
  };
  const cli = new ShopifyCli({ store: "shop.test", themeToken: "x", runner });
  assert.deepEqual(await cli.listThemes(), []);
  assert.equal(attempts, 2);
});

test("parses Theme Check JSON into theme-relative files and 1-based lines", () => {
  // Shape captured from Shopify CLI 3.94 on a synthetic theme.
  const stdout = JSON.stringify([
    {
      path: "/tmp/theme/sections/filter.liquid",
      offenses: [{ check: "UnknownFilter", severity: "error", start_row: 1, start_column: 9, end_row: 1, end_column: 20, message: "Unknown filter 'money_x' used." }],
      errorCount: 1,
      warningCount: 0,
      infoCount: 0,
    },
  ]);
  const [offense] = parseThemeCheck(stdout, "/tmp/theme");
  assert.equal(offense?.rule, "theme-check:UnknownFilter");
  assert.equal(offense?.file, "sections/filter.liquid");
  assert.equal(offense?.line, 2);
});
