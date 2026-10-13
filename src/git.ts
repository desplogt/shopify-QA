import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StageError } from "./errors.js";
import { runCommand, type CommandRunner } from "./shopify/cli.js";

async function git(runner: CommandRunner, cwd: string, args: string[]): Promise<string> {
  const result = await runner("git", args, { cwd, env: process.env });
  if (result.code !== 0) throw new StageError("checks", "config", `git ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`, "Check out the repository with enough history (fetch-depth: 2 on pull requests).");
  return result.stdout;
}

export async function currentCommit(cwd: string, runner: CommandRunner = runCommand): Promise<string | undefined> {
  try {
    return (await git(runner, cwd, ["rev-parse", "HEAD"])).trim();
  } catch {
    return undefined;
  }
}

/** Files changed between `base` and HEAD, relative to the theme root. */
export async function changedThemeFiles(cwd: string, base: string, themeRoot: string, runner: CommandRunner = runCommand): Promise<string[]> {
  const output = await git(runner, cwd, ["diff", "--name-only", "--no-renames", base, "HEAD"]);
  const prefix = path.posix.normalize(themeRoot).replace(/^\.\/?/, "").replace(/\/?$/, "/");
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((file) => (prefix === "/" ? [file] : file.startsWith(prefix) ? [file.slice(prefix.length)] : []));
}

/** Checks out `ref` in a temporary worktree, runs `action`, and always removes the worktree. */
export async function withWorktree<T>(cwd: string, ref: string, action: (directory: string) => Promise<T>, runner: CommandRunner = runCommand): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "theme-qa-base-"));
  await git(runner, cwd, ["worktree", "add", "--detach", directory, ref]);
  try {
    return await action(directory);
  } finally {
    await runner("git", ["worktree", "remove", "--force", directory], { cwd, env: process.env }).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}
