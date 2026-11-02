import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { limit, pool } from '../src/core.mjs';
import { resolveConfig } from '../src/config.mjs';
import { parseName, parseSrt, transcriptWindows, windowText } from '../src/corpus.mjs';
import { parseScenes, planFrames } from '../src/frames.mjs';
import { client, isContentBlock } from '../src/decisions.mjs';
import { score } from '../src/classify.mjs';
import { loadScale } from '../src/scale.mjs';

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'safety-classification-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('pool limits concurrency and keeps failures', async () => {
  let active = 0, maximum = 0;
  const run = limit(2);
  const results = await pool([0, 1, 2, 3], 4, i => run(async () => {
    active++; maximum = Math.max(maximum, active); await new Promise(r => setTimeout(r, 5)); active--;
    if (i === 1) throw Error('x'); return i;
  }));
  assert.equal(maximum, 2); assert.equal(results[1].status, 'rejected'); assert.equal(results[3].value, 3);
});
test('config rejects unknown ranges and resolves the default scale', () => {
  const c = resolveConfig({ mediaDir: 'm', stateDir: 's' }, 'C:/base');
  assert.match(c.scale, /scales[\\/]silk-v1$/);
  assert.throws(() => resolveConfig({ frameWidth: 100 }, '.'), /frameWidth/);
});
test('library names parse into date, titles and ID', () => {
  assert.deepEqual(parseName('2024-02-01 - A Quiet Evening — 조용한 저녁 [AbC123xyz_]'),
    { id: 'AbC123xyz_', date: '2024-02-01', titleEn: 'A Quiet Evening', titleKo: '조용한 저녁' });
  const local = parseName('2024-05-01 - Local Only — 로컬 🫣');
  assert.match(local.id, /^local-[0-9a-f]{12}$/); assert.equal(local.titleKo, '로컬 🫣');
  assert.equal(parseName('random clip').titleEn, 'random clip');
});
test('transcript windows assign each cue once and fold a short tail', () => {
  const cues = parseSrt('1\n00:00:01,000 --> 00:00:02,000\nhello\n\n2\n00:04:59,900 --> 00:05:01,000\nedge\n\n3\n00:10:30,000 --> 00:10:31,000\ntail\n');
  const w = transcriptWindows(640, { en: cues }, 300);
  assert.deepEqual(w.map(x => [x.start, x.end]), [[0, 300], [300, 640]], '40 s tail joins the last window');
  assert.deepEqual(w.map(x => x.lines.en.length), [2, 1]);
  assert.match(windowText(w[1]), /^Spoken transcript, 05:00–10:40\.\n\nEnglish \(translation\):\n\[10:30\] tail$/);
  assert.equal(windowText({ start: 0, end: 1, lines: { en: [] } }), '');
});
test('scene parsing and frame planning', () => {
  const scenes = parseScenes('[x] frame:0 pts:1 pts_time:2.0\n[x] lavfi.scene_score=1.0\nframe= 2 fps\r[x] frame:1 pts:2 pts_time:70.07\n[x] lavfi.scene_score=0.54\n[x] frame:2 pts:3 pts_time:200.5\n[x] lavfi.scene_score=0.9\n');
  assert.deepEqual(scenes, [{ t: 2, score: 1 }, { t: 70.07, score: .54 }, { t: 200.5, score: .9 }]);
  const plan = planFrames(300, scenes, { frameIntervalSeconds: 60, maxSceneFrames: 1, sceneMinGapSeconds: 15 });
  assert.deepEqual(plan.filter(f => f.source === 'grid').map(f => f.t), [30, 90, 150, 210, 270]);
  // Strongest scene (t=2) is kept; the cap stops the 200.5 cut; 70.07 would fall within 15 s of 90 anyway.
  assert.deepEqual(plan.filter(f => f.source === 'scene').map(f => f.t), [2.5]);
  assert.equal(plan[0].start, 0); assert.equal(plan.at(-1).end, 300);
  for (let i = 1; i < plan.length; i++) assert.equal(plan[i].start, plan[i - 1].end);
  assert.equal(planFrames(20, [], { frameIntervalSeconds: 60, maxSceneFrames: 0, sceneMinGapSeconds: 15 })[0].t, 10, 'short clips still get a frame');
});
test('moderation-style refusals are recognised', () => {
  assert.equal(isContentBlock(403, { error: { message: 'Input was flagged by moderation', metadata: { reasons: ['sexual'] } } }), true);
  assert.equal(isContentBlock(403, { error: { message: 'Key disabled' } }), false);
  assert.equal(isContentBlock(500, { error: { message: 'moderation service down' } }), false);
});

function fakeResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), text: async () => JSON.stringify(body) };
}
test('client caches answers, records blocks, tracks BYOK cost and sends attribution', async t => {
  const stateDir = await temporary(t);
  process.env.OPENROUTER_API_KEY = 'test-key';
  const questions = { q: { type: 'noul', instructions: 'x' } };
  const sent = [];
  const replies = [
    fakeResponse(200, { id: 'gen-1', model: 'm', answers: { q: { type: 'noul', noul: .8 } }, usage: { input_tokens: 2000, output_tokens: 0, cost: 0 } }),
    fakeResponse(403, { error: { message: 'Your input was flagged', metadata: { reasons: ['sexual/minors'] } } })
  ];
  const api = client({ stateDir, model: 'm', maxAttempts: 2, maxRunCostUsd: 1, inputUsdPerMillion: .1, appName: 'App', appUrl: '' },
    () => {}, async (url, init) => { sent.push({ url, init }); return replies.shift(); });
  const first = await api.decide({ identity: { a: 1 }, questions, body: () => ({ state: 'hi' }), meta: { session_id: 's1' } });
  assert.equal(first.answers.q.noul, .8);
  const again = await api.decide({ identity: { a: 1 }, questions, body: () => { throw Error('must not rebuild'); } });
  assert.equal(again.cached, true);
  const blocked = await api.decide({ identity: { a: 2 }, questions, body: () => ({ state: 'bad' }) });
  assert.equal(blocked.blocked, true);
  assert.equal((await api.decide({ identity: { a: 2 }, questions, body: () => ({}) })).blocked, true, 'blocks are cached too');
  assert.equal(sent.length, 2);
  const body = JSON.parse(sent[0].init.body);
  assert.equal(body.session_id, 's1'); assert.equal(body.model, 'm'); assert.deepEqual(body.questions, questions);
  assert.equal(sent[0].init.headers['X-Title'], 'App');
  assert.match(sent[0].url, /\/api\/alpha\/decisions$/);
  assert.deepEqual(api.stats(), { requests: 2, cached: 2, blocked: 1, refusals: 0, inputTokens: 2000, costUsd: .0002 });
});
test('client drops refused questions, re-asks the rest and caches the refusal', async t => {
  const stateDir = await temporary(t);
  process.env.OPENROUTER_API_KEY = 'test-key';
  const questions = { a: { type: 'noul', instructions: 'x' }, b: { type: 'noul', instructions: 'y' } };
  const sent = [];
  const replies = [
    fakeResponse(502, { error: { message: 'OpenAI refused to answer question "a"', code: 502 } }),
    fakeResponse(200, { id: 'g', answers: { b: { type: 'noul', noul: .4 } }, usage: { input_tokens: 100 } })
  ];
  const api = client({ stateDir, model: 'm', maxAttempts: 1, maxRunCostUsd: 1, inputUsdPerMillion: .1, appName: 'A', appUrl: '' },
    () => {}, async (url, init) => { sent.push(JSON.parse(init.body)); return replies.shift(); });
  const r = await api.decide({ identity: { x: 1 }, questions, body: () => ({ state: 's' }) });
  assert.deepEqual(r.refused, ['a']); assert.equal(r.answers.b.noul, .4);
  assert.deepEqual(Object.keys(sent[1].questions), ['b'], 'the refused question is not re-sent');
  assert.deepEqual((await api.decide({ identity: { x: 1 }, questions, body: () => ({}) })).refused, ['a']);
  assert.equal(api.stats().refusals, 1);
  const all = client({ stateDir, model: 'm', maxAttempts: 1, maxRunCostUsd: 1, inputUsdPerMillion: .1, appName: 'A', appUrl: '' }, () => {},
    async (url, init) => fakeResponse(502, { error: { message: `OpenAI refused to answer question "${Object.keys(JSON.parse(init.body).questions)[0]}"` } }));
  const none = await all.decide({ identity: { x: 2 }, questions, body: () => ({ state: 's' }) });
  assert.equal(none.blocked, true); assert.deepEqual(none.refused, ['a', 'b']);
});
test('client stops at the cost ceiling and on schema errors', async t => {
  const stateDir = await temporary(t);
  process.env.OPENROUTER_API_KEY = 'test-key';
  const questions = { q: { type: 'noul', instructions: 'x' } };
  const ok = () => fakeResponse(200, { id: 'g', answers: { q: { type: 'noul', noul: 0 } }, usage: { input_tokens: 10_000_000 } });
  const api = client({ stateDir, model: 'm', maxAttempts: 2, maxRunCostUsd: .5, inputUsdPerMillion: .1, appName: 'A', appUrl: '' }, () => {}, async () => ok());
  await api.decide({ identity: { n: 1 }, questions, body: () => ({ state: '' }) });
  await assert.rejects(api.decide({ identity: { n: 2 }, questions, body: () => ({ state: '' }) }), /Cost ceiling/);
  const bad = client({ stateDir, model: 'm', maxAttempts: 3, maxRunCostUsd: 1, inputUsdPerMillion: .1, appName: 'A', appUrl: '' }, () => {},
    async () => fakeResponse(400, { error: { message: 'Invalid discriminator value' } }));
  await assert.rejects(bad.decide({ identity: { n: 3 }, questions, body: () => ({ state: '' }) }), /OpenRouter 400/);
});
test('score() turns an answers document into a video result', async () => {
  const scale = await loadScale((await import('../src/config.mjs')).DEFAULT_SCALE);
  const neutral = {};
  for (const [id, q] of Object.entries(scale.visual.questions)) {
    neutral[id] = q.type === 'noul' ? { type: 'noul', noul: 0 }
      : q.type === 'score' ? { type: 'score', score: 0, probabilities: Object.fromEntries(q.criteria.map((_, i) => [i, i ? 0 : 1])) }
      : { type: 'choice', choice: 'real', probabilities: { real: 1 } };
  }
  const nude = { ...neutral, exposed_breasts: { type: 'noul', noul: .95 } };
  const doc = {
    video: { id: 'v1', name: 'v1.mp4', date: '2024-01-01', titleEn: 'T', titleKo: '' }, duration: 600, scale: 'silk-v1', model: 'm',
    frames: [
      { t: 150, start: 0, end: 300, source: 'grid', answers: neutral, tokens: 3000 },
      { t: 450, start: 300, end: 600, source: 'grid', answers: nude, tokens: 3000 }
    ],
    windows: [{ index: 0, start: 0, end: 300, empty: true }, { index: 1, start: 300, end: 600, blocked: true, error: 'flagged' }],
    title: null
  };
  const r = score(doc, scale.rules);
  assert.equal(r.rating, 5); assert.equal(r.driver, 'visual'); assert.equal(r.visual.share['5'], .5);
  assert.equal(r.verbal.items, 1, 'empty windows are not counted'); assert.equal(r.verbal.missing, 1);
  assert.equal(r.blocked.windows, 1); assert.equal(r.inputTokens, 6000);
});
