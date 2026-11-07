import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL) for (const ext of ['.tsx', '.ts']) {
      const url = new URL(specifier + ext, context.parentURL);
      if (existsSync(url)) return next(url.href, context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (/\.tsx?$/.test(url)) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText };
    return next(url, context);
  },
});
const model = await import('../src/account-columns-model.ts');

test('view defaults keep fixed columns and distinguish task and trash columns', () => {
  assert.deepEqual(model.defaultColumns('accounts'), ['identity', 'group', 'tags', 'totp', 'status', 'createdAt', 'actions']);
  assert.ok(model.defaultColumns('workbuddy').includes('task'));
  assert.ok(model.defaultColumns('occupied').includes('task'));
  assert.ok(model.defaultColumns('pat').includes('patExpiresAt'));
  assert.ok(model.defaultColumns('pat').includes('task'));
  assert.ok(model.defaultColumns('trash').includes('deletedAt'));
  assert.ok(!model.defaultColumns('trash').includes('task'));
  assert.ok(!model.availableColumns('accounts').some(column => column.id === 'deletedAt'));
  let columns = model.defaultColumns('pat');
  for (const id of columns) columns = model.toggleColumn('pat', columns, id);
  assert.deepEqual(columns, ['identity', 'actions']);
});

test('preferences survive reload per view and persist only version and column IDs', () => {
  const entries = new Map();
  const storage = { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
  model.saveColumns('accounts', ['identity', 'notes', 'actions'], storage);
  model.saveColumns('pat', ['identity', 'actions'], storage);
  assert.deepEqual(model.loadColumns('accounts', storage), ['identity', 'notes', 'actions']);
  assert.deepEqual(model.loadColumns('pat', storage), ['identity', 'actions']);
  assert.deepEqual(model.loadColumns('workbuddy', storage), model.defaultColumns('workbuddy'));
  assert.deepEqual(JSON.parse(entries.get(model.columnStorageKey('accounts'))), { version: 1, visible: ['identity', 'notes', 'actions'] });
  model.saveColumns('accounts', model.defaultColumns('accounts'), storage);
  assert.deepEqual(model.loadColumns('accounts', storage), model.defaultColumns('accounts'));
  assert.deepEqual(model.loadColumns('pat', storage), ['identity', 'actions']);
});

test('corrupted, outdated and inaccessible storage cannot prevent list loading', () => {
  for (const value of ['{', 'null', '[]', '{"version":0,"visible":[]}', '{"version":1,"visible":"notes"}', '{"version":1,"visible":["secret"]}', '{"version":1,"visible":[7]}', '{"version":1,"visible":["deletedAt"]}']) {
    assert.deepEqual(model.loadColumns('accounts', { getItem: () => value }), model.defaultColumns('accounts'), value);
  }
  const denied = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } };
  assert.deepEqual(model.loadColumns('pat', denied), model.defaultColumns('pat'));
  assert.doesNotThrow(() => model.saveColumns('pat', ['identity', 'actions'], denied));
  assert.deepEqual(model.loadColumns('accounts', { getItem: () => '{"version":1,"visible":[]}' }), ['identity', 'actions']);
});

test('timestamp sorting is stable, non-mutating and always places invalid dates last', () => {
  const rows = [
    { id: 'z', username: 'zebra', createdAt: null, checkedAt: 'bad' },
    { id: 'b', username: 'beta', createdAt: '2026-10-18T00:00:00Z', checkedAt: '2026-10-18T00:00:00Z' },
    { id: 'a', username: 'alpha', createdAt: '2026-10-18T00:00:00Z', checkedAt: '2026-10-18T00:00:00Z' },
    { id: 'c', username: 'charlie', createdAt: '2026-10-19T00:00:00Z', checkedAt: '2026-10-19T00:00:00Z' },
    { id: 'y', username: 'yankee', createdAt: 'bad', checkedAt: null },
  ];
  for (const mode of ['newest', 'checked-newest']) assert.deepEqual(model.sortAccounts(rows, mode).map(row => row.id), ['c', 'a', 'b', 'y', 'z']);
  for (const mode of ['oldest', 'checked-oldest']) assert.deepEqual(model.sortAccounts(rows, mode).map(row => row.id), ['a', 'b', 'c', 'y', 'z']);
  assert.deepEqual(model.sortAccounts(rows, 'username').map(row => row.id), ['a', 'b', 'c', 'y', 'z']);
  assert.deepEqual(rows.map(row => row.id), ['z', 'b', 'a', 'c', 'y']);
});

test('all displayed timestamps consistently use Beijing time and safe empty text', () => {
  assert.equal(model.accountTime('2026-10-19T23:05:08Z'), '2026-10-20 07:05');
  assert.equal(model.fullAccountTime('2026-10-19T23:05:08Z'), '2026-10-20 07:05:08');
  for (const input of [null, undefined, '', 'not-a-date']) assert.equal(model.accountTime(input), '—');
});

test('column settings expose labelled native controls, sections and fixed-column explanation', async () => {
  const { ColumnSettings } = await import('../src/AccountColumns.tsx');
  const html = renderToStaticMarkup(createElement(ColumnSettings, { view: 'accounts', visible: ['identity', 'actions'], onToggle() {}, onReset() {}, onClose() {} }));
  for (const label of ['显示列', '基本信息', '检测', '任务与时间', '恢复默认', '账号信息', '来源分组', '标签', 'TOTP', '检测状态', '勾选', '操作', '固定']) assert.ok(html.includes(label), label);
  assert.doesNotMatch(html, /移除时间/);
  assert.match(html, /type="checkbox"[^>]*disabled=""[^>]*checked=""/);
  assert.match(html, /<fieldset/);
  assert.match(html, /<legend/);
});
