import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJSON } from './core.mjs';

export const DEFAULT_SCALE = fileURLToPath(new URL('../scales/silk-v1', import.meta.url));
export const DEFAULTS = {
  mediaDir: './media', stateDir: './state', ffmpeg: 'ffmpeg', ffprobe: 'ffprobe',
  scale: '', model: 'openai/gpt-6-luna-decisions',
  frameIntervalSeconds: 60, frameWidth: 768,
  sceneThreshold: .3, maxSceneFrames: 20, sceneMinGapSeconds: 15,
  windowSeconds: 300,
  videoConcurrency: 2, apiConcurrency: 8, mediaConcurrency: 2, maxAttempts: 3,
  maxRunCostUsd: 5, inputUsdPerMillion: .1,
  appName: 'Safety_Classification', appUrl: ''
};
export async function configuration(file) {
  const raw = await readJSON(file);
  for (const key of Object.keys(raw)) if (!(key in DEFAULTS)) throw Error(`Unknown setting: ${key}`);
  return resolveConfig(raw, path.dirname(path.resolve(file)));
}
export function resolveConfig(raw, base) {
  const c = { ...DEFAULTS, ...raw };
  for (const key of ['mediaDir', 'stateDir', 'ffmpeg', 'ffprobe', 'model', 'appName']) {
    if (typeof c[key] !== 'string' || !c[key].trim()) throw Error(`Invalid ${key}`);
  }
  for (const key of ['scale', 'appUrl']) if (typeof c[key] !== 'string') throw Error(`Invalid ${key}`);
  const integer = (key, min, max) => {
    if (!Number.isInteger(c[key]) || c[key] < min || c[key] > max) throw Error(`Invalid ${key}: expected an integer ${min}–${max}`);
  };
  integer('frameIntervalSeconds', 5, 3600); integer('frameWidth', 256, 1568);
  integer('maxSceneFrames', 0, 200); integer('sceneMinGapSeconds', 0, 3600); integer('windowSeconds', 30, 3600);
  for (const key of ['videoConcurrency', 'apiConcurrency', 'mediaConcurrency', 'maxAttempts']) integer(key, 1, 32);
  if (!(c.sceneThreshold > 0 && c.sceneThreshold < 1)) throw Error('Invalid sceneThreshold');
  for (const key of ['maxRunCostUsd', 'inputUsdPerMillion']) if (!Number.isFinite(c[key]) || c[key] < 0) throw Error(`Invalid ${key}`);
  for (const key of ['mediaDir', 'stateDir']) c[key] = path.resolve(base, c[key]);
  for (const key of ['ffmpeg', 'ffprobe']) if (/[\\/]/.test(c[key])) c[key] = path.resolve(base, c[key]);
  c.scale = c.scale ? path.resolve(base, c.scale) : DEFAULT_SCALE;
  if (c.mediaDir === c.stateDir) throw Error('mediaDir and stateDir must differ');
  return c;
}
