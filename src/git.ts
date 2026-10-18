import { execFile, spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ChangeContext, Scope } from './types';

interface Change { status: string; file: string; original?: string }
const MAX_CONTEXT = 60_000;
const MAX_FILE = 20_000;
const TRUNCATION = '\n[详细 diff 已截断；请结合全部文件摘要]';
interface FileContext {
  change: Change;
  summary: string;
  reason?: string;
  content?: string;
  readLimit?: boolean;
  summaryOnly?: boolean;
}

export function runGit(root: string, args: string[], signal?: AbortSignal, executable = 'git'): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, ['--literal-pathspecs', ...args], {
      cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 15_000,
      signal, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

export function parseStatus(output: string): Change[] {
  const parts = output.split('\0');
  const result: Change[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) { continue; }
    const status = entry.slice(0, 2);
    const change: Change = { status, file: entry.slice(3) };
    if (/[RC]/.test(status)) { change.original = parts[++i]; }
    result.push(change);
  }
  return result;
}

export function excluded(file: string): boolean {
  const normalized = file.replaceAll('\\', '/');
  const base = path.posix.basename(normalized).toLowerCase();
  return /(^|\/)(node_modules|dist|build|vendor|\.git|\.ssh|\.aws|\.azure|\.gnupg)(\/|$)/i.test(normalized) ||
    /^\.env($|\.)/.test(base) ||
    /^(\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials(?:\..*)?|secrets?(?:\..*)?|id_rsa(?:\..*)?|id_ed25519(?:\..*)?|service[-_]?account.*\.json)$/.test(base) ||
    /\.(pem|key|p12|pfx|keystore|jks|lock|png|jpe?g|gif|webp|ico|pdf|zip|gz|mp[34]|woff2?|ttf|dmg|exe|vsix)$/i.test(base) ||
    /^(package-lock\.json|npm-shrinkwrap\.json|bun\.lockb)$/.test(base);
}

export function redact(text: string): string {
  return text
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/g, '[已移除私钥]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g, '[已移除密钥]')
    .replace(/((?:api[_-]?key|access[_-]?token|secret|password)\s*["']?\s*[:=]\s*["'])([^"'\r\n]+)(["'])/gi, '$1[已移除敏感值]$3');
}

// Read only the allocated preview, then stop git. Large patches never fill memory.
export function readDiffPreview(root: string, args: string[], limit: number, signal?: AbortSignal, executable = 'git'): Promise<{ text: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    let text = '';
    let truncated = false;
    let timedOut = false;
    const child = spawn(executable, ['--literal-pathspecs', ...args], {
      cwd: root, signal, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
    });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 15_000);
    child.stdout.on('data', (chunk: Buffer) => {
      text += decoder.write(chunk);
      if (text.length > limit) { text = text.slice(0, limit); truncated = true; child.kill(); }
    });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (signal?.aborted) { reject(signal.reason); }
      else if (timedOut) { reject(new Error('读取 diff 超时。')); }
      else if (code !== 0 && !truncated) { reject(new Error('无法读取 diff。')); }
      else { resolve({ text: text.slice(0, limit), truncated }); }
    });
  });
}

export async function getRecentCommits(root: string, signal?: AbortSignal, executable = 'git'): Promise<string[]> {
  try {
    const output = await runGit(root, ['log', '-5', '--format=%s', '--no-decorate', '--no-show-signature'], signal, executable);
    return output.split(/\r?\n/).filter(Boolean).map(title => redact(title).slice(0, 200));
  } catch (error) {
    if (signal?.aborted) { throw error; }
    return []; // History is optional, including in repositories without a first commit.
  }
}

function parseNumstat(output: string): Map<string, { added: string; removed: string }> {
  const result = new Map<string, { added: string; removed: string }>();
  for (const record of output.split('\0')) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record);
    if (match) { result.set(match[3], { added: match[1], removed: match[2] }); }
  }
  return result;
}

export async function collectChanges(root: string, requested: Scope, signal?: AbortSignal, executable = 'git'): Promise<ChangeContext> {
  const git = (args: string[]) => runGit(root, args, signal, executable);
  let changes: Change[];
  try { changes = parseStatus(await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])); }
  catch (error) {
    if (signal?.aborted) { throw error; }
    throw new Error('无法读取 Git 仓库状态。请确认 Git 可用，且仓库可以正常访问。');
  }
  if (changes.some(c => c.status.includes('U') || ['AA', 'DD'].includes(c.status))) {
    throw new Error('仓库存在未解决的合并冲突，请先解决冲突。');
  }
  const staged = changes.filter(c => c.status[0] !== ' ' && c.status[0] !== '?');
  const scope = requested === 'auto' ? (staged.length ? 'staged' : 'all') : requested;
  const selected = scope === 'staged' ? staged : changes;
  if (!selected.length) { throw new Error(scope === 'staged' ? '没有已暂存的变更。可在配置中切换生成范围。' : '当前仓库没有变更。'); }
  let hasHead = true;
  try { await git(['rev-parse', '--verify', 'HEAD']); }
  catch (error) { if (signal?.aborted) { throw error; } hasHead = false; }
  const diffArgs = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames'];
  if (scope === 'staged' || !hasHead) { diffArgs.push('--cached'); }
  else { diffArgs.push('HEAD'); }
  const stats = parseNumstat(await git([...diffArgs, '--numstat', '-z']));
  const files: FileContext[] = [];
  // Phase one always covers the complete selection, before any patch consumes budget.
  for (const change of selected) {
    signal?.throwIfAborted();
    if (scope === 'all' && !hasHead && change.status === 'AD') { continue; }
    const stat = stats.get(change.file);
    const previous = change.original ? stats.get(change.original) : undefined;
    let counts = stat ? (stat.added === '-' ? '二进制' : `+${Number(stat.added) + Number(previous?.added ?? 0)} / -${Number(stat.removed) + Number(previous?.removed ?? 0)}`) : '变更';
    const status = scope === 'staged' ? change.status[0] : change.status.trim();
    const location = change.original ? `${JSON.stringify(change.original)} → ${JSON.stringify(change.file)}` : JSON.stringify(change.file);
    const entry: FileContext = { change, summary: '' };
    if (excluded(change.file) || (change.original && excluded(change.original))) { entry.reason = '默认排除内容'; }
    else if (stat?.added === '-') { entry.reason = '二进制内容'; }
    else if (change.status === '??' || (scope === 'all' && !hasHead)) {
      const absolute = path.resolve(root, change.file);
      if (!absolute.startsWith(path.resolve(root) + path.sep)) { throw new Error('文件不在仓库内。'); }
      const fileStat = await lstat(absolute);
      if (!fileStat.isFile()) { entry.reason = '非普通文件'; }
      else if (fileStat.size > 256_000) {
        counts = `新增，${fileStat.size} 字节`; entry.summaryOnly = true;
      } else {
        const raw = await readFile(absolute, 'utf8');
        if (raw.includes('\0') || raw.includes('\uFFFD')) { entry.reason = '二进制内容'; }
        else {
          counts = `+${raw ? raw.split('\n').length - Number(raw.endsWith('\n')) : 0} / -0`;
          const content = redact(`新增文件 ${JSON.stringify(change.file)}\n${raw}`);
          entry.content = content.slice(0, MAX_FILE);
          entry.readLimit = content.length > MAX_FILE;
        }
      }
    }
    entry.summary = redact(`${status} ${location} | ${counts}${entry.reason ? ` | ${entry.reason}，仅列路径状态` : entry.summaryOnly ? ' | 文件过大，仅摘要' : ''}`);
    files.push(entry);
  }
  const summary = files.map(file => file.summary).join('\n');
  if (summary.length > MAX_CONTEXT - 1000) {
    throw new Error('文件摘要已超过上下文上限，请缩小本次提交范围后重试。');
  }
  const eligible = files.filter(file => !file.reason);
  if (!eligible.length) { throw new Error('没有可发送的文本变更：所选变更均为敏感文件、二进制或默认排除文件。'); }
  const skipped = files.filter(file => file.reason).map(file => `${file.change.file}（${file.reason}）`);
  let text = '';
  let truncated = false;
  let detailed = 0;
  let remaining = MAX_CONTEXT - summary.length - 1000;
  // Stable round-robin allocation: later files receive their share even after large files.
  for (let index = 0; index < eligible.length; index++) {
    signal?.throwIfAborted();
    const file = eligible[index];
    const header = `\n--- ${redact(JSON.stringify(file.change.file))} ---\n`;
    const quota = Math.min(MAX_FILE, Math.floor(remaining / (eligible.length - index)));
    if (file.summaryOnly || quota < header.length + TRUNCATION.length + 128) { truncated = true; continue; }
    const limit = quota - header.length - TRUNCATION.length - 1;
    let content: string;
    let clipped: boolean;
    if (file.content !== undefined) { content = file.content.slice(0, limit); clipped = Boolean(file.readLimit) || file.content.length > limit; }
    else {
      const paths = file.change.original ? [file.change.original, file.change.file] : [file.change.file];
      try {
        const preview = await readDiffPreview(root, [...diffArgs, '--unified=3', '--', ...paths], limit, signal, executable);
        content = redact(preview.text); clipped = preview.truncated;
      } catch (error) {
        if (signal?.aborted) { throw error; }
        throw new Error(`读取 ${JSON.stringify(file.change.file)} 失败，请检查 Git 或文件状态。`);
      }
    }
    if (!content.trim()) { continue; }
    const block = header + content + (clipped ? TRUNCATION : '') + '\n';
    text += block; remaining -= block.length;
    truncated ||= clipped;
    detailed++;
  }
  const recentCommits = hasHead ? await getRecentCommits(root, signal, executable) : [];
  return { scope, text, summary, total: files.length, included: eligible.length, detailed, recentCommits, skipped, truncated };
}
