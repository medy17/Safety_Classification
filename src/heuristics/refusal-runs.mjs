// A refused question counts as a "yes" only when a neighbouring item (within `reach`) also refused it
// or answered it yes. Isolated refusals stay unknown. Motivation (2026-11-03 pilot): 21 of 32
// refusals had no supporting neighbour, while real acts produced runs of refusals.
import { matches } from './match.mjs';

export default {
  id: 'refusal-runs',
  stage: 'items',
  description: 'Refused questions count as yes when an adjacent item refused or affirmed the same question.',
  validate({ as = .75, reach = 1, include = [] }) {
    if (!(as >= 0 && as <= 1)) throw Error('refusal-runs: "as" must be 0–1');
    if (!Number.isInteger(reach) || reach < 1) throw Error('refusal-runs: "reach" must be a positive integer');
    if (!Array.isArray(include)) throw Error('refusal-runs: "include" must be an array of question IDs or globs');
  },
  apply(items, { as = .75, reach = 1, include = ['act_*', 'fluid_*', 'exposed_*', 'covered_nudity'] }, { threshold }) {
    const affirms = (item, q) => !!item && ((item.refused ?? []).includes(q)
      || (item.answers?.[q]?.type === 'noul' && item.answers[q].noul >= threshold));
    return items.map((item, i) => {
      const candidates = (item.refused ?? []).filter(q => matches(include, q) && !item.answers?.[q]);
      if (!candidates.length || !item.answers) return item;
      const answers = { ...item.answers }, adjusted = [...(item.adjusted ?? [])];
      for (const q of candidates) {
        let support = false;
        for (let d = 1; d <= reach && !support; d++) support = affirms(items[i - d], q) || affirms(items[i + d], q);
        if (!support) continue;
        answers[q] = { type: 'noul', noul: as, imputed: 'refusal-runs' };
        adjusted.push({ heuristic: 'refusal-runs', question: q, value: as });
      }
      return adjusted.length === (item.adjusted ?? []).length ? item : { ...item, answers, adjusted };
    });
  }
};
