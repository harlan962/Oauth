# PAT provisioning Implementation Plan
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkboxes.
**Goal:** Add dedicated PAT accounts, safe automatic replacement of invalid tokens, resumable quota-aware public checks, and clear account states.
**Architecture:** Separate encrypted PAT persistence, dedicated browser state machine, provisioning service, and existing checker. Share explicit metadata contracts; keep tokens backend-only.
**Tech Stack:** Node22+, Express5, SQLite, project Playwright Chromium, React19/TypeScript/Vite.
**Spec:** docs/superpowers/specs/2026-10-19-pat-provisioning-design.md

## Global Constraints
- Work only in E:\AAAAAAA中转\OAuth. This directory is not a Git repository; do not initialize one, commit, or change live data.
- No real account logins, PAT creation, external mutations, service restarts, or production data access during development.
- Use apply_patch for source edits. Preserve existing WorkBuddy agreement changes. Tests use temporary databases and synthetic browser pages.
- Default maintain 1 valid PAT; configurable target 1–3, expiry 30 days, public-resource read-only, no extra account/repository permissions.
- Cooling PATs still count as valid: quota exhaustion never triggers account replenishment or rotating around limits.
- Separate permanent PAT purpose from temporary browser lock; all generic and WorkBuddy selection paths exclude dedicated accounts.
- Encrypt tokens with existing Store key. Never expose tokens/passwords/TOTP/Cookies in API responses, logs or test artifacts.
- Individual task implementers never spawn agents. Follow TDD, report RED and GREEN evidence, and self-review. Controller provides task reviews.

### Task 1: PAT persistence and account isolation
**Files:** Create server/pat-store.js, tests/pat-store.test.js; modify server/store.js, server/workbuddy.js.
**Interfaces:**
- export class PatStore(store); set store.pats=this. Schema initialized by PatStore, but account purpose column exists from Store migration.
- accounts gains patDedicated INTEGER NOT NULL DEFAULT 0, included in public list/get. public account.pat is safe metadata from PatStore.summary(accountId), or null.
- settings(): {enabled:boolean,targetCount:number}; configure({enabled,targetCount,confirmed}): settings. Enable requires confirmed true; counts integer 1..3.
- list(): safe records {id,accountId,username,status,message,createdAt,expiresAt,remaining,limit,resetAt,retryAt,creationUncertain}; no ciphertext.
- reserve(): transactionally pick random eligible ordinary account (24h reachable, not selected/reserved/deleted/dedicated/mapped success), set patDedicated=1 and reservedBy='pat:'+id; insert preparing record; return safe record.
- update(id, patch): allowlisted internal metadata only. status values preparing,valid,cooling,invalid,manual,disabled,verifying.
- saveToken(id, token, expiresAt): encrypt first and set verifying; secret(id): backend-only decrypted token; complete(id): release owned temporary lock after caller closes browser.
- markInvalid(id,message), disable(id), releaseDedicated(id,{confirmed:true}): latter only when no potentially usable token or unknown outcome, not reserved; expired/confirmed-invalid tokens may be released, no implicit remote revocation.
- summary(accountId), usable(): stable valid/cooling/verifying nonexpired entries; expired entries become invalid. Return only metadata; secret separately.
- persistSettings and internal named JSON checkpoint getCheckpoint(name)/setCheckpoint(name,value) for checker/service, no tokens in JSON.
**Steps:**
- [ ] Write temp Store tests that import module optionally then assert constructor exists; RED for absent implementation. Example:
```js
const {PatStore}=await import('../server/pat-store.js').catch(()=>({}));
assert.equal(typeof PatStore,'function');
const pats=new PatStore(store);
pats.configure({enabled:true,targetCount:1,confirmed:true});
const item=pats.reserve();
assert.equal(store.get(item.accountId).patDedicated,1);
assert.throws(()=>store.select(item.accountId),/PAT/);
```
- [ ] Implement migrations and transactions; all Store.select automatic/explicit and WorkBuddy candidate/preview/start paths exclude dedicated accounts, including before PatStore is constructed. Prevent rename/secret edits and trash of dedicated accounts until safely released, but allow notes changes.
```js
if (row.patDedicated) throw new AppError('PAT 专用账号不可选用，请先处理专用用途',409);
// Automatic queries add: AND patDedicated=0
```
- [ ] Tests cover encrypted persistence, token redaction, config validation, expiry/cooling counts, duplicate reservation, release safety, eligibility exclusion across generic/WorkBuddy; use actual Store and temporary SQLite.
- [ ] Run node --test tests/pat-store.test.js then node --test --test-reporter=spec tests/*.test.js. Record result and changed files in task report; no git commits.

### Task 2: Isolated PAT browser and replenishment service
**Files:** Create server/pat-browser.js, server/pat-service.js, tests/pat-browser.test.js, tests/pat-service.test.js. Modify server/app.js, server/index.js for service wiring/routes/shutdown; narrow server/workbuddy.js and server/integrations.js start guards enforce bidirectional interactive-job exclusion.
**Consumes:** Task 1 PatStore interface.
**Produces:**
- PatBrowser.assertAvailable(); open({account,getSecrets,name,onSubmitted,onToken}): session with step(): {status:'captured'|'manual'|'failed',reason?}, close(): Promise. onSubmitted persists uncertainty BEFORE submit; onToken(token,expiresAt) persists encrypted token immediately. No token returned via public results.
- PatService(store,{patBrowser?,patFetcher?}={}): .pats (PatStore), status(): {settings,records,running,activeId,message}; configure(body), start(), resume(), stop(), ensure(signal), credential(signal), reportResponse(id,response), disable(id), release(id,body).
- credential returns internal {id,token} OR {waitUntil,message} OR throws AppError for manual/disabled/no candidate. Must not expose token over HTTP. ensure fills target up to 3 distinct candidates per run, stops on human/security challenge, expiry/confirmed invalidity triggers new candidate; network/403/quota never replenish.
- GET /api/pat, PUT /api/pat/config, POST /api/pat/start, /resume, /stop, /:id/disable, /:id/release. Safe response only; local guards inherited.
**Steps:**
- [ ] RED tests for isolated Chromium, official GitHub-only credential form, fresh TOTP, email/manual challenge, expected identity and exact minimal permissions, wrong owner/permissions -> no submit, creation once, immediate persistence, stop/navigation -> no stale actions.
```js
await session.step(); await session.step();
assert.equal(submissions,1);
assert.equal(captured.length,1);
assert.equal(persistedBeforeSubmit,true);
```
- [ ] Implement separate state machine. Start official fine-grained new-token URL with documented prefill parameters (name, description, expires_in=30), no private scope. Validate actual main document owner, public-only access, absence of account permissions and selected extra repository permissions, expiry, and same-document state before submission. Inspect public GitHub docs as needed; unknown live layouts must safely request manual help, not pretend supported.
- [ ] Service verifies captured token via https://api.github.com/user, redirect error, bounded timeout, username match; preserve verifying on network error; 401 invalid; 403/429 cooldown when supported by headers, otherwise manual. Persistent submission marker prevents replay after cancellation/restart.
```js
await browserSession.close();
pats.complete(record.id); // never release before real browser close
```
- [ ] Tests for default disabled, config enable confirmation, bounded attempts, synchronous single-flight guards, unknown-result no recreate, restart no login, cancellation while opening/capturing/closing, retained dedicated role, public API redaction and no secrets in error strings.
- [ ] Wire createApp (return pats service as pat), index shutdown awaiting pat.stop(), preserving current WorkBuddy behavior. Service blocks concurrent interactive WorkBuddy/legacy authorization and vice versa using their running state, not just account locks.
- [ ] Run focused tests and full suite; write report with browser DOM limitations.

### Task 3: Authenticated checks, quota waits, durable progress
**Files:** Modify server/checker.js, server/app.js; add tests/pat-checker.test.js; update affected checker tests.
**Consumes:** PatService credential(signal), reportResponse(id,response), stop(); PatStore checkpoints.
**Produces:** createChecker(store,fetcher,delayMs,options={pat:null,clock:Date.now,wait:abortableWait}); preserve existing first three arguments. status retains Job fields plus phase (idle/checking/waiting/pat/manual/interrupted), retryAt ISO|null, canResume boolean; resume() resumes persisted queue.
**Steps:**
- [ ] RED tests that auth is supplied only to official API, quota failure preserves prior account status and queue index, waits do not request/replenish, cancellation immediate, 401 causes bounded replenish, generic403/network errors no replenish.
```js
assert.equal(store.get(id).publicStatus,'reachable');
assert.equal(checker.status().done,0);
assert.equal(checker.status().phase,'waiting');
checker.cancel();
await finished(checker);
```
- [ ] Extend checkGithub(username,fetcher,signal,credential?) to return classified diagnostics plus quota metadata; no secret in return/error. Headers actual limit/remaining/reset/Retry-After, differentiate primary/secondary/forbidden/auth/network. Existing unauthenticated check API remains valid when PAT mode disabled.
- [ ] In PAT-enabled mode no silent anonymous fallback. Request PAT once, signal-aware waits, preserve current index during credential/quota problems. Impose bounded transient retry and escalation rather than infinite loops; 403 unknown requires manual diagnosis.
- [ ] Persist queue IDs+expected usernames, index, results/counts/retryAt before/after each operation; mark interrupted on startup, never auto run; POST /api/checks/resume explicit. Progress endpoints safe and backward-compatible. Expired/deleted/renamed rows skipped without overwrites.
- [ ] Anonymous rate limits with reset also wait, unknown reset reports blocked safely; no valid account result overwritten by auth/quota/network transport issues. Tests should assert behavior rather than obsolete exact stop text.
- [ ] Run focused/full tests, record timing injection and cancellation evidence in report.

### Task 4: Account categories and PAT configuration UI
**Files:** Modify src/types.ts, src/App.tsx, src/AccountDetail.tsx, src/CheckProgress.tsx, src/styles.css; create src/PatConfig.tsx, src/AccountCategories.tsx if extraction useful, tests/pat-ui.test.js (reuse actual TS transpile/SSR helper or browser).
**Consumes:** GET /api/pat shape from Task 2 and extended Job from Task 3; Account.patDedicated and Account.pat metadata.
**Steps:**
- [ ] Read frontend-design, ui-ux-pro-max, interaction-design, vercel-react-best-practices before implementation. Use existing tokens/fonts, no redesign; skill script fallback already documented.
- [ ] RED tests for six primary categories, PAT substate counts, eligible() excludes dedicated, attention not cooling, detail read-only and token-free, confirmation and waiting cancel/resume.
```js
assert.equal(eligible({...reachableAccount,patDedicated:1}),false);
assert.match(rendered,/PAT 专用/);
assert.doesNotMatch(rendered,/github_pat_/);
```
- [ ] Add main categories 全部账号/待选用/已选用/PAT 专用/处理中/需留意. PAT filter statuses preparing,valid,cooling,invalid,manual/verifying,disabled map to approved Chinese names. Derive counters and filters with shared functions, count nondeleted rows; preserve query/paging semantics.
- [ ] Add 检测配置 dialog with explicit enable confirmation (external PAT creation, public read-only,30 days,1..3 target); controls start/resume/stop/disable/release with confirmation for consequential changes. Never request or display token plaintext. Safe errors beside actions, focus/keyboard/escape use existing Modal/ConfirmDialog.
- [ ] Add PAT badge and quota/expiry safe details; don't mix publicStatus, PAT role, WorkBuddy outcome. Disabled configuration still displays safe stored status.
- [ ] Poll while PAT tasks/checks active, stop polling on unmount; avoid overlapping requests. Waiting shows Beijing reset time and cancellation/resume; no endless spinner for idle cooldown.
- [ ] Real synthetic local-browser UI checks desktop and375px, keyboard, reduced-motion, no horizontal overflow, confirm/cancel flows. No real database or external calls.
- [ ] Run node --test --test-reporter=spec tests/*.test.js and npm run build -- --outDir output/pat-build (production-mode staged build). Serve staged assets only in temporary QA server; do not overwrite live dist while old backend is still running. Task review then broad final review. No production restart; disclose prior policy block and provide manual activation if still blocked.


