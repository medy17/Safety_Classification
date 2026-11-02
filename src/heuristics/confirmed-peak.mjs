// The highest level reached by at least `minRun` consecutive scored items, so one flickering frame
// can't set the peak on its own. Missing items (blocked) break a run. Adds { confirmedPeak, confirmedAt }.
export default {
  id: 'confirmed-peak',
  stage: 'summary',
  description: 'Highest level held by at least minRun consecutive items.',
  validate({ minRun = 2 }) {
    if (!Number.isInteger(minRun) || minRun < 1) throw Error('confirmed-peak: "minRun" must be a positive integer');
  },
  apply(items, { minRun = 2 }) {
    const levels = items.map(i => i.level).filter(Number.isInteger);
    if (!levels.length) return { confirmedPeak: null, confirmedAt: null };
    // Too few items to form a run (a very short clip): fall back to the plain peak.
    if (items.length < minRun) return { confirmedPeak: Math.max(...levels), confirmedAt: items[0].at ?? items[0].start };
    for (let level = Math.max(...levels); level >= 0; level--) {
      let run = 0;
      for (let i = 0; i < items.length; i++) {
        run = Number.isInteger(items[i].level) && items[i].level >= level ? run + 1 : 0;
        if (run >= minRun) { const first = items[i - minRun + 1]; return { confirmedPeak: level, confirmedAt: first.at ?? first.start }; }
      }
    }
    return { confirmedPeak: null, confirmedAt: null };
  }
};
