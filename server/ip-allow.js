import { isIPv4, isIPv6 } from 'node:net';
import { AppError } from './store.js';

// An address allowlist for the workbench itself, independent of the reverse
// proxy. A proxy rule is invisible to this process: it cannot tell the operator
// that someone knocked, and one misconfigured upstream prefix (`proxy_pass` with
// the wrong Host, a CDN in front) silently removes the whole control. Enforcing
// here means the rule travels with the data, and every rejection is recorded.
//
// Loopback is never blocked. Every break-glass path available to the operator —
// `npm run admin:unlock`, a local browser, the setup code file — arrives from
// 127.0.0.1. An allowlist that can lock out the machine that runs the service
// would convert a typo into an unrecoverable installation.

const maxEntries = 100;
const blockedLogWindowMs = 60000;
const blockedLogCeiling = 60;

function ipv4Value(text) {
  if (!isIPv4(text)) return null;
  return text.split('.').reduce((value, part) => (value << 8n) + BigInt(Number(part)), 0n);
}

function ipv6Value(text) {
  if (!isIPv6(text)) return null;
  let value = text;
  // An embedded dotted quad (`::ffff:192.0.2.1`) is two 16-bit groups, not one.
  if (value.includes('.')) {
    const cut = value.lastIndexOf(':');
    const quad = ipv4Value(value.slice(cut + 1));
    if (quad === null) return null;
    value = `${value.slice(0, cut + 1)}${(quad >> 16n).toString(16)}:${(quad & 0xffffn).toString(16)}`;
  }
  const compressed = value.includes('::');
  const [head, tail = ''] = compressed ? value.split('::') : [value, ''];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const fill = Array(Math.max(0, 8 - left.length - right.length)).fill('0');
  const groups = [...left, ...(compressed ? fill : []), ...right];
  if (groups.length !== 8) return null;
  return groups.reduce((acc, part) => {
    const parsed = /^[0-9a-f]{1,4}$/i.test(part) ? parseInt(part, 16) : NaN;
    return Number.isNaN(parsed) ? null : acc === null ? null : (acc << 16n) + BigInt(parsed);
  }, 0n);
}

/** `{version, value}` for an address, or null. IPv4-mapped IPv6 collapses to v4. */
export function addressValue(address) {
  const text = String(address || '').trim();
  if (!text) return null;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(text);
  if (mapped) {
    const value = ipv4Value(mapped[1]);
    return value === null ? null : { version: 4, value };
  }
  if (isIPv4(text)) return { version: 4, value: ipv4Value(text) };
  if (isIPv6(text)) {
    const value = ipv6Value(text);
    return value === null ? null : { version: 6, value };
  }
  return null;
}

function renderIPv6(value) {
  const groups = [];
  for (let shift = 112n; shift >= 0n; shift -= 16n) groups.push(Number((value >> shift) & 0xffffn));
  // Compress the longest zero run, the way every other tool prints an address.
  let start = -1;
  let length = 0;
  for (let index = 0; index < groups.length; index++) {
    if (groups[index] !== 0) continue;
    let end = index;
    while (end < groups.length && groups[end] === 0) end++;
    if (end - index > length) {
      start = index;
      length = end - index;
    }
    index = end - 1;
  }
  const hex = groups.map((group) => group.toString(16));
  if (length < 2) return hex.join(':');
  return `${hex.slice(0, start).join(':')}::${hex.slice(start + length).join(':')}`;
}

function renderAddress(version, value) {
  if (version === 4)
    return [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 0xffn)).join('.');
  return renderIPv6(value);
}

/**
 * Parse `1.2.3.4`, `10.0.0.0/8`, `::1` or `2001:db8::/32`.
 * A prefix of 0 is refused: it matches everything, which is what "disabled" is for.
 */
export function parseEntry(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new AppError('白名单地址不能为空');
  if (raw.length > 64) throw new AppError('白名单地址过长');
  const slash = raw.indexOf('/');
  const address = addressValue(slash === -1 ? raw : raw.slice(0, slash));
  if (!address) throw new AppError(`无法识别的地址：${raw}`);
  const bits = address.version === 4 ? 32 : 128;
  const prefix = slash === -1 ? bits : Number(raw.slice(slash + 1));
  if (!Number.isInteger(prefix) || prefix < 1 || prefix > bits)
    throw new AppError(`${raw} 的前缀长度无效（IPv${address.version} 为 1–${bits}）`);
  const text = prefix === bits ? renderAddress(address.version, address.value) : `${renderAddress(address.version, address.value)}/${prefix}`;
  return { text, version: address.version, value: address.value, prefix };
}

function matches(entry, address) {
  if (!address || entry.version !== address.version) return false;
  const shift = BigInt(entry.version === 4 ? 32 : 128) - BigInt(entry.prefix);
  return entry.value >> shift === address.value >> shift;
}

const loopbackEntries = [parseEntry('127.0.0.0/8'), parseEntry('::1')];

function parseList(input) {
  const items = Array.isArray(input)
    ? input
    : String(input || '').split(/[\s,;]+/).filter(Boolean);
  const seen = new Set();
  const entries = [];
  for (const item of items) {
    const entry = parseEntry(item);
    if (seen.has(entry.text)) continue;
    seen.add(entry.text);
    entries.push(entry);
  }
  if (entries.length > maxEntries) throw new AppError(`白名单最多 ${maxEntries} 条`);
  return entries;
}

export class IpAllow {
  constructor(store, { env = '', clock = Date.now } = {}) {
    this.store = store;
    this.db = store.db;
    this.clock = clock;
    this.fromEnv = false;
    this.blockedSeen = new Map();
    this.blockedWindow = -1;
    this.blockedCount = 0;
    this.db.exec(`CREATE TABLE IF NOT EXISTS admin_ip_allow (
      id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0,
      entries TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT 'ui',
      updatedAt INTEGER NOT NULL DEFAULT 0
    );`);
    const existing = this.db.prepare('SELECT * FROM admin_ip_allow WHERE id=1').get();
    if (!existing) {
      // The environment seeds the first run only. Afterwards the page owns the
      // list: an operator who deletes a stale entry must not watch it come back
      // on the next restart.
      const seeded = parseList(env);
      this.db.prepare('INSERT INTO admin_ip_allow(id,enabled,entries,source,updatedAt) VALUES(1,?,?,?,?)')
        .run(seeded.length ? 1 : 0, JSON.stringify(seeded.map((item) => item.text)), seeded.length ? 'env' : 'ui', this.clock());
    }
    this.fromEnv = this.#row().source === 'env';
  }
  #row() {
    return this.db.prepare('SELECT * FROM admin_ip_allow WHERE id=1').get();
  }
  #entries(row = this.#row()) {
    try {
      const list = JSON.parse(row.entries);
      return Array.isArray(list) ? list.map(parseEntry) : [];
    } catch {
      // A corrupt row must not silently open the door: fail closed by treating
      // it as an empty list, which `permits` reads as "nothing is allowed".
      return [];
    }
  }
  state() {
    const row = this.#row();
    return {
      enabled: !!row.enabled,
      entries: this.#entries(row).map((item) => item.text),
      source: row.source,
      updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
      alwaysAllowed: loopbackEntries.map((item) => item.text),
    };
  }
  save(body, req = null, onEvent = null) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('请求格式无效');
    if (typeof body.enabled !== 'boolean') throw new AppError('请指定是否启用白名单');
    const entries = parseList(body.entries ?? []);
    if (body.enabled && !entries.length) throw new AppError('启用白名单前至少填写一个地址');
    const previous = this.state();
    this.db.prepare('UPDATE admin_ip_allow SET enabled=?,entries=?,source=?,updatedAt=? WHERE id=1')
      .run(body.enabled ? 1 : 0, JSON.stringify(entries.map((item) => item.text)), 'ui', this.clock());
    this.fromEnv = false;
    const added = entries.map((item) => item.text).filter((text) => !previous.entries.includes(text));
    const removed = previous.entries.filter((text) => !entries.map((item) => item.text).includes(text));
    const detail = [
      previous.enabled === body.enabled ? null : body.enabled ? 'enabled' : 'disabled',
      added.length ? `added=${added.join(',')}` : null,
      removed.length ? `removed=${removed.join(',')}` : null,
    ].filter(Boolean).join(' ');
    onEvent?.('ip_allow_changed', detail || 'unchanged', !body.enabled, { req, method: 'session' });
    return this.state();
  }
  /** The client address as this process sees it, after any trusted proxy hop. */
  clientAddress(req) {
    const raw = req?.ip || req?.socket?.remoteAddress || '';
    return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
  }
  permits(req) {
    const row = this.#row();
    if (!row.enabled) return true;
    const address = addressValue(this.clientAddress(req));
    if (!address) return false;
    if (loopbackEntries.some((entry) => matches(entry, address))) return true;
    const entries = this.#entries(row);
    // An enabled list with no usable entries is a misconfiguration. Denying is
    // the safe reading; the page still loads from loopback.
    return entries.some((entry) => matches(entry, address));
  }
  /** Record a rejection without turning a flood into unbounded audit writes. */
  recordBlocked(req, event) {
    const ip = this.clientAddress(req);
    const now = this.clock();
    const minute = Math.floor(now / 60000);
    if (this.blockedWindow !== minute) {
      this.blockedWindow = minute;
      this.blockedCount = 0;
    }
    // One row per source per minute, and a hard ceiling across all sources:
    // scanning a /16 would otherwise write a row per probe into the same table
    // the operator needs to read afterwards.
    if (this.blockedCount >= blockedLogCeiling) return;
    if (now - (this.blockedSeen.get(ip) || 0) < blockedLogWindowMs) return;
    this.blockedSeen.set(ip, now);
    if (this.blockedSeen.size > 500)
      for (const [key, at] of this.blockedSeen) if (now - at >= blockedLogWindowMs) this.blockedSeen.delete(key);
    this.blockedCount += 1;
    event?.('ip_rejected', ip || 'unknown', true, { req, method: 'none' });
  }
}
