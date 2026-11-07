import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '../server/browser-runtime.js';
import { PatSession } from '../server/pat-browser.js';

const date = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
const token = 'github_pat_SYNTHETIC_modern_fixture_123';
// Structure witnessed on GitHub's actual new fine-grained PAT page. All values
// are synthetic; the complete context is routed locally, including the preview.
const form = () => `<meta name="user-login" content="octo"><form method="post" action="/settings/personal-access-tokens">
<input type="hidden" name="authenticity_token" value="SYNTHETIC">
<input name="user_programmatic_access[name]" value="fixture">
<textarea name="user_programmatic_access[description]">Public reads</textarea>
<input type="hidden" name="target_name" value="octo"><button type="button" id="resource-owner-select-panel-button">octo</button>
<div hidden><input name="filter" value=""></div><input type="hidden" name="target_name" value="octo" id="resource-owner-hidden-field">
<input type="hidden" name="user_programmatic_access[default_expires_at]" value="custom">
<input type="date" name="user_programmatic_access[custom_expires_at]" value="${date}">
<fieldset><legend>Repository access</legend><input type="radio" name="install_target" id="install_target_none" value="none" aria-describedby="public-hint" checked><label for="install_target_none">Public repositories</label><p id="public-hint">Read-only access to public repositories.</p></fieldset>
<h2>Permissions</h2><h3>No account permissions added yet</h3>
<input type="hidden" name="integration[default_permissions][contents]" value="none">
<input type="hidden" name="integration[default_permissions][emails]" value="none">
<fgpat-confirmation-dialog data-confirmation-src="/settings/personal-access-tokens/confirmation">
<button type="button" data-action="click:fgpat-confirmation-dialog#requestConfirmation">Generate token</button>
<dialog id="fgpat-confirmation-dialog"><p>New personal access token</p><button type="submit">Generate token</button></dialog>
</fgpat-confirmation-dialog></form><script>
document.querySelector('[data-action]').onclick=async()=>{ const response=await fetch('/settings/personal-access-tokens/confirmation',{method:'POST',body:new FormData(document.querySelector('form'))});if(response.ok) document.querySelector('dialog').showModal(); };
</script>`;

async function fixture(t, { html = form(), onSubmitted, onProgress, beforePreviewResponse } = {}) {
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  const context = await browser.newContext();
  t.after(() => browser.close());
  const state = { preview: 0, created: 0, captured: 0, marked: false };
  await context.route('**/*', async route => {
    const r = route.request();
    if (r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/confirmation')) {
      assert.equal(state.marked, false, 'preview is read only'); state.preview++;
      await beforePreviewResponse?.();
      return route.fulfill({ body: '<p>Preview</p>' });
    }
    if (r.method() === 'POST') {
      assert.equal(state.marked, true, 'durable mark precedes generation'); state.created++;
      return route.fulfill({ contentType: 'text/html', body: `<input id="new-access-token" value="${token}">` });
    }
    return route.fulfill({ contentType: 'text/html', body: html });
  });
  const page = await context.newPage();
  const session = new PatSession(context, { account: { username: 'octo' }, name: 'fixture', getSecrets() { throw Error('unexpected credentials'); },
    onSubmitted: async () => { state.marked = true; await onSubmitted?.(page); },
    onToken: (value, expiry) => { assert.equal(value, token); assert.ok(Date.parse(expiry) <= Date.parse(date + 'T00:00:00Z')); state.captured++; }, onProgress });
  await session.ready;
  await page.goto('https://github.com/settings/personal-access-tokens/new');
  return { page, session, state };
}

test('actual GitHub form validates duplicate owner, custom expiry and zero permissions through preview then creates once', async t => {
  const phases = [];
  const f = await fixture(t, { onProgress: phase => phases.push(phase) });
  assert.equal((await f.session.step()).status, 'captured');
  assert.equal((await f.session.step()).status, 'captured');
  assert.deepEqual(f.state, { preview: 1, created: 1, captured: 1, marked: true });
  assert.deepEqual(phases, ['permissions', 'generating', 'capturing']);
});

for (const [name, mutate] of [
  ['owner mismatch in duplicate field', html => html.replace('value="octo" id=', 'value="other" id=')],
  ['hidden permission grant', html => html.replace('name="integration[default_permissions][contents]" value="none"', 'name="integration[default_permissions][contents]" value="write"')],
  ['no expiry', html => html.replace('value="custom"', 'value="none"')],
  ['unknown submitted control', html => html.replace('</form>', '<input name="extra_grant" value="true"></form>')],
  ['unverified public read access', html => html.replace('Read-only access to public repositories.', 'Private access')],
]) test(`actual GitHub form rejects ${name} before preview or creation`, async t => {
  const f = await fixture(t, { html: mutate(form()) });
  assert.equal((await f.session.step()).status, 'manual');
  assert.deepEqual(f.state, { preview: 0, created: 0, captured: 0, marked: false });
});

test('replacement document during durable marker cannot use prior validation', async t => {
  const f = await fixture(t, { onSubmitted: page => page.reload() });
  assert.equal((await f.session.step()).reason, 'document_changed');
  assert.equal(f.state.created, 0);
});

test('submit-time field mutation is rejected against validated actual form data', async t => {
  const f = await fixture(t);
  await f.page.evaluate(() => document.querySelector('form').addEventListener('submit', event => {
    const input = document.createElement('input'); input.name = 'integration[default_permissions][contents]'; input.value = 'write'; event.target.append(input);
  }));
  assert.equal((await f.session.step()).status, 'manual');
  assert.equal(f.state.created, 0);
});

test('resume reuses only the completed validated confirmation in the same document', async t => {
  let pause = true;
  const f = await fixture(t, { onProgress: phase => {
    if (phase === 'generating' && pause) { pause = false; throw new Error('synthetic pause'); }
  } });
  assert.equal((await f.session.step()).status, 'manual');
  assert.equal(f.state.preview, 1);
  assert.equal(f.state.marked, false);
  assert.equal((await f.session.step()).status, 'captured');
  assert.equal(f.state.preview, 1);
  assert.equal(f.state.created, 1);
});

test('visible confirmation spinner cannot trigger creation before the preview response completes', async t => {
  let complete = false;
  const html = form().replace("const response=await fetch", "document.querySelector('dialog').showModal(); const response=await fetch").replace("if(response.ok) document.querySelector('dialog').showModal();", '');
  const f = await fixture(t, { html, beforePreviewResponse: async () => { await new Promise(resolve => setTimeout(resolve, 400)); complete = true; },
    onSubmitted: () => assert.equal(complete, true, 'preview must finish before generation') });
  assert.equal((await f.session.step()).status, 'captured');
  assert.equal(f.state.created, 1);
});
