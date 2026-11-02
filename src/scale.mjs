// Scale loading, rule evaluation and aggregation. Pure apart from loadScale, so any change to
// rules.json can be re-scored from cached answers without calling the API.
import fs from 'node:fs/promises';
import path from 'node:path';
import { hash } from './core.mjs';
import { activeHeuristics, checkHeuristics } from './heuristics/index.mjs';

export async function loadScale(dir) {
  const read = async name => JSON.parse(await fs.readFile(path.join(dir, name + '.json'), 'utf8'));
  const [visual, verbal, rules] = await Promise.all(['visual', 'verbal', 'rules'].map(read));
  const scale = { name: path.basename(dir), visual, verbal, rules };
  checkScale(scale);
  // Only the question files change what the API returns; rules are applied locally.
  scale.questionsHash = hash(JSON.stringify([visual.questions, verbal.questions])).slice(0, 12);
  return scale;
}

function conditionQuestions(cond, out = []) {
  if (cond.q) out.push(...[cond.q].flat());
  for (const key of ['any', 'all']) for (const c of cond[key] ?? []) conditionQuestions(c, out);
  if (cond.not) conditionQuestions(cond.not, out);
  return out;
}
export function checkScale({ visual, verbal, rules }) {
  const levels = rules.levels.map(l => l.level);
  checkHeuristics(rules.heuristics);
  const ratingFrom = rules.video?.ratingFrom ?? 'peak';
  const provided = new Set(['peak', 'sustained', ...(rules.heuristics ?? []).filter(h => h.enabled !== false && h.use === 'confirmed-peak').map(() => 'confirmedPeak')]);
  if (!provided.has(ratingFrom)) throw Error(`video.ratingFrom "${ratingFrom}" is not produced by the core or an enabled heuristic`);
  for (const [kind, set] of [['visual', visual], ['verbal', verbal]]) {
    const ids = Object.keys(set.questions);
    const r = rules[kind];
    const conds = [...r.rules, ...(r.gate ? [r.gate] : []), ...Object.values(r.flags ?? {})];
    for (const item of conds) {
      if (item.level !== undefined && !levels.includes(item.level)) throw Error(`${kind}: unknown level ${item.level}`);
      for (const q of conditionQuestions(item.when)) {
        const matches = q.endsWith('*') ? ids.filter(id => id.startsWith(q.slice(0, -1))) : ids.filter(id => id === q);
        if (!matches.length) throw Error(`${kind}: rule references unknown question ${q}`);
      }
    }
  }
}

const expand = (q, answers) => [q].flat().flatMap(id => id.endsWith('*')
  ? Object.keys(answers).filter(k => k.startsWith(id.slice(0, -1))) : [id]);

// Strength of a single question-condition, in [0, 1].
function questionStrength(cond, answer) {
  if (!answer) return 0;
  if (answer.type === 'noul') return answer.noul;
  if (answer.type === 'choice') {
    if (cond.is === undefined) throw Error('choice conditions need "is"');
    return answer.probabilities?.[cond.is] ?? (answer.choice === cond.is ? 1 : 0);
  }
  if (answer.type === 'score') {
    const k = cond.atLeast ?? 1;
    if (answer.probabilities) return Object.entries(answer.probabilities).reduce((s, [lvl, p]) => s + (Number(lvl) >= k ? p : 0), 0);
    return answer.score >= k - .5 ? 1 : 0;
  }
  return 0;
}
// Returns { pass, strength }. strength is the highest probability among matched questions for
// "any", the lowest for "all", so a flag can report how close it came to firing.
export function test(cond, answers, threshold) {
  if (cond.any) {
    const r = cond.any.map(c => test(c, answers, threshold));
    return { pass: r.some(x => x.pass), strength: Math.max(0, ...r.map(x => x.strength)) };
  }
  if (cond.all) {
    const r = cond.all.map(c => test(c, answers, threshold));
    return { pass: r.every(x => x.pass), strength: Math.min(1, ...r.map(x => x.strength)) };
  }
  if (cond.not) { const r = test(cond.not, answers, threshold); return { pass: !r.pass, strength: 1 - r.strength }; }
  const min = cond.min ?? threshold;
  const strengths = expand(cond.q, answers).map(id => questionStrength(cond, answers[id]));
  const strength = Math.max(0, ...strengths);
  return { pass: strength >= min, strength: +strength.toFixed(4) };
}

// One frame, transcript window, title or prompt → { level, fired, flags }. Pure: answers in, level out.
// Anything that looks across items (refusal handling, run confirmation) is a heuristic module.
export function evaluate(kind, answers, rules) {
  const set = rules[kind], threshold = rules.threshold;
  let level = 0, fired = [], gated = false;
  if (set.gate && test(set.gate.when, answers, threshold).pass) { gated = true; fired = [set.gate.id]; level = set.gate.level; }
  else for (const rule of set.rules) {
    if (!test(rule.when, answers, threshold).pass) continue;
    fired.push(rule.id);
    level = Math.max(level, rule.level);
  }
  const flags = {};
  for (const [name, flag] of Object.entries(set.flags ?? {})) {
    const r = gated ? { pass: false, strength: 0 } : test(flag.when, answers, threshold);
    flags[name] = { fired: r.pass && level >= (flag.minLevel ?? 0), strength: r.strength };
  }
  return { level, fired, flags };
}

// items: [{ start, end, level, fired, flags }] with null level for missing/blocked items.
export function aggregate(items, rules) {
  const levels = rules.levels.map(l => l.level);
  const scored = items.filter(i => Number.isInteger(i.level));
  const total = scored.reduce((s, i) => s + (i.end - i.start), 0);
  const share = Object.fromEntries(levels.map(l => [l, 0]));
  for (const i of scored) share[i.level] += total ? (i.end - i.start) / total : 1 / scored.length;
  const atLeast = l => levels.filter(x => x >= l).reduce((s, x) => s + share[x], 0);
  const peak = scored.length ? Math.max(...scored.map(i => i.level)) : null;
  const sustained = scored.length ? Math.max(...levels.filter(l => atLeast(l) >= rules.video.sustainedShare - 1e-9)) : null;
  const flags = {}, rulesFired = {};
  for (const i of scored) {
    for (const [name, f] of Object.entries(i.flags ?? {})) {
      flags[name] ??= { count: 0, maxStrength: 0, firstAt: null };
      flags[name].maxStrength = Math.max(flags[name].maxStrength, f.strength);
      if (f.fired) { flags[name].count++; flags[name].firstAt ??= i.start; }
    }
    for (const id of i.fired ?? []) rulesFired[id] = (rulesFired[id] ?? 0) + 1;
  }
  const peakItem = scored.find(i => i.level === peak);
  return {
    peak, sustained, peakAt: peakItem ? peakItem.at ?? peakItem.start : null,
    share: Object.fromEntries(Object.entries(share).map(([k, v]) => [k, +v.toFixed(4)])),
    shareAtLeast3: +atLeast(3).toFixed(4),
    items: items.length, scored: scored.length, missing: items.length - scored.length,
    flags, rulesFired
  };
}

// An ordered sequence of frames or windows ({ start, end, at?, answers, refused }) → scored items
// plus aggregate. Enabled heuristics run around evaluate(): "items" modules before, "summary" after.
export function scoreSequence(kind, items, rules) {
  const active = activeHeuristics(rules, kind), ctx = { kind, threshold: rules.threshold, rules };
  let sequence = items;
  for (const h of active) if (h.module.stage === 'items') sequence = h.module.apply(sequence, h.options, ctx);
  const scored = sequence.map(i => ({ ...i, ...(i.answers ? evaluate(kind, i.answers, rules) : { level: null, fired: [], flags: {} }) }));
  const summary = aggregate(scored, rules);
  for (const h of active) if (h.module.stage === 'summary') Object.assign(summary, h.module.apply(scored, h.options, ctx));
  summary.heuristics = active.map(h => h.use);
  return { scored, aggregate: summary };
}

// rules.video.ratingFrom picks the per-modality metric the rating uses: "peak" (default),
// "sustained", or a metric added by a summary heuristic such as "confirmedPeak".
export function rateVideo({ visual, verbal, title }, rules) {
  const pick = key => { const v = Math.max(...[visual?.[key], verbal?.[key]].filter(Number.isInteger), -1); return v < 0 ? null : v; };
  const from = rules.video?.ratingFrom ?? 'peak';
  const rating = pick(from), sustained = pick('sustained');
  const label = l => rules.levels.find(x => x.level === l)?.label ?? null;
  return {
    rating, label: label(rating), ratingFrom: from, peak: pick('peak'), confirmedPeak: pick('confirmedPeak'),
    sustained, sustainedLabel: label(sustained), titleLevel: title?.level ?? null,
    driver: rating === null ? null : visual?.[from] === verbal?.[from] ? 'both' : (visual?.[from] ?? -1) > (verbal?.[from] ?? -1) ? 'visual' : 'verbal'
  };
}
