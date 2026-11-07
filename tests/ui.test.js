import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Compile the actual UI in memory; no generated files or extra test dependencies.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && context.parentURL) {
      for (const extension of [".tsx", ".ts"]) {
        const url = new URL(specifier + extension, context.parentURL);
        if (existsSync(url)) return next(url.href, context);
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (/\.tsx?$/.test(url))
      return {
        format: "module",
        shortCircuit: true,
        source: ts.transpileModule(readFileSync(new URL(url), "utf8"), {
          compilerOptions: {
            module: ts.ModuleKind.ESNext,
            jsx: ts.JsxEmit.ReactJSX,
          },
        }).outputText,
      };
    return next(url, context);
  },
});
const { AccountDetail } = await import("../src/AccountDetail.tsx");
const { eligible } = await import("../src/types.ts");
const components = await import("../src/components.tsx");

test("proxy configuration uses one link field without restoring stored credentials", async () => {
  const { WorkBuddyConfig } = await import("../src/WorkBuddyConfig.tsx");
  const target = {
    id: "proxy-config",
    name: "Test",
    baseUrl: "https://example.test",
    revision: "r1",
    hasApiKey: true,
    browserProxy: {
      server: "http://127.0.0.1:7890",
      username: "proxy-user",
      hasPassword: true,
    },
  };
  const html = renderToStaticMarkup(
    createElement(WorkBuddyConfig, {
      targets: [target],
      selectedId: target.id,
      onSaved() {},
      onClose() {},
    }),
  );
  assert.doesNotMatch(html, /已保存的部署|配置名称|新建配置|项目专用 Chromium/);
  assert.doesNotMatch(html, /代理需要认证|代理用户名|代理密码|value="proxy-user"/);
  assert.match(html, /已保存 http:\/\/127.0.0.1:7890/);
  const password = (html.match(/<input\b[^>]*>/g) || []).find((s) =>
    s.includes('id="wb-proxy-server"'),
  );
  assert.ok(password);
  assert.match(password, /type="password"/);
  assert.match(password, /value=""/);
});
const account = {
  id: "test",
  email: "test@example.com",
  username: "test",
  hasTotp: 1,
  notes: "test note",
  risk: "flagged",
  publicStatus: "reachable",
  checkMessage: "ok",
  checkedAt: new Date().toISOString(),
  selectedAt: null,
  purpose: "",
  createdAt: null,
  deletedAt: null,
};
const props = {
  account,
  checking: false,
  onClose() {},
  onUpdate: async () => {},
  onSelect() {},
  onCheck: async () => {},
  onTrash() {},
  notify() {},
};

test("detail only exposes read-only credentials, copy and automatic check", () => {
  const html = renderToStaticMarkup(
    createElement(AccountDetail, { ...props, mode: "view" }),
  );
  const inputs = html.match(/<input\b[^>]*>/g) || [];
  assert.equal(inputs.length, 4);
  for (const input of inputs) assert.match(input, /readOnly=""/);
  for (const label of [
    "复制邮箱",
    "复制GitHub 用户名",
    "复制密码",
    "复制TOTP 密钥",
    "检查此账号",
  ])
    assert.ok(html.includes(label));
  assert.doesNotMatch(html, /保存修改|修改密码|人工风控|<textarea|<select/);
});
test("edit provides editable identity and explicit secret modification without check or selection actions", () => {
  const html = renderToStaticMarkup(
    createElement(AccountDetail, { ...props, mode: "edit" }),
  );
  assert.match(html, /保存修改/);
  assert.match(html, /修改密码/);
  const email = html.match(/<input\b[^>]*id="detail-email"[^>]*>/)[0];
  assert.doesNotMatch(email, /readOnly/);
  assert.match(html, /<textarea/);
  assert.doesNotMatch(html, /检查此账号|选用此账号|人工风控|<select/);
});
test("candidate availability is based on automatic checks, not legacy manual flags", () => {
  assert.equal(eligible(account), true);
  assert.equal(eligible({ ...account, hasTotp: 0 }), false);
  assert.equal(eligible({ ...account, publicStatus: "missing" }), false);
  assert.equal(
    eligible({ ...account, selectedAt: new Date().toISOString() }),
    false,
  );
  assert.equal(
    eligible({
      ...account,
      selectedAt: null,
      workbuddyResult: { status: "success" },
    }),
    false,
  );
});
test("confirmation provides explicit cancel and destructive actions in an accessible dialog", () => {
  assert.equal(typeof components.ConfirmDialog, "function");
  const html = renderToStaticMarkup(
    createElement(components.ConfirmDialog, {
      title: "放弃未保存的修改？",
      description: "关闭后，本次修改不会保存。",
      cancelLabel: "继续编辑",
      confirmLabel: "放弃修改",
      onCancel() {},
      onConfirm() {},
    }),
  );
  assert.match(html, /<dialog[^>]*role="alertdialog"/);
  assert.match(html, /aria-describedby=/);
  assert.match(html, /继续编辑/);
  assert.match(html, /放弃修改/);
});

test("project integration is a distinct navigation destination", async () => {
  const { default: App } = await import("../src/App.tsx");
  const html = renderToStaticMarkup(createElement(App));
  assert.match(html, /WorkBuddy2api/);
});

test("workbuddy start confirmation names accounts, target and remote side effects", async () => {
  const ui = await import("../src/WorkBuddy.tsx");
  const html = renderToStaticMarkup(
    createElement(ui.RunConfirmation, {
      preview: {
        target: { name: "测试部署", baseUrl: "https://example.com" },
        count: 2,
        accounts: [
          { id: "a", username: "alice", email: "a@example.com", hasTotp: 1 },
          { id: "b", username: "bob", email: "b@example.com", hasTotp: 0 },
        ],
      },
      busy: false,
      error: "",
      onCancel() {},
      onConfirm() {},
    }),
  );
  for (const value of [
    'role="alertdialog"',
    "alice",
    "bob",
    "https://example.com",
    "国际版",
    "账号池",
    "trial",
    "取消",
    "确认开始",
  ])
    assert.ok(html.includes(value), value);
});

test("workbuddy metrics never count link acquisition as OAuth success", async () => {
  const ui = await import("../src/WorkBuddy.tsx");
  const html = renderToStaticMarkup(
    createElement(ui.RunMetrics, {
      count: 2,
      now: Date.now(),
      job: {
        total: 2,
        createdAt: new Date().toISOString(),
        finishedAt: null,
        items: [{ status: "browser" }, { status: "success" }],
      },
    }),
  );
  assert.match(html, /aria-label="授权成功：1"/);
  assert.match(html, /aria-label="已处理：1\/2"/);
});

test("WorkBuddy progress counts attempted accounts separately from accounts never started", async () => {
  const {RunMetrics}=await import('../src/WorkBuddy.tsx');
  const html=renderToStaticMarkup(createElement(RunMetrics,{count:60,now:Date.now(),job:{total:60,createdAt:new Date().toISOString(),items:[{status:'restricted'},...Array.from({length:59},()=>({status:'skipped'}))]}}));
  assert.match(html,/aria-label="已处理：1\/60"/);
  assert.match(html,/未执行：59/);
});

test("workbuddy page no longer offers a separate account list", async () => {
  const ui = await import("../src/WorkBuddy.tsx");
  const html = renderToStaticMarkup(
    createElement(ui.WorkBuddy, {
      active: true,
      notify() {},
      async onAccountsChanged() {},
    }),
  );
  assert.doesNotMatch(html, /账号列表|核对后释放占用/);
  assert.match(html, /停止/);
});

test("account details retain WorkBuddy failure outcome separately from GitHub checks", () => {
  const html = renderToStaticMarkup(
    createElement(AccountDetail, {
      ...props,
      account: {
        ...account,
        workbuddyResult: {
          status: "unknown",
          message: "远端结果未知，已自动释放占用",
        },
      },
    }),
  );
  assert.match(html, /WorkBuddy.*结果未知/);
  assert.match(html, /已自动释放占用/);
});

// The standalone link-acquisition page (src/Integrations.tsx) was removed:
// its job now lives entirely in the WorkBuddy OAuth queue, which refuses to
// treat a fetched link as success. These former coverage points are kept as
// server-side assertions in tests/integrations.test.js.
