// Compares five visual sampling strategies on the same videos.
//   A per-frame, 1/min grid + scene cuts   (the main pipeline)
//   B per-frame, 1/min grid only           (subset of A, no extra requests)
//   C per-frame, every other grid frame    (subset of A, no extra requests)
//   D grid of 16 frames per request, 1/min
//   E grid of 16 frames per request, every other minute
// Usage: node --env-file-if-exists=.env.local scripts/compare-sampling.mjs --match "a|b|c" [--config config.json]
import fs from 'node:fs/promises';
import path from 'node:path';
import { configuration } from '../src/config.mjs';
import { acquireLock, hash, limit, pool, readJSON, writeJSON } from '../src/core.mjs';
import { scanLibrary } from '../src/corpus.mjs';
import { frameFile } from '../src/frames.mjs';
import { client } from '../src/decisions.mjs';
import { aggregate, evaluate, loadScale } from '../src/scale.mjs';
import { classifyVideo, refusalCounts, videoDir } from '../src/classify.mjs';

const GRID = 16;
const GRID_PREAMBLE = `Up to ${GRID} still frames sampled in time order from one segment of a video, given as separate images. Answer every question for the most explicit frame among them.`;

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a, all[i + 1]]] : acc), []));
const config = await configuration(path.resolve(args['--config'] || 'config.json'));
const scale = await loadScale(config.scale);
const log = m => console.log(`[${new Date().toLocaleTimeString()}] ${m}`);
const needles = (args['--match'] || '').split('|').map(s => s.trim().toLowerCase()).filter(Boolean);
if (!needles.length) throw Error('Provide --match "name1|name2|..."');
const videos = (await scanLibrary(config.mediaDir)).filter(v => needles.some(n => v.name.toLowerCase().includes(n)));
for (const n of needles) if (!videos.some(v => v.name.toLowerCase().includes(n))) throw Error(`No video matches: ${n}`);

// Re-derive each frame's span from its neighbours after taking a subset.
const reweight = (frames, duration) => frames.map((f, i) => ({ ...f,
  start: i ? (frames[i - 1].t + f.t) / 2 : 0, end: i < frames.length - 1 ? (f.t + frames[i + 1].t) / 2 : duration }));

const nouls = Object.entries(scale.visual.questions).filter(([, q]) => q.type === 'noul').map(([id]) => id);
function summarise(items, requests) {
  const scored = items.map(i => ({ ...i, ...(i.answers ? evaluate('visual', i.answers, scale.rules) : { level: null, fired: [], flags: {} }) }));
  const agg = aggregate(scored, scale.rules);
  const detections = {};
  for (const id of nouls) {
    const ps = items.filter(i => i.answers?.[id]).map(i => i.answers[id].noul);
    detections[id] = { max: +Math.max(0, ...ps).toFixed(2), hits: ps.filter(p => p >= scale.rules.threshold).length };
  }
  return { peak: agg.peak, sustained: agg.sustained, shareAtLeast3: agg.shareAtLeast3, share: agg.share, rulesFired: agg.rulesFired,
    requests, inputTokens: items.reduce((s, i) => s + (i.tokens ?? 0), 0), items: items.length, blocked: items.filter(i => i.blocked).length,
    itemsWithRefusals: items.filter(i => i.refused?.length).length, refusals: refusalCounts(items), detections };
}

const release = await acquireLock(config.stateDir);
try {
  const api = client(config, log);
  const ctx = { config, scale, api, apiSlot: limit(config.apiConcurrency), mediaSlot: limit(config.mediaConcurrency), log };
  const outcomes = await pool(videos, config.videoConcurrency, async video => {
    await classifyVideo(video, ctx);
    const doc = await readJSON(path.join(videoDir(config, video.id), 'answers.json'));
    const grid = doc.frames.filter(f => f.source === 'grid');
    const everyOther = grid.filter((_, i) => i % 2 === 0);

    async function gridRequests(frames) {
      const spans = reweight(frames, doc.duration);
      const chunks = [];
      for (let i = 0; i < spans.length; i += GRID) chunks.push(spans.slice(i, i + GRID));
      return Promise.all(chunks.map(async chunk => {
        const images = await Promise.all(chunk.map(f => fs.readFile(frameFile(path.join(videoDir(config, video.id), 'frames'), f.t))));
        const { questions } = scale.visual;
        const r = await ctx.apiSlot(() => api.decide({
          identity: { model: config.model, kind: 'visual-grid', preamble: GRID_PREAMBLE, questions, images: images.map(b => hash(b)) },
          questions,
          body: () => ({ state: [GRID_PREAMBLE, ...images.map(b => ({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b.toString('base64') } }))] }),
          meta: { session_id: video.id, trace: { trace_name: scale.name, generation_name: 'grid', span_name: `grid ${chunk[0].t}-${chunk.at(-1).t}` } }
        }));
        return { start: chunk[0].start, end: chunk.at(-1).end, frames: chunk.map(f => f.t), refused: r.refused ?? [],
          ...(r.blocked ? { blocked: true } : { answers: r.answers, tokens: r.usage.input_tokens }) };
      }));
    }
    const [gridD, gridE] = await Promise.all([gridRequests(grid), gridRequests(everyOther)]);
    const result = {
      id: video.id, name: video.name, minutes: +(doc.duration / 60).toFixed(1),
      options: {
        A: summarise(doc.frames, doc.frames.length),
        B: summarise(reweight(grid, doc.duration), grid.length),
        C: summarise(reweight(everyOther, doc.duration), everyOther.length),
        D: summarise(gridD, gridD.length),
        E: summarise(gridE, gridE.length)
      },
      verbal: (await readJSON(path.join(videoDir(config, video.id), 'result.json'))).verbal
    };
    await writeJSON(path.join(config.stateDir, 'experiments', 'sampling', `${video.id}.json`), result);
    log(`${video.id}: A ${result.options.A.peak}/${result.options.A.sustained} · D ${result.options.D.peak}/${result.options.D.sustained} · E ${result.options.E.peak}/${result.options.E.sustained}`);
    return result;
  });
  const results = outcomes.filter(o => o.status === 'fulfilled').map(o => o.value);
  for (const o of outcomes) if (o.status === 'rejected') log(`FAILED: ${o.reason.message}`);
  await writeJSON(path.join(config.stateDir, 'experiments', 'sampling', 'summary.json'), { generatedAt: new Date().toISOString(), grid: GRID, results });
  console.log(JSON.stringify({ videos: results.length, failed: outcomes.length - results.length, usage: api.stats() }, null, 2));
  if (results.length < outcomes.length) process.exitCode = 1;
} finally { await release(); }
