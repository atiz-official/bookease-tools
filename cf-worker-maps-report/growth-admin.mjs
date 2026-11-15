#!/usr/bin/env node
// BookEase Growth records — team tool (2026-11-16).
// Writes the work log and the list of tracked shops into the worker's KV with wrangler, so it needs a
// Cloudflare login (`npx wrangler login`) and no extra secret. Run from this folder.
//
//   node growth-admin.mjs track-shop <placeId> --name "ร้าน…" --cat salon --area thaphra [--buildings <id>,<id>] [--since 2026-11-16]
//   node growth-admin.mjs track-building <placeId> --name "Aqua Residences" --status sample|approved|live
//   node growth-admin.mjs log <placeId> --at 2026-11-15 --what "…" [--where "…"] [--minutes 5] [--evidence https://…]
//   node growth-admin.mjs show <placeId>
//   node growth-admin.mjs untrack <placeId>
//
// cat = salon | massage | barber | nail | clinic | tattoo (the radar's shop types)
// area = an id from areas-data.js (the landmark the "hub" rank is taken from), e.g. thaphra, asok
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CATS = ['salon', 'massage', 'barber', 'nail', 'clinic', 'tattoo'];
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function wrangler(args) {
  return execFileSync(npx, ['wrangler', ...args, '--binding', 'REPORTS', '--remote'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
}
function kvGet(key) {
  try {
    const out = wrangler(['kv', 'key', 'get', key]).trim();
    if (!out || /^value not found/i.test(out)) return null;
    const start = out.search(/[[{]/); // wrangler may print a banner line before the value
    if (start === -1) throw new Error(`unexpected wrangler output for ${key}: ${out.slice(0, 200)}`);
    return JSON.parse(out.slice(start));
  } catch (e) {
    const msg = String(e.stderr || e.message || e);
    if (/not found|404/i.test(msg)) return null;
    throw e;
  }
}
function kvPut(key, value) {
  const dir = mkdtempSync(join(tmpdir(), 'growth-'));
  const file = join(dir, 'v.json');
  try {
    writeFileSync(file, JSON.stringify(value), 'utf8');
    wrangler(['kv', 'key', 'put', key, '--path', file]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}
function placeId(v) {
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(v || '')) throw new Error(`not a Google place id: ${v}`);
  return v;
}
const today = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

function setIndex(id, kind, remove = false) {
  const index = (kvGet('g/index') || []).filter((x) => x.id !== id);
  if (!remove) index.push({ id, kind });
  kvPut('g/index', index);
  return index.length;
}

const [cmd, rawId, ...rest] = process.argv.slice(2);
const f = flags(rest);
try {
  if (cmd === 'track-shop') {
    const id = placeId(rawId);
    if (!f.name) throw new Error('--name is required');
    if (!CATS.includes(f.cat)) throw new Error(`--cat must be one of ${CATS.join(', ')}`);
    const old = kvGet(`g/shop/${id}`) || {};
    const cfg = { ...old, id, kind: 'shop', name: f.name, cat: f.cat, area: f.area || old.area || '',
      since: f.since || old.since || today(), buildings: f.buildings ? String(f.buildings).split(',').map(placeId) : (old.buildings || []), active: true };
    kvPut(`g/shop/${id}`, cfg);
    console.log('tracked shop', cfg, '· index size', setIndex(id, 'shop'));
  } else if (cmd === 'track-building') {
    const id = placeId(rawId);
    if (!f.name) throw new Error('--name is required');
    const status = f.status || 'sample';
    if (!['survey', 'sample', 'approved', 'live'].includes(status)) throw new Error('--status must be survey|sample|approved|live');
    const old = kvGet(`g/shop/${id}`) || {};
    const cfg = { ...old, id, kind: 'building', name: f.name, status, since: old.since || today(), liveSince: status === 'live' ? (old.liveSince || today()) : null };
    kvPut(`g/shop/${id}`, cfg);
    console.log('tracked building', cfg, '· index size', setIndex(id, 'building'));
  } else if (cmd === 'log') {
    const id = placeId(rawId);
    if (!f.what) throw new Error('--what is required');
    if (!kvGet(`g/shop/${id}`)) throw new Error('track the shop first');
    const at = f.at || today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(at)) throw new Error('--at must be YYYY-MM-DD');
    if (f.evidence && !/^https:\/\//.test(f.evidence)) throw new Error('--evidence must be an https link');
    const log = kvGet(`g/log/${id}`) || [];
    log.push({ at, what: f.what, where: f.where || '', minutes: f.minutes ? Number(f.minutes) : null, evidence: f.evidence || '' });
    log.sort((a, b) => a.at.localeCompare(b.at));
    kvPut(`g/log/${id}`, log);
    console.log(`logged (${log.length} entries)`, log[log.length - 1]);
  } else if (cmd === 'show') {
    const id = placeId(rawId);
    for (const k of ['shop', 'log', 'hist', 'counts']) console.log(`── g/${k}/${id}\n`, JSON.stringify(kvGet(`g/${k}/${id}`), null, 1));
  } else if (cmd === 'untrack') {
    const id = placeId(rawId);
    console.log('index size', setIndex(id, '', true), '(records kept; re-track to resume)');
  } else {
    console.log('commands: track-shop | track-building | log | show | untrack  (see the top of this file)');
    process.exitCode = 1;
  }
} catch (e) {
  console.error('[growth-admin]', e.stderr ? String(e.stderr).slice(0, 600) : e.message);
  process.exitCode = 1;
}
