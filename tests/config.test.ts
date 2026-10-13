import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig, parseConfig, resolveStore } from "../src/config.js";
import { StageError } from "../src/errors.js";

const minimal = {
  store: "example-store.myshopify.com",
  pages: ["/", "/products/shirt", "/"],
  purchase: { products: ["/products/shirt"] },
};

test("applies defaults and removes duplicate pages", () => {
  const config = parseConfig(minimal);
  assert.equal(config.storeUrl, "https://example-store.myshopify.com");
  assert.equal(config.storeDomain, "example-store.myshopify.com");
  assert.deepEqual(config.pages, ["/", "/products/shirt"]);
  assert.deepEqual(config.viewports, ["desktop", "mobile"]);
  assert.equal(config.build, null);
  assert.equal(config.themeRoot, ".");
  assert.ok(config.themeCheck.blocking.includes("LiquidHTMLSyntaxError"));
});

test("accepts a store prefix like the Shopify CLI does", () => {
  assert.equal(resolveStore("example-store").storeUrl, "https://example-store.myshopify.com");
});

test("rejects plain HTTP except for local test servers", () => {
  assert.throws(() => resolveStore("http://example.com"), StageError);
  assert.equal(resolveStore("http://127.0.0.1:4010").storeUrl, "http://127.0.0.1:4010");
});

test("reports every invalid field as a config error with its path", () => {
  try {
    parseConfig({ store: "x.myshopify.com", pages: ["products/shirt"], purchase: { products: ["/collections/all"] } });
    assert.fail("expected an error");
  } catch (error) {
    assert.ok(error instanceof StageError);
    assert.equal(error.category, "config");
    assert.match(error.message, /pages\.0/);
    assert.match(error.message, /purchase\.products\.0/);
  }
});

test("the example config shipped in examples/ is valid", async () => {
  const config = await loadConfig(fileURLToPath(new URL("../examples/theme-qa.yml", import.meta.url)));
  assert.equal(config.storeDomain, "example-store.myshopify.com");
  assert.equal(config.purchase.products.length, 2);
});

test("ignore rules must explain why and match something", () => {
  assert.throws(() => parseConfig({ ...minimal, ignore: [{ reason: "because" }] }), /needs at least one of rule, match, or page/);
  assert.throws(() => parseConfig({ ...minimal, ignore: [{ rule: "console-error" }] }), /ignore\.0\.reason/);
});
