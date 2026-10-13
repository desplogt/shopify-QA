# Theme QA

A deterministic release gate for Shopify themes. On every pull request to `main` it uploads the pull request's code to an unpublished QA theme, compares it with the live theme, and blocks the merge when the change introduces a defect that would reach shoppers.

It is built for stores that use the Shopify GitHub integration, where merging to `main` publishes the theme. The full process, including how every error is handled, is in [`docs/PROCESS.md`](docs/PROCESS.md).

## What it checks

| Check | Blocks when the pull request introduces… |
|---|---|
| **Technical errors** | Liquid errors on the page, uncaught JavaScript exceptions, failing theme assets, pages that stop loading, Theme Check errors that break rendering. Console errors, broken images, and broken links are warnings. |
| **Purchase flow** | A broken path from product page → add to cart → cart quantity → checkout, on desktop and mobile. It stops at Shopify's checkout; no order is placed. |

Only what is **new** compared with the live theme counts. Pre-existing problems are listed but never block. If a mandatory check cannot run, the gate blocks (fail closed).

## Set up a theme repository

1. Install the **Theme Access** app in the store and create a password.
2. Add repository secrets:
   - `SHOPIFY_CLI_THEME_TOKEN`: the Theme Access password
   - `STOREFRONT_PASSWORD`: only if the storefront is password protected
3. Copy [`examples/theme-qa.yml`](examples/theme-qa.yml) to the repository root and adjust the store, pages, and products. Use products that are always in stock.
4. Copy [`examples/theme-qa.workflow.yml`](examples/theme-qa.workflow.yml) to `.github/workflows/theme-qa.yml`.
5. In **Settings → Branches**, protect `main` and require the **Theme QA / check** status.

The workflow posts a single comment on the pull request, updated on every push, and uploads the full report (JSON, Markdown, screenshots, Playwright traces) as a workflow artifact. Closing the pull request deletes its QA theme.

## Run it locally

Requires Node.js 20.19+ and the Shopify CLI.

```bash
npm install
npx playwright install chromium-headless-shell

export SHOPIFY_CLI_THEME_TOKEN=...      # Theme Access password
export STOREFRONT_PASSWORD=...          # if the store is protected

# From the theme repository (where theme-qa.yml lives):
npx tsx /path/to/theme-qa/src/cli.ts check --base origin/main
# or compare an existing unpublished theme without uploading:
npx tsx /path/to/theme-qa/src/cli.ts check --theme-id 123456789
```

Local runs upload to a theme named `theme-qa local` unless `--pr` or `--theme-id` is given. The report is written to `theme-qa-report/`. The exit code is `1` when blocked.

## Safety

- The live theme is only read. The tool never passes `--allow-live` or `--publish`, refuses to upload to a theme with the live role, and only deletes themes named `theme-qa PR #N` or `theme-qa local`.
- Credentials are passed to the Shopify CLI through environment variables, never command-line arguments.
- Secrets and sensitive URL parameters are redacted from every report.

## Development

```bash
npm test          # accuracy, unit, browser, and end-to-end tests (no Shopify access)
npm run typecheck
npm run build
```

Browser and end-to-end tests run against a local fake storefront ([`tests/fixtures/fake-store.ts`](tests/fixtures/fake-store.ts)) that mimics Shopify's preview themes, theme-numbered asset paths, cart API, checkout redirect, and password page, with switchable faults.

## Roadmap

Phase 1 (this version): technical errors, Theme Check diff, purchase flow, PR comment, GitHub Action. Next: visual diff by section, performance metrics with on-demand Lighthouse, and roll-out to client stores. See `docs/PROCESS.md` section 9.
