import type { Browser, BrowserContext, Page } from "playwright";
import { StageError } from "../errors.js";
import type { ThemeSide, Viewport } from "../types.js";

/*
 * Functions passed to page.evaluate() are serialized and run in the page. When the source
 * runs through tsx/esbuild (keepNames), nested named functions are wrapped with a `__name`
 * helper that does not exist in the page, so every context defines a no-op shim.
 */
const NAME_SHIM = "globalThis.__name = globalThis.__name || ((target) => target);";

/** Shopify's preview bar is fixed to the bottom of the page: it can cover buttons and pollutes screenshots. */
const HIDE_PREVIEW_BAR = `document.addEventListener("DOMContentLoaded", () => {
  const style = document.createElement("style");
  style.textContent = "#preview-bar-iframe, #PBarNextFrameWrapper, #PBarNextFrame { display: none !important; }";
  document.head.appendChild(style);
});`;

const VIEWPORT_SETTINGS = {
  desktop: { viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false },
  mobile: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
} as const;

export interface SessionOptions {
  storeUrl: string;
  side: ThemeSide;
  viewport: Viewport;
  /** Theme expected to render. On the preview side it is requested with preview_theme_id. */
  themeId: number;
  storefrontPassword?: string;
  /** Substrings of hostnames whose requests are aborted (analytics, chat widgets, popups). */
  blockHosts: readonly string[];
  /** Cookies from a session that already unlocked the storefront, so the password is sent once per run. */
  storageState?: Awaited<ReturnType<BrowserContext["storageState"]>>;
}

export const BOT_CHALLENGE_HINT =
  "Wait 30–60 minutes and re-run. If it keeps happening, run Theme QA from a self-hosted runner (a non-datacenter IP) or check fewer pages and viewports.";

/** Shopify's bot protection page ("Just a moment… Your connection needs to be verified"). */
export async function isBotChallenge(page: Page): Promise<boolean> {
  if (/just a moment/i.test(await page.title().catch(() => ""))) return true;
  return (await page.getByText(/connection needs to be verified/i).count().catch(() => 0)) > 0;
}

function botChallengeError(label: string): StageError {
  return new StageError("verify", "infra", `Shopify's bot protection challenged the automated browser (${label}): "Your connection needs to be verified".`, BOT_CHALLENGE_HINT);
}

export async function isPasswordPage(page: Page): Promise<boolean> {
  if (new URL(page.url()).pathname.replace(/\/+$/, "") === "/password") return true;
  return (await page.locator('form[action*="/password"] input[type="password"]').count()) > 0;
}

export async function renderedThemeId(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const id = (window as unknown as { Shopify?: { theme?: { id?: unknown } } }).Shopify?.theme?.id;
    const value = Number(id);
    return id !== undefined && id !== null && Number.isFinite(value) ? value : null;
  });
}

/** One isolated browser context per theme side and viewport, with its own cookies and cart. */
export class StoreSession {
  private constructor(
    readonly context: BrowserContext,
    readonly options: SessionOptions,
  ) {}

  static async open(browser: Browser, options: SessionOptions): Promise<StoreSession> {
    // Headless Chromium announces itself as "HeadlessChrome", and a Safari user agent on a Chromium
    // engine contradicts its client hints. Bot protection throttles both, so the user agent is
    // a regular Chrome (desktop) or Chrome on Android (mobile) of the same version.
    const chrome = `Chrome/${browser.version().split(".")[0]}.0.0.0`;
    const userAgent =
      options.viewport === "desktop"
        ? `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ${chrome} Safari/537.36`
        : `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) ${chrome} Mobile Safari/537.36`;
    const settings = { ...VIEWPORT_SETTINGS[options.viewport], userAgent };
    const context = await browser.newContext({ ...settings, reducedMotion: "reduce", storageState: options.storageState });
    await context.addInitScript({ content: NAME_SHIM });
    await context.addInitScript({ content: HIDE_PREVIEW_BAR });
    if (options.blockHosts.length > 0) {
      await context.route("**/*", (route) => {
        const host = new URL(route.request().url()).hostname;
        return options.blockHosts.some((blocked) => host.includes(blocked)) ? route.abort("blockedbyclient") : route.continue();
      });
    }
    const session = new StoreSession(context, options);
    try {
      await session.unlock();
    } catch (error) {
      await context.close();
      throw error;
    }
    return session;
  }

  get label(): string {
    return `${this.options.side} ${this.options.viewport}`;
  }

  /** Absolute storefront URL for this session's theme. */
  url(path: string): string {
    const url = new URL(path, this.options.storeUrl);
    if (this.options.side === "preview") url.searchParams.set("preview_theme_id", String(this.options.themeId));
    return url.toString();
  }

  private async unlock(): Promise<void> {
    const page = await this.context.newPage();
    try {
      await page.goto(this.url("/"), { waitUntil: "domcontentloaded", timeout: 30_000 }).catch((error: unknown) => {
        throw new StageError("verify", "infra", `The storefront did not respond (${this.label}): ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`, "Re-run the job.");
      });
      if (await isBotChallenge(page)) throw botChallengeError(this.label);
      if (!(await isPasswordPage(page))) return;
      const password = this.options.storefrontPassword;
      if (!password) {
        throw new StageError("verify", "config", "The storefront is password protected.", "Add the STOREFRONT_PASSWORD secret.");
      }
      const input = page.locator('form[action*="/password"] input[type="password"]').first();
      await input.fill(password);
      await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => null), input.press("Enter")]);
      if (await isBotChallenge(page)) throw botChallengeError(this.label);
      if (await isPasswordPage(page)) {
        throw new StageError("verify", "config", "The storefront password was rejected.", "Update the STOREFRONT_PASSWORD secret.");
      }
    } finally {
      await page.close();
    }
  }

  /** Confirms the storefront renders the expected theme, so live is never compared with itself. */
  async verifyTheme(): Promise<void> {
    const page = await this.context.newPage();
    try {
      await page.goto(this.url("/"), { waitUntil: "domcontentloaded", timeout: 30_000 });
      const rendered = await renderedThemeId(page);
      if (rendered === null && (await isBotChallenge(page))) throw botChallengeError(this.label);
      if (rendered !== this.options.themeId) {
        throw new StageError(
          "verify",
          "infra",
          `The ${this.options.side} storefront (${this.options.viewport}) rendered theme ${rendered ?? "unknown"} instead of ${this.options.themeId}.`,
          "Open the preview link in a browser to confirm it works, then re-run the job.",
        );
      }
    } finally {
      await page.close();
    }
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}
