import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

export class BrowserSession {
  constructor(browser, page, baseUrl, captureDir) {
    this.browser = browser; this.page = page; this.baseUrl = baseUrl.replace(/\/$/, "");
    this.captureDir = captureDir; this.step = 0; this.trace = [];
  }

  static async open(baseUrl, captureDir) {
    fs.mkdirSync(captureDir, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    return new BrowserSession(browser, page, baseUrl, captureDir);
  }

  async observe(action = "inspect") {
    if (!this.page.url().startsWith(this.baseUrl)) throw new Error("browser left the configured local portal");
    const screenshot = path.join(this.captureDir, `step-${String(this.step++).padStart(2, "0")}.png`);
    await this.page.screenshot({ path: screenshot, fullPage: true });
    const view = {
      url: this.page.url(),
      title: await this.page.title(),
      text: (await this.page.locator("body").innerText()).slice(0, 6000),
      controls: await this.page.locator("a,button,input,select").evaluateAll((elements) =>
        elements.map((el) => ({ tag: el.tagName.toLowerCase(), text: (el.textContent || "").trim().slice(0, 90),
          label: el.id ? document.querySelector(`label[for="${el.id}"]`)?.textContent?.trim() || "" : "",
          value: "value" in el ? String(el.value) : "" })).slice(0, 40)),
      screenshot,
    };
    this.trace.push({ action, ...view });
    return view;
  }

  async execute(name, args) {
    try {
      if (name === "browser_inspect") return await this.observe();
      if (name === "browser_click") {
        if (!["link", "button"].includes(args.role)) throw new Error("role must be link or button");
        await this.page.getByRole(args.role, { name: args.name, exact: true }).click();
      } else if (name === "browser_fill") {
        await this.page.getByLabel(args.label, { exact: true }).fill(args.value);
      } else if (name === "browser_select") {
        await this.page.getByLabel(args.label, { exact: true }).selectOption({ label: args.option });
      } else throw new Error("unknown browser tool");
      await this.page.waitForLoadState("networkidle");
      return await this.observe(`${name} ${JSON.stringify(args)}`);
    } catch (error) {
      return { error: String(error), ...(await this.observe(`failed ${name}`)) };
    }
  }

  async close() { await this.browser.close(); }
}
