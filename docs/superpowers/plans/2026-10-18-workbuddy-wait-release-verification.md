# WorkBuddy readiness and automatic release verification

## Scope

- Wait up to 45 seconds for a visible GitHub provider in the current authorization session; do not create additional login/start requests.
- Include visible WorkBuddy child frames only when their complete ancestor chain is on trusted WorkBuddy HTTPS origins. Passwords and TOTP remain limited to the existing main-page GitHub checks.
- Distinguish unchecked named agreements, disabled providers, ambiguous providers, and absence. No automatic agreement acceptance.
- Remove the per-run account-list modal and its manual-release UI.
- After stopping/finishing, release all locally unsuccessful accounts, including unknown remote outcomes, per explicit user instruction. Preserve unknown/failure records. Never clear successful mappings or reselect mapped accounts.
- Reconcile reservations left on older finished jobs. Display latest WorkBuddy outcomes in account management/details.

## Verification

- RED observed before fixes: delayed 12-second provider, cancellation during loading, trusted iframe, agreements, automatic release/recovery, removed modal, outcome display.
- Additional RED/GREEN: concurrent close calls formerly returned before browser shutdown. Cache the close promise; queue regression verifies reservations/active state remain held until closure finishes.
- 82 automated tests pass; production TypeScript/Vite build passes.
- Real project Chromium, local-only HTML fixtures: native button/link/custom provider, hidden duplicate, delayed 6.5-second rendering, official iframe, unchecked agreement. All pass; no live credentials used.
- Synthetic UI on port 4324: stop confirmation, auto-release, successful exclusion, persisted unknown outcome, 1440px desktop / 375px mobile, no horizontal overflow. Screenshots under output/playwright/auto-release-*.png.
- Focused reviewer identified the concurrent-close race; repaired and re-review passed.

## Limits and operational record

The real official link redirected the isolated diagnostic browser to the public homepage. The user's live login DOM/iframe location and full OAuth success have not been independently verified. Do not describe local fixtures as an end-to-end authorization success.

Production restart: new PID 36212, HTTP 200, 42 accounts retained, previous unused reservation released. Full data backup (six files, SHA256 verified): output/backups/auto-release-08f6e51af3424f69adc4e74740c03def/data.

Operational error: the pre-restart check found active work, but separate subsequent tool calls still stopped the service. Backup inspection confirmed there were no running WorkBuddy or legacy integration jobs; the interrupted operation was an account-liveness check. Completed results were preserved; 16 accounts were unchecked at backup. User was informed and the initial mistaken statement that an OAuth task was interrupted was corrected. No checks or authorizations were automatically retried. Future restart gating must stop subsequent calls on any nonzero preflight result, and keep verification/stop within one guarded operation.

Older historical log and job-summary messages remain historical text; current reservation state and latest item outcomes reflect automatic release.
