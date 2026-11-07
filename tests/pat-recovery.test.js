import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { PatBrowser } from '../server/pat-browser.js';
import { browserDirectory } from '../server/browser-runtime.js';

for (const [name, processes, expected] of [
  ['no browsers', [], true],
  ['user Chrome only', [{ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' }], true],
  ['old project browser revision', [{ executablePath: join(browserDirectory, 'chromium-old', 'chrome-win', 'chrome.exe') }], false],
  ['unreadable browser path', [{ executablePath: null }], false],
  ['invalid inventory', null, false],
]) test(`PAT recovery checks browser ownership: ${name}`, async () => {
  const browser = new PatBrowser({ inspectProcesses: async () => processes });
  assert.equal(await browser.confirmClosed(), expected);
});

test('PAT recovery fails closed when Windows process inspection fails', async () => {
  const browser = new PatBrowser({ inspectProcesses: async () => { throw new Error('access denied'); } });
  assert.equal(await browser.confirmClosed(), false);
});
