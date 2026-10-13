import { StageError } from "../errors.js";
import type { RemoteTheme, ShopifyCli } from "./cli.js";

export const QA_THEME_PREFIX = "theme-qa PR #";
export const LOCAL_THEME_NAME = "theme-qa local";
const DEFAULT_THEME_LIMIT = 20;

export function qaThemeName(pullRequest?: number): string {
  return pullRequest ? `${QA_THEME_PREFIX}${pullRequest}` : LOCAL_THEME_NAME;
}

/** Only themes created by Theme QA may ever be deleted. */
export function isQaTheme(theme: Pick<RemoteTheme, "name" | "role">): boolean {
  return (theme.name.startsWith(QA_THEME_PREFIX) || theme.name === LOCAL_THEME_NAME) && !isLive(theme);
}

export function isLive(theme: Pick<RemoteTheme, "role">): boolean {
  return theme.role === "live" || theme.role === "main";
}

export function pullRequestFromName(name: string): number | undefined {
  if (!name.startsWith(QA_THEME_PREFIX)) return undefined;
  const value = Number(name.slice(QA_THEME_PREFIX.length));
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

export interface PrepareThemeOptions {
  root: string;
  name: string;
  themeLimit?: number;
  /** Used to clean up QA themes of closed pull requests when the store is full. */
  isPullRequestOpen?: (pullRequest: number) => Promise<boolean>;
}

/** Deletes QA themes whose pull request is closed. Returns how many were deleted. */
export async function deleteOrphanThemes(cli: ShopifyCli, themes: readonly RemoteTheme[], isPullRequestOpen: (pullRequest: number) => Promise<boolean>): Promise<number> {
  let deleted = 0;
  for (const theme of themes) {
    const pullRequest = pullRequestFromName(theme.name);
    if (!pullRequest || !isQaTheme(theme)) continue;
    if (await isPullRequestOpen(pullRequest)) continue;
    await cli.deleteTheme(theme.id);
    deleted += 1;
  }
  return deleted;
}

/** Creates or reuses the QA theme and uploads the code. Never touches the live theme. */
export async function prepareQaTheme(cli: ShopifyCli, options: PrepareThemeOptions): Promise<{ theme: RemoteTheme; live: RemoteTheme }> {
  const themes = await cli.listThemes();
  const live = themes.find(isLive);
  if (!live) throw new StageError("theme", "infra", "Shopify did not report a live theme for this store.", "Re-run the job.");

  const existing = themes.find((theme) => theme.name === options.name);
  if (existing && isLive(existing)) {
    throw new StageError("theme", "config", `Refusing to upload: "${options.name}" is the live theme.`, "Rename the live theme in Shopify Admin.");
  }

  let theme: RemoteTheme;
  if (existing) {
    theme = await cli.push(options.root, { id: existing.id });
  } else {
    const limit = options.themeLimit ?? DEFAULT_THEME_LIMIT;
    // Development themes do not count toward the store's theme limit.
    if (themes.filter((candidate) => candidate.role !== "development").length >= limit && options.isPullRequestOpen) {
      await deleteOrphanThemes(cli, themes, options.isPullRequestOpen);
    }
    theme = await cli.push(options.root, { name: options.name });
  }

  if (isLive(theme) || theme.id === live.id) {
    throw new StageError("theme", "internal", "The upload target resolved to the live theme. Stopping before any check runs.");
  }
  return { theme, live };
}

/** Deletes the QA theme of a pull request, if it exists. */
export async function deleteQaTheme(cli: ShopifyCli, name: string): Promise<boolean> {
  const theme = (await cli.listThemes()).find((candidate) => candidate.name === name);
  if (!theme || !isQaTheme(theme)) return false;
  await cli.deleteTheme(theme.id);
  return true;
}
