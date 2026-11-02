// Frame sampling: a fixed grid plus scene-change frames, then single-frame JPEG extraction.
import fs from 'node:fs/promises';
import path from 'node:path';
import { command, exists } from './core.mjs';

export async function probeDuration(file, config) {
  const { stdout } = await command(config.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], 60000);
  const duration = Number(stdout.trim());
  if (!(duration > 0)) throw Error(`No duration: ${file}`);
  return duration;
}

// Decodes keyframes only (~150x realtime on this corpus) and reports scene-change scores.
export async function detectScenes(file, config) {
  const { stderr } = await command(config.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'info', '-skip_frame', 'nokey', '-i', file,
    '-an', '-sn', '-vf', `scale=160:-2,select='gt(scene,${config.sceneThreshold})',metadata=print:key=lavfi.scene_score`,
    '-fps_mode', 'vfr', '-f', 'null', '-']);
  return parseScenes(stderr);
}
export function parseScenes(text) {
  const scenes = [];
  let t = null;
  for (const line of text.split(/\r?\n|\r/)) {
    const time = line.match(/pts_time:(-?[\d.]+)/);
    if (time) { t = Number(time[1]); continue; }
    const score = line.match(/lavfi\.scene_score=([\d.]+)/);
    if (score && t !== null) { scenes.push({ t, score: Number(score[1]) }); t = null; }
  }
  return scenes;
}

// Grid frames sit mid-interval (30 s, 90 s, …) to avoid title cards at 0:00. Scene frames are
// added strongest first, skipping any within sceneMinGapSeconds of a chosen frame. Each frame
// then owns the span halfway to its neighbours, which is its weight in runtime shares.
export function planFrames(duration, scenes, config) {
  const { frameIntervalSeconds: step, maxSceneFrames, sceneMinGapSeconds: gap } = config;
  const frames = [];
  for (let t = step / 2; t < duration; t += step) frames.push({ t: +t.toFixed(2), source: 'grid' });
  if (!frames.length) frames.push({ t: +(duration / 2).toFixed(2), source: 'grid' });
  const lastSafe = Math.max(0, duration - 0.5);
  for (const s of [...scenes].sort((a, b) => b.score - a.score)) {
    if (frames.filter(f => f.source === 'scene').length >= maxSceneFrames) break;
    // Land just after the cut so the new shot is fully on screen.
    const t = +Math.min(lastSafe, s.t + 0.5).toFixed(2);
    if (frames.some(f => Math.abs(f.t - t) < gap)) continue;
    frames.push({ t, source: 'scene', sceneScore: s.score });
  }
  frames.sort((a, b) => a.t - b.t);
  return frames.map((f, i) => ({
    ...f, index: i,
    start: i ? +((frames[i - 1].t + f.t) / 2).toFixed(2) : 0,
    end: i < frames.length - 1 ? +((f.t + frames[i + 1].t) / 2).toFixed(2) : +duration.toFixed(2)
  }));
}

export const frameFile = (dir, t) => path.join(dir, `t${t.toFixed(2).padStart(9, '0')}.jpg`);

// Some sources are limited-range YUV that the MJPEG encoder rejects; force full-range yuvj420p.
export async function extractFrame(input, t, output, config) {
  if (await exists(output)) return output;
  await fs.mkdir(path.dirname(output), { recursive: true });
  const partial = output + '.partial.jpg';
  await command(config.ffmpeg, ['-v', 'error', '-nostdin', '-y', '-ss', String(t), '-i', input, '-frames:v', '1',
    '-vf', `scale=${config.frameWidth}:-2:out_range=full,format=yuvj420p`, '-q:v', '5', partial], 120000);
  const { size } = await fs.stat(partial);
  if (!size) throw Error(`Empty frame at ${t}s: ${input}`);
  await fs.rename(partial, output);
  return output;
}
