// "act_*" style matching shared by the heuristic modules.
export const matches = (patterns, id) => patterns.some(p => p.endsWith("*") ? id.startsWith(p.slice(0, -1)) : p === id);
