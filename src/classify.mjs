// Per-video pipeline: probe → scenes → frames → Decisions (frames, transcript windows, title)
// → answers.json → rules → result.json → corpus report. Every stage is cached and resumable.
import fs from 'node:fs/promises';
import path from 'node:path';
import { hash, pool, readJSON, writeJSON } from './core.mjs';
import { clock, parseSrt, transcriptWindows, windowText } from './corpus.mjs';
import { detectScenes, extractFrame, frameFile, planFrames, probeDuration } from './frames.mjs';
import { evaluate, rateVideo, scoreSequence } from './scale.mjs';

export const videoDir = (config, id) => path.join(config.stateDir, 'videos', id);

export async function prepare(video, config, mediaSlot) {
  const file = path.join(videoDir(config, video.id), 'media.json');
  const { size, mtimeMs } = await fs.stat(video.file);
  const wantScenes = config.maxSceneFrames > 0;
  let meta = await readJSON(file, null);
  const stale = !meta || meta.size !== size || meta.mtimeMs !== mtimeMs
    || (wantScenes && meta.sceneThreshold !== config.sceneThreshold);
  if (stale) {
    const duration = await mediaSlot(() => probeDuration(video.file, config));
    const scenes = wantScenes ? await mediaSlot(() => detectScenes(video.file, config)) : null;
    meta = { size, mtimeMs, duration, sceneThreshold: wantScenes ? config.sceneThreshold : null, scenes };
    await writeJSON(file, meta);
  }
  return { ...meta, scenes: meta.scenes ?? [] };
}

const record = r => r.blocked
  ? { blocked: true, error: r.error?.message ?? String(r.status), ...(r.refused ? { refused: r.refused } : {}) }
  : { answers: r.answers, tokens: r.usage.input_tokens, generationId: r.id, ...(r.refused ? { refused: r.refused } : {}) };

// Which questions OpenAI declined, and how often, across frames or windows.
export const refusalCounts = items => items.reduce((acc, i) => {
  for (const q of i.refused ?? []) acc[q] = (acc[q] ?? 0) + 1;
  return acc;
}, {});

function textRequest(api, scale, config, video, text, span) {
  const { preamble, questions } = scale.verbal;
  return api.decide({
    identity: { model: config.model, kind: 'verbal', preamble, questions, text: hash(text) },
    questions, body: () => ({ state: [preamble, text] }),
    meta: { session_id: video.id, trace: { trace_name: scale.name, generation_name: 'verbal', span_name: span } }
  });
}

export async function classifyVideo(video, { config, scale, api, apiSlot, mediaSlot, log }) {
  const dir = videoDir(config, video.id);
  const media = await prepare(video, config, mediaSlot);
  const plan = planFrames(media.duration, media.scenes, config);
  const { preamble, questions } = scale.visual;

  const frames = await Promise.all(plan.map(async f => {
    const file = frameFile(path.join(dir, 'frames'), f.t);
    await mediaSlot(() => extractFrame(video.file, f.t, file, config));
    const bytes = await fs.readFile(file);
    const r = await apiSlot(() => api.decide({
      identity: { model: config.model, kind: 'visual', preamble, questions, image: hash(bytes) },
      questions,
      body: () => ({ state: [preamble, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + bytes.toString('base64') } }] }),
      meta: { session_id: video.id, trace: { trace_name: scale.name, generation_name: 'frame', span_name: `frame ${clock(f.t)}` } }
    }));
    return { ...f, ...record(r) };
  }));

  const cues = {};
  for (const [lang, file] of Object.entries(video.transcripts)) cues[lang] = parseSrt(await fs.readFile(file, 'utf8'));
  const windows = await Promise.all(transcriptWindows(media.duration, cues, config.windowSeconds).map(async w => {
    const text = windowText(w);
    const base = { index: w.index, start: w.start, end: w.end, chars: text.length };
    if (!text) return { ...base, empty: true };
    return { ...base, ...record(await apiSlot(() => textRequest(api, scale, config, video, text, `window ${clock(w.start)}`))) };
  }));

  const titleText = `Video title.\nEnglish: ${video.titleEn}${video.titleKo ? `\nKorean: ${video.titleKo}` : ''}`;
  const title = record(await apiSlot(() => textRequest(api, scale, config, video, titleText, 'title')));

  const doc = {
    video: { id: video.id, name: video.name, date: video.date, titleEn: video.titleEn, titleKo: video.titleKo, transcripts: Object.keys(video.transcripts) },
    duration: media.duration, scale: scale.name, questionsHash: scale.questionsHash, model: config.model,
    classifiedAt: new Date().toISOString(), frames, windows, title
  };
  await writeJSON(path.join(dir, 'answers.json'), doc);
  const result = score(doc, scale.rules);
  await writeJSON(path.join(dir, 'result.json'), result);
  log(`${video.id} ${result.label ?? 'unrated'} (sustained ${result.sustainedLabel ?? '-'}) · ${frames.length} frames, ${windows.filter(w => !w.empty).length} windows`);
  return result;
}

export function score(doc, rules) {
  const frameSeq = scoreSequence('visual', doc.frames.map(f => ({ start: f.start, end: f.end, at: f.t, answers: f.answers ?? null, refused: f.refused ?? [] })), rules);
  const windowSeq = scoreSequence('verbal', doc.windows.filter(w => !w.empty).map(w => ({ start: w.start, end: w.end, answers: w.answers ?? null, refused: w.refused ?? [] })), rules);
  const frameItems = frameSeq.scored, windowItems = windowSeq.scored;
  const visual = frameSeq.aggregate, verbal = windowSeq.aggregate;
  const title = doc.title?.answers ? evaluate('verbal', doc.title.answers, rules) : null;
  const tokens = [...doc.frames, ...doc.windows, doc.title].reduce((s, x) => s + (x?.tokens ?? 0), 0);
  return {
    id: doc.video.id, name: doc.video.name, date: doc.video.date, titleEn: doc.video.titleEn, titleKo: doc.video.titleKo,
    minutes: +(doc.duration / 60).toFixed(1), scale: doc.scale, model: doc.model,
    ...rateVideo({ visual, verbal, title }, rules),
    visual, verbal, title,
    blocked: { frames: doc.frames.filter(f => f.blocked).length, windows: doc.windows.filter(w => w.blocked).length, title: !!doc.title?.blocked },
    refusals: { frames: refusalCounts(doc.frames), windows: refusalCounts(doc.windows), title: doc.title?.refused ?? [] },
    inputTokens: tokens,
    timeline: {
      frames: frameItems.map((f, i) => ({ t: f.at, source: doc.frames[i].source, level: f.level, fired: f.fired, refused: f.refused, adjusted: f.adjusted ?? [] })),
      windows: windowItems.map(w => ({ start: w.start, end: w.end, level: w.level, fired: w.fired, refused: w.refused, adjusted: w.adjusted ?? [] }))
    }
  };
}

export async function classifyAll(videos, ctx) {
  const { config, log } = ctx;
  let done = 0;
  const outcomes = await pool(videos, config.videoConcurrency, async v => {
    try { return await classifyVideo(v, ctx); }
    finally { done++; const s = ctx.api.stats(); log(`progress ${done}/${videos.length} · ${s.requests} requests, ${s.cached} cached, ${s.blocked} blocked · $${s.costUsd.toFixed(4)}`); }
  });
  const failures = outcomes.map((o, i) => o.status === 'rejected' ? { id: videos[i].id, error: o.reason.message } : null).filter(Boolean);
  for (const f of failures) log(`FAILED ${f.id}: ${f.error}`);
  return { classified: outcomes.length - failures.length, failures };
}

// Re-applies rules.json to every cached answers.json; no API calls.
export async function rescore(config, scale, log) {
  const root = path.join(config.stateDir, 'videos');
  const ids = await fs.readdir(root).catch(() => []);
  let count = 0, skipped = 0;
  for (const id of ids) {
    const doc = await readJSON(path.join(root, id, 'answers.json'), null);
    if (!doc) continue;
    if (doc.questionsHash !== scale.questionsHash) { skipped++; log(`skip ${id}: answers were made with different questions`); continue; }
    await writeJSON(path.join(root, id, 'result.json'), score(doc, scale.rules)); count++;
  }
  return { rescored: count, skipped };
}

const csvCell = v => v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
export async function writeReport(config, scale) {
  const root = path.join(config.stateDir, 'videos');
  const results = [];
  for (const id of await fs.readdir(root).catch(() => [])) {
    const r = await readJSON(path.join(root, id, 'result.json'), null);
    if (r) results.push(r);
  }
  results.sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.id.localeCompare(b.id));
  const flagNames = [...new Set(results.flatMap(r => [...Object.keys(r.visual.flags), ...Object.keys(r.verbal.flags)].map(n => n)))];
  const columns = {
    id: r => r.id, date: r => r.date, title_en: r => r.titleEn, title_ko: r => r.titleKo, minutes: r => r.minutes,
    rating: r => r.rating, label: r => r.label, sustained: r => r.sustained, driver: r => r.driver, title_level: r => r.titleLevel,
    rating_from: r => r.ratingFrom, peak: r => r.peak, confirmed_peak: r => r.confirmedPeak,
    visual_peak: r => r.visual.peak, visual_confirmed: r => r.visual.confirmedPeak, visual_sustained: r => r.visual.sustained, visual_share_ge3: r => r.visual.shareAtLeast3,
    verbal_peak: r => r.verbal.peak, verbal_confirmed: r => r.verbal.confirmedPeak, verbal_sustained: r => r.verbal.sustained, verbal_share_ge3: r => r.verbal.shareAtLeast3,
    frames_adjusted: r => r.timeline.frames.filter(f => f.adjusted?.length).length,
    ...Object.fromEntries(flagNames.map(n => [`flag_${n}`, r => (r.visual.flags[n] ?? r.verbal.flags[n])?.count ?? ''])),
    ...Object.fromEntries(flagNames.map(n => [`max_${n}`, r => (r.visual.flags[n] ?? r.verbal.flags[n])?.maxStrength ?? ''])),
    frames: r => r.visual.items, windows: r => r.verbal.items,
    blocked_frames: r => r.blocked.frames, blocked_windows: r => r.blocked.windows,
    frames_with_refusals: r => r.timeline.frames.filter(f => f.refused.length).length,
    refused_questions: r => Object.entries({ ...r.refusals.frames }).map(([q, n]) => `${q}:${n}`).join(' '),
    input_tokens: r => r.inputTokens, cost_usd: r => +(r.inputTokens * config.inputUsdPerMillion / 1e6).toFixed(6)
  };
  const csv = [Object.keys(columns).join(','), ...results.map(r => Object.values(columns).map(f => csvCell(f(r))).join(','))].join('\n') + '\n';
  const dir = path.join(config.stateDir, 'report');
  await writeJSON(path.join(dir, 'results.json'), { scale: scale.name, levels: scale.rules.levels, generatedAt: new Date().toISOString(), results });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'results.csv'), '﻿' + csv);
  const distribution = Object.fromEntries(scale.rules.levels.map(l => [l.label, results.filter(r => r.rating === l.level).length]));
  return { videos: results.length, distribution, dir };
}
