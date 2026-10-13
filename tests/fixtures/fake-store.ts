/**
 * A local stand-in for a Shopify storefront: two themes selected with preview_theme_id,
 * theme-numbered asset paths, Shopify.theme, a cart API, checkout redirect, and an
 * optional password page. Faults can be switched on per theme to exercise every check.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type Fault =
  | "liquid-error"
  | "js-exception"
  | "missing-asset"
  | "page-500"
  | "broken-image"
  | "broken-link"
  | "broken-add-to-cart"
  | "no-variant-id"
  | "no-checkout-button"
  | "legacy-console-error"
  | "leak-secret";

export interface FakeTheme {
  id: number;
  /** Theme number used in asset paths: /cdn/shop/t/<number>/assets/... */
  number: number;
  name: string;
  role: "live" | "unpublished";
  /** Shopify template ID embedded in section IDs; differs between duplicated themes. */
  templateId: string;
  faults: Set<Fault>;
}

export interface FakeStoreOptions {
  password?: string;
  /** Simulates a broken preview link: preview_theme_id is ignored. */
  ignorePreview?: boolean;
  /** Value logged by the "leak-secret" fault, to prove reports redact it. */
  secret?: string;
  /** The first request to each of these paths gets Shopify's HTML "429 Too Many Requests" page. */
  rateLimitOnce?: string[];
  /** Serve Shopify's bot protection page ("Just a moment...") instead of the storefront. */
  challenge?: boolean;
  /** Serve the bot protection page only when the cart is submitted to checkout. */
  challengeCheckout?: boolean;
}

interface CartItem {
  variant_id: number;
  quantity: number;
}

const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

const PRODUCTS: Record<string, { title: string; variants: Array<{ id: number; available: boolean }> }> = {
  shirt: { title: "Shirt", variants: [{ id: 111, available: true }, { id: 112, available: false }] },
  "sold-out": { title: "Sold out", variants: [{ id: 211, available: false }] },
};

function parseCookies(request: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    (request.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim().split("="))
      .filter((pair) => pair.length === 2) as Array<[string, string]>,
  );
}

async function readBody(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

export async function startFakeStore(themes: FakeTheme[], options: FakeStoreOptions = {}) {
  const carts = new Map<string, CartItem[]>();
  const rateLimited = new Set<string>();
  const stats = { passwordSubmissions: 0 };
  const shopperSessions = new Map<string, { unlocked: boolean; previewThemeId?: number }>();
  let nextSession = 1;
  let nextCart = 1;
  const live = themes.find((theme) => theme.role === "live")!;

  const server = createServer(async (request, response) => {
    try {
      await handle(request, response);
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain" }).end(String(error));
    }
  });

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", "http://store.test");
    if (options.rateLimitOnce?.includes(url.pathname) && !rateLimited.has(url.pathname)) {
      rateLimited.add(url.pathname);
      response.writeHead(429, { "content-type": "text/html", "retry-after": "1" }).end("<!DOCTYPE html><title>Too Many Requests</title>");
      return;
    }
    if (options.challenge && !url.pathname.startsWith("/cdn/")) {
      response
        .writeHead(403, { "content-type": "text/html" })
        .end("<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><p>Your connection needs to be verified before you can proceed</p></body></html>");
      return;
    }
    const cookies = parseCookies(request);
    const setCookies: string[] = [];
    const send = (status: number, body: string | Buffer, type = "text/html; charset=utf-8", headers: Record<string, string> = {}) => {
      response.writeHead(status, { "content-type": type, ...(setCookies.length ? { "set-cookie": setCookies } : {}), ...headers }).end(body);
    };
    const redirect = (location: string) => send(302, "", "text/plain", { location });
    const json = (value: unknown) => send(200, JSON.stringify(value), "application/json");

    // Like Shopify, the unlocked password and the previewed theme live in a server-side session
    // identified by one cookie (_shopify_essential): contexts that share the cookie share both.
    let sessionId = cookies._shopify_essential;
    if (!sessionId || !shopperSessions.has(sessionId)) {
      sessionId = `s${nextSession++}`;
      shopperSessions.set(sessionId, { unlocked: false });
      setCookies.push(`_shopify_essential=${sessionId}; Path=/`);
    }
    const shopper = shopperSessions.get(sessionId)!;

    // Password page
    if (url.pathname === "/password") {
      if (request.method === "POST") {
        stats.passwordSubmissions += 1;
        const body = await readBody(request);
        if (body.get("password") === options.password) {
          shopper.unlocked = true;
          return redirect("/");
        }
        return send(200, passwordPage("Wrong password"));
      }
      return send(200, passwordPage());
    }
    if (options.password && !shopper.unlocked) return redirect("/password");

    // Theme selection: preview_theme_id stores the preview in the shopper session.
    const requested = url.searchParams.get("preview_theme_id");
    if (requested && !options.ignorePreview) shopper.previewThemeId = Number(requested);
    const themeId = options.ignorePreview ? live.id : (shopper.previewThemeId ?? live.id);
    const theme = themes.find((candidate) => candidate.id === themeId) ?? live;

    // Cart session
    let cartId = cookies.cart;
    if (!cartId || !carts.has(cartId)) {
      cartId = String(nextCart++);
      carts.set(cartId, []);
      setCookies.push(`cart=${cartId}; Path=/`);
    }
    const cart = carts.get(cartId)!;
    const cartJson = () => ({ item_count: cart.reduce((sum, item) => sum + item.quantity, 0), items: cart });
    const add = (variantId: number, quantity: number) => {
      const existing = cart.find((item) => item.variant_id === variantId);
      if (existing) existing.quantity += quantity;
      else cart.push({ variant_id: variantId, quantity });
    };

    // Assets: /cdn/shop/t/<number>/assets/<file>
    const asset = url.pathname.match(/^\/cdn\/shop\/t\/(\d+)\/assets\/(.+)$/);
    if (asset) {
      const assetTheme = themes.find((candidate) => candidate.number === Number(asset[1]));
      if (!assetTheme) return send(404, "Not found", "text/plain");
      return serveAsset(assetTheme, asset[2]!, send);
    }
    if (url.pathname === "/cdn/shop/files/hero.png") return send(200, PNG_1X1, "image/png");
    if (url.pathname.startsWith("/cdn/")) return send(404, "Not found", "text/plain");

    // Cart API
    if (url.pathname === "/cart.js") return json(cartJson());
    if (url.pathname === "/cart/clear.js" && request.method === "POST") {
      cart.length = 0;
      // Real Shopify answers this endpoint with JSON labelled as text/javascript.
      return send(200, JSON.stringify(cartJson()), "text/javascript; charset=utf-8");
    }
    if ((url.pathname === "/cart/add.js" || url.pathname === "/cart/add") && request.method === "POST") {
      const body = await readBody(request);
      const variant = Number(body.get("id"));
      if (!variant) return send(422, JSON.stringify({ description: "Missing variant id" }), "application/json");
      add(variant, Number(body.get("quantity") ?? 1) || 1);
      return url.pathname.endsWith(".js") ? json(cartJson()) : redirect("/cart");
    }
    if (url.pathname === "/cart" && request.method === "POST") {
      const body = await readBody(request);
      body.getAll("updates[]").forEach((value, index) => {
        if (cart[index]) cart[index]!.quantity = Number(value);
      });
      for (let index = cart.length - 1; index >= 0; index -= 1) if (cart[index]!.quantity <= 0) cart.splice(index, 1);
      if (body.has("checkout") && options.challengeCheckout) {
        return send(403, "<!DOCTYPE html><title>Just a moment...</title><p>Your connection needs to be verified before you can proceed</p>");
      }
      return redirect(body.has("checkout") ? "/checkout" : "/cart");
    }
    if (url.pathname === "/checkout") return redirect("/checkouts/cn/test-token");
    if (url.pathname.startsWith("/checkouts/")) return send(200, "<!doctype html><title>Checkout</title><h1>Checkout</h1>");

    // Product JSON
    const productJson = url.pathname.match(/^\/products\/([\w-]+)\.js$/);
    if (productJson) {
      const product = PRODUCTS[productJson[1]!];
      return product ? json(product) : send(404, "{}", "application/json");
    }

    // Pages
    const page = renderPage(theme, url.pathname, cartJson().items);
    if (!page) return send(404, layout(theme, "<h1>Page not found</h1>"));
    return send(page.status, page.html);
  }

  function serveAsset(theme: FakeTheme, file: string, send: (status: number, body: string, type?: string) => void) {
    switch (file) {
      case "theme.css":
        return send(200, "body { font-family: sans-serif; } .price { display: inline-block; }", "text/css");
      case "theme.js": {
        const lines = ["window.themeLoaded = true;"];
        if (theme.faults.has("legacy-console-error")) lines.push('console.error("Legacy widget failed to initialize");');
        if (theme.faults.has("leak-secret")) lines.push(`console.error(${JSON.stringify(`debug token ${options.secret ?? ""}`)});`);
        if (theme.faults.has("js-exception")) lines.push("document.querySelector('#missing-element').dataset.ready = 'true';");
        return send(200, lines.join("\n"), "application/javascript");
      }
      case "product-form.js": {
        const broken = theme.faults.has("broken-add-to-cart");
        return send(
          200,
          `document.querySelectorAll('form.product-form').forEach((form) => {
            form.addEventListener('submit', async (event) => {
              event.preventDefault();
              ${broken ? "form.querySelector('.does-not-exist').dataset.loading = 'true';" : ""}
              const body = new URLSearchParams(new FormData(form));
              await fetch('/cart/add.js', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
              document.querySelector('#cart-count').textContent = 'Added';
            });
          });`,
          "application/javascript",
        );
      }
      default:
        return send(404, "Not found", "text/plain");
    }
  }

  function layout(theme: FakeTheme, content: string, mainSection = "main"): string {
    const n = theme.number;
    return `<!doctype html>
<html lang="en">
<head>
  <title>Fake store</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/cdn/shop/t/${n}/assets/theme.css?v=${n}00">
  <script>window.Shopify = { theme: { id: ${theme.id}, name: ${JSON.stringify(theme.name)}, role: "${theme.role === "live" ? "main" : "unpublished"}" } };</script>
  <script src="/cdn/shop/t/${n}/assets/theme.js?v=${n}01" defer></script>
  ${theme.faults.has("missing-asset") ? `<script src="/cdn/shop/t/${n}/assets/missing.js?v=${n}02" defer></script>` : ""}
</head>
<body>
  <div id="shopify-section-sections--${theme.templateId}__header" class="shopify-section">
    <header><a href="/">Home</a> <a href="/collections/all">Shop</a> <a href="/cart">Cart</a> <span id="cart-count"></span></header>
    <!-- Like Dawn: a hidden cart drawer with its own checkout button, earlier in the DOM than the cart page's. -->
    <div id="CartDrawer" style="display:none"><form id="CartDrawer-Form" action="/cart" method="post"><input type="number" name="updates[]" value="1"></form><button type="submit" name="checkout" form="CartDrawer-Form">Check out</button></div>
  </div>
  <main>
    <div id="shopify-section-template--${theme.templateId}__${mainSection}" class="shopify-section">${content}</div>
  </main>
</body>
</html>`;
  }

  function renderPage(theme: FakeTheme, pathname: string, items: CartItem[]): { status: number; html: string } | undefined {
    const ok = (content: string, section?: string) => ({ status: 200, html: layout(theme, content, section) });
    switch (pathname) {
      case "/":
        return ok(`<h1>Welcome</h1>
          <img src="/cdn/shop/files/hero.png" alt="Hero" width="1" height="1">
          ${theme.faults.has("broken-image") ? '<img src="/cdn/shop/files/missing.png" alt="Missing" width="1" height="1">' : ""}
          <a href="/products/shirt">Shirt</a> <a href="/pages/about">About</a>
          ${theme.faults.has("broken-link") ? '<a href="/pages/gone">Gone</a>' : ""}`);
      case "/collections/all":
        if (theme.faults.has("page-500")) return { status: 500, html: layout(theme, "<h1>Internal error</h1>") };
        return ok('<h1>All products</h1><a href="/products/shirt">Shirt</a> <a href="/products/sold-out">Sold out</a>');
      case "/pages/about":
        return ok("<h1>About us</h1>");
      case "/products/shirt":
      case "/products/sold-out": {
        const handle = pathname.split("/").pop()!;
        const product = PRODUCTS[handle]!;
        const selected = product.variants[0]!;
        const liquidError = theme.faults.has("liquid-error") ? "<p>Liquid error (sections/main-product line 45): undefined filter 'money_x'</p>" : "";
        return ok(
          `<h1>${product.title}</h1>
          <img src="/cdn/shop/files/hero.png" alt="${product.title}" width="200" height="200">
          <span class="price">$20.00</span>
          <form action="/cart/add" method="post" class="installment"><input type="hidden" name="id" value="${selected.id}"></form>
          ${liquidError}
          <form action="/cart/add" method="post" class="product-form">
            ${theme.faults.has("no-variant-id") ? "" : `<input type="hidden" name="id" value="${selected.id}">`}
            <input type="number" name="quantity" value="1">
            <button type="submit" name="add" ${selected.available ? "" : "disabled"}>${selected.available ? "Add to cart" : "Sold out"}</button>
          </form>
          <script src="/cdn/shop/t/${theme.number}/assets/product-form.js?v=${theme.number}03" defer></script>`,
          "main-product",
        );
      }
      case "/cart": {
        const rows = items.map((item) => `<div class="cart-item">Variant ${item.variant_id} <input type="number" name="updates[]" value="${item.quantity}"></div>`).join("");
        const checkout = theme.faults.has("no-checkout-button") ? "" : '<button type="submit" name="checkout">Check out</button>';
        return ok(`<h1>Cart</h1><form action="/cart" method="post">${rows}<button type="submit" name="update">Update</button>${checkout}</form>`, "main-cart");
      }
      default:
        return undefined;
    }
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    stats,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function passwordPage(error = ""): string {
  return `<!doctype html><html><head><title>Opening soon</title></head><body>
    ${error ? `<p class="error">${error}</p>` : ""}
    <form action="/password" method="post"><input type="password" name="password"><button type="submit">Enter</button></form>
  </body></html>`;
}

export function fakeTheme(role: "live" | "unpublished", faults: Fault[] = []): FakeTheme {
  return role === "live"
    ? { id: 1001, number: 12, name: "Live theme", role, templateId: "16754345869410", faults: new Set(faults) }
    : { id: 2002, number: 148, name: "theme-qa PR #42", role, templateId: "17000000000001", faults: new Set(faults) };
}
