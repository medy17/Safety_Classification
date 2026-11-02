import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SCALE } from '../src/config.mjs';
import { aggregate, checkScale, evaluate, loadScale, rateVideo, scoreSequence, test as check } from '../src/scale.mjs';
import { HEURISTICS } from '../src/heuristics/index.mjs';

const scale = await loadScale(DEFAULT_SCALE);
const rules = scale.rules;
const noul = p => ({ type: 'noul', noul: p });
const score = probs => ({ type: 'score', score: probs.reduce((s, p, i) => s + p * i, 0), probabilities: Object.fromEntries(probs.map((p, i) => [String(i), p])) });
const choice = (probs) => ({ type: 'choice', choice: Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0], probabilities: probs });

// A neutral visual answer set; tests override individual questions.
function visual(overrides = {}) {
  const a = {};
  for (const [id, q] of Object.entries(scale.visual.questions)) {
    if (q.type === 'noul') a[id] = noul(0);
    else if (q.type === 'score') a[id] = score(q.criteria.map((_, i) => i === 0 ? 1 : 0));
    else a[id] = choice(Object.fromEntries(Object.keys(q.criteria).map((k, i) => [k, i === 1 ? 1 : 0])));
  }
  return { ...a, ...overrides };
}
function verbal(overrides = {}) {
  const a = {};
  for (const [id, q] of Object.entries(scale.verbal.questions)) a[id] = q.type === 'noul' ? noul(0) : score(q.criteria.map((_, i) => i === 0 ? 1 : 0));
  return { ...a, ...overrides };
}

test('the shipped scale is internally consistent', () => {
  assert.doesNotThrow(() => checkScale(scale));
  assert.deepEqual(rules.levels.map(l => l.level), [0, 1, 2, 3, 4, 5]);
  for (const id of Object.keys(scale.verbal.questions).filter(k => /^(act|fluid)_/.test(k))) assert.ok(scale.visual.questions[id], `${id} exists in both modalities`);
});
test('checkScale rejects rules that reference unknown questions', () => {
  const broken = structuredClone(scale);
  broken.rules.visual.rules.push({ level: 2, id: 'x', when: { q: 'nope' } });
  assert.throws(() => checkScale(broken), /unknown question nope/);
});
test('score conditions use cumulative probability, not the expected value', () => {
  // Expected value 1.5 but only 45% mass at level >= 2.
  const a = { pose: score([.1, .45, .25, .2]) };
  assert.equal(check({ q: 'pose', atLeast: 2 }, a, .5).pass, false);
  assert.equal(check({ q: 'pose', atLeast: 2 }, a, .5).strength, .45);
  assert.equal(check({ q: 'pose', atLeast: 1 }, a, .5).pass, true);
});
test('globs, lists, combinators and per-condition thresholds', () => {
  const a = { act_a: noul(.2), act_b: noul(.7), other: noul(.9) };
  assert.equal(check({ q: 'act_*' }, a, .5).pass, true);
  assert.equal(check({ q: ['act_a'] }, a, .5).pass, false);
  assert.equal(check({ q: 'act_*', min: .8 }, a, .5).pass, false);
  assert.equal(check({ all: [{ q: 'act_b' }, { q: 'other' }] }, a, .5).strength, .7);
  assert.equal(check({ not: { q: 'act_a' } }, a, .5).pass, true);
});
test('visual levels follow the rule ladder', () => {
  assert.equal(evaluate('visual', visual(), rules).level, 0);
  assert.equal(evaluate('visual', visual({ pose: score([.2, .8, 0, 0]) }), rules).level, 1);
  assert.equal(evaluate('visual', visual({ focus_legs: noul(.9) }), rules).level, 2);
  assert.equal(evaluate('visual', visual({ clothing: score([0, .2, .7, .1, 0]) }), rules).level, 3);
  assert.equal(evaluate('visual', visual({ covered_nudity: noul(.8) }), rules).level, 4);
  assert.equal(evaluate('visual', visual({ act_fellatio: noul(.9) }), rules).level, 4, 'clothed simulated act');
  assert.equal(evaluate('visual', visual({ act_fellatio: noul(.9), covered_nudity: noul(.8) }), rules).level, 5, 'act while undressed');
  assert.equal(evaluate('visual', visual({ exposed_breasts: noul(.9) }), rules).level, 5);
  assert.equal(evaluate('visual', visual({ act_groping: noul(.9) }), rules).level, 3, 'groping alone is S3');
  assert.equal(evaluate('visual', visual({ fluid_saliva: noul(.9) }), rules).level, 3);
  assert.equal(evaluate('visual', visual({ fluid_semen: noul(.9) }), rules).level, 4);
  assert.equal(evaluate('visual', visual({ fluid_semen: noul(.9), covered_nudity: noul(.9) }), rules).level, 5);
});
// A frame sequence where some frames refused act_fellatio.
function sequence(spec) {
  return spec.map((s, i) => {
    const answers = visual(s.answers ?? {});
    for (const q of s.refused ?? []) delete answers[q];
    return { start: i * 60, end: (i + 1) * 60, at: i * 60 + 30, answers, refused: s.refused ?? [] };
  });
}
const only = (...uses) => ({ ...rules, heuristics: rules.heuristics.map(h => ({ ...h, enabled: uses.includes(h.use) })) });

test('refusal-runs: isolated refusals stay unknown, runs and affirmed neighbours count as yes', () => {
  const seq = sequence([{}, { refused: ['act_fellatio'] }, {}, { refused: ['act_fellatio'] }, { refused: ['act_fellatio'] }, {}, { answers: { act_fellatio: noul(.9) } }, { refused: ['act_fellatio'] }]);
  const { scored } = scoreSequence('visual', seq, only('refusal-runs'));
  assert.deepEqual(scored.map(s => s.level), [0, 0, 0, 4, 4, 0, 4, 4]);
  assert.deepEqual(scored[3].adjusted, [{ heuristic: 'refusal-runs', question: 'act_fellatio', value: .75 }]);
  assert.equal(scored[1].adjusted, undefined, 'isolated refusal untouched');
});
test('refusal-runs ignores questions outside include, such as minor_appearance', () => {
  const seq = sequence([{ refused: ['minor_appearance'] }, { refused: ['minor_appearance'] }]);
  const { scored } = scoreSequence('visual', seq, only('refusal-runs'));
  assert.ok(scored.every(s => !s.adjusted && !s.flags.minor_appearance.fired));
});
test('refusal-constant treats every refusal as yes; disabled modules do nothing', () => {
  const seq = sequence([{}, { refused: ['act_fellatio'] }, {}]);
  assert.deepEqual(scoreSequence('visual', seq, only('refusal-constant')).scored.map(s => s.level), [0, 4, 0]);
  assert.deepEqual(scoreSequence('visual', seq, only()).scored.map(s => s.level), [0, 0, 0]);
});
test('confirmed-peak needs a run; a lone spike does not set it', () => {
  const run = (levels, minRun = 2) => HEURISTICS['confirmed-peak'].apply(levels.map((level, i) => ({ level, at: i })), { minRun });
  assert.deepEqual(run([2, 5, 2, 3, 3, 2]), { confirmedPeak: 3, confirmedAt: 3 });
  assert.equal(run([2, 5, null, 5, 2]).confirmedPeak, 2, 'a missing frame breaks the run');
  assert.equal(run([4]).confirmedPeak, 4, 'too short to form a run falls back to the peak');
  assert.equal(run([1, 4, 4], 3).confirmedPeak, 1);
  const { aggregate: agg } = scoreSequence('visual', sequence([{ answers: { exposed_breasts: noul(.9) } }, {}, {}]), only('confirmed-peak'));
  assert.equal(agg.peak, 5); assert.equal(agg.confirmedPeak, 0); assert.deepEqual(agg.heuristics, ['confirmed-peak']);
});
test('heuristic config is validated and ratingFrom must be produced', () => {
  assert.throws(() => checkScale({ ...scale, rules: { ...rules, heuristics: [{ use: 'nope' }] } }), /Unknown heuristic "nope"/);
  assert.throws(() => checkScale({ ...scale, rules: { ...rules, heuristics: [{ use: 'confirmed-peak', options: { minRun: 0 } }] } }), /minRun/);
  assert.throws(() => checkScale({ ...scale, rules: { ...only(), video: { ...rules.video, ratingFrom: 'confirmedPeak' } } }), /ratingFrom/);
  const r = rateVideo({ visual: { peak: 5, confirmedPeak: 3, sustained: 3 }, verbal: { peak: 2, confirmedPeak: 2, sustained: 2 } }, { ...rules, video: { ...rules.video, ratingFrom: 'confirmedPeak' } });
  assert.equal(r.rating, 3); assert.equal(r.peak, 5); assert.equal(r.ratingFrom, 'confirmedPeak'); assert.equal(r.driver, 'visual');
});
test('the no-people gate short-circuits rules and flags', () => {
  const e = evaluate('visual', visual({ people: choice({ none: .9, real: .1, drawn: 0, rendered: 0 }), focus_feet: noul(.9), minor_appearance: noul(.9) }), rules);
  assert.equal(e.level, 0);
  assert.deepEqual(e.fired, ['no_people']);
  assert.equal(e.flags.minor_appearance.fired, false);
});
test('flags respect minLevel', () => {
  const plain = evaluate('visual', visual({ minor_appearance: noul(.9) }), rules);
  assert.equal(plain.flags.minor_appearance.fired, true);
  assert.equal(plain.flags.minor_sexualized.fired, false);
  const sexualized = evaluate('visual', visual({ minor_appearance: noul(.9), clothing: score([0, .1, .9, 0, 0]) }), rules);
  assert.equal(sexualized.flags.minor_sexualized.fired, true);
  const nc = evaluate('verbal', verbal({ non_consent: noul(.9) }), rules);
  assert.equal(nc.flags.non_consent.fired, false, 'non-consent needs sexual context (S2+)');
});
test('verbal levels, using the answers from the live limits test', () => {
  const live = verbal({
    sexual_content: score([.01, 0, .01, .01, .29, .68]), explicit_language: noul(1), act_fellatio: noul(1),
    act_intercourse: noul(.96), non_consent: noul(.78), minor_coded: noul(.01)
  });
  const e = evaluate('verbal', live, rules);
  assert.equal(e.level, 5);
  assert.ok(e.fired.includes('graphic_description') && e.fired.includes('explicit_act'));
  assert.equal(e.flags.non_consent.fired, true);
  assert.equal(e.flags.minor_coded.fired, false);
  assert.equal(evaluate('verbal', verbal({ sexual_content: score([.1, .2, .6, .1, 0, 0]) }), rules).level, 2);
});
test('aggregate weights by time and computes a misfire-resistant sustained level', () => {
  const items = [
    { start: 0, end: 540, level: 2, fired: ['revealing_clothing'], flags: {} },
    { start: 540, end: 570, level: 5, fired: ['visible_nudity'], flags: { f: { fired: true, strength: .9 } } },
    { start: 570, end: 600, level: null, fired: [], flags: {} }
  ];
  const a = aggregate(items, rules);
  assert.equal(a.peak, 5);
  assert.equal(a.sustained, 2, 'a 30 s spike in a 570 s timeline is under 10%');
  assert.equal(a.missing, 1);
  assert.equal(a.share['2'], +(540 / 570).toFixed(4));
  assert.equal(a.flags.f.count, 1);
  assert.equal(a.flags.f.firstAt, 540);
  assert.equal(a.peakAt, 540);
});
test('rateVideo takes the higher modality and names the driver', () => {
  const r = rateVideo({ visual: { peak: 3, sustained: 2 }, verbal: { peak: 5, sustained: 4 }, title: { level: 3 } }, rules);
  assert.equal(r.rating, 5); assert.equal(r.label, 'S5 Graphic'); assert.equal(r.sustained, 4); assert.equal(r.driver, 'verbal'); assert.equal(r.titleLevel, 3);
  assert.equal(rateVideo({ visual: { peak: null, sustained: null }, verbal: { peak: null, sustained: null } }, rules).rating, null);
});
