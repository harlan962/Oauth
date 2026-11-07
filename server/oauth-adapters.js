// Upstream page contracts for the WorkBuddy Global GitHub OAuth flow.
//
// Everything the automation assumes about somebody else's HTML lives here: the
// WorkBuddy consent screen (a Keycloak page with private `sp-*` classes) and the
// few GitHub pages it walks through. When an upstream redesign breaks authorisation,
// this file is the only place that needs updating — no hunting through the
// 900-line browser driver.
//
// Failure mode to keep in mind: a changed selector does not raise an error. The
// driver reports `github_authorize_unrecognized` / `agreement` / `provider_missing`,
// and workbuddy.js trips its circuit breaker once the same structural reason repeats.
export const workbuddyGlobal = {
  // "Continue with GitHub" / "使用 GitHub 登录" style provider buttons and links.
  provider:
    /^(?:(?:continue|sign\s+in|log\s+in|sign\s+up|register)\s+with\s+|(?:使用|通过)\s*)?GitHub(?:\s*(?:登录|注册))?$/i,

  // Required agreements shown before the GitHub hand-off. Only these documents are
  // auto-accepted; anything unrecognised stops the flow instead of opting in blindly.
  agreementDocument:
    "(?:服务协议|数据处理(?:与)?安全协议|数据处理协议|隐私政策|可接受使用政策)",
  agreement: null, // filled below, needs agreementDocument to build the pattern

  // WorkBuddy consent screen (Keycloak): native inputs are hidden behind custom marks.
  policyLabel: ".policy-wrapper label.custom-checkbox",
  policyInput: 'input[type="checkbox"][data-policy-kind]',
  policyKinds: ["service", "privacy"],
  policyCheckmark: ".sp-color-checkmark-outline",
  policyWrapper: ".policy-wrapper",

  // Fallback consent control, used when the GitHub authorise form is not present.
  consentButton: /^(?:Authorize|授权)(?:\s+.{1,120})?$/i,

  github: {
    identityMeta: 'meta[name="user-login"]',
    loginField: "input#login_field",
    passwordField: "input#password",
    loginForm: 'form[action="/session"]',
    loginSubmit:
      'form[action="/session"] input[type="submit"], form[action="/session"] button[type="submit"]',
    twoFactorField: "input#app_totp",
    twoFactorForm: 'form[action="/sessions/two-factor"]',
    twoFactorSubmit: 'form[action="/sessions/two-factor"] button[type="submit"]',
    authorizeForm: 'form[action="/login/oauth/authorize"]',
    authorizeButton: 'form[action="/login/oauth/authorize"] button[name="authorize"]',
    trustedDeviceSkip: /^Ask me later$/i,
  },
};

workbuddyGlobal.agreement = new RegExp(
  `^(?:本人|我)(?:已阅读)?(?:并)?(?:同意|知悉)\\s*(?:WorkBuddy\\s*)?${workbuddyGlobal.agreementDocument}(?:\\s*[,，、和及与]\\s*${workbuddyGlobal.agreementDocument})*[。.]?$|^I (?:have read and )?(?:agree to|acknowledge) (?:the )?(?:WorkBuddy |Tencent Cloud CodeBuddy )?(?:Terms of Service|Service Agreement|Privacy Policy|Data Processing Agreement|Acceptable Use Policy)(?:(?:,\\s*| and )(?:the )?(?:Data Processing(?: and Security)? Agreement|Acceptable Use Policy|Privacy Policy))*[.]?$`,
  "i",
);

// Reasons that mean "the page is not what we expect" rather than "this account
// needs another try". Repeating one of these across accounts is the signal that the
// upstream UI changed, so the queue stops instead of grinding every account.
export const structuralReasons = new Set([
  "provider_missing",
  "provider_ambiguous",
  "agreement",
  "github_authorize_unrecognized",
  "github_identity_missing",
]);
