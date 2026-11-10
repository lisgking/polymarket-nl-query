/**
 * 离线单测：node --test tests/  （或 node tests/nlq.test.mjs）
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  build, checkParams, parseAmount, resolveTime, urlencode, summarize,
  PARAM_SPEC, SLOT_KEYS, MANAGED, KNOWN_TAG_IDS, DEFAULT_TZ,
} from '../bin/nlq.mjs';

const NOW = new Date('2026-11-10T12:00:00Z');
const TZ = DEFAULT_TZ;

const b = (intent, tz = TZ) => build(intent, NOW, tz);
const paramsOf = (intent, tz = TZ) => {
  const res = b(intent, tz);
  assert.deepEqual(res.errors, [], JSON.stringify(res.errors));
  return res.params;
};
const c = (raw, tz = TZ) => checkParams(raw, NOW, tz);

test('amount: plain numbers', () => {
  assert.equal(parseAmount(250000), 250000);
  assert.equal(parseAmount('250000'), 250000);
});

test('amount: chinese units', () => {
  assert.equal(parseAmount('100万'), 1_000_000);
  assert.equal(parseAmount('1.5万'), 15_000);
  assert.equal(parseAmount('2亿'), 200_000_000);
  assert.equal(parseAmount('100万美元'), 1_000_000);
  assert.equal(parseAmount('50萬'), 500_000);
});

test('amount: short units', () => {
  assert.equal(parseAmount('$1.5M'), 1_500_000);
  assert.equal(parseAmount('10w'), 100_000);
  assert.equal(parseAmount('5K'), 5_000);
  assert.equal(parseAmount('2b'), 2_000_000_000);
});

test('amount: invalid', () => {
  for (const bad of ['很多', '', '1M2', true]) {
    assert.throws(() => parseAmount(bad));
  }
});

test('time: relative', () => {
  const r = (e) => resolveTime(e, NOW, TZ);
  assert.equal(r('rel:-7d'), '2026-11-03T12:00:00Z');
  assert.equal(r('rel:+3h'), '2026-11-10T15:00:00Z');
  assert.equal(r('rel:-2mo'), '2026-09-11T12:00:00Z');
  assert.equal(r('rel:+1y'), '2027-11-10T12:00:00Z');
  assert.equal(r('rel:-30min'), '2026-11-10T11:30:00Z');
});

test('time: tokens use local tz', () => {
  const r = (e) => resolveTime(e, NOW, TZ);
  assert.equal(r('today_start'), '2026-11-09T16:00:00Z');
  assert.equal(r('today_end'), '2026-11-10T15:59:59Z');
  assert.equal(r('tomorrow_start'), '2026-11-10T16:00:00Z');
  assert.equal(r('week_start'), '2026-11-08T16:00:00Z');
  assert.equal(r('week_end'), '2026-11-15T15:59:59Z');
  assert.equal(r('month_start'), '2026-10-31T16:00:00Z');
  assert.equal(r('month_end'), '2026-11-30T15:59:59Z');
  assert.equal(r('year_end'), '2026-12-31T15:59:59Z');
});

test('time: iso passthrough', () => {
  const r = (e) => resolveTime(e, NOW, TZ);
  assert.equal(r('2026-11-01'), '2026-10-31T16:00:00Z');
  assert.equal(r('2026-11-01T00:00:00Z'), '2026-11-01T00:00:00Z');
  assert.equal(r('2026-11-01T08:00:00+08:00'), '2026-11-01T00:00:00Z');
});

test('time: tz matters', () => {
  assert.equal(resolveTime('today_start', NOW, 'UTC'), '2026-11-10T00:00:00Z');
});

test('time: bad expressions', () => {
  assert.throws(() => resolveTime('下周三', NOW, TZ));
  assert.throws(() => resolveTime('rel:7x', NOW, TZ));
});

test('build: keyword and state', () => {
  const p = paramsOf({ keyword: 'OpenAI', closed: false });
  assert.equal(p.title_search, 'OpenAI');
  assert.equal(p.closed, false);
});

test('build: closed any', () => {
  assert.equal(paramsOf({ closed: 'any' }).closed, 'any');
});

test('build: single known tag resolves to id', () => {
  assert.deepEqual(paramsOf({ tags: ['politics'] }).tag_id, [2]);
});

test('build: single unknown tag uses tag_slug', () => {
  assert.equal(paramsOf({ tags: ['sports'] }).tag_slug, 'sports');
});

test('build: multiple known tags', () => {
  assert.deepEqual([...paramsOf({ tags: ['politics', 'elections'] }).tag_id].sort((a, b) => a - b), [2, 144]);
});

test('build: multiple unknown tags error', () => {
  const res = b({ tags: ['sports', 'crypto'] });
  assert.equal(res.ok, false);
  assert.match(res.errors[0], /没有已知 id/);
});

test('build: exclude tags', () => {
  const p = paramsOf({ tags: ['politics'], exclude_tags: ['elections'] });
  assert.deepEqual(p.tag_id, [2]);
  assert.deepEqual(p.exclude_tag_id, [144]);
});

test('build: volume range', () => {
  const p = paramsOf({ volume: { min: '10万', max: '100万' } });
  assert.equal(p.volume_min, 100_000);
  assert.equal(p.volume_max, 1_000_000);
});

test('build: volume bad key', () => {
  assert.throws(() => b({ volume: { gte: 100 } }));
});

test('build: order object', () => {
  const p = paramsOf({ order: { field: 'endDate', direction: 'desc' } });
  assert.equal(p.order, 'endDate');
  assert.equal(p.ascending, false);
});

test('build: order shortcut', () => {
  const p = paramsOf({ order: 'volume', ascending: false });
  assert.equal(p.order, 'volume');
  assert.equal(p.ascending, false);
});

test('build: limit clamped with warning', () => {
  const res = b({ limit: 500 });
  assert.equal(res.params.limit, 100);
  assert.ok(res.warnings.some((w) => w.includes('截断')));
});

test('build: unknown slot rejected', () => {
  assert.throws(() => b({ query: '找体育盘' }));
});

test('build: raw param passthrough', () => {
  const p = paramsOf({ series_id: [12], include_children: true, parent_event_id: 3 });
  assert.deepEqual(p.series_id, [12]);
  assert.equal(p.include_children, true);
  assert.equal(p.parent_event_id, 3);
});

test('build: after_cursor', () => {
  assert.equal(paramsOf({ after_cursor: 'abcDEF_123' }).after_cursor, 'abcDEF_123');
});

test('build: url and summary', () => {
  const res = b({
    keyword: 'OpenAI', closed: false, volume: { min: '100万' },
    order: 'volume', ascending: false, limit: 20,
  });
  assert.ok(res.url.startsWith('https://gamma-api.polymarket.com/events/keyset?'));
  assert.ok(res.query.includes('title_search=OpenAI'));
  assert.ok(res.summary.includes('未结算'));
});

test('build: utf8 keyword encoded', () => {
  const res = b({ keyword: '特朗普' });
  assert.ok(res.url.includes('%E7%89%B9'));
  assert.ok(res.summary.includes('特朗普'));
});

test('check: offset rejected', () => {
  assert.throws(() => c({ offset: 0 }));
});

test('check: unknown param rejected', () => {
  assert.throws(() => c({ volume24hr_min: 1000 }));
});

test('check: tag overlap rejected', () => {
  assert.throws(() => c({ tag_id: [2], exclude_tag_id: [2] }));
});

test('check: closed bool coercion', () => {
  assert.equal(c({ closed: 'false' })[0].closed, false);
});

test('check: arrays repeat in query', () => {
  const res = b({ tag_ids: [2, 144], id: [1, 2] });
  assert.ok(res.query.includes('tag_id=2&tag_id=144'));
  assert.ok(res.query.includes('id=1&id=2'));
});

test('check: ascending without order warns', () => {
  const [, w] = c({ ascending: false });
  assert.ok(w.some((x) => x.includes('ascending')));
});

test('check: unknown order field warns', () => {
  const [, w] = c({ order: 'banana' });
  assert.ok(w.some((x) => x.includes('banana')));
});

test('check: inverted range warns', () => {
  const [, w] = c({ volume_min: 10, volume_max: 5 });
  assert.ok(w.some((x) => x.includes('volume_min')));
});

test('check: datetime normalized', () => {
  const [p] = c({ end_date_max: '2026-11-17T12:00:00+08:00' });
  assert.equal(p.end_date_max, '2026-11-17T04:00:00Z');
});

test('check: limit zero clamped', () => {
  const [p, w] = c({ limit: 0 });
  assert.equal(p.limit, 1);
  assert.ok(w.length > 0);
});

test('schema: every param has kind', () => {
  for (const [name, spec] of Object.entries(PARAM_SPEC)) assert.ok(spec.kind, name);
});

test('schema: slots cover managed', () => {
  for (const slot of MANAGED) assert.ok(SLOT_KEYS.has(slot), slot);
});

test('schema: known tag ids are numbers', () => {
  for (const [slug, id] of Object.entries(KNOWN_TAG_IDS)) {
    assert.equal(typeof id, 'number', slug);
    assert.ok(id > 0, slug);
  }
});

test('urlencode/summarize sanity', () => {
  const q = urlencode({ closed: false, tag_id: [2, 144], limit: 5 });
  assert.equal(q, 'closed=false&tag_id=2&tag_id=144&limit=5');
  assert.match(summarize({ limit: 5 }), /每页 5 条/);
});
