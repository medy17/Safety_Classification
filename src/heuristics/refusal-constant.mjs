// Every refused question (matching `include`) counts as a fixed probability. The blunt alternative
// to refusal-runs; with "as" >= the threshold it treats any refusal as a yes.
import { matches } from './match.mjs';

export default {
  id: 'refusal-constant',
  stage: 'items',
  description: 'Refused questions count as a fixed probability.',
  validate({ as = .75, include = [] }) {
    if (!(as >= 0 && as <= 1)) throw Error('refusal-constant: "as" must be 0–1');
    if (!Array.isArray(include)) throw Error('refusal-constant: "include" must be an array');
  },
  apply(items, { as = .75, include = ['act_*', 'fluid_*', 'exposed_*', 'covered_nudity'] }) {
    return items.map(item => {
      const candidates = (item.refused ?? []).filter(q => matches(include, q) && !item.answers?.[q]);
      if (!candidates.length || !item.answers) return item;
      const answers = { ...item.answers };
      for (const q of candidates) answers[q] = { type: 'noul', noul: as, imputed: 'refusal-constant' };
      return { ...item, answers, adjusted: [...(item.adjusted ?? []), ...candidates.map(q => ({ heuristic: 'refusal-constant', question: q, value: as }))] };
    });
  }
};
