// Library scanning, filename metadata and transcript windows. Read-only on mediaDir.
import fs from 'node:fs/promises';
import path from 'node:path';
import { exists, hash } from './core.mjs';

const VIDEO = /\.(mp4|mkv|mov|webm)$/i;

// "YYYY-MM-DD - English Title — Korean Title emoji [ID]" (an example library naming scheme).
// Anything that does not match keeps its whole stem as the English title.
export function parseName(stem) {
  const id = stem.match(/\s\[([\w-]+)\]$/)?.[1];
  const rest = stem.replace(/\s\[[\w-]+\]$/, '');
  const date = rest.match(/^(\d{4}-\d{2}-\d{2}) - /)?.[1] ?? null;
  const titles = date ? rest.slice(date.length + 3) : rest;
  const [en, ko = ''] = titles.split(' — ');
  return { id: id ?? 'local-' + hash(stem).slice(0, 12), date, titleEn: en.trim(), titleKo: ko.trim() };
}

export async function scanLibrary(mediaDir, languages = ['ko', 'en']) {
  const entries = await fs.readdir(mediaDir, { withFileTypes: true });
  const videos = [];
  for (const e of entries.filter(e => e.isFile() && VIDEO.test(e.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const stem = e.name.replace(VIDEO, '');
    const transcripts = {};
    for (const lang of languages) {
      const file = path.join(mediaDir, `${stem}.${lang}.srt`);
      if (await exists(file)) transcripts[lang] = file;
    }
    videos.push({ ...parseName(stem), file: path.join(mediaDir, e.name), name: e.name, transcripts });
  }
  const seen = new Set();
  for (const v of videos) { if (seen.has(v.id)) throw Error(`Duplicate video ID ${v.id}: ${v.name}`); seen.add(v.id); }
  return videos;
}

export function parseSrt(text) {
  const seconds = t => t.replace(',', '.').split(':').reduce((sum, x) => sum * 60 + Number(x), 0);
  const body = text.replace(/^﻿/, '').replace(/\r/g, '').trim();
  if (!body) return [];
  return body.split(/\n\s*\n/).map((block, i) => {
    const lines = block.split('\n');
    const match = lines[1]?.match(/^(\d{2,}:[0-5]\d:[0-5]\d,\d{3}) --> (\d{2,}:[0-5]\d:[0-5]\d,\d{3})$/);
    if (!/^\d+$/.test(lines[0]) || !match) throw Error(`Malformed SRT block ${i + 1}`);
    return { start: seconds(match[1]), end: seconds(match[2]), text: lines.slice(2).join(' ').trim() };
  });
}

export const clock = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// Fixed windows; a tail shorter than a fifth of a window joins the previous one.
// A cue belongs to the window containing its start, so no line is sent twice.
export function transcriptWindows(duration, cuesByLanguage, windowSeconds) {
  const windows = [];
  for (let start = 0; start < duration; start += windowSeconds) {
    let end = Math.min(duration, start + windowSeconds);
    if (duration - end < windowSeconds / 5) end = duration;
    windows.push({ index: windows.length, start, end, lines: {} });
    if (end === duration) break;
  }
  for (const [lang, cues] of Object.entries(cuesByLanguage)) {
    for (const w of windows) {
      const last = w.end === duration;
      w.lines[lang] = cues.filter(c => c.start >= w.start && (last || c.start < w.end) && c.text)
        .map(c => `[${clock(c.start)}] ${c.text}`);
    }
  }
  return windows;
}

const LANGUAGE_NAMES = { ko: 'Korean (original)', en: 'English (translation)' };
export function windowText(w) {
  const parts = Object.entries(w.lines).filter(([, lines]) => lines.length)
    .map(([lang, lines]) => `${LANGUAGE_NAMES[lang] ?? lang}:\n${lines.join('\n')}`);
  return parts.length ? `Spoken transcript, ${clock(w.start)}–${clock(w.end)}.\n\n${parts.join('\n\n')}` : '';
}
