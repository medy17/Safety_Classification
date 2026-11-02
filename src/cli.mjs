#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { configuration } from './config.mjs';
import { acquireLock, hash, limit, pool } from './core.mjs';
import { scanLibrary } from './corpus.mjs';
import { probeDuration, planFrames, extractFrame, frameFile } from './frames.mjs';
import { client } from './decisions.mjs';
import { evaluate, loadScale } from './scale.mjs';
import { classifyAll, prepare, rescore, videoDir, writeReport } from './classify.mjs';
import { serveReview } from './review.mjs';

const help = `Safety_Classification — Node 22+, FFmpeg/FFprobe, OpenRouter Decisions

  npm run cli -- scale                      validate and summarise the scale
  npm run cli -- plan    [select]           count frames/windows, estimate cost (no API)
  npm run cli -- frames  [select]           detect scenes and extract frames (no API)
  npm run cli -- classify [select]          run Decisions on frames, transcript windows and titles
  npm run cli -- rescore                    re-apply rules.json to cached answers (no API)
  npm run cli -- report                     rebuild state/report/results.{json,csv}
  npm run cli -- try --text "a prompt"      classify one text, as SilkChat would
  npm run cli -- try --image photo.jpg      classify one image, as SilkChat would
  npm run cli -- review [--port 4317]       local page to review frames and record labels

select: --ids id1,id2  --match "substring"  --limit N
Options: --config config.json (default)
`;
// Measured on silk-v1 (2026-11-03): the question set dominates each request's input.
const EST = { frame: 3300, window: 3500, title: 2400 };

async function main() {
  const args = process.argv.slice(2), stage = args.shift();
  if (!stage || ['help', '--help', '-h'].includes(stage)) { console.log(help); return; }
  const values = {};
  while (args.length) {
    const arg = args.shift();
    if (!['--config', '--ids', '--match', '--limit', '--text', '--image', '--port'].includes(arg)) throw Error(`Unknown option ${arg}`);
    const value = args.shift();
    if (value === undefined) throw Error(`Missing value for ${arg}`);
    values[arg] = value;
  }
  if (!['scale', 'plan', 'frames', 'classify', 'rescore', 'report', 'try', 'review'].includes(stage)) throw Error('Unknown command; use --help');
  const config = await configuration(path.resolve(values['--config'] || 'config.json'));
  const scale = await loadScale(config.scale);
  const log = message => console.log(`[${new Date().toLocaleTimeString()}] ${message}`);

  if (stage === 'scale') {
    console.log(JSON.stringify({
      scale: scale.name, path: config.scale, questionsHash: scale.questionsHash, threshold: scale.rules.threshold,
      levels: scale.rules.levels.map(l => `${l.label}: ${l.summary}`),
      visualQuestions: Object.keys(scale.visual.questions), verbalQuestions: Object.keys(scale.verbal.questions)
    }, null, 2));
    return;
  }
  if (stage === 'try') {
    const api = client(config, log);
    const kind = values['--image'] ? 'visual' : 'verbal';
    const { preamble, questions } = scale[kind];
    let state, identity;
    if (values['--image']) {
      const file = path.resolve(values['--image']);
      const ext = path.extname(file).slice(1).toLowerCase().replace('jpg', 'jpeg');
      if (!['jpeg', 'png', 'webp'].includes(ext)) throw Error('Image must be JPEG, PNG or WebP');
      const bytes = await fs.readFile(file);
      identity = { model: config.model, kind, preamble, questions, image: hash(bytes) };
      state = [preamble, { type: 'image_url', image_url: { url: `data:image/${ext};base64,${bytes.toString('base64')}` } }];
    } else {
      if (!values['--text']) throw Error('Provide --text "..." or --image file');
      identity = { model: config.model, kind, preamble, questions, text: hash(values['--text']) };
      state = [preamble, values['--text']];
    }
    const r = await api.decide({ identity, questions, body: () => ({ state }), meta: { trace: { trace_name: scale.name, generation_name: `try-${kind}` } } });
    if (r.blocked) { console.log(JSON.stringify({ blocked: true, error: r.error }, null, 2)); return; }
    const e = evaluate(kind, r.answers, scale.rules);
    console.log(JSON.stringify({ label: scale.rules.levels.find(l => l.level === e.level).label, ...e, answers: r.answers, usage: r.usage, cached: !!r.cached }, null, 2));
    return;
  }

  if (stage === 'review') {
    const { url, labelsFile } = await serveReview(config, scale, Number(values['--port'] || 4317));
    console.log(`Review page: ${url}
Labels are saved to ${labelsFile}
Ctrl+C to stop.`);
    return;
  }
  const release = await acquireLock(config.stateDir);
  try {
    if (stage === 'rescore') { console.log(JSON.stringify({ ...await rescore(config, scale, log), ...await writeReport(config, scale) }, null, 2)); return; }
    if (stage === 'report') { console.log(JSON.stringify(await writeReport(config, scale), null, 2)); return; }

    let videos = await scanLibrary(config.mediaDir);
    if (values['--ids']) {
      const ids = values['--ids'].split(',');
      for (const id of ids) if (!videos.some(v => v.id === id)) throw Error(`Unknown ID: ${id}`);
      videos = videos.filter(v => ids.includes(v.id));
    }
    if (values['--match']) videos = videos.filter(v => v.name.toLowerCase().includes(values['--match'].toLowerCase()));
    if (values['--limit']) videos = videos.slice(0, Number(values['--limit']));
    if (!videos.length) throw Error('No videos selected');
    const mediaSlot = limit(config.mediaConcurrency);

    if (stage === 'plan') {
      let frames = 0, windows = 0, seconds = 0, scenesKnown = 0, noTranscript = 0;
      for (const v of videos) {
        const media = await fs.readFile(path.join(videoDir(config, v.id), 'media.json'), 'utf8').then(JSON.parse).catch(() => null);
        const duration = media?.duration ?? await probeDuration(v.file, config);
        if (media?.scenes) scenesKnown++;
        seconds += duration;
        frames += planFrames(duration, media?.scenes ?? [], config).length;
        windows += Math.max(1, Math.round(duration / config.windowSeconds));
        if (!Object.keys(v.transcripts).length) noTranscript++;
      }
      const sceneAllowance = (videos.length - scenesKnown) * config.maxSceneFrames;
      const tokens = (frames + sceneAllowance) * EST.frame + windows * EST.window + videos.length * EST.title;
      console.log(JSON.stringify({
        videos: videos.length, hours: +(seconds / 3600).toFixed(2), videosWithoutTranscripts: noTranscript,
        frames, sceneFramesNotYetDetected: sceneAllowance ? `up to ${sceneAllowance}` : 0, transcriptWindows: windows,
        estimatedInputTokens: tokens, estimatedUsd: +(tokens * config.inputUsdPerMillion / 1e6).toFixed(2),
        maxRunCostUsd: config.maxRunCostUsd,
        note: 'Upper-bound estimate; empty transcript windows are skipped and cached answers are free.'
      }, null, 2));
      return;
    }
    if (stage === 'frames') {
      let count = 0;
      const outcomes = await pool(videos, config.videoConcurrency, async v => {
        const media = await prepare(v, config, mediaSlot);
        const plan = planFrames(media.duration, media.scenes, config);
        await Promise.all(plan.map(f => mediaSlot(() => extractFrame(v.file, f.t, frameFile(path.join(videoDir(config, v.id), 'frames'), f.t), config))));
        count += plan.length;
        log(`${v.id}: ${plan.length} frames (${plan.filter(f => f.source === 'scene').length} from scene cuts)`);
      });
      const failed = outcomes.filter(o => o.status === 'rejected');
      for (const f of failed) log(`FAILED: ${f.reason.message}`);
      console.log(JSON.stringify({ videos: videos.length, frames: count, failed: failed.length }, null, 2));
      if (failed.length) process.exitCode = 1;
      return;
    }
    // classify
    const api = client(config, log);
    const ctx = { config, scale, api, apiSlot: limit(config.apiConcurrency), mediaSlot, log };
    const outcome = await classifyAll(videos, ctx);
    const report = await writeReport(config, scale);
    console.log(JSON.stringify({ ...outcome, usage: api.stats(), report }, null, 2));
    if (outcome.failures.length) process.exitCode = 1;
  } finally { await release(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
