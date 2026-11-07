# WorkBuddy login sequence repair

## Observed causes

- The official login page embeds its Keycloak login UI in a trusted WorkBuddy iframe. Both required policy inputs are native checkboxes styled `display:none`, inside visible `.policy-wrapper label.custom-checkbox` elements. The actionable square is `.sp-color-checkmark-outline`; `input.checked` is the authoritative state.
- The previous accessible-role search omitted those hidden inputs, treated zero matches as agreement readiness, and clicked GitHub. This triggered the agreement dialog in the user's screenshot.
- The current Chinese label uses `数据处理与安全协议`; the old expression did not cover it. The English page also uses `Service Agreement` and `Data Processing and Security Agreement`.
- Public unauthenticated redirect inspection confirmed GitHub's `/login` URL preserves the official OAuth authorization URL in `return_to`. The previous browser session could not recover this context when the original authorize navigation was missed.
- Fixed 700 ms waits and immediate manual results could interrupt slow page transitions and delayed GitHub form rendering.

## Changes

- Read each native policy state, click only an unchecked recognized policy's visible square, then recheck both before clicking GitHub. Prechecked policies stay checked. A visible but unrecognized policy section blocks provider submission.
- Keep the existing official-frame, document epoch, cancellation and policy-name checks. Do not automate unrelated opt-ins.
- Recover only an official GitHub authorization `return_to` with a matching outer client ID and a valid official WorkBuddy redirect/state. Existing identity and callback binding remains required before remote polling.
- Allow bounded waits for provider navigation, form readiness and submitted-form navigation without submitting the same form repeatedly in one step.
- Report specific pause causes in the existing service messages.

## Verification

- RED/GREEN browser regressions reproduced the unwanted agreement dialog with both or one hidden policy unchecked, then passed with correct action order.
- Real project Chromium, isolated context, synthetic credentials and routed HTML cover prechecked policies, English labels, slow navigation, delayed forms, authorization/callback, cancellation during a hidden-policy click, and unrecognized policy controls. Fixture navigations use HTML redirects so redirected network requests cannot escape Playwright routing.
- Unit cases cover valid `return_to`, lookalike GitHub origin, untrusted callback, client mismatch and missing state.
- Full suite: `npm test` — 256 passed. After the final unrecognized-policy guard was added, all 64 WorkBuddy browser/service tests passed again.
- `npm run build` passed. Existing Node experimental SQLite/MockTimers and npm configuration warnings remain.

## Activation and limits

- All local WorkBuddy, integration, PAT and checker queues were confirmed idle before restart.
- Data backup: `output/backups/workbuddy-flow-20261019` (two files, 268 KiB).
- Restarted the local server with the new implementation; frontend and WorkBuddy/PAT/checker API health checks returned HTTP 200.
- Public live page structure and unauthenticated redirects were inspected. No real account was enrolled or polled as part of this repair; successful real-account authorization and remote admission still require a live run.
