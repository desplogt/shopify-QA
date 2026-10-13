import assert from "node:assert/strict";
import { test } from "node:test";
import type { CheckResult } from "../src/types.js";
import { computeVerdict } from "../src/verdict.js";

const check = (id: CheckResult["id"], status: CheckResult["status"], mandatory = id === "technical" || id === "purchase"): CheckResult => ({
  id,
  title: id,
  mandatory,
  status,
  summary: "",
  findings: [],
});

test("passes only when every check passes", () => {
  assert.equal(computeVerdict(undefined, [check("technical", "pass"), check("purchase", "pass")]), "passed");
});

test("warnings never block", () => {
  assert.equal(computeVerdict(undefined, [check("technical", "warn"), check("purchase", "pass"), check("visual", "warn")]), "warnings");
});

test("an advisory check that could not run is a warning, not a block", () => {
  assert.equal(computeVerdict(undefined, [check("technical", "pass"), check("purchase", "pass"), check("performance", "error")]), "warnings");
});

test("fails closed when a mandatory check fails, errors, or is missing", () => {
  assert.equal(computeVerdict(undefined, [check("technical", "fail"), check("purchase", "pass")]), "blocked");
  assert.equal(computeVerdict(undefined, [check("technical", "pass"), check("purchase", "error")]), "blocked");
  assert.equal(computeVerdict(undefined, [check("technical", "pass")]), "blocked");
});

test("a stage failure always blocks", () => {
  const failure = { stage: "verify" as const, category: "infra" as const, message: "Preview served the wrong theme" };
  assert.equal(computeVerdict(failure, [check("technical", "pass"), check("purchase", "pass")]), "blocked");
});
