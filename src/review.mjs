// Local review server: browse classified videos frame by frame and record ground-truth labels.
// Binds to 127.0.0.1 only. Labels go to state/review/labels.json for calibration.
import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJSON, writeJSON } from './core.mjs';
import { parseSrt, scanLibrary, transcriptWindows, windowText } from './corpus.mjs';
import { videoDir } from './classify.mjs';

const PAGE = fileURLToPath(new URL('./review/index.html', import.meta.url));

export async function serveReview(config, scale, port = 4317) {
  const library = new Map((await scanLibrary(config.mediaDir)).map(v => [v.id, v]));
  const labelsFile = path.join(config.stateDir, 'review', 'labels.json');
  let labels = await readJSON(labelsFile, { videos: {}, frames: {}, windows: {} });
  let writing = Promise.resolve();

  const classified = async () => {
    const ids = await fs.readdir(path.join(config.stateDir, 'videos')).catch(() => []);
    const out = [];
    for (const id of ids) {
      const result = await readJSON(path.join(videoDir(config, id), 'result.json'), null);
      if (result) out.push(result);
    }
    return out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  };
  const before = id => readJSON(path.join(config.stateDir, 'experiments', 'before-fixes', id + '.json'), null);

  async function overview() {
    const videos = [];
    for (const r of await classified()) {
      const b = await before(r.id);
      videos.push({
        id: r.id, name: r.name, date: r.date, titleEn: r.titleEn, titleKo: r.titleKo, minutes: r.minutes,
        rating: r.rating, sustained: r.sustained, confirmedPeak: r.confirmedPeak, ratingFrom: r.ratingFrom, driver: r.driver, titleLevel: r.titleLevel,
        visual: { peak: r.visual.peak, sustained: r.visual.sustained, shareAtLeast3: r.visual.shareAtLeast3 },
        verbal: { peak: r.verbal.peak, sustained: r.verbal.sustained, shareAtLeast3: r.verbal.shareAtLeast3 },
        refusedFrames: r.timeline.frames.filter(f => f.refused?.length).length,
        frames: r.timeline.frames.map(f => [f.t, f.level, f.fired, f.refused ?? []]),
        windows: r.timeline.windows.map(w => [w.start, w.level, w.fired]),
        before: b ? { rating: b.rating, sustained: b.sustained } : null
      });
    }
    const heuristics = (scale.rules.heuristics ?? []).map(h => ({ use: h.use, enabled: h.enabled !== false, kinds: h.kinds, options: h.options }));
    return { scale: scale.name, threshold: scale.rules.threshold, levels: scale.rules.levels, heuristics, videos, labels };
  }

  async function video(id) {
    const v = library.get(id);
    const doc = await readJSON(path.join(videoDir(config, id), 'answers.json'), null);
    const result = await readJSON(path.join(videoDir(config, id), 'result.json'), null);
    if (!doc || !result) return null;
    const b = await before(id);
    const beforeLevels = new Map((b?.timeline.frames ?? []).map(f => [f.t, f.level]));
    const cues = {};
    for (const [lang, file] of Object.entries(v?.transcripts ?? {})) cues[lang] = parseSrt(await fs.readFile(file, 'utf8'));
    const texts = new Map(transcriptWindows(doc.duration, cues, config.windowSeconds).map(w => [w.start, windowText(w)]));
    return {
      result: { ...result, timeline: undefined },
      frames: doc.frames.map((f, i) => ({
        t: f.t, source: f.source, start: f.start, end: f.end, file: path.basename(frameUrl(f.t)),
        level: result.timeline.frames[i]?.level ?? null, fired: result.timeline.frames[i]?.fired ?? [],
        before: beforeLevels.get(f.t) ?? null, refused: f.refused ?? [], blocked: !!f.blocked, answers: f.answers ?? null,
        adjusted: result.timeline.frames[i]?.adjusted ?? []
      })),
      windows: doc.windows.filter(w => !w.empty).map((w, i) => ({
        start: w.start, end: w.end, level: result.timeline.windows[i]?.level ?? null, fired: result.timeline.windows[i]?.fired ?? [],
        refused: w.refused ?? [], blocked: !!w.blocked, answers: w.answers ?? null, text: texts.get(w.start) ?? ''
      })),
      title: { text: `${doc.video.titleEn}${doc.video.titleKo ? ' — ' + doc.video.titleKo : ''}`, answers: doc.title?.answers ?? null, level: result.title?.level ?? null, fired: result.title?.fired ?? [] },
      questions: { visual: scale.visual.questions, verbal: scale.verbal.questions }
    };
  }
  const frameUrl = t => `t${t.toFixed(2).padStart(9, '0')}.jpg`;

  const send = (res, status, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, await fs.readFile(PAGE), 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/api/overview') return send(res, 200, await overview());
      let m = url.pathname.match(/^\/api\/video\/([\w-]+)$/);
      if (req.method === 'GET' && m) { const v = await video(m[1]); return v ? send(res, 200, v) : send(res, 404, { error: 'not found' }); }
      m = url.pathname.match(/^\/frames\/([\w-]+)\/(t[\d.]+\.jpg)$/);
      if (req.method === 'GET' && m) {
        const file = path.join(videoDir(config, m[1]), 'frames', m[2]);
        try { await fs.access(file); } catch { return send(res, 404, 'no frame', 'text/plain'); }
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=86400' });
        return createReadStream(file).pipe(res);
      }
      if (req.method === 'POST' && url.pathname === '/api/labels') {
        let raw = '';
        for await (const chunk of req) { raw += chunk; if (raw.length > 1e5) return send(res, 413, { error: 'too large' }); }
        const { scope, key, value } = JSON.parse(raw);
        if (!['videos', 'frames', 'windows'].includes(scope) || typeof key !== 'string' || !/^[\w-]+(@[\d.]+)?$/.test(key)) return send(res, 400, { error: 'bad label' });
        if (value === null) delete labels[scope][key];
        else labels[scope][key] = { ...value, updatedAt: new Date().toISOString() };
        writing = writing.then(() => writeJSON(labelsFile, labels));
        await writing;
        return send(res, 200, { ok: true });
      }
      send(res, 404, { error: 'not found' });
    } catch (e) { send(res, 500, { error: e.message }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${port}/`, labelsFile, close: () => new Promise(r => server.close(r)) };
}
