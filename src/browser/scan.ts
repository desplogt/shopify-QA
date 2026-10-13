import type { APIRequestContext } from "playwright";
import { normalizeUrl, sectionKey } from "../normalize.js";
import type { Observation, ThemeSide, Viewport } from "../types.js";
import { renderedThemeId, type StoreSession } from "./session.js";

const THEME_ASSET_PATH = /\/t\/\d+\/(?:compiled_)?assets\//;
const STACK_URL = /https?:\/\/[^\s)]+/;

export interface PageScan {
  path: string;
  side: ThemeSide;
  viewport: Viewport;
  /** HTTP status of the document, or null when it did not load. */
  status: number | null;
  loadError?: string;
  themeId: number | null;
  observations: Observation[];
  /** Same-origin links found on the page, without fragments. */
  links: string[];
}

function isThemeAsset(url: string): boolean {
  try {
    return THEME_ASSET_PATH.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function stackResource(stack: string | undefined): string | undefined {
  const match = stack?.match(STACK_URL)?.[0];
  return match ? normalizeUrl(match.replace(/:\d+(?::\d+)?$/, "")) : undefined;
}

/** Loads one page once and collects every technical observation from that single load. */
export async function scanPage(session: StoreSession, path: string): Promise<PageScan> {
  const { side, viewport } = session.options;
  const base = { page: path, viewport };
  const observations: Observation[] = [];
  const page = await session.context.newPage();

  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const location = message.location();
    observations.push({
      ...base,
      rule: "console-error",
      message: message.text().slice(0, 500),
      resource: location.url ? normalizeUrl(location.url) : undefined,
      evidence: { location: location.url ? `${location.url}:${location.lineNumber}:${location.columnNumber}` : undefined },
    });
  });
  page.on("pageerror", (error) => {
    observations.push({
      ...base,
      rule: "js-exception",
      message: `${error.name}: ${error.message}`.slice(0, 500),
      resource: stackResource(error.stack),
      evidence: { stack: error.stack?.split("\n").slice(0, 4).join("\n") },
    });
  });
  page.on("requestfailed", (request) => {
    const url = request.url();
    if (url.startsWith("data:") || (request.isNavigationRequest() && request.frame() === page.mainFrame())) return;
    observations.push({
      ...base,
      rule: isThemeAsset(url) ? "theme-asset-error" : "request-failed",
      message: `${request.resourceType()} request failed`,
      resource: normalizeUrl(url),
      evidence: { failure: request.failure()?.errorText, resourceType: request.resourceType() },
    });
  });
  page.on("response", (response) => {
    const status = response.status();
    const request = response.request();
    if (status < 400 || (request.isNavigationRequest() && request.frame() === page.mainFrame())) return;
    observations.push({
      ...base,
      rule: isThemeAsset(response.url()) ? "theme-asset-error" : "resource-error",
      message: `HTTP ${status} for ${request.resourceType()}`,
      resource: normalizeUrl(response.url()),
      evidence: { status, resourceType: request.resourceType() },
    });
  });

  try {
    let status: number | null;
    try {
      const response = await page.goto(session.url(path), { waitUntil: "domcontentloaded", timeout: 30_000 });
      status = response?.status() ?? null;
    } catch (error) {
      return { path, side, viewport, status: null, loadError: error instanceof Error ? error.message.split("\n")[0] : String(error), themeId: null, observations: [], links: [] };
    }
    if (status !== null && status >= 400) {
      observations.push({ ...base, rule: "page-status", message: `Page returned HTTP ${status}`, evidence: { status } });
    }

    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
    // Scroll through the page so lazy-loaded images and sections render, then wait briefly for images.
    await page.evaluate(async () => {
      const step = Math.max(window.innerHeight * 0.8, 400);
      for (let y = 0, steps = 0; y < document.body.scrollHeight && steps < 15; y += step, steps += 1) {
        window.scrollTo(0, y);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      window.scrollTo(0, 0);
      await Promise.race([
        Promise.all(
          Array.from(document.images).map((image) =>
            image.complete ? null : new Promise((resolve) => {
              image.addEventListener("load", resolve, { once: true });
              image.addEventListener("error", resolve, { once: true });
            }),
          ),
        ),
        new Promise((resolve) => setTimeout(resolve, 3_000)),
      ]);
    });

    const liquidErrors = await page.evaluate(() => {
      const results: Array<{ text: string; section: string | null }> = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? "";
        if (!/Liquid (?:syntax )?error/i.test(text)) continue;
        const section = node.parentElement?.closest('[id^="shopify-section-"]')?.id ?? null;
        for (const match of text.match(/Liquid (?:syntax )?error[^\n<]*/gi) ?? []) results.push({ text: match.trim().slice(0, 300), section });
      }
      return results;
    });
    for (const error of liquidErrors) {
      observations.push({ ...base, rule: "liquid-error", message: error.text, section: error.section ? sectionKey(error.section) : undefined });
    }

    const brokenImages = await page.evaluate(() =>
      Array.from(document.images)
        .filter((image) => {
          const source = image.currentSrc || image.src;
          return Boolean(source) && !source.startsWith("data:") && image.complete && image.naturalWidth === 0;
        })
        .map((image) => ({ source: image.currentSrc || image.src, section: image.closest('[id^="shopify-section-"]')?.id ?? null })),
    );
    for (const image of brokenImages) {
      observations.push({
        ...base,
        rule: "broken-image",
        message: "Image failed to load",
        resource: normalizeUrl(image.source),
        section: image.section ? sectionKey(image.section) : undefined,
      });
    }

    const links = await page.evaluate(() =>
      [
        ...new Set(
          Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
            .map((anchor) => anchor.href)
            .filter((href) => {
              try {
                const url = new URL(href);
                return (
                  url.origin === location.origin &&
                  !url.pathname.startsWith("/cart/add") &&
                  !url.pathname.startsWith("/cdn/") &&
                  !/^\/(?:account|password|checkouts?|challenge)(?:\/|$)/.test(url.pathname)
                );
              } catch {
                return false;
              }
            })
            .map((href) => href.split("#")[0] ?? href),
        ),
      ].slice(0, 60),
    );

    return { path, side, viewport, status, themeId: await renderedThemeId(page), observations, links };
  } finally {
    await page.close();
  }
}

export interface LinkResult {
  status?: number;
  error?: string;
}

/** Checks each unique link once per run, independent of the theme that linked to it. */
export async function checkLinks(request: APIRequestContext, links: Iterable<string>, concurrency = 6): Promise<Map<string, LinkResult>> {
  const unique = [...new Set([...links].map((link) => normalizeUrl(link)))];
  const results = new Map<string, LinkResult>();
  let index = 0;
  const worker = async () => {
    while (index < unique.length) {
      const link = unique[index++]!;
      try {
        let response = await request.head(link, { maxRedirects: 5, timeout: 10_000, failOnStatusCode: false });
        if ([403, 405, 501].includes(response.status())) {
          response = await request.get(link, { maxRedirects: 5, timeout: 10_000, failOnStatusCode: false });
        }
        results.set(link, { status: response.status() });
      } catch (error) {
        results.set(link, { error: error instanceof Error ? error.message.split("\n")[0] : String(error) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, worker));
  return results;
}

export function brokenLinkObservations(scan: PageScan, results: ReadonlyMap<string, LinkResult>): Observation[] {
  return scan.links.flatMap((link) => {
    const resource = normalizeUrl(link);
    const result = results.get(resource);
    if (!result || (result.status !== undefined && result.status < 400)) return [];
    return [
      {
        page: scan.path,
        viewport: scan.viewport,
        rule: "broken-link",
        message: result.status ? `Link returns HTTP ${result.status}` : `Link request failed: ${result.error}`,
        resource,
        evidence: { status: result.status, error: result.error },
      },
    ];
  });
}
