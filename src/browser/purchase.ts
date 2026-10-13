import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import type { ErrorCategory, ThemeSide, Viewport } from "../types.js";
import { diagnoseCartPage, diagnoseProductPage } from "./diagnose.js";
import { isBotChallenge, type StoreSession } from "./session.js";

export const PURCHASE_STEPS = [
  "Clear the cart",
  "Open the product",
  "Add to cart",
  "Change the quantity in the cart",
  "Reach checkout",
  "Clear the cart",
] as const;

export interface PurchaseSelectors {
  addToCart?: string;
  quantity?: string;
  update?: string;
  checkout?: string;
}

export interface PurchaseOutcome {
  side: ThemeSide;
  viewport: Viewport;
  status: "passed" | "failed" | "error";
  product?: string;
  /** 1-based index into PURCHASE_STEPS. */
  failedStep?: number;
  message?: string;
  /** Only for status "error": why the flow could not be verified. */
  category?: ErrorCategory;
  /** Diagnosis relevant to the failed step. */
  diagnosis: string[];
  jsErrors: string[];
  screenshot?: string;
  trace?: string;
  notes: string[];
}

interface CartState {
  item_count: number;
  items: Array<{ variant_id: number; quantity: number }>;
}

interface ProductJson {
  variants?: Array<{ id: number; available: boolean }>;
}

class StepFailure extends Error {
  constructor(
    readonly step: number,
    message: string,
  ) {
    super(message);
  }
}

/** Shopify throttled the session or returned something other than the cart API. */
class InfraError extends Error {}

const ADD_CONTROL = '[name="add"], button[type="submit"], input[type="submit"]';

/** Themes keep hidden copies of controls (Dawn's cart drawer has its own checkout button). */
const visible = (locator: Locator) => locator.filter({ visible: true }).first();

const firstLine = (error: unknown) => (error instanceof Error ? error.message.split("\n")[0] ?? error.message : String(error));

export interface PurchaseOptions {
  products: readonly string[];
  selectors: PurchaseSelectors;
  artifactDir: string;
}

/** Runs the purchase flow up to Shopify's checkout page. No order is ever placed. */
export async function runPurchaseFlow(session: StoreSession, options: PurchaseOptions): Promise<PurchaseOutcome> {
  const { side, viewport, storeUrl } = session.options;
  const { context } = session;
  const outcome: PurchaseOutcome = { side, viewport, status: "passed", diagnosis: [], jsErrors: [], notes: [] };
  const productDiagnosis: string[] = [];
  const cartDiagnosis: string[] = [];

  /**
   * Calls the cart API from inside the page with fetch(), exactly like theme JavaScript does
   * (same origin, browser headers, cookies). Shopify throttles bursts with HTTP 429, so it
   * honours Retry-After and only gives up after about half a minute.
   */
  const cartApi = async (method: "GET" | "POST", path: string): Promise<CartState> => {
    let last = "no response";
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      if (!page.url().startsWith(new URL(storeUrl).origin)) await page.goto(session.url("/cart"), { waitUntil: "domcontentloaded", timeout: 30_000 });
      const result = await page
        .evaluate(
          async ({ method, path }) => {
            const response = await fetch(path, { method, headers: { accept: "application/json" }, credentials: "same-origin" });
            // Shopify serves some cart endpoints as text/javascript, so parse the body, not the header.
            const text = await response.text();
            let json: unknown = null;
            if (response.ok) {
              try {
                json = JSON.parse(text);
              } catch {
                json = null;
              }
            }
            return { status: response.status, json, retryAfter: response.headers.get("retry-after"), detail: response.headers.get("content-type") ?? "" };
          },
          { method, path },
        )
        // A navigation started by the theme interrupts the call; try again on the next page.
        .catch((error: unknown) => ({ status: 0, json: null, retryAfter: null, detail: firstLine(error) }));
      if (result.json) return result.json as CartState;
      last = result.status === 429 ? "HTTP 429 (Shopify rate limit)" : result.status === 0 ? `request interrupted (${result.detail})` : `HTTP ${result.status} (${result.detail || "no content-type"})`;
      const retryAfter = Number(result.retryAfter);
      await page.waitForTimeout(Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : 1_500 * attempt, 10_000)).catch(() => undefined);
    }
    throw new InfraError(`${path} kept failing: ${last}.`);
  };
  const readCart = () => cartApi("GET", "/cart.js");
  const clearCart = async () => {
    await cartApi("POST", "/cart/clear.js");
  };
  const waitForCart = async (predicate: (cart: CartState) => boolean, failure: string) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (predicate(await readCart())) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(failure);
  };

  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  page.on("pageerror", (error) => outcome.jsErrors.push(`${error.name}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !/^Failed to load resource/i.test(message.text())) outcome.jsErrors.push(message.text());
  });

  /** Retries a step once before it counts as failed. */
  const step = async <T>(index: number, action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      if (error instanceof InfraError) throw error;
      await page.waitForTimeout(1_000);
      try {
        return await action();
      } catch (retryError) {
        if (retryError instanceof InfraError) throw retryError;
        throw new StepFailure(index, firstLine(retryError));
      }
    }
  };

  let traceSaved = false;
  try {
    await step(1, async () => {
      await clearCart();
      if ((await readCart()).item_count !== 0) throw new Error("The cart still has items after /cart/clear.js.");
    });

    const choice = await chooseProduct(session, options.products);
    if (!choice) {
      return { ...outcome, status: "error", category: "config", message: `None of the configured products has an available variant: ${options.products.join(", ")}.` };
    }
    outcome.product = choice.product;

    await step(2, async () => {
      const response = await page.goto(session.url(choice.product), { waitUntil: "domcontentloaded", timeout: 30_000 });
      if (await isBotChallenge(page)) throw new InfraError("Shopify's bot protection challenged the automated browser on the product page.");
      if (!response || response.status() >= 400) throw new Error(`The product page returned HTTP ${response?.status() ?? "no response"}.`);
      await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
    });
    productDiagnosis.push(...(await diagnoseProductPage(page)));

    const form = await productForm(page);
    const variantId = await ensureAvailableVariant(form, choice.available, outcome.notes);

    await step(3, async () => {
      const button = options.selectors.addToCart ? visible(page.locator(options.selectors.addToCart)) : await addToCartControl(page, form);
      await button.scrollIntoViewIfNeeded({ timeout: 5_000 });
      await button.click({ timeout: 10_000 });
      await waitForCart(
        (cart) => cart.items.some((item) => variantId === undefined || item.variant_id === variantId),
        "“Add to cart” was clicked but /cart.js does not contain the selected variant.",
      );
    });
    const addedVariant = variantId ?? (await readCart()).items[0]?.variant_id;

    await step(4, async () => {
      await page.goto(session.url("/cart"), { waitUntil: "domcontentloaded", timeout: 30_000 });
      const quantity = visible(page.locator(options.selectors.quantity ?? 'input[name="updates[]"], input[name^="updates["]'));
      if ((await quantity.count()) === 0) throw new Error("No quantity input was found on /cart.");
      await quantity.fill("2");
      await quantity.dispatchEvent("change");
      const update = visible(page.locator(options.selectors.update ?? '[name="update"]'));
      if ((await update.count()) > 0 && (await update.isVisible())) await update.click({ timeout: 10_000 });
      await waitForCart(
        (cart) => cart.items.find((item) => item.variant_id === addedVariant)?.quantity === 2,
        "The quantity was set to 2 but /cart.js did not update.",
      );
    });

    if (!new URL(page.url()).pathname.startsWith("/cart")) await page.goto(session.url("/cart"), { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
    cartDiagnosis.push(...(await diagnoseCartPage(page)));

    await step(5, async () => {
      if (!new URL(page.url()).pathname.startsWith("/cart")) await page.goto(session.url("/cart"), { waitUntil: "domcontentloaded", timeout: 30_000 });
      const checkout = visible(page.locator(options.selectors.checkout ?? '[name="checkout"], a[href*="/checkout"]'));
      await checkout.click({ timeout: 10_000 });
      await page.waitForURL((url) => /\/checkouts?(?:\/|$)/.test(url.pathname) || url.hostname.endsWith("checkout.shopify.com"), {
        timeout: 25_000,
        waitUntil: "commit",
      });
    });

    await step(6, async () => {
      await clearCart();
      if ((await readCart()).item_count !== 0) throw new Error("The cart still has items after /cart/clear.js.");
    });
    return outcome;
  } catch (error) {
    if (error instanceof InfraError) {
      return { ...outcome, status: "error", category: "infra", message: `The purchase flow could not be verified: ${error.message}` };
    }
    if (!(error instanceof StepFailure)) {
      return { ...outcome, status: "error", category: "internal", message: `The purchase flow stopped unexpectedly: ${firstLine(error)}` };
    }
    outcome.status = "failed";
    outcome.failedStep = error.step;
    outcome.message = error.message;
    outcome.diagnosis = error.step >= 4 ? cartDiagnosis : error.step >= 2 ? productDiagnosis : [];
    await mkdir(options.artifactDir, { recursive: true });
    const stem = path.join(options.artifactDir, `purchase-${side}-${viewport}`);
    outcome.screenshot = await page.screenshot({ path: `${stem}.png` }).then(() => `${stem}.png`, () => undefined);
    await context.tracing.stop({ path: `${stem}-trace.zip` }).catch(() => undefined);
    outcome.trace = `${stem}-trace.zip`;
    traceSaved = true;
    return outcome;
  } finally {
    outcome.jsErrors = [...new Set(outcome.jsErrors)].slice(0, 10);
    await clearCart().catch(() => undefined);
    if (!traceSaved) await context.tracing.stop().catch(() => undefined);
    await page.close().catch(() => undefined);
  }
}

async function chooseProduct(session: StoreSession, products: readonly string[]): Promise<{ product: string; available: number[] } | undefined> {
  for (const product of products) {
    const pathname = new URL(product, session.options.storeUrl).pathname.replace(/\/+$/, "");
    for (let attempt = 1; ; attempt += 1) {
      const response = await session.context.request.get(`${session.options.storeUrl}${pathname}.js`, { failOnStatusCode: false, timeout: 15_000 }).catch(() => undefined);
      // A throttled request says nothing about stock; never mistake it for "no product available".
      if (response?.status() === 429) {
        if (attempt >= 4) throw new InfraError(`${pathname}.js kept returning HTTP 429 (Shopify rate limit).`);
        await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
        continue;
      }
      if (response?.ok()) {
        const json = (await response.json().catch(() => ({}))) as ProductJson;
        const available = (json.variants ?? []).filter((variant) => variant.available).map((variant) => variant.id);
        if (available.length > 0) return { product, available };
      }
      break;
    }
  }
  return undefined;
}

/**
 * The product form is the /cart/add form that has an add-to-cart control. Themes such as Dawn
 * render other /cart/add forms first (Shop Pay installments) that have no button.
 */
async function productForm(page: Page): Promise<Locator> {
  for (const scope of ['main form[action*="/cart/add"]', 'form[action*="/cart/add"]']) {
    const withControl = page.locator(`${scope}:has(${ADD_CONTROL})`);
    if ((await withControl.count()) > 0) return withControl.first();
  }
  const inMain = page.locator('main form[action*="/cart/add"]');
  return (await inMain.count()) > 0 ? inMain.first() : page.locator('form[action*="/cart/add"]').first();
}

/** The add-to-cart control inside the form, or one linked to it with the form="id" attribute. */
async function addToCartControl(page: Page, form: Locator): Promise<Locator> {
  const inside = form.locator(ADD_CONTROL);
  if ((await inside.count()) > 0) return visible(inside);
  const id = await form.getAttribute("id").catch(() => null);
  return id ? visible(page.locator(`[form="${id}"]:is(${ADD_CONTROL})`)) : visible(inside);
}

/** Returns the selected variant ID, switching to an available one when the default is sold out. */
async function ensureAvailableVariant(form: Locator, available: number[], notes: string[]): Promise<number | undefined> {
  const field = form.locator('[name="id"]').first();
  if ((await field.count()) === 0) return undefined;
  const selected = Number(await field.inputValue().catch(() => Number.NaN));
  if (available.includes(selected)) return selected;
  const replacement = available[0]!;
  const tag = await field.evaluate((element) => element.tagName.toLowerCase());
  if (tag === "select") await field.selectOption(String(replacement));
  else await field.evaluate((element, value) => ((element as HTMLInputElement).value = value), String(replacement));
  notes.push(`The default variant was unavailable; variant ${replacement} was selected instead.`);
  return replacement;
}
