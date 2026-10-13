# Theme QA — Release Gate Process

Theme QA is a deterministic release gate for Shopify themes. It runs on every pull request to `main`, compares the proposed theme against the live theme, and blocks the merge when the change introduces a defect that would reach shoppers.

In stores that use the Shopify GitHub integration, merging to `main` publishes the theme. The gate therefore runs **before the merge**, as a required status check enforced by branch protection.

The tool has no AI and no runtime dependency on Claude Code. The same engine runs locally (`theme-qa check`) and in GitHub Actions.

---

## 1. Principles

1. **Never modify the live theme.** The live theme is only read. The tool only writes to themes whose name starts with `theme-qa PR #`, refuses to push to a theme with the `live` role, and never passes `--allow-live` or `--publish` to the Shopify CLI.
2. **Only block what the pull request introduces.** Every observation is compared against the live theme. Pre-existing problems are reported but never block.
3. **Fail closed.** If a mandatory check cannot run, the result is ❌, never ✅.
4. **Retry before blaming.** Network errors, slow Shopify responses, and flaky interaction steps are retried before they are reported.
5. **Run everything, except when the foundation is broken.** One failing check does not stop the others, so the report is complete. The exception: if the theme cannot be uploaded or the preview does not serve the expected theme, the run stops early, because every later check would be meaningless.
6. **Every finding is actionable.** It states what happened, where (page, viewport, section, file, line), the evidence, and what to do next.

## 2. Outcomes

| Outcome | Meaning | Merge allowed? |
|---|---|---|
| ✅ **Passed** | Nothing new was found | Yes |
| ⚠️ **Passed with warnings** | Only non-blocking findings (performance, visual, minor issues) | Yes — the comment highlights them |
| ❌ **Blocked** | A new blocking defect, or a mandatory check could not be verified | No |

## 3. Pipeline

```
Pull request opened or updated (target: main)
 1. Prepare   → read theme-qa.yml, validate secrets, confirm store access
 2. Build     → only when the theme needs a build step
 3. QA theme  → push the PR merge commit to "theme-qa PR #N" (create or reuse)
 4. Verify    → unlock the storefront, confirm the preview serves that theme
 5. Checks    → technical errors · purchase flow · performance · visual
 6. Verdict   → ✅ / ⚠️ / ❌
 7. Report    → PR comment + HTML/JSON report + check status
Pull request closed → delete the QA theme
```

**Why the merge commit.** The Shopify GitHub integration commits theme editor changes ("auto-save") to `main`, including `config/settings_data.json` and JSON templates. GitHub checks out the PR merge commit by default (`refs/pull/N/merge`), which contains the branch plus the latest `main`. Pushing it reproduces exactly what the live theme will become after the merge, and avoids false positives caused by stale settings.

| Stage | What it does | On failure |
|---|---|---|
| 1. Prepare | Validates `theme-qa.yml`, required secrets, and that the store responds | ❌ **config** — names the missing field or secret. Nothing is uploaded |
| 2. Build | Runs the configured `build` command | ❌ **theme** — shows the tail of the build log |
| 3. QA theme | If the store is at its theme limit, first deletes `theme-qa PR #N` themes whose pull request is closed. Then pushes the code | Liquid rejected by Shopify → ❌ **theme** with file and message. Invalid token → ❌ **config** ("regenerate the Theme Access password"). Shopify unavailable → 3 retries with exponential backoff, then ❌ **infra** |
| 4. Verify | Unlocks a password-protected storefront once (other sessions reuse the cookie), then checks that `window.Shopify.theme.id` on the preview equals the QA theme ID | Mismatch → ❌ **infra**, run stops (prevents approving live-vs-live). Wrong storefront password → ❌ **config**. Shopify's bot protection page ("Your connection needs to be verified") → ❌ **infra** with a wait-and-retry hint, never reported as a wrong password |
| 5. Checks | See section 4 | Each check reports independently |
| 6–7. Verdict & report | Computes the outcome, updates a single sticky PR comment, publishes artifacts and the job status | If the comment cannot be posted, the job status still reflects the outcome |
| Cleanup | Deletes the QA theme when the PR closes | If deletion fails, stage 3 cleans it up on a later run |

General rules:

- A new commit cancels the in-progress run for the same pull request.
- The whole run has a 20-minute budget. If it is exceeded, the result is ❌ **infra** with whatever was checked so far.
- A bug in the tool itself is reported as ❌ **internal**, with the log, so it is never confused with a theme defect.

Error categories used in reports:

| Category | Meaning | Typical action |
|---|---|---|
| `theme` | The pull request introduced a defect | Fix and push |
| `config` | `theme-qa.yml` or a secret is wrong | Fix the config or secret |
| `infra` | Shopify, GitHub, or the network failed | Re-run the job |
| `internal` | Bug in Theme QA | Re-run; report the log if it repeats |

## 4. Checks

Each check returns `pass`, `warn`, `fail`, or `error` (could not run). Technical errors and the purchase flow are **mandatory**: `fail` or `error` blocks the merge. Performance and visual are **advisory**: they never block.

### 4.1 Technical errors (mandatory)

Each configured page is loaded once per theme (live and preview) and per viewport (desktop and mobile). The same load collects:

- Liquid errors rendered by Shopify (`Liquid error (sections/... line N): ...`, `Liquid syntax error`)
- uncaught JavaScript exceptions and `console.error` messages
- failed requests and HTTP 4xx/5xx responses, split into theme assets and third-party resources
- the HTTP status of the page itself
- broken images
- same-origin links, checked once per unique URL per run

Theme Check runs on the base commit and on the merge commit. Only **new offenses in files changed by the pull request** are reported.

| New finding in the preview | Response |
|---|---|
| Liquid error rendered on the page | ❌ |
| Uncaught JavaScript exception | ❌ |
| Theme asset (`/assets/...`) returning 4xx/5xx | ❌ |
| Page that loads on live but returns 4xx/5xx on the preview | ❌ |
| Theme Check offense from a blocking check (see below) | ❌ |
| `console.error`, failed third-party request, broken image, broken link | ⚠️ |
| Theme Check offense from any other check | ⚠️ |
| Anything that already exists on live | ℹ️ reported, never blocks |

**Blocking Theme Check checks.** Theme Check marks many style and translation issues as `error` (for example `MatchingTranslations` and `ImgWidthAndHeight`), and mature themes often carry thousands of them. Blocking on severity alone would block almost every pull request. Only checks that break rendering or the theme editor block:

`LiquidHTMLSyntaxError`, `JSONSyntaxError`, `ValidJSON`, `MissingTemplate`, `MissingAsset`, `UnknownFilter`, `TranslationKeyExists`, `ValidSchema`, `ValidSchemaName`, `UniqueSettingId`, `JSONMissingBlock`, `ValidBlockTarget`, `ValidLocalBlocks`, `ValidStaticBlockType`, `ValidSettingsKey`, `ValidVisibleIf`, `RequiredLayoutThemeObject`, `ValidContentForArguments`.

The list can be overridden per store in `theme-qa.yml`.

**Comparison rules** (what makes "new" reliable):

- Findings are matched as a multiset: if live has two identical errors and the preview has three, exactly one is new.
- URLs are normalized before comparison. Shopify serves each theme's assets from a different path (`/cdn/shop/t/12/assets/theme.js?v=123`). The theme number, the `v` cache-buster, and `:line:column` suffixes are removed.
- Shopify-generated identifiers are normalized: `shopify-section-template--1234567890__main` becomes `main`.
- Known infrastructure noise is ignored: aborted requests, requests blocked by the tool, 401/403/429 from third parties, "Failed to load resource" console duplicates, Shopify analytics endpoints, and preview-bar/`shop.app` framing messages.
- The same finding on desktop and mobile is reported once, listing both viewports.
- Secrets are redacted from every report: `preview_token`, `_bt`, `key`, `password`, `token`, and the literal values of configured secrets.

### 4.2 Purchase flow (mandatory)

Runs on desktop and mobile:

1. Clear the cart (`/cart/clear.js`).
2. Open the configured product and confirm an available variant is selected (via `/products/<handle>.js`).
3. Click "Add to cart" and confirm in `/cart.js` that the expected variant was added.
4. Open `/cart`, set the quantity to 2, and confirm it in `/cart.js`.
5. Click "Checkout" and confirm the theme sends the cart to Shopify's checkout. The flow stops there; no order is placed. The checkout page belongs to Shopify, not the theme: if Shopify's checkout bot protection challenges the automated browser after the cart was sent, it is reported as a note, not a failure.
6. Clear the cart.

The same flow runs on the live theme as a control:

| Live | Preview | Response |
|---|---|---|
| ✅ | ✅ | ✅ |
| ✅ | ❌ | ❌ the pull request breaks the purchase flow |
| ❌ | ❌ at the same step | ⚠️ not caused by this pull request, reported with priority |
| ❌ | ❌ at an earlier step | ❌ the pull request makes it worse |
| ❌ | ✅ | ✅ marked as resolved |

- A failing step is retried once before it is considered failed.
- On failure the tool stores a screenshot, a Playwright trace, and the JavaScript errors captured at that moment.
- Before the flow, a quick diagnosis inspects the product page and cart: product form posting to `/cart/add`, variant ID input, add-to-cart control, visible price, product image, disabled button without an availability message, and checkout control in a non-empty cart. When the flow fails, the diagnosis explains why (for example, "the product form no longer submits a variant ID").
- If the configured product is out of stock, the next product in the list is tried. If none is available, the check returns `error` ("configure a product with stock") and blocks.
- Selectors work out of the box on Dawn-style themes and can be overridden per store.

### 4.3 Performance (advisory — phase 3)

- On every run, from the same page loads: JavaScript and CSS weight, request count, and cumulative layout shift.
- Lighthouse runs only when the pull request touches `assets/` or `layout/`, or when weight grows past the threshold: mobile only, home and product pages, 3 runs per theme, median.
- ⚠️ when the score drops 10+ points, LCP grows 500+ ms, CLS grows 0.05+, or JS/CSS grows 50+ KB.

### 4.4 Visual (advisory — phase 2)

- Before capture: animations disabled, fonts and images awaited, page scrolled to trigger lazy loading, configured `mask` selectors hidden.
- Sections are matched by normalized ID and compared with two signals: a structural fingerprint (tags, depth, roles — ignores text and images) and a pixel diff.
  - Structure changed → code change.
  - Only pixels changed → content or dynamic element.
- Changes are cross-referenced with the files in the pull request, following `{% render %}` to know which sections use a changed snippet:
  - **Expected change:** the section changed and the pull request modifies its files.
  - **Unexpected change:** the section changed but the pull request does not touch it (for example, a global CSS change). Listed first.

## 5. Pull request comment

One sticky comment per pull request, updated on every run. It contains the verdict, one line per check, the blocking findings with evidence, and a link to the full report. Example:

```markdown
## ❌ Theme QA: blocked (2 new issues)
Theme: theme-qa PR #42 (preview) · commit a1b2c3d · 5 min

| Check            | Result                                  |
|------------------|-----------------------------------------|
| Purchase flow    | ❌ Fails at "Add to cart" (mobile)       |
| Technical errors | ❌ 1 new · 3 pre-existing                |

### What blocks
1. **Purchase flow · mobile · step 3** — "Add to cart" was clicked but
   /cart.js is still empty. Works on live.
   JS error at that moment: TypeError: Cannot read properties of null
   (reading 'dataset') in assets/product-form.js:88
2. **Liquid error** on /collections/all —
   sections/main-collection.liquid line 45: undefined filter 'money_x'

### Next steps
Fix and push: the check runs again automatically. Full report: <link>
```

## 6. Team playbook

| Situation | Action |
|---|---|
| ❌ `theme` | Fix and push; the check re-runs automatically |
| ❌ `infra` (Shopify down, timeout) | Re-run the job in GitHub Actions |
| ❌ `config` | Fix `theme-qa.yml` or the named secret |
| False positive | Add it to `ignore` in `theme-qa.yml` with a reason. The exception is versioned and reviewed in the pull request |
| Emergency (hotfix while the tool is down) | A repository admin uses GitHub's branch-protection bypass, which is logged |

## 7. Configuration

`theme-qa.yml` at the root of each theme repository:

```yaml
store: example-store.myshopify.com
build: null                       # or "npm run build"
themeRoot: .                      # folder that contains layout/, sections/, ...
pages: ["/", "/collections/all", "/products/example", "/cart"]
purchase:
  products: ["/products/example", "/products/backup-example"]
viewports: [desktop, mobile]
block: ["klaviyo", "googletagmanager", "connect.facebook.net"]  # third-party hosts to block
ignore:
  - rule: console-error
    match: "Widget failed to load"
    reason: "Third-party reviews widget, tracked in TICKET-123"
```

Secrets (GitHub repository secrets, or environment variables locally):

| Secret | Purpose |
|---|---|
| `SHOPIFY_CLI_THEME_TOKEN` | Theme Access password for the store |
| `STOREFRONT_PASSWORD` | Only when the storefront is password protected |

Secrets are never written to logs, reports, or artifacts.

## 8. Cost and efficiency

The gate runs on GitHub-hosted Linux runners: $0.006 per minute beyond the monthly included minutes (2,000 on Free, 3,000 on Team; public repositories are free). Usage is billed to the organization that owns the theme repository. Self-hosted runners are free.

Target duration for a typical run: **4–6 minutes** (about $0.03). Rules that keep it there:

1. One page load per page, theme, and viewport feeds every check.
2. Prebuilt environment (Chromium, Shopify CLI, dependencies) so setup takes ~30 s.
3. Live and preview, desktop and mobile, run in parallel browser contexts. Lighthouse stays sequential.
4. Pages are chosen per template type; pages using a template changed by the pull request are added automatically.
5. Pull requests that do not touch theme files report ✅ in seconds (the required check still reports). Draft pull requests are skipped.
6. The run stops early only when the foundation is broken (stage 3 or 4).
7. Each unique link is checked once per run.
8. Lighthouse only when relevant (section 4.3).
9. Phase 2: reuse live-theme results across pull requests until `main` changes or a few hours pass, re-verifying any difference against a fresh live load.

If an organization without a payment method exhausts its included minutes, the check cannot run and merges stay blocked (fail closed). Mitigate with a payment method plus a spending budget, or a self-hosted runner.

**Shopify rate limits and bot protection.** Shopify throttles bursts of storefront requests (HTTP 429) and its bot protection can challenge automated browsers, especially after many runs in a short time or from datacenter IPs. Theme QA keeps its footprint small: the storefront password is sent once per run, live and preview run together per viewport while viewports run sequentially, link checks are paced, user agents are regular Chrome, and 429 responses are waited out using `Retry-After`. Throttled observations are never reported as theme defects. If CI runs are challenged regularly, use a self-hosted runner.

## 9. Roadmap

| Phase | Scope |
|---|---|
| 1 | Accuracy test suite · QA theme lifecycle · theme verification · technical errors · Theme Check diff · purchase flow · verdict · PR comment · GitHub Action |
| 2 | Visual diff by section · HTML report · reusable live baseline |
| 3 | Performance: weight metrics and on-demand Lighthouse |
| 4 | Roll-out to client stores · optional Slack notification · optional post-merge smoke check on live |

Phase 1 is validated on a test store with deliberate pull requests: no changes (✅), broken add-to-cart (❌), Liquid error (❌), visual change (⚠️).

## 10. Accuracy requirements

These are encoded as automated tests and must always pass:

- Two identical themes produce no new or resolved findings and a ✅ verdict (pre-existing issues are only listed as ℹ️).
- Asset paths that differ only by theme number or cache-buster match.
- Shopify-generated section IDs match across duplicated themes.
- Repeated findings are compared as a multiset.
- The same finding on desktop and mobile counts once.
- Known infrastructure noise never appears as a new finding.
- Secrets never appear in any report.

## 11. Findings from the test store

Real-store behavior that the first local version did not handle, now covered by regression tests:

- Dawn renders a Shop Pay installments form posting to `/cart/add` before the product form; the product form is the one with an add-to-cart control.
- Dawn's cart drawer keeps hidden copies of the checkout button and quantity inputs; only visible controls are used.
- `/cart/clear.js` returns JSON labelled `text/javascript`; cart responses are parsed by body.
- `?preview_theme_id=` redirects to the same path and keeps the preview in a cookie.
- Shopify's preview bar is fixed to the bottom of the page; it is hidden so it cannot cover buttons or appear in screenshots.
- Rate limits and the bot protection page (see section 8). Shopify's checkout is protected by Cloudflare ("Verify you are human"); the purchase flow therefore verifies the theme's hand-off to checkout rather than the checkout page itself.
- Shopify keeps the unlocked storefront password and the previewed theme in the same server-side session (`_shopify_essential`). Sessions of the same theme share it, so the password is sent once per side; live and preview never share it, or live would render the preview theme. Theme verification caught this during testing.
- Development stores cannot remove their storefront password, so every run must submit it, and the password form is where bot protection is strictest. Test stores are therefore harsher than public client stores: space out runs, and expect occasional "bot protection" infra results there.

## 12. To validate on the test store

- Exact Shopify CLI output when a push is rejected (Liquid errors), to parse file and message reliably.
- `shopify theme push --development-context <PR>` (CLI 3.94+): development themes may avoid the theme limit and expire automatically. Adopt it if preview links work for them.
- Real durations per stage, to confirm the 4–6 minute target.

## 13. Prior art

The comparison approach was informed by a review of [Giedrius-Lau/shopify-qa-agent](https://github.com/Giedrius-Lau/shopify-qa-agent): multiset comparison against live, normalization of Shopify-generated identifiers, infrastructure-noise filtering, structural section fingerprints, file-to-section attribution, and accuracy regression tests. That repository has no license, so **no code was copied**; only the ideas were reimplemented. Gaps addressed here: verifying that the preview serves the expected theme, normalizing theme-numbered asset paths, retrying flaky steps, failing closed, and exercising the real purchase flow instead of only inspecting the DOM.
