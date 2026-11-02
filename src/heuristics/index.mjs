// Optional, pluggable scoring heuristics. A scale opts in via rules.json "heuristics":
//   { "use": "<id>", "enabled": true, "kinds": ["visual", "verbal"], "options": { ... } }
// Two stages:
//   items   — apply(items, options, ctx) → items. Rewrites the ordered frame/window sequence before
//             evaluation (e.g. imputing answers). Changed items get `adjusted` entries for the reviewer.
//   summary — apply(scoredItems, options, ctx) → { metric: value }. Merged into that kind's aggregate.
// ctx: { kind, threshold, rules }. Modules must be pure: same input, same output, no I/O.
import refusalRuns from './refusal-runs.mjs';
import refusalConstant from './refusal-constant.mjs';
import confirmedPeak from './confirmed-peak.mjs';

export const HEURISTICS = Object.fromEntries([refusalRuns, refusalConstant, confirmedPeak].map(h => [h.id, h]));
const KINDS = ['visual', 'verbal'];

export function checkHeuristics(list = []) {
  if (!Array.isArray(list)) throw Error('rules.heuristics must be an array');
  for (const h of list) {
    const mod = HEURISTICS[h.use];
    if (!mod) throw Error(`Unknown heuristic "${h.use}". Available: ${Object.keys(HEURISTICS).join(', ')}`);
    for (const k of h.kinds ?? KINDS) if (!KINDS.includes(k)) throw Error(`${h.use}: unknown kind ${k}`);
    mod.validate?.(h.options ?? {});
  }
}
export const activeHeuristics = (rules, kind) => (rules.heuristics ?? [])
  .filter(h => h.enabled !== false && (h.kinds ?? KINDS).includes(kind))
  .map(h => ({ ...h, module: HEURISTICS[h.use], options: h.options ?? {} }));

