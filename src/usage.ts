import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface TokenUsage {
  input: number;
  output: number;
  total: number;
  cacheHit?: number;
  cacheMiss?: number;
}
export interface ModelUsage {
  provider: string;
  model: string;
  requests: number;
  unreported: number;
  tests: number;
  input: number;
  cacheHit: number;
  cacheMiss: number;
  cacheUnknown: number;
  output: number;
  total: number;
}
export interface UsageSnapshot { version: 1; models: ModelUsage[] }
const empty = (): UsageSnapshot => ({ version: 1, models: [] });
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function parseUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== 'object') { return undefined; }
  const data = value as Record<string, unknown>;
  if (!count(data.prompt_tokens) || !count(data.completion_tokens)) { return undefined; }
  const input = data.prompt_tokens;
  const output = data.completion_tokens;
  const usage: TokenUsage = { input, output, total: count(data.total_tokens) ? data.total_tokens : input + output };
  const details = data.prompt_tokens_details as { cached_tokens?: unknown } | undefined;
  let hit = data.prompt_cache_hit_tokens ?? details?.cached_tokens;
  let miss = data.prompt_cache_miss_tokens;
  if (hit === undefined && count(miss) && miss <= input) { hit = input - miss; }
  if (miss === undefined && count(hit) && hit <= input) { miss = input - hit; }
  if (count(hit) && count(miss) && hit + miss === input) { usage.cacheHit = hit; usage.cacheMiss = miss; }
  return usage;
}

export class UsageStore {
  private queue = Promise.resolve();
  private readonly file: string;
  private readonly lock: string;
  constructor(private readonly directory: string, private readonly onChange: () => void = () => {}) {
    this.file = path.join(directory, 'usage-v1.json');
    this.lock = path.join(directory, 'usage-v1.lock');
  }
  async snapshot(): Promise<UsageSnapshot> {
    await this.queue;
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8')) as UsageSnapshot;
      const fields = ['requests', 'unreported', 'tests', 'input', 'cacheHit', 'cacheMiss', 'cacheUnknown', 'output', 'total'] as const;
      if (data.version !== 1 || !Array.isArray(data.models) || data.models.some(row =>
        typeof row.provider !== 'string' || typeof row.model !== 'string' || fields.some(field => !count(row[field])))) {
        throw new Error('用量记录格式异常。');
      }
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return empty(); }
      throw error;
    }
  }
  record(provider: string, model: string, purpose: 'generate' | 'test', usage?: TokenUsage): Promise<void> {
    const task = this.queue.then(async () => {
      await mkdir(this.directory, { recursive: true });
      await this.acquireLock();
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        // Read after taking the lock to merge requests from other VS Code windows.
        const data = await this.readWhileLocked();
        let row = data.models.find(item => item.provider === provider && item.model === model);
        if (!row) {
          row = { provider, model, requests: 0, unreported: 0, tests: 0, input: 0, cacheHit: 0, cacheMiss: 0, cacheUnknown: 0, output: 0, total: 0 };
          data.models.push(row);
        }
        row.requests++;
        if (purpose === 'test') { row.tests++; }
        if (!usage) { row.unreported++; }
        else {
          row.input += usage.input; row.output += usage.output; row.total += usage.total;
          if (usage.cacheHit !== undefined && usage.cacheMiss !== undefined) {
            row.cacheHit += usage.cacheHit; row.cacheMiss += usage.cacheMiss;
          } else { row.cacheUnknown += usage.input; }
        }
        await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
        await rename(temporary, this.file);
      } finally { await rm(temporary, { force: true }); await rm(this.lock, { recursive: true, force: true }); }
      this.onChange();
    });
    this.queue = task.catch(() => {});
    return task;
  }
  private async readWhileLocked(): Promise<UsageSnapshot> {
    // Separate reader avoids waiting on our own pending queue.
    return new UsageStore(this.directory).snapshot();
  }
  private async acquireLock() {
    const deadline = Date.now() + 5000;
    while (true) {
      try { await mkdir(this.lock); return; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
        try {
          if (Date.now() - (await stat(this.lock)).mtimeMs > 30_000) { await rm(this.lock, { recursive: true, force: true }); continue; }
        } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { continue; } throw error; }
        if (Date.now() >= deadline) { throw new Error('用量记录暂时忙，请稍后刷新。'); }
        await new Promise(resolve => setTimeout(resolve, 30));
      }
    }
  }
}
