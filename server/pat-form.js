// Runs entirely in the bound main document. This adapter follows the observed
// GitHub fine-grained PAT form; every successful submitted field is checked.
export function githubPatForm(form, { username, name, expiryDate, action = 'inspect' }) {
  const visible = node => !!node && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
  const one = selector => { const nodes = form.querySelectorAll(selector); return nodes.length === 1 ? nodes[0] : null; };
  const identity = document.querySelectorAll('meta[name="user-login"]');
  if (identity.length !== 1 || identity[0].content.toLowerCase() !== username.toLowerCase()) return 'identity';
  if (form.ownerDocument !== document || !form.isConnected || !visible(form) || form.method !== 'post' || form.action !== 'https://github.com/settings/personal-access-tokens' || !['', '_self'].includes(form.target) || form.enctype !== 'application/x-www-form-urlencoded') return 'form';
  const owners = [...form.querySelectorAll('input[name="target_name"]')];
  const ownerButton = one('#resource-owner-select-panel-button');
  if (owners.length !== 2 || owners.some(node => node.type !== 'hidden' || node.disabled || node.value.toLowerCase() !== username.toLowerCase()) || !visible(ownerButton) || ownerButton.textContent.trim().toLowerCase() !== username.toLowerCase()) return 'owner';
  const expiry = one('input[name="user_programmatic_access[default_expires_at]"]');
  const custom = one('input[name="user_programmatic_access[custom_expires_at]"]');
  if (!expiry || expiry.disabled || expiry.type !== 'hidden' || expiry.value !== 'custom' || !visible(custom) || custom.disabled || custom.type !== 'date' || custom.value !== expiryDate) return 'expiry';
  const tokenName = one('input[name="user_programmatic_access[name]"]');
  if (!visible(tokenName) || tokenName.disabled || tokenName.value !== name) return 'name';
  const groups = [...form.querySelectorAll('fieldset')].filter(node => node.querySelector('legend')?.textContent.trim().toLowerCase() === 'repository access');
  if (groups.length !== 1 || !visible(groups[0])) return 'public_access';
  const selected = [...groups[0].querySelectorAll('input:checked')];
  const access = selected[0];
  const hints = (access?.getAttribute('aria-describedby') || '').split(/\s+/).map(id => document.getElementById(id)).filter(visible).map(node => node.textContent).join(' ');
  if (selected.length !== 1 || access.type !== 'radio' || access.name !== 'install_target' || access.id !== 'install_target_none' || access.value !== 'none' || !visible(access) || ![...access.labels].some(label => visible(label) && /^public repositories$/i.test(label.textContent.trim())) || !/read.only access to public repositories/i.test(hints)) return 'public_access';
  const summaries = [...form.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')].filter(node => visible(node) && node.textContent.trim() === 'No account permissions added yet');
  if (summaries.length !== 1) return 'permissions_unknown';
  // Take the snapshot before the page's click/submit listeners run. The network
  // guard compares duplicates and values against this exact validated multiset.
  const entries = [...new FormData(form)];
  const counts = new Map();
  let permissions = 0;
  const allowed = new Set(['authenticity_token', 'utf8', 'user_programmatic_access[name]', 'user_programmatic_access[description]', 'target_name', 'filter', 'user_programmatic_access[default_expires_at]', 'user_programmatic_access[custom_expires_at]', 'install_target']);
  for (const [key, value] of entries) {
    if (typeof value !== 'string') return 'permissions_unknown';
    counts.set(key, (counts.get(key) || 0) + 1);
    if (/^integration\[default_permissions\]\[[a-z_]+\]$/.test(key)) {
      permissions++;
      if (value !== 'none') return 'permissions_extra';
    } else if (!allowed.has(key)) return 'permissions_unknown';
    if (key === 'target_name' && value.toLowerCase() !== username.toLowerCase()) return 'owner';
    if (key === 'filter' && value !== '') return 'owner';
    if (key === 'install_target' && value !== 'none') return 'public_access';
    if (key === 'user_programmatic_access[custom_expires_at]' && value !== expiryDate) return 'expiry';
    if (key === 'user_programmatic_access[default_expires_at]' && value !== 'custom') return 'expiry';
    if (counts.get(key) > (key === 'target_name' ? 2 : 1)) return 'permissions_unknown';
  }
  if (!permissions || counts.get('target_name') !== 2 || counts.get('install_target') !== 1 || counts.get('user_programmatic_access[custom_expires_at]') !== 1) return 'permissions_unknown';
  const component = one('fgpat-confirmation-dialog');
  if (!component || component.getAttribute('data-confirmation-src') !== '/settings/personal-access-tokens/confirmation') return 'confirmation_unknown';
  const dialog = one('#fgpat-confirmation-dialog');
  const trigger = one('button[data-action="click:fgpat-confirmation-dialog#requestConfirmation"]');
  if (!dialog || !component.contains(dialog) || !trigger || !component.contains(trigger) || trigger.type !== 'button' || trigger.disabled || !/^generate token$/i.test(trigger.textContent.trim())) return 'confirmation_unknown';
  const buttons = [...form.querySelectorAll('button[type="submit"],input[type="submit"]')];
  if (buttons.length !== 1 || !dialog.contains(buttons[0])) return 'submit_unknown';
  const button = buttons[0];
  if (button.disabled || button.name || !/^generate token$/i.test((button.textContent || button.value).trim()) || (button.hasAttribute('formaction') && button.formAction !== form.action) || (button.hasAttribute('formmethod') && button.formMethod !== 'post') || (button.hasAttribute('formtarget') && !['', '_self'].includes(button.formTarget)) || (button.hasAttribute('formenctype') && button.formEnctype !== form.enctype)) return 'submit_unknown';
  if (action === 'preview') {
    if (!visible(trigger) || visible(dialog)) return 'confirmation_unknown';
    trigger.click();
  } else if (action === 'submit') {
    if (!visible(dialog) || !visible(button) || !(dialog.open || dialog.getAttribute('aria-modal') === 'true')) return 'confirmation_unknown';
    let started = false;
    const observe = event => { started = !event.defaultPrevented; };
    form.addEventListener('submit', observe);
    try { form.requestSubmit(button); } finally { form.removeEventListener('submit', observe); }
    if (!started) return 'submission_not_started';
  }
  return { entries, modern: true };
}

export async function requestMatchesForm(request, expected) {
  const type = request.headers()['content-type'] || '';
  let entries;
  if (type.startsWith('application/x-www-form-urlencoded')) entries = [...new URLSearchParams(request.postData() || '')];
  else if (type.startsWith('multipart/form-data;')) {
    const body = request.postDataBuffer();
    if (!body || body.length > 256 * 1024) return false;
    entries = [...await new Response(body, { headers: { 'content-type': type } }).formData()];
  } else return false;
  const normalize = values => JSON.stringify(values.map(([key, value]) => [key, value.replace(/\r?\n/g, '\r\n')]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  return entries.every(([, value]) => typeof value === 'string') && normalize(entries) === normalize(expected);
}
