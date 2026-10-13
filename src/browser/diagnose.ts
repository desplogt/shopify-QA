import type { Page } from "playwright";

/**
 * Static inspection of the product page and cart. It never decides the outcome of the
 * purchase flow; it explains why a step failed.
 */
export async function diagnoseProductPage(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const forms = Array.from(document.querySelectorAll<HTMLFormElement>('form[action*="/cart/add"]'));
    if (forms.length === 0) return ["The product page has no form posting to /cart/add."];
    const form = forms.find((candidate) => candidate.closest("main")) ?? forms[0]!;
    if (!form.querySelector('[name="id"]')) problems.push("The product form does not submit a variant ID (no field named id).");

    const controls = Array.from(form.querySelectorAll<HTMLButtonElement | HTMLInputElement>('[name="add"], button[type="submit"], input[type="submit"]'));
    if (controls.length === 0) problems.push("The product form has no add-to-cart button.");

    // Elements with a box that are not hidden.
    const visible = (selector: string, root: ParentNode) =>
      Array.from(root.querySelectorAll<HTMLElement>(selector)).filter((element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      });
    const disabled = controls.filter((control) => control.disabled || control.getAttribute("aria-disabled") === "true");
    const availabilityMessages = visible('[class*="sold-out"], [class*="sold_out"], [data-sold-out-message], [class*="inventory"], [id*="SoldOut"]', document);
    if (controls.length > 0 && disabled.length === controls.length && availabilityMessages.length === 0) {
      problems.push("Add to cart is disabled without a visible availability message.");
    }
    const root = form.closest("main") ?? document.body;
    if (visible('[itemprop="price"], [data-product-price], .price, [class*="price"], .money', root).length === 0) problems.push("No visible price on the product page.");
    if (visible("img", root).length === 0) problems.push("No visible product image.");
    return problems;
  });
}

export async function diagnoseCartPage(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const hasItems = document.querySelectorAll('input[name="updates[]"], input[name^="updates["], [data-cart-item], .cart-item').length > 0;
    const hasCheckout = document.querySelectorAll('[name="checkout"], a[href*="/checkout"], [formaction*="/checkout"]').length > 0;
    return hasItems && !hasCheckout ? ["The cart has items but no checkout button or link."] : [];
  });
}
