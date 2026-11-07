import { existsSync } from "node:fs";
import { chromium as projectChromium } from "./browser-runtime.js";
import { prepareBrowserNetwork } from "./browser-network.js";

const diagnosticURL = "https://github.com/login";

// Deliberately separate from OAuthSession: no account, cookie, or authorization state.
export class ConnectionBrowser {
  constructor({ chromium = projectChromium, exists = existsSync } = {}) {
    this.chromium = chromium;
    this.exists = exists;
  }

  async check(proxy = null) {
    const mode = proxy ? "proxy" : "direct";
    let browser, network;
    let result;
    try {
      const executablePath = this.chromium.executablePath();
      if (!this.exists(executablePath))
        return { ok: false, mode, message: "项目专用 Chromium 尚未安装，请运行 npm run browser:install" };
      network = await prepareBrowserNetwork(proxy);
      browser = await this.chromium.launch({
        executablePath,
        headless: true,
        timeout: 15000,
        ...network.launchOptions,
      });
      const context = await browser.newContext({ serviceWorkers: "block", javaScriptEnabled: false });
      // Only the fixed public login document is needed. Block other entrypoints,
      // subresources and non-GET requests; no page scripts or forms are executed.
      await context.route("**/*", async route => {
        const request = route.request();
        if (request.url() === diagnosticURL && request.method() === "GET")
          await route.continue();
        else await route.abort();
      });
      const page = await context.newPage();
      const response = await page.goto(diagnosticURL, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
      const status = response?.status();
      if (!Number.isInteger(status) || status < 200 || status >= 300 || response.url() !== diagnosticURL) {
        const messages = {
          403: "浏览器访问被拒绝（HTTP 403），请检查网络或代理访问权限",
          407: "代理认证失败（HTTP 407），请检查代理用户名和密码",
          429: "浏览器访问受限（HTTP 429），请稍后再试",
        };
        result = { ok: false, mode, message: messages[status] || (Number.isInteger(status)
          ? `浏览器网络测试失败（HTTP ${status}），请检查网络或代理配置`
          : "浏览器未收到有效响应，请检查网络或代理配置") };
      } else {
        result = { ok: true, mode, message: mode === "proxy"
          ? "浏览器已通过配置的代理访问 GitHub"
          : "浏览器已直连 GitHub" };
      }
    } catch (error) {
      // Playwright errors can contain command lines, proxy credentials, and URLs.
      result = { ok: false, mode, message: error?.name === "TimeoutError"
        ? "浏览器网络测试超时，请检查网络或代理配置"
        : "浏览器网络测试失败，请检查 Chromium、网络或代理配置" };
    } finally {
      const cleanup = await Promise.allSettled([
        Promise.resolve().then(() => browser?.close()),
        Promise.resolve().then(() => network?.close()),
      ]);
      if (cleanup.some(item => item.status === 'rejected'))
        result = { ok: false, mode, message: "浏览器测试清理失败，请检查本地浏览器运行状态" };
    }
    return result;
  }
}
