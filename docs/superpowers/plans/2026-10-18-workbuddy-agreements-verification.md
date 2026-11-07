# WorkBuddy required agreement automation

User explicitly approved automatically selecting the two required WorkBuddy agreement checkboxes before continuing with GitHub login.

## Behavior

- Recognize complete required agreement labels, not arbitrary checkboxes or a generic “agree” substring.
- Check each visible recognized agreement using an idempotent checkbox operation; leave prechecked agreements selected. Recheck the entire recognized group before clicking GitHub.
- Only act in the identified provider's trusted WorkBuddy page/frame. Revalidate document/navigation epochs, trusted ancestors, and cancellation before further actions.
- Retry transient checkbox failures within the existing provider wait loop; preserve a safe diagnostic if selection cannot be verified. Do not create another OAuth state or poll as part of agreement handling.
- Passwords/TOTP and OAuth identity/callback verification remain unchanged. No frontend changes, database migration, or automatic rerun of stopped jobs.

## Verification

- RED/GREEN: both unchecked, first prechecked, both prechecked, unrelated opt-ins ignored, cancellation and navigation during selection.
- Existing non-sticky-checkbox test continues to verify that the provider cannot be submitted without confirmed selection.
- Reviewer reproduced same-URL official iframe reload allowing stale actions. Added a regression through the actual browser request-handler setup: RED observed (two checks instead of one), then fixed with frame/ancestor navigation epochs.
- Full Node suite: 88 passed, zero failed. Existing experimental SQLite/MockTimers warnings remain.
- Project Chromium local-only fixtures: native button/link/custom provider, delayed rendering, official iframe, two native checkboxes, one prechecked, semantic custom checkboxes, and two agreements within an official iframe. Marketing opt-in remains unchecked.
- Focused re-review passed. Reviewer reran the same-URL iframe reproduction through production browser wiring: no second checkbox action or GitHub click after reload.

## Activation

Automatic restart was rejected by the execution environment before the command ran. The existing server remains on PID 36212; the new backend code is saved but has not been activated. No backup or stop from that rejected command occurred. Restart is still required; no live tasks were automatically rerun.

## Limits

Tests use synthetic DOM and no real credentials or remote OAuth calls. The user's live WorkBuddy checkbox markup and a full successful OAuth login have not been independently verified. Only recognized semantic checkboxes are automated; unknown layouts are not blindly clicked.

The earlier wait/release verification report describes the previous manual-agreement behavior; this change supersedes that agreement-specific behavior only.
