import { existsSync } from "node:fs";
import { AppError } from "./store.js";
import { chromium as projectChromium } from "./browser-runtime.js";
import { prepareBrowserNetwork } from "./browser-network.js";
import { workbuddyGlobal as upstream } from "./oauth-adapters.js";

export function trustedOrigin(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password || u.port || u.hash)
      return null;
    if (u.origin === "https://github.com") return "github";
    if (
      u.origin === "https://workbuddy.ai" ||
      u.origin === "https://www.workbuddy.ai"
    )
      return "workbuddy";
  } catch {}
  return null;
}

const manual = () => ({ status: "manual" });
const githubProviderName = upstream.provider;
const visibleOnly = (locator) => locator.filter?.({ visible: true }) ?? locator;
async function providerControls(page, frameEpochs) {
  const scopes = [page];
  for (const frame of page.frames?.() || []) {
    if (frame === page.mainFrame()) continue;
    let trusted = true;
    for (let ancestor = frame; ancestor; ancestor = ancestor.parentFrame()) {
      if (trustedOrigin(ancestor.url()) !== "workbuddy") {
        trusted = false;
        break;
      }
    }
    if (!trusted) continue;
    const element = await frame.frameElement();
    try {
      if (await element.isVisible()) scopes.push(frame);
    } finally {
      await element.dispose();
    }
  }
  const found = [];
  for (const scope of scopes) {
    const documents = [];
    for (let ancestor = scope; ancestor; ancestor = ancestor.parentFrame?.()) {
      documents.push({
        frame: ancestor,
        epoch: frameEpochs.get(ancestor) || 0,
      });
    }
    const button = visibleOnly(
      scope.getByRole("button", { name: githubProviderName }),
    );
    const link = visibleOnly(
      scope.getByRole("link", { name: githubProviderName }),
    );
    const buttons = await button.count(),
      links = await link.count();
    if (buttons + links > 1) return { reason: "provider_ambiguous" };
    let control = buttons === 1 ? button : links === 1 ? link : null;
    if (!control) {
      const text = visibleOnly(scope.getByText(githubProviderName));
      const count = await text.count();
      if (count > 1) return { reason: "provider_ambiguous" };
      if (count === 1) control = text;
    }
    if (control) found.push({ scope, control, url: scope.url(), documents });
  }
  return found.length === 1
    ? found[0]
    : { reason: found.length ? "provider_ambiguous" : "provider_missing" };
}

// The user authorized these required WorkBuddy agreements, not arbitrary opt-ins.
const agreementName = upstream.agreement;
async function acceptAgreements(scope, stillCurrent) {
  const checks = scope.getByRole("checkbox", {
    name: agreementName,
  });
  try {
    // The official Keycloak page hides its native inputs (display:none).
    // Click only the visible checkmark belonging to a recognized policy label;
    // read the native checked property before and after, never toggle blindly.
    const labels = scope.locator(upstream.policyLabel);
    const policyLabels = labels.filter?.({ visible: true });
    const policyCount = policyLabels ? await policyLabels.count() : 0;
    if (policyCount) {
      if (policyCount !== 2) return false;
      const policies = [];
      for (let i = 0; i < policyCount; i++) {
        const label = policyLabels.nth(i);
        if (!agreementName.test((await label.innerText()).replace(/\s+/g, " ").trim()))
          return false;
        const input = label.locator(upstream.policyInput);
        if ((await input.count()) !== 1) return false;
        const kind = await input.getAttribute("data-policy-kind");
        if (!upstream.policyKinds.includes(kind) || policies.some(p => p.kind === kind))
          return false;
        policies.push({ label, input, kind });
      }
      for (const { label, input } of policies) {
        if (!stillCurrent()) return false;
        const checked = await input.isChecked();
        if (!stillCurrent()) return false;
        if (!checked) {
          const mark = label.locator(upstream.policyCheckmark);
          if ((await mark.count()) !== 1 || !(await mark.isVisible())) return false;
          if (!stillCurrent()) return false;
          await mark.click({ timeout: 1500 });
        }
        if (!stillCurrent() || !(await input.isChecked())) return false;
      }
      for (const { label, input } of policies) {
        if (!stillCurrent() || !(await label.isVisible()) || !(await input.isChecked()))
          return false;
      }
      return stillCurrent();
    }
    const wrappers = scope.locator(upstream.policyWrapper).filter?.({ visible: true });
    if (wrappers && (await wrappers.count())) return false;
    const count = await checks.count();
    for (let i = 0; i < count; i++) {
      if (!stillCurrent()) return false;
      const check = checks.nth(i);
      if (!(await check.isVisible())) continue;
      const checked = await check.isChecked();
      if (!stillCurrent()) return false;
      if (!checked) await check.check({ timeout: 1500 });
      if (!stillCurrent() || !(await check.isChecked())) return false;
    }
    // Some custom controls rerender or reset a sibling: verify the whole group again.
    if ((await checks.count()) !== count) return false;
    for (let i = 0; i < count; i++) {
      const check = checks.nth(i);
      if ((await check.isVisible()) && !(await check.isChecked())) return false;
    }
    return stillCurrent();
  } catch {
    return false;
  }
}
async function visible(page, selector) {
  const locator = page.locator(selector);
  return (await locator.count()) === 1 && (await locator.isVisible())
    ? locator
    : null;
}

async function consentButton(page, current, flow) {
  const button = visibleOnly(page.getByRole("button", { name: upstream.consentButton }));
  if (await button.count() !== 1 || !await button.isEnabled()) return null;
  return validateConsentButton(button, current, flow);
}
async function validateConsentButton(button, current, flow) {
  const details = await button.evaluate(button => {
    const form = button.form;
    if (!form || !form.isConnected || button.type !== "submit") return null;
    const fields = {};
    for (const name of ["client_id", "state", "redirect_uri"]) {
      const nodes = [...form.elements].filter(e => e.name === name);
      if (nodes.length > 1) return null;
      if (nodes.length) fields[name] = nodes[0].value;
    }
    return {
      action: button.hasAttribute("formaction") ? button.formAction : form.action,
      method: button.getAttribute("formmethod") || form.method,
      target: button.getAttribute("formtarget") || form.target,
      fields,
    };
  });
  if (!details || details.method.toLowerCase() !== "post" || !["", "_self"].includes(details.target)) return null;
  const action = new URL(details.action, current);
  if (trustedOrigin(action.href) !== "github" || action.pathname !== "/login/oauth/authorize") return null;
  for (const [key, expected] of Object.entries({client_id:flow.clientId, state:flow.state, redirect_uri:flow.redirectURL})) {
    if (action.searchParams.has(key) && (action.searchParams.getAll(key).length !== 1 || action.searchParams.get(key) !== expected)) return null;
    if (key in details.fields && details.fields[key] !== expected) return null;
  }
  return button;
}

async function githubIdentity(page, current) {
  const meta = page.locator(upstream.github.identityMeta);
  const count = await meta.count();
  if (count > 1) return undefined;
  let identity = count === 1 ? await meta.getAttribute("content") : null;
  if (!identity && new URL(current).pathname === "/login/oauth/authorize") {
    const pattern = /^Verify your GitHub identity\s*\(([a-z\d](?:[a-z\d-]{0,37}[a-z\d])?)\)$/i;
    const statement = visibleOnly(page.getByText(pattern));
    if (await statement.count() === 1)
      identity = (await statement.innerText()).trim().match(pattern)?.[1] || null;
  }
  return identity;
}

// One isolated context per account. The session keeps evidence only in memory.
// It never infers identity from a WorkBuddy nickname or from editable login inputs.
export class OAuthSession {
  constructor(context, account, getSecrets, browser = null, authorizationUrl = null) {
    this.context = context;
    this.account = account;
    this.getSecrets = getSecrets;
    this.browser = browser;
    this.flow = null;
    this.identity = null;
    this.callbackVerified = false;
    this.providerAttempted = false;
    this.closed = false;
    this.identityEvidence = null;
    this.callbackEvidence = null;
    this.evidenceInvalid = false;
    this.pageEpochs = new WeakMap();
    this.frameEpochs = new WeakMap();
    this.documentResponses = new WeakMap();
    this.navigationFailure = null;
    this.identityPages = new WeakSet();
    this.identityProfileAttempts = 0;
    this.githubNavigationGeneration = 0;
    this.deviceState = null;
    if (authorizationUrl && trustedOrigin(authorizationUrl) === "workbuddy") {
      const initial = new URL(authorizationUrl);
      if (initial.searchParams.get("platform")?.toLowerCase() === "cli")
        this.deviceState = initial.searchParams.get("state");
    }
    this.confirmedDocuments = new WeakMap();
    this.submittedDocuments = new WeakMap();
  }
  invalidateEvidence() {
    this.evidenceInvalid = true;
    this.identity = null;
    this.callbackVerified = false;
    this.identityEvidence = null;
    this.callbackEvidence = null;
  }
  navigationStarted(page, value, method = "GET") {
    if (trustedOrigin(value) === "github") this.githubNavigationGeneration++;
    this.navigationTarget = { page, url: value, method };
    this.navigationFailure = null;
    const previousEpoch = this.pageEpochs.get(page) || 0;
    this.pageEpochs.set(page, previousEpoch + 1);
    // Only consent submitted by the sampled document may carry its identity forward.
    // A new GET, even to the same URL/state, is a new document and needs new evidence.
    if (this.identityEvidence && trustedOrigin(value) === "github") {
      const consent =
        page === this.flow?.page &&
        method === "POST" &&
        new URL(value).pathname === "/login/oauth/authorize" &&
        this.identityEvidence.epoch === previousEpoch;
      if (!consent) this.invalidateEvidence();
    }
  }
  sameDocument(page, value, epoch, flow) {
    return (
      !this.closed &&
      !this.evidenceInvalid &&
      this.flow === flow &&
      page.url() === value &&
      (this.pageEpochs.get(page) || 0) === epoch
    );
  }
  observe(
    value,
    page = this.context
      .pages()
      .filter((p) => !p.isClosed())
      .at(-1),
  ) {
    if (this.evidenceInvalid) return;
    try {
      const u = new URL(value);
      // GitHub redirects anonymous OAuth visitors to /login, preserving the
      // authorization URL in return_to. Recover it on resume even if the first
      // redirect was missed; the normal state/client/page binding still applies.
      if (trustedOrigin(value) === "github" && u.pathname === "/login") {
        const returnTo = u.searchParams.get("return_to");
        if (returnTo) {
          const target = new URL(returnTo, u.origin);
          const outerClient = u.searchParams.get("client_id");
          if (
            trustedOrigin(target.href) === "github" &&
            target.pathname === "/login/oauth/authorize" &&
            (!outerClient || outerClient === target.searchParams.get("client_id"))
          ) this.observe(target.href, page);
          else this.invalidateEvidence();
        }
        return;
      }
      if (
        trustedOrigin(value) === "github" &&
        u.pathname === "/login/oauth/authorize"
      ) {
        const state = u.searchParams.get("state"),
          redirect = u.searchParams.get("redirect_uri");
        if (
          state &&
          state.length <= 8192 &&
          trustedOrigin(redirect) === "workbuddy"
        ) {
          const r = new URL(redirect);
          const candidate = {
            state,
            redirect: r.origin + r.pathname,
            redirectURL: r.href,
            clientId: u.searchParams.get("client_id") || "",
            page,
          };
          if (this.flow) {
            if (
              this.flow.state !== candidate.state ||
              this.flow.redirectURL !== candidate.redirectURL ||
              this.flow.clientId !== candidate.clientId ||
              this.flow.page !== page
            )
              this.invalidateEvidence();
          } else this.flow = Object.freeze(candidate);
        } else if (state || redirect) {
          this.invalidateEvidence();
        }
      }
      if (
        !this.evidenceInvalid &&
        this.flow &&
        page === this.flow.page &&
        trustedOrigin(value) === "workbuddy" &&
        u.origin + u.pathname === this.flow.redirect &&
        u.searchParams.get("state") === this.flow.state &&
        u.searchParams.get("code")
      ) {
        const redirect = new URL(this.flow.redirectURL);
        if (
          [...redirect.searchParams].every(
            ([key, value]) => u.searchParams.get(key) === value,
          )
        ) {
          this.callbackEvidence = Object.freeze({ flow: this.flow, page });
          this.callbackVerified = true;
        }
      }
    } catch {}
  }
  observeResponse(
    value,
    status,
    page = this.context
      .pages()
      .filter((p) => !p.isClosed())
      .at(-1),
  ) {
    if (page && trustedOrigin(value) && Number.isInteger(status) && status >= 100 && status <= 599)
      this.documentResponses.set(page, { url: value, status });
    if (status >= 200 && status < 400 && trustedOrigin(value) === "workbuddy")
      this.observe(value, page);
  }
  diagnostic() {
    // Fixed stage labels only: never persist URLs, query strings, body text,
    // cookies, account names or exception messages in batch diagnostics.
    const page = this.context.pages().filter(p => !p.isClosed()).at(-1);
    const current = page?.url();
    const origin = trustedOrigin(current);
    const stages = {
      github: {
        "/login": "GitHub 登录", "/session": "GitHub 登录",
        "/sessions/two-factor": "GitHub 二次验证", "/sessions/two-factor/app": "GitHub 二次验证",
        "/sessions/trusted-device": "GitHub 设备提示", "/login/oauth/authorize": "GitHub 授权",
        "/sessions/verified-device": "GitHub 邮箱设备验证",
      },
      workbuddy: {
        "/auth/realms/copilot/broker/github/endpoint": "WorkBuddy GitHub 回调",
        "/auth/realms/copilot/login-actions/first-broker-login": "WorkBuddy 首次关联",
        "/login/select": "WorkBuddy 登录确认", "/select": "WorkBuddy 登录确认",
        "/login/started": "WorkBuddy 登录结果",
      },
    };
    const stage = origin ? stages[origin][new URL(current).pathname] || (origin === "github" ? "GitHub 其他页面" : "WorkBuddy 其他页面") : "页面不可用或来源未确认";
    const response = page && this.documentResponses.get(page);
    const status = origin && response?.url === current ? response.status : "未记录";
    return `阶段=${stage}；HTTP=${status}；授权上下文=${!!this.flow}；身份=${!!this.identityEvidence}；回调=${this.callbackVerified}；上下文失效=${this.evidenceInvalid}`;
  }
  async step() {
    const result = await this.advance();
    // A redirect may complete while a GitHub locator is being read or clicked.
    // Inspect the final official document before returning an incomplete result.
    if (result.status === "manual" && !this.closed) {
      try {
        const page = this.context.pages().filter(p => !p.isClosed()).at(-1);
        const url = page?.url(), epoch = this.pageEpochs.get(page) || 0;
        if (trustedOrigin(url) === "workbuddy") {
          const body = (await page.locator("body").innerText()).slice(0, 50000);
          if (!this.closed && page.url() === url && (this.pageEpochs.get(page) || 0) === epoch && /access (?:denied|restricted)|region.{0,30}(?:not supported|unavailable)|访问受限|所在地区.{0,20}(?:不支持|不可用)/i.test(body))
            return { status: "restricted", reason: /账号因安全策略限制/.test(body) ? "account_security" : undefined };
          // Consent can succeed while its locator throws because the old document
          // disappeared. Re-evaluate the official destination using the existing
          // bound evidence; do not replay the consent click.
          if (!this.closed && !this.evidenceInvalid && this.callbackVerified &&
              this.callbackEvidence?.flow === this.flow && this.identityEvidence?.flow === this.flow)
            return await this.advance();
        }
      } catch { /* Keep the original manual result if the document is unavailable. */ }
    }
    if (result.status === "manual" && this.evidenceInvalid)
      return { status: "manual", reason: "oauth_changed" };
    return result;
  }
  async retryNavigation() {
    const target = this.navigationTarget;
    if (this.closed || this.evidenceInvalid || this.identityEvidence || this.callbackEvidence ||
        !target || target.page.isClosed() || target.method !== "GET" || !trustedOrigin(target.url)) return false;
    const url = new URL(target.url);
    // Never replay an OAuth code callback or a credential/consent POST.
    if (url.searchParams.has("code")) return false;
    this.navigationFailure = null;
    try {
      await target.page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    } catch {
      this.navigationFailure ||= "network";
    }
    return true;
  }
  async clickAuthorization(control, page, current, epoch, flow) {
    // Actionability checking scrolls below-the-fold buttons into view and waits
    // for disabled/covered controls, without dispatching a click or submission.
    try {
      await control.scrollIntoViewIfNeeded({ timeout: 10000 });
      await control.click({ trial: true, timeout: 10000 });
    } catch {
      return { status: "manual", reason: "github_authorize_not_ready" };
    }
    if (!this.sameDocument(page, current, epoch, flow)) return manual();
    const identity = await githubIdentity(page, current);
    if (!identity) return { status: "manual", reason: "github_identity_pending" };
    if (identity.toLowerCase() !== this.account.username.toLowerCase()) {
      this.invalidateEvidence();
      return { status: "manual", reason: "oauth_changed" };
    }
    if (!await validateConsentButton(control, current, flow))
      return { status: "manual", reason: "github_authorize_unrecognized" };
    if (!this.sameDocument(page, current, epoch, flow)) return manual();
    this.submittedDocuments.set(page, { epoch, url: current });
    try {
      await control.click({ timeout: 10000, noWaitAfter: true });
    } catch {
      // Dispatch may have happened. Preserve the latch and inspect callbacks;
      // unlike a failed trial, an ambiguous real click must never be replayed.
      return { status: "manual", reason: "github_authorize_pending" };
    }
    return null;
  }
  async recoverCallbackIdentity(page, current, epoch, flow) {
    // Already-approved GitHub apps may redirect before the consent identity is
    // visible. Read the authenticated profile in this same isolated cookie jar.
    // The callback must remain bound to the original page/flow throughout.
    if (!flow || flow.page !== page || this.identityEvidence ||
        !this.callbackVerified || this.callbackEvidence?.flow !== flow ||
        this.callbackEvidence?.page !== page || !this.context.newPage ||
        this.identityProfileAttempts >= 2 || !this.sameDocument(page, current, epoch, flow)) return false;
    this.identityProfileAttempts++;
    const generation = this.githubNavigationGeneration;
    let profile;
    try {
      profile = await this.context.newPage();
      this.identityPages.add(profile);
      const response = await profile.goto("https://github.com/settings/profile", {
        waitUntil: "domcontentloaded", timeout: 15000,
      });
      const url = profile.url();
      if (response?.status() !== 200 || url !== "https://github.com/settings/profile") return false;
      const identity = await githubIdentity(profile, url);
      if (!this.sameDocument(page, current, epoch, flow) ||
          generation !== this.githubNavigationGeneration ||
          this.callbackEvidence?.flow !== flow || this.callbackEvidence?.page !== page ||
          profile.url() !== url || !this.callbackVerified) return false;
      if (!identity || !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(identity)) return false;
      if (identity.toLowerCase() !== this.account.username.toLowerCase()) {
        this.invalidateEvidence();
        return false;
      }
      this.identity = identity;
      this.identityEvidence = Object.freeze({ username: identity, flow, page, epoch, source: "authenticated-profile" });
      return true;
    } catch { return false; }
    finally { await profile?.close().catch(() => {}); }
  }
  async advance() {
    if (this.closed) return manual();
    if (this.evidenceInvalid) return { status: "manual", reason: "oauth_changed" };
    if (this.navigationFailure)
      return { status: "manual", reason: this.navigationFailure };
    try {
      let providerWait = 0, transitionWait = 0, readinessWait = 0;
      for (let n = 0; n < 110; n++) {
        if (this.closed || this.evidenceInvalid) return manual();
        if (this.navigationFailure)
          return { status: "manual", reason: this.navigationFailure };
        const pages = this.context.pages().filter((p) => !p.isClosed());
        const page = pages.at(-1);
        if (!page) return manual();
        const current = page.url(),
          origin = trustedOrigin(current);
        if (!origin) return manual();
        if (origin === "workbuddy") {
          const flow = this.flow,
            epoch = this.pageEpochs.get(page) || 0;
          const body = (await page.locator("body").innerText()).slice(0, 50000);
          if (!this.sameDocument(page, current, epoch, flow)) return manual();
          if (
            /access (?:denied|restricted)|region.{0,30}(?:not supported|unavailable)|访问受限|所在地区.{0,20}(?:不支持|不可用)/i.test(
              body,
            )
          )
            return { status: "restricted", reason: /账号因安全策略限制/.test(body) ? "account_security" : undefined };
          if (this.callbackVerified && !this.identityEvidence && this.callbackEvidence?.flow === flow) {
            await this.recoverCallbackIdentity(page, current, epoch, flow);
            if (!this.sameDocument(page, current, epoch, flow)) return manual();
            if (!this.identityEvidence) return { status: "manual", reason: "github_identity_missing" };
          }
          const proven = (
            !this.evidenceInvalid &&
            this.callbackEvidence?.flow === this.flow &&
            this.identityEvidence?.flow === this.flow &&
            this.callbackVerified &&
            this.identity?.toLowerCase() === this.account.username.toLowerCase()
          );
          if (proven) {
            const url = new URL(current);
            if (this.deviceState) {
              const matchesDevice = url.searchParams.get("state") === this.deviceState && url.searchParams.get("platform")?.toLowerCase() === "cli";
              if (["/login/select", "/select"].includes(url.pathname.replace(/\/$/, "")) && matchesDevice) {
                const confirm = visibleOnly(page.getByRole("button", { name: /^(?:确认登录|确定登录|开始使用|Confirm login|Confirm sign in|Get Started)$/i }));
                if ((await confirm.count()) === 1 && await confirm.isEnabled() && this.confirmedDocuments.get(page) !== epoch) {
                  if (!this.sameDocument(page, current, epoch, flow) || this.closed) return manual();
                  this.confirmedDocuments.set(page, epoch);
                  await confirm.click({ timeout: 5000 });
                  await page.waitForTimeout(500);
                  continue;
                }
              }
              if (!(matchesDevice && url.pathname.replace(/\/$/, "") === "/login/started" && /登录成功|Login Successful/i.test(body))) {
                if (transitionWait < 20000) {
                  await page.waitForTimeout(500);
                  transitionWait += 500;
                  continue;
                }
                return { status: "manual", reason: "workbuddy_confirmation" };
              }
            }
            return {
              status: "verified",
              githubUsername: this.identity,
              callbackVerified: true,
            };
          }
          if (this.providerAttempted) {
            if (transitionWait < 20000) {
              await page.waitForTimeout(500);
              transitionWait += 500;
              continue;
            }
            return { status: "manual", reason: this.callbackVerified && !this.identityEvidence ? "github_identity_missing" : this.flow ? "callback_pending" : "provider_navigation" };
          }
          // Wait for actual provider readiness, including visible official child frames.
          // Never refresh the page, create another state, or fill secrets in a frame.
          let match;
          try {
            match = await providerControls(page, this.frameEpochs);
          } catch {
            match = { reason: "provider_loading" };
          }
          const { control, scope } = match;
          const stillCurrent = () => {
            if (this.closed || !this.sameDocument(page, current, epoch, flow))
              return false;
            if (!scope || scope.url() !== match.url) return false;
            if (
              match.documents.some(
                ({ frame, epoch }) =>
                  frame.isDetached?.() ||
                  (this.frameEpochs.get(frame) || 0) !== epoch,
              )
            )
              return false;
            for (
              let ancestor = scope;
              ancestor;
              ancestor = ancestor.parentFrame?.()
            ) {
              if (trustedOrigin(ancestor.url()) !== "workbuddy") return false;
            }
            return true;
          };
          const agreementsReady =
            control && (await acceptAgreements(scope, stillCurrent));
          if (control && !stillCurrent()) return manual();
          const enabled =
            control &&
            agreementsReady &&
            (control.isEnabled ? await control.isEnabled() : true);
          if (!enabled) {
            if (providerWait < 45000) {
              await page.waitForTimeout(500);
              providerWait += 500;
              continue;
            }
            return {
              status: "manual",
              reason: control
                ? agreementsReady
                  ? "provider_disabled"
                  : "agreement"
                : match.reason,
            };
          }
          if (!stillCurrent()) return manual();
          this.providerAttempted = true;
          await control.click({ timeout: 10000 });
          await page.waitForTimeout(700);
          continue;
        }
        this.observe(current, page);
        if (this.evidenceInvalid || (this.flow && this.flow.page !== page))
          return manual();
        const flow = this.flow,
          epoch = this.pageEpochs.get(page) || 0;
        if (flow && new URL(current).pathname === "/login/oauth/authorize") {
          // GitHub may defer rendering/actionability until the permissions page
          // is scrolled. Do this before identity and control discovery, otherwise
          // those checks can prevent us from ever reaching the click's scroll.
          await page.evaluate(() => {
            const root = document.scrollingElement;
            root?.scrollTo({ top: root.scrollHeight, behavior: "instant" });
          });
          await page.waitForTimeout(150);
          if (!this.sameDocument(page, current, epoch, flow)) return manual();
        }
        const identity = await githubIdentity(page, current);
        if (identity === undefined) return manual();
        if (!this.sameDocument(page, current, epoch, flow)) return manual();
        if (identity) {
          if (identity.toLowerCase() !== this.account.username.toLowerCase()) {
            this.invalidateEvidence();
            return manual();
          }
          if (flow && new URL(current).pathname === "/login/oauth/authorize") {
            this.identity = identity;
            this.identityEvidence = Object.freeze({
              username: identity,
              flow,
              page,
              epoch,
            });
          }
        }
        // Without an observed OAuth redirect back to official WorkBuddy, do not type credentials.
        if (!this.flow) return { status: "manual", reason: "oauth_context" };
        const path = new URL(current).pathname;
        if (path === "/sessions/verified-device")
          return { status: "manual", reason: "github_email_device_verification" };
        const submitted = this.submittedDocuments.get(page);
        if (submitted?.epoch === epoch && submitted.url === current)
          return { status: "manual", reason: path === "/login/oauth/authorize" ? "github_authorize_pending" : path === "/login" || path === "/session" ? "github_login" : "github_challenge" };
        const markSubmitted = () => this.submittedDocuments.set(page, { epoch, url: current });
        let acted = false;
        if (path === "/login" || path === "/session") {
          const login = await visible(page, upstream.github.loginField),
            password = await visible(page, upstream.github.passwordField);
          const form = await visible(page, upstream.github.loginForm);
          if (
            login &&
            password &&
            form &&
            trustedOrigin(
              new URL(await form.getAttribute("action"), current).href,
            ) === "github"
          ) {
            const secrets = this.getSecrets();
            if (!this.sameDocument(page, current, epoch, flow)) return manual();
            await login.fill(this.account.username);
            // Recheck immediately before every sensitive operation.
            if (!this.sameDocument(page, current, epoch, flow)) return manual();
            await password.fill(secrets.password);
            if (!this.sameDocument(page, current, epoch, flow)) return manual();
            markSubmitted();
            await page
              .locator(upstream.github.loginSubmit)
              .click();
            acted = true;
          }
        } else if (
          path === "/sessions/two-factor/app" ||
          path === "/sessions/two-factor"
        ) {
          // GitHub's authenticator-app field is distinct from email/device OTP fields.
          const otp = await visible(page, upstream.github.twoFactorField);
          const form = await visible(
            page,
            upstream.github.twoFactorForm,
          );
          if (
            otp &&
            form &&
            trustedOrigin(
              new URL(await form.getAttribute("action"), current).href,
            ) === "github"
          ) {
            let token = this.getSecrets().otp; // regenerate at the moment of filling
            if (!token || !Number.isFinite(token.expiresAt)) return manual();
            // Avoid submitting a code that will expire while the browser sends the form.
            if (token.expiresAt - Date.now() < 2000) {
              await page.waitForTimeout(
                Math.max(0, Math.min(2100, token.expiresAt - Date.now() + 100)),
              );
              token = this.getSecrets().otp;
            }
            if (
              !token ||
              typeof token.code !== "string" ||
              !/^\d{6}$/.test(token.code) ||
              token.expiresAt - Date.now() < 2000 ||
              !this.sameDocument(page, current, epoch, flow)
            )
              return manual();
            await otp.fill(token.code);
            if (!this.sameDocument(page, current, epoch, flow)) return manual();
            markSubmitted();
            await page
              .locator(
                upstream.github.twoFactorSubmit,
              )
              .click();
            acted = true;
          }
        } else if (path === "/sessions/trusted-device") {
          const link = visibleOnly(page.getByRole("link", { name: upstream.github.trustedDeviceSkip }));
          const button = visibleOnly(page.getByRole("button", { name: upstream.github.trustedDeviceSkip }));
          const links = await link.count(), buttons = await button.count();
          const later = links === 1 && buttons === 0 ? link : buttons === 1 && links === 0 ? button : null;
          if (later) {
            const href = links ? await later.getAttribute("href") : null;
            if (links && (!href || trustedOrigin(new URL(href, current).href) !== "github")) return manual();
            if (!this.sameDocument(page, current, epoch, flow) || this.closed) return manual();
            markSubmitted();
            await later.click({ timeout: 5000 });
            acted = true;
          }
        } else if (path === "/login/oauth/authorize" && this.identity) {
          const form = await visible(
            page,
            upstream.github.authorizeForm,
          );
          const authorize = await visible(
            page,
            upstream.github.authorizeButton,
          );
          if (
            form &&
            authorize &&
            trustedOrigin(
              new URL(await form.getAttribute("action"), current).href,
            ) === "github"
          ) {
            if (!this.sameDocument(page, current, epoch, flow)) return manual();
            const result = await this.clickAuthorization(authorize, page, current, epoch, flow);
            if (result) return result;
            acted = true;
          } else {
            const control = await consentButton(page, current, flow);
            if (control) {
              if (!this.sameDocument(page, current, epoch, flow) || this.closed) return manual();
              const result = await this.clickAuthorization(control, page, current, epoch, flow);
              if (result) return result;
              acted = true;
            }
          }
        }
        if (this.navigationFailure)
          return { status: "manual", reason: this.navigationFailure };
        if (!acted) {
          if (
            ["/login", "/session", "/login/oauth/authorize", "/sessions/two-factor/app", "/sessions/two-factor", "/sessions/trusted-device"].includes(path) &&
            readinessWait < 10000
          ) {
            await page.waitForTimeout(500);
            readinessWait += 500;
            continue;
          }
          if (path === "/login/oauth/authorize")
            return { status: "manual", reason: this.identity ? "github_authorize_unrecognized" : "github_identity_pending" };
          return manual();
        }
        readinessWait = 0;
        await page.waitForTimeout(700);
        if (this.navigationFailure)
          return { status: "manual", reason: this.navigationFailure };
        // A successful click does not mean that the destination has loaded.
        // Wait for navigation, without submitting the same form a second time.
        let waited = 700;
        while (page.url() === current && waited < 15000 && !this.closed && !this.evidenceInvalid && !this.navigationFailure) {
          await page.waitForTimeout(300);
          waited += 300;
        }
        if (page.url() === current)
          return { status: "manual", reason: path === "/login/oauth/authorize" ? "github_authorize_pending" : path === "/login" || path === "/session" ? "github_login" : "github_challenge" };
      }
    } catch {
      /* Unknown layouts are returned to the bounded queue for retry or skip. */
    }
    return this.navigationFailure
      ? { status: "manual", reason: this.navigationFailure }
      : manual();
  }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      // Browser shutdown must not be held hostage by a hung context close.
      const results = await Promise.allSettled([
        Promise.resolve().then(() => this.context.close()),
        Promise.resolve().then(() => this.browser?.close()),
        Promise.resolve().then(() => this.networkCleanup?.()),
      ]);
      const failure = results.find(result => result.status === "rejected");
      if (failure) throw failure.reason;
    })();
    return this.closePromise;
  }
}

export class OAuthBrowser {
  constructor({ chromium = projectChromium } = {}) {
    this.chromium = chromium;
  }
  assertAvailable() {
    const executablePath = this.chromium.executablePath();
    if (!existsSync(executablePath))
      throw new AppError(
        "项目专用 Chromium 尚未安装，请在项目目录运行 npm run browser:install；不会回退使用你的 Edge/Chrome",
        409,
      );
    return executablePath;
  }
  async open({ url, account, getSecrets, proxy = null, signal }) {
    if (trustedOrigin(url) !== "workbuddy")
      throw new AppError("仅允许打开官方 WorkBuddy HTTPS 授权链接");
    const executablePath = this.assertAvailable();
    let browser, session, network;
    const abort = () => {
      if (session) void session.close().catch(() => {});
      else if (browser) void browser.close().catch(() => {});
    };
    if (signal?.aborted) throw new Error("cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    try {
      network = await prepareBrowserNetwork(proxy);
      if (signal?.aborted) throw new Error("cancelled");
      browser = await this.chromium.launch({
        executablePath,
        headless: false,
        timeout: 30000,
        ...network.launchOptions,
      });
      if (signal?.aborted) throw new Error("cancelled");
      const context = await browser.newContext({ viewport: null });
      context.setDefaultTimeout?.(10000);
      context.setDefaultNavigationTimeout?.(30000);
      session = new OAuthSession(context, account, getSecrets, browser, url);
      session.networkCleanup = network.close;
      context.on("request", (request) => {
        try {
          if (session.identityPages.has(request.frame().page())) return;
          if (request.isNavigationRequest()) {
            const frame = request.frame();
            session.frameEpochs.set(
              frame,
              (session.frameEpochs.get(frame) || 0) + 1,
            );
          }
          if (
            request.isNavigationRequest() &&
            request.frame() === request.frame().page().mainFrame()
          ) {
            const page = request.frame().page();
            session.navigationStarted(page, request.url(), request.method());
            if (trustedOrigin(request.url()) === "github")
              session.observe(request.url(), page);
          }
        } catch {}
      });
      context.on("response", (response) => {
        try {
          const request = response.request();
          if (session.identityPages.has(request.frame().page())) return;
          if (
            request.isNavigationRequest() &&
            request.frame() === request.frame().page().mainFrame()
          )
            session.observeResponse(
              response.url(),
              response.status(),
              request.frame().page(),
            );
        } catch {}
      });
      context.on("requestfailed", (request) => {
        try {
          if (session.identityPages.has(request.frame().page())) return;
          if (
            request.isNavigationRequest() &&
            request.frame() === request.frame().page().mainFrame()
          ) {
            const failure = request.failure()?.errorText || "";
            if (failure !== "net::ERR_ABORTED")
              session.navigationFailure = /PROXY|TUNNEL/.test(failure)
                ? "proxy"
                : "network";
          }
        } catch {}
      });
      const page = await context.newPage();
      session.navigationTarget = { page, url, method: "GET" };
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      } catch {
        session.navigationFailure ||= "network";
      }
      return session;
    } catch {
      await Promise.allSettled([
        Promise.resolve().then(() => browser?.close()),
        Promise.resolve().then(() => network?.close()),
      ]);
      throw new AppError(
        "无法启动项目专用 Chromium；请检查浏览器安装和代理配置后核对远端结果",
        409,
      );
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
}
