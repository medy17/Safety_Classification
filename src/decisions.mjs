// OpenRouter Decisions client: response cache, retries, cost ceiling and moderation handling.
// Adapted from Audeeeee's OpenRouter client.
import path from 'node:path';
import { hash, readJSON, writeJSON, sleep } from './core.mjs';

export const ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
export class FatalAPIError extends Error {}

// A refusal on content grounds is a result worth keeping, not a reason to stop the run.
export const isContentBlock = (status, data) => [400, 403].includes(status)
  && /moderat|flagged|content.?policy|safety|prohibited/i.test(JSON.stringify(data?.error ?? ''));

// OpenAI declines individual questions it won't answer about the content, surfaced by
// OpenRouter as 502 "OpenAI refused to answer question \"id\"".
export const refusedQuestion = (status, data) => status === 502
  ? (data?.error?.message ?? '').match(/refused to answer question "([^"]+)"/)?.[1] ?? null : null;

export function validateAnswers(questions) {
  return data => {
    if (data.blocked) return;
    const refused = new Set(data.refused ?? []);
    for (const [id, q] of Object.entries(questions)) {
      if (refused.has(id)) continue;
      const a = data.answers?.[id];
      if (!a || a.type !== q.type) throw Error(`Missing or mistyped answer: ${id}`);
      const value = { noul: a.noul, score: a.score, choice: a.probabilities?.[a.choice], box: 1 }[q.type];
      if (!Number.isFinite(value)) throw Error(`Malformed answer: ${id}`);
    }
    if (!Number.isInteger(data.usage?.input_tokens)) throw Error('Missing usage.input_tokens');
  };
}

export function client(config, log = () => {}, fetchImpl = globalThis.fetch) {
  let tokens = 0, requests = 0, cached = 0, blocked = 0, refusals = 0, fatal = null;
  const key = process.env.OPENROUTER_API_KEY;
  // Under BYOK, OpenRouter's usage.cost is 0; the provider bills input tokens at the listed rate.
  const spent = () => tokens * config.inputUsdPerMillion / 1e6;
  const headers = () => ({
    Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
    'X-Title': config.appName, 'X-OpenRouter-Title': config.appName,
    ...(config.appUrl ? { 'HTTP-Referer': config.appUrl } : {})
  });

  // identity: what makes the answer reusable (model, questions, content hashes); never base64.
  // body(): builds the full request lazily, so cached answers never read images from disk.
  // meta: session_id/trace for the OpenRouter dashboard; excluded from the cache key.
  async function decide({ identity, body, questions, meta = {} }) {
    const fingerprint = hash(JSON.stringify(identity));
    const cache = path.join(config.stateDir, 'responses', fingerprint.slice(0, 2), fingerprint + '.json');
    const validate = validateAnswers(questions);
    const saved = await readJSON(cache, null);
    if (saved) { validate(saved); cached++; return { ...saved, fingerprint, cached: true }; }
    if (!key) throw new FatalAPIError('Set OPENROUTER_API_KEY (e.g. node --env-file=.env.local)');
    if (fatal) throw fatal;
    if (spent() >= config.maxRunCostUsd) throw (fatal = new FatalAPIError(`Cost ceiling reached: $${spent().toFixed(4)} >= maxRunCostUsd`));
    const content = await body();
    const refused = [];
    const active = () => Object.fromEntries(Object.entries(questions).filter(([id]) => !refused.includes(id)));
    for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
      let delay = 1500 * 2 ** (attempt - 1);
      try {
        const payload = JSON.stringify({ model: config.model, ...content, questions: active(), ...meta });
        const response = await fetchImpl(ENDPOINT, { method: 'POST', headers: headers(), body: payload, signal: AbortSignal.timeout(180000) });
        const raw = await response.text();
        let data;
        try { data = JSON.parse(raw); } catch { data = { invalidJSON: raw.slice(0, 2000) }; }
        requests++;
        const retryAfter = Number(response.headers.get('retry-after'));
        if (Number.isFinite(retryAfter) && retryAfter > 0) delay = Math.min(retryAfter * 1000, 180000);
        const declined = refusedQuestion(response.status, data);
        if (declined && declined in active()) {
          // Drop the refused question and ask the rest again; this does not use up an attempt.
          refused.push(declined); refusals++; attempt--;
          // Keep the full refusal (body + response headers) to see whether a reason or generation ID is exposed.
          await writeJSON(path.join(config.stateDir, 'refusals', `${fingerprint}-${declined}.json`), {
            time: new Date().toISOString(), status: response.status, question: declined, response: data,
            headers: Object.fromEntries([...(response.headers?.entries?.() ?? [])].filter(([k]) => !/cookie|authorization/i.test(k)))
          });
          log(`refused ${declined}${refused.length > 1 ? ` (${refused.length} so far)` : ''}`);
          if (!Object.keys(active()).length) {
            const result = { blocked: true, refused, status: 502, error: data.error, time: new Date().toISOString() };
            await writeJSON(cache, result); blocked++;
            return { ...result, fingerprint };
          }
          continue;
        }
        if (!response.ok && isContentBlock(response.status, data)) {
          const result = { blocked: true, status: response.status, error: data.error, time: new Date().toISOString() };
          await writeJSON(cache, result); blocked++;
          log(`blocked (${response.status}): ${data.error?.message ?? 'content'}`);
          return { ...result, fingerprint };
        }
        if (!response.ok) {
          await writeJSON(path.join(config.stateDir, 'failures', `${fingerprint}-${Date.now()}.json`), { status: response.status, response: data });
          if ([400, 401, 402, 403, 404, 413].includes(response.status)) {
            throw (fatal = new FatalAPIError(`OpenRouter ${response.status}: ${data.error?.message || 'request rejected'}`));
          }
          throw Error(`OpenRouter ${response.status}: ${data.error?.message || 'request failed'}`);
        }
        validate({ ...data, refused });
        tokens += data.usage.input_tokens;
        const result = { id: data.id, model: data.model, provider: data.provider, answers: data.answers, usage: data.usage,
          ...(refused.length ? { refused } : {}), time: new Date().toISOString() };
        await writeJSON(cache, result);
        return { ...result, fingerprint };
      } catch (e) {
        if (e instanceof FatalAPIError || attempt === config.maxAttempts) throw e;
        log(`retry ${attempt}/${config.maxAttempts - 1}: ${e.message}`);
        await sleep(delay);
      }
    }
  }
  return {
    decide,
    stats: () => ({ requests, cached, blocked, refusals, inputTokens: tokens, costUsd: +spent().toFixed(6) }),
    get fatal() { return fatal; }
  };
}
