/**
 * Accuracy requirements from docs/PROCESS.md section 10. A release gate that reports
 * false positives gets ignored, so these must always pass.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFindings } from "../src/compare.js";
import { normalizeUrl, sectionKey } from "../src/normalize.js";
import type { Observation } from "../src/types.js";
import { statusFromFindings } from "../src/verdict.js";

const asset = (theme: number, file: string, version = "1700000000") =>
  `https://example.myshopify.com/cdn/shop/t/${theme}/assets/${file}?v=${version}`;

function themeObservations(themeNumber: number, templateId: string): Observation[] {
  return [
    { rule: "console-error", message: `Uncaught config at ${asset(themeNumber, "theme.js")}:120:14`, page: "/", viewport: "desktop" },
    { rule: "resource-error", message: "HTTP 404 response", page: "/", viewport: "desktop", resource: normalizeUrl("https://cdn.reviews.example/widget.js"), evidence: { status: 404 } },
    { rule: "broken-image", message: "Image failed to load", page: "/collections/all", viewport: "mobile", section: sectionKey(`shopify-section-template--${templateId}__main`) },
    { rule: "theme-asset-error", message: "HTTP 404 response", page: "/", viewport: "mobile", resource: normalizeUrl(asset(themeNumber, "old.css")), evidence: { status: 404 } },
  ];
}

const newFindings = (findings: ReturnType<typeof buildFindings>) => findings.filter((finding) => finding.status !== "existing");

test("two identical themes produce no new or resolved findings", () => {
  const live = themeObservations(12, "16754345869410");
  const preview = themeObservations(12, "16754345869410");
  const findings = buildFindings(live, preview);
  assert.deepEqual(newFindings(findings), []);
  assert.ok(findings.every((finding) => finding.severity === "info"));
  assert.equal(statusFromFindings(findings, true), "pass");
});

test("a duplicated theme (different theme number and template IDs) still matches", () => {
  const live = themeObservations(12, "16754345869410");
  const preview = themeObservations(148, "17000000000001");
  assert.deepEqual(newFindings(buildFindings(live, preview)), []);
});

test("asset URLs that differ only by theme number or cache-buster normalize to the same value", () => {
  assert.equal(normalizeUrl(asset(12, "theme.js", "111")), normalizeUrl(asset(148, "theme.js", "222")));
  assert.equal(
    normalizeUrl("https://cdn.shopify.com/s/files/1/0001/2345/t/7/assets/app.js?v=9"),
    normalizeUrl("https://cdn.shopify.com/s/files/1/0001/2345/t/31/assets/app.js?v=10"),
  );
  assert.notEqual(normalizeUrl(asset(12, "theme.js")), normalizeUrl(asset(12, "other.js")));
});

test("Shopify-generated section IDs match across duplicated themes", () => {
  assert.equal(sectionKey("shopify-section-template--16754345869410__main"), "main");
  assert.equal(sectionKey("shopify-section-template--17000000000001__main"), "main");
  assert.equal(sectionKey("shopify-section-sections--16754345869410__header"), "header");
  assert.equal(sectionKey("shopify-section-announcement-bar"), "announcement-bar");
});

test("repeated findings are compared as a multiset", () => {
  const error: Observation = { rule: "js-exception", message: "TypeError: x is undefined", page: "/", viewport: "desktop" };
  const findings = buildFindings([error, error], [error, error, error]);
  const added = findings.filter((finding) => finding.status === "new");
  assert.equal(added.length, 1);
  assert.equal(findings.filter((finding) => finding.status === "existing").length, 1, "existing duplicates merge into one entry");
});

test("the same new finding on desktop and mobile is reported once with both viewports", () => {
  const preview: Observation[] = [
    { rule: "liquid-error", message: "Liquid error (sections/main-product line 45): undefined filter", page: "/products/shirt", viewport: "desktop" },
    { rule: "liquid-error", message: "Liquid error (sections/main-product line 45): undefined filter", page: "/products/shirt", viewport: "mobile" },
  ];
  const findings = buildFindings([], preview);
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0]?.viewports, ["desktop", "mobile"]);
  assert.equal(findings[0]?.severity, "block");
});

test("line and column shifts in a changed file do not create new findings", () => {
  const live: Observation[] = [{ rule: "console-error", message: `boom at ${asset(12, "cart.js")}:10:5`, page: "/cart", viewport: "desktop" }];
  const preview: Observation[] = [{ rule: "console-error", message: `boom at ${asset(13, "cart.js")}:42:9`, page: "/cart", viewport: "desktop" }];
  assert.deepEqual(newFindings(buildFindings(live, preview)), []);
});

test("known infrastructure noise never appears as a new finding", () => {
  const preview: Observation[] = [
    { rule: "console-error", message: "Failed to load resource: the server responded with a status of 404 ()", page: "/" },
    { rule: "console-error", message: "Refused to frame 'https://shop.app/' because an ancestor violates frame-ancestors", page: "/" },
    { rule: "request-failed", message: "GET request failed", page: "/", resource: "https://www.googletagmanager.com/gtm.js", evidence: { failure: "net::ERR_BLOCKED_BY_CLIENT" } },
    { rule: "request-failed", message: "POST request failed", page: "/", resource: "https://example.myshopify.com/api/collect", evidence: { failure: "net::ERR_ABORTED" } },
    { rule: "resource-error", message: "HTTP 429 response", page: "/", resource: "https://reviews.example/api", evidence: { status: 429 } },
    { rule: "resource-error", message: "HTTP 500 response", page: "/", resource: "https://monorail-edge.shopifysvc.com/v1/produce", evidence: { status: 500 } },
  ];
  assert.deepEqual(buildFindings([], preview), []);
});

test("configured exceptions are excluded", () => {
  const preview: Observation[] = [{ rule: "console-error", message: "Reviews widget failed to load", page: "/" }];
  const ignore = [{ rule: "console-error", match: "reviews widget", reason: "Third-party widget, tracked in TICKET-1" }];
  assert.deepEqual(buildFindings([], preview, { ignore }), []);
});

test("pre-existing problems never block; new ones are classified by rule", () => {
  const exception: Observation = { rule: "js-exception", message: "TypeError: a is null", page: "/", viewport: "desktop" };
  const consoleError: Observation = { rule: "console-error", message: "Something logged", page: "/", viewport: "desktop" };
  assert.equal(statusFromFindings(buildFindings([exception], [exception]), true), "pass");
  const findings = buildFindings([], [exception, consoleError]);
  assert.equal(findings.find((finding) => finding.rule === "js-exception")?.severity, "block");
  assert.equal(findings.find((finding) => finding.rule === "console-error")?.severity, "warn");
  assert.equal(statusFromFindings(findings, true), "fail");
});

test("only blocking Theme Check checks block; style checks warn", () => {
  const offense = (check: string): Observation => ({ rule: `theme-check:${check}`, message: "offense", page: "sections/main.liquid", file: "sections/main.liquid", line: 3 });
  const findings = buildFindings([], [offense("LiquidHTMLSyntaxError"), offense("MatchingTranslations"), offense("ImgWidthAndHeight")]);
  assert.equal(findings.find((finding) => finding.rule === "theme-check:LiquidHTMLSyntaxError")?.severity, "block");
  assert.equal(findings.find((finding) => finding.rule === "theme-check:MatchingTranslations")?.severity, "warn");
  assert.equal(findings.find((finding) => finding.rule === "theme-check:ImgWidthAndHeight")?.severity, "warn");
});

test("problems fixed by the pull request are reported as resolved, never blocking", () => {
  const exception: Observation = { rule: "js-exception", message: "TypeError: a is null", page: "/", viewport: "mobile" };
  const findings = buildFindings([exception], []);
  assert.equal(findings[0]?.status, "resolved");
  assert.equal(findings[0]?.severity, "info");
});
