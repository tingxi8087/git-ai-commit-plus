import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { parseUsage, UsageStore } from '../src/usage';

const tokens = { input: 100, output: 20, total: 120, cacheHit: 70, cacheMiss: 30 };

test('parses cache hits and misses as parts of input, without double counting', () => {
  assert.deepEqual(parseUsage({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 70, prompt_cache_miss_tokens: 30 }), tokens);
  assert.deepEqual(parseUsage({ prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 70 } }), tokens);
  assert.deepEqual(parseUsage({ prompt_tokens: 100, completion_tokens: 20, prompt_cache_miss_tokens: 30 }), tokens);
});

test('unreported or inconsistent cache detail remains unknown rather than zero or invented', () => {
  for (const cache of [{}, { prompt_cache_hit_tokens: 200 }, { prompt_cache_hit_tokens: 40, prompt_cache_miss_tokens: 30 }]) {
    assert.deepEqual(parseUsage({ prompt_tokens: 100, completion_tokens: 20, ...cache }), { input: 100, output: 20, total: 120 });
  }
  for (const value of [undefined, {}, { prompt_tokens: -1, completion_tokens: 2 }, { prompt_tokens: 1.5, completion_tokens: 2 }, { prompt_tokens: '100', completion_tokens: 2 }]) {
    assert.equal(parseUsage(value), undefined);
  }
});

test('persists model-separated totals including tests and preserves missing usage as unreported', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-commit-usage-'));
  try {
    let notifications = 0;
    const store = new UsageStore(directory, () => { notifications++; });
    await store.record('deepseek', 'deepseek-flash', 'generate', tokens);
    await store.record('deepseek', 'deepseek-flash', 'test', { input: 10, output: 2, total: 12 });
    await store.record('deepseek', 'deepseek-flash', 'generate');
    await store.record('deepseek', 'deepseek-v4-pro', 'generate', tokens);
    const data = await new UsageStore(directory).snapshot();
    assert.equal(data.models.length, 2);
    assert.deepEqual(data.models[0], {
      provider: 'deepseek', model: 'deepseek-flash', requests: 3, unreported: 1, tests: 1,
      input: 110, output: 22, total: 132, cacheHit: 70, cacheMiss: 30, cacheUnknown: 10
    });
    assert.equal(data.models[1].total, 120); assert.equal(notifications, 4);
    assert.doesNotMatch(await readFile(path.join(directory, 'usage-v1.json'), 'utf8'), /apiKey|messages|diff/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('concurrent writers across instances merge all records without lost updates', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-commit-usage-'));
  try {
    const first = new UsageStore(directory); const second = new UsageStore(directory);
    await Promise.all(Array.from({ length: 40 }, (_, index) => (index % 2 ? first : second).record('deepseek', 'deepseek-flash', 'generate', tokens)));
    const [row] = (await first.snapshot()).models;
    assert.equal(row.requests, 40); assert.equal(row.input, 4000); assert.equal(row.total, 4800);
    assert.equal(row.cacheHit + row.cacheMiss + row.cacheUnknown, row.input);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a corrupt existing file is preserved and a failed write does not poison future requests', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-commit-usage-'));
  try {
    const file = path.join(directory, 'usage-v1.json'); await writeFile(file, 'corrupt');
    const store = new UsageStore(directory);
    await assert.rejects(store.record('deepseek', 'deepseek-flash', 'generate', tokens));
    assert.equal(await readFile(file, 'utf8'), 'corrupt');
    await rm(file);
    await store.record('deepseek', 'deepseek-flash', 'generate', tokens);
    assert.equal((await store.snapshot()).models[0].total, 120);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
