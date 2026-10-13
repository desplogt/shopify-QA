/**
 * Runs the real browser checks against the local fake store (no Shopify access).
 */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { StoreSession } from "../src/browser/session.js";
import { runPurchaseCheck } from "../src/checks/purchase.js";
import { runTechnicalCheck } from "../src/checks/technical.js";
import { DEFAULT_BLOCKING_THEME_CHECKS } from "../src/compare.js";
import { StageError } from "../src/errors.js";
import type { Viewport } from "../src/types.js";
import { fakeTheme, startFakeStore, type Fault, type FakeStoreOptions } from "./fixtures/fake-store.js";

let browser: Browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser.close();
});

const PAGES = ["/", "/collections/all", "/products/shirt", "/cart"];

async function withStore<T>(previewFaults: Fault[], action: (context: { url: string; open: (viewports?: Viewport[]) => Promise<StoreSession[]> }) => Promise<T>, options: FakeStoreOptions & { liveFaults?: Fault[] } = {}): Promise<T> {
  const live = fakeTheme("live", options.liveFaults);
  const preview = fakeTheme("unpublished", previewFaults);
  const store = await startFakeStore([live, preview], options);
  const sessions: StoreSession[] = [];
  try {
    return await action({
      url: store.url,
      open: async (viewports = ["desktop"]) => {
        for (const viewport of viewports) {
          for (const [side, themeId] of [["live", live.id], ["preview", preview.id]] as const) {
            sessions.push(await StoreSession.open(browser, { storeUrl: store.url, side, viewport, themeId, storefrontPassword: options.password, blockHosts: [] }));
          }
        }
        return sessions;
      },
    });
  } finally {
    await Promise.all(sessions.map((session) => session.close()));
    await store.close();
  }
}

const technical = (sessions: StoreSession[]) => runTechnicalCheck({ sessions, pages: PAGES, ignore: [], blockingThemeChecks: [...DEFAULT_BLOCKING_THEME_CHECKS] });

test("identical themes pass the technical check; pre-existing errors are only informational", async () => {
  await withStore(
    ["legacy-console-error"],
    async ({ open }) => {
      const sessions = await open(["desktop", "mobile"]);
      await Promise.all(sessions.map((session) => session.verifyTheme()));
      const result = await technical(sessions);
      assert.equal(result.status, "pass", JSON.stringify(result.findings, null, 2));
      assert.ok(result.findings.some((finding) => finding.status === "existing" && finding.rule === "console-error"));
      assert.equal(result.findings.filter((finding) => finding.status === "new").length, 0);
    },
    { liveFaults: ["legacy-console-error"] },
  );
});

test("new defects in the preview are found, attributed, and classified", async () => {
  await withStore(["liquid-error", "js-exception", "missing-asset", "page-500", "broken-image", "broken-link"], async ({ open }) => {
    const result = await technical(await open());
    assert.equal(result.status, "fail");
    const byRule = (rule: string) => result.findings.filter((finding) => finding.rule === rule && finding.status === "new");

    const liquid = byRule("liquid-error")[0];
    assert.equal(liquid?.severity, "block");
    assert.equal(liquid?.page, "/products/shirt");
    assert.equal(liquid?.section, "main-product");

    assert.equal(byRule("js-exception")[0]?.severity, "block");
    assert.match(byRule("theme-asset-error")[0]?.resource ?? "", /\/t\/\*\/assets\/missing\.js/);
    assert.equal(byRule("page-status").find((finding) => finding.page === "/collections/all")?.severity, "block");
    assert.equal(byRule("broken-link")[0]?.severity, "warn");
    assert.equal(byRule("broken-image")[0]?.severity, "warn");
  });
});

test("the purchase flow passes end to end on both viewports", async () => {
  await withStore([], async ({ open }) => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "theme-qa-artifacts-"));
    const result = await runPurchaseCheck({ sessions: await open(["desktop", "mobile"]), products: ["/products/sold-out", "/products/shirt"], selectors: {}, artifactDir });
    assert.equal(result.status, "pass", result.summary);
    assert.match(result.summary, /works on desktop and mobile/);
  });
});

test("a broken add-to-cart blocks, with the step, JS error, and evidence", async () => {
  await withStore(["broken-add-to-cart"], async ({ open }) => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "theme-qa-artifacts-"));
    const result = await runPurchaseCheck({ sessions: await open(), products: ["/products/shirt"], selectors: {}, artifactDir });
    assert.equal(result.status, "fail");
    const finding = result.findings[0]!;
    assert.equal(finding.severity, "block");
    assert.equal(finding.evidence?.step, 3);
    assert.match(finding.message, /Add to cart/);
    assert.ok((finding.evidence?.jsErrors as string[]).some((error) => /TypeError/.test(error)));
    assert.equal(finding.evidence?.live, "passes on live");
    assert.ok(String(finding.evidence?.screenshot).endsWith(".png"));
  });
});

test("the diagnosis explains a product form without a variant ID", async () => {
  await withStore(["no-variant-id"], async ({ open }) => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "theme-qa-artifacts-"));
    const result = await runPurchaseCheck({ sessions: await open(), products: ["/products/shirt"], selectors: {}, artifactDir });
    assert.equal(result.status, "fail");
    assert.ok((result.findings[0]?.evidence?.diagnosis as string[]).some((problem) => /variant ID/.test(problem)));
  });
});

test("a missing checkout button blocks at the checkout step", async () => {
  await withStore(["no-checkout-button"], async ({ open }) => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "theme-qa-artifacts-"));
    const result = await runPurchaseCheck({ sessions: await open(), products: ["/products/shirt"], selectors: {}, artifactDir });
    assert.equal(result.status, "fail");
    assert.equal(result.findings[0]?.evidence?.step, 5);
    assert.ok((result.findings[0]?.evidence?.diagnosis as string[]).some((problem) => /checkout/.test(problem)));
  });
});

test("no product with stock means the purchase flow cannot be verified (fails closed)", async () => {
  await withStore([], async ({ open }) => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "theme-qa-artifacts-"));
    const result = await runPurchaseCheck({ sessions: await open(), products: ["/products/sold-out"], selectors: {}, artifactDir });
    assert.equal(result.status, "error");
    assert.equal(result.failure?.category, "config");
  });
});

test("password-protected storefronts: missing, wrong, and correct passwords", async () => {
  const store = await startFakeStore([fakeTheme("live"), fakeTheme("unpublished")], { password: "letmein" });
  const options = { storeUrl: store.url, side: "live" as const, viewport: "desktop" as const, themeId: 1001, blockHosts: [] };
  try {
    await assert.rejects(StoreSession.open(browser, options), (error: unknown) => error instanceof StageError && error.category === "config" && /password protected/.test(error.message));
    await assert.rejects(StoreSession.open(browser, { ...options, storefrontPassword: "nope" }), (error: unknown) => error instanceof StageError && /rejected/.test(error.message));
    const session = await StoreSession.open(browser, { ...options, storefrontPassword: "letmein" });
    await session.verifyTheme();
    await session.close();
  } finally {
    await store.close();
  }
});

test("a preview that serves the live theme is caught before any check runs", async () => {
  await withStore(
    [],
    async ({ url }) => {
      const session = await StoreSession.open(browser, { storeUrl: url, side: "preview", viewport: "desktop", themeId: 2002, blockHosts: [] });
      try {
        await assert.rejects(session.verifyTheme(), (error: unknown) => error instanceof StageError && error.category === "infra" && /instead of 2002/.test(error.message));
      } finally {
        await session.close();
      }
    },
    { ignorePreview: true },
  );
});

test("Dawn-style pages: the installment form without a button is skipped", async () => {
  // The fake store renders a Shop Pay installments form before the real product form, like Dawn.
  await withStore([], async ({ open }) => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "theme-qa-artifacts-"));
    const result = await runPurchaseCheck({ sessions: await open(), products: ["/products/shirt"], selectors: {}, artifactDir });
    assert.equal(result.status, "pass", result.summary);
  });
});

test("Shopify rate limits (429) on the cart API and links are waited out, not reported", async () => {
  await withStore(
    [],
    async ({ open }) => {
      const sessions = await open();
      const artifactDir = await mkdtemp(path.join(os.tmpdir(), "theme-qa-artifacts-"));
      const purchase = await runPurchaseCheck({ sessions, products: ["/products/shirt"], selectors: {}, artifactDir });
      assert.equal(purchase.status, "pass", purchase.summary);
      const result = await technical(sessions);
      assert.ok(!result.findings.some((finding) => finding.rule === "broken-link"), JSON.stringify(result.findings, null, 2));
    },
    { rateLimitOnce: ["/cart.js", "/pages/about"] },
  );
});

test("Shopify's bot protection page is reported as such, never as a wrong password", async () => {
  const store = await startFakeStore([fakeTheme("live"), fakeTheme("unpublished")], { password: "letmein", challenge: true });
  try {
    await assert.rejects(
      StoreSession.open(browser, { storeUrl: store.url, side: "live", viewport: "desktop", themeId: 1001, storefrontPassword: "letmein", blockHosts: [] }),
      (error: unknown) => error instanceof StageError && error.category === "infra" && /bot protection/.test(error.message) && /Wait 30/.test(error.hint ?? ""),
    );
  } finally {
    await store.close();
  }
});
