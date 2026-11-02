// Small primitives carried over from Audeeeee: hashing, atomic JSON, bounded concurrency,
// child processes and a PID lock.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function exists(file) {
  try { await fs.access(file); return true; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
export async function readJSON(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT' && arguments.length > 1) return fallback; throw e; }
}
export async function atomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.partial`;
  const handle = await fs.open(temporary, 'wx');
  try { await handle.writeFile(data); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temporary, file);
}
export const writeJSON = (file, data) => atomic(file, JSON.stringify(data, null, 2) + '\n');

export function limit(maximum) {
  let active = 0;
  const waiting = [];
  return async action => {
    if (active >= maximum) await new Promise(resolve => waiting.push(resolve));
    else active++;
    try { return await action(); }
    finally { if (waiting.length) waiting.shift()(); else active--; }
  };
}
export async function pool(items, concurrency, action) {
  let cursor = 0;
  const outcomes = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try { outcomes[i] = { status: 'fulfilled', value: await action(items[i], i) }; }
      catch (error) { outcomes[i] = { status: 'rejected', reason: error }; }
    }
  }));
  return outcomes;
}
// Resolves { stdout, stderr }. Both are tail-truncated so a chatty process cannot exhaust memory.
export function command(executable, args, timeout = 60 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', expired = false;
    const timer = setTimeout(() => { expired = true; child.kill(); }, timeout);
    child.stdout.on('data', b => { stdout = (stdout + b).slice(-8 * 1024 * 1024); });
    child.stderr.on('data', b => { stderr = (stderr + b).slice(-4 * 1024 * 1024); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0 && !expired) resolve({ stdout, stderr });
      else reject(Error(`${path.basename(executable)} ${expired ? 'timed out' : 'exited ' + code}: ${stderr.slice(-2000)}`));
    });
  });
}
// The lock lives in stateDir so the media library is never written to.
export async function acquireLock(dir) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, '.classify.lock');
  let handle;
  try { handle = await fs.open(file, 'wx'); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const old = await readJSON(file);
    if (!Number.isInteger(old.pid) || old.pid <= 0) throw Error('Invalid lock; inspect it manually.');
    try { process.kill(old.pid, 0); throw Error(`Another run is active (PID ${old.pid}).`); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    await fs.rename(file, file + '.stale-' + Date.now());
    handle = await fs.open(file, 'wx');
  }
  await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  await handle.close();
  return () => fs.unlink(file);
}
