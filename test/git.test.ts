import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, rename, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectChanges, excluded, parseStatus, redact, runGit } from '../src/git';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-commit-'));
  const git = (...args: string[]) => runGit(root, args);
  const write = (name: string, text: string | Buffer) => writeFile(path.join(root, name), text);
  await git('init');
  await git('config', 'user.name', 'Test');
  await git('config', 'user.email', 'test@example.invalid');
  const commit = async () => { await git('add', '.'); await git('commit', '-m', 'fixture'); };
  return { root, git, write, commit, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('auto uses the index version and excludes unstaged edits and new files when staged changes exist', async () => {
  const f = await fixture();
  try {
    await f.write('a.txt', 'base\n'); await f.commit();
    await f.write('a.txt', 'STAGED_ONLY\n'); await f.git('add', 'a.txt');
    await f.write('a.txt', 'UNSTAGED_ONLY\n'); await f.write('new.txt', 'UNTRACKED_ONLY\n');
    const result = await collectChanges(f.root, 'auto');
    assert.equal(result.scope, 'staged'); assert.equal(result.included, 1);
    assert.match(result.text, /STAGED_ONLY/); assert.doesNotMatch(result.text, /UNSTAGED_ONLY|UNTRACKED_ONLY/);
    const all = await collectChanges(f.root, 'all');
    assert.match(all.text, /UNSTAGED_ONLY/); assert.match(all.text, /UNTRACKED_ONLY/);
    assert.doesNotMatch(all.text, /\+STAGED_ONLY/);
  } finally { await f.cleanup(); }
});

test('auto falls back to all changes, includes new files and handles spaces and literal pathspec characters', async () => {
  const f = await fixture();
  try {
    await f.write('base', 'base\n'); await f.commit();
    await f.write('a [1] 文档.txt', 'new text'); await f.write('base', 'changed\n');
    const result = await collectChanges(f.root, 'auto');
    assert.equal(result.scope, 'all'); assert.equal(result.included, 2); assert.match(result.text, /new text/);
    await assert.rejects(collectChanges(f.root, 'staged'), /没有已暂存/);
  } finally { await f.cleanup(); }
});

test('unborn repositories support staged and untracked first commits', async () => {
  const f = await fixture();
  try {
    await f.write('a.txt', 'first');
    assert.match((await collectChanges(f.root, 'auto')).text, /first/);
    await f.git('add', '.');
    assert.equal((await collectChanges(f.root, 'auto')).scope, 'staged');
    assert.match((await collectChanges(f.root, 'all')).text, /first/);
  } finally { await f.cleanup(); }
});

test('renames and deletions are represented without reading a deleted file', async () => {
  const f = await fixture();
  try {
    await f.write('old name.txt', 'keep\n'); await f.write('delete.txt', 'remove\n'); await f.commit();
    await rename(path.join(f.root, 'old name.txt'), path.join(f.root, 'new name.txt'));
    await rm(path.join(f.root, 'delete.txt')); await f.git('add', '.');
    const result = await collectChanges(f.root, 'auto');
    assert.match(result.text, /new name/); assert.match(result.text, /old name/); assert.match(result.text, /-remove/);
  } finally { await f.cleanup(); }
});

test('exclusions and redaction prevent common credentials, binaries and lock content from being sent', async () => {
  const f = await fixture();
  try {
    await f.write('.env.local', 'password=never-send');
    await f.write('package-lock.json', 'never-send-lock');
    await f.write('raw.dat', Buffer.from([0, 1, 2]));
    await f.write('config.ts', 'const apiKey = "sk-123456789012345678901234";\n');
    const result = await collectChanges(f.root, 'auto');
    assert.equal(result.included, 1); assert.equal(result.skipped.length, 3);
    assert.doesNotMatch(result.text, /never-send|sk-123/); assert.match(result.text, /已移除/);
    assert.equal(excluded('nested/credentials.json'), true);
    assert.equal(excluded('nested/.aws/config'), true);
    assert.doesNotMatch(redact('-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----'), /secret/);
  } finally { await f.cleanup(); }
});

test('large contexts are bounded and explicitly marked', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 5; i++) { await f.write(`${i}.txt`, 'line\n'.repeat(10_000)); }
    const result = await collectChanges(f.root, 'auto');
    assert.equal(result.truncated, true); assert.ok(result.text.length <= 60_000); assert.match(result.text, /已截断/);
  } finally { await f.cleanup(); }
});

test('empty, excluded-only, cancelled and conflicted repositories fail clearly', async () => {
  const f = await fixture();
  try {
    await assert.rejects(collectChanges(f.root, 'auto'), /没有变更/);
    await f.write('.env', 'SECRET'); await assert.rejects(collectChanges(f.root, 'auto'), /没有可发送/);
    await rm(path.join(f.root, '.env')); await f.write('a', 'base\n'); await f.commit();
    const initialBranch = (await f.git('branch', '--show-current')).trim();
    await f.git('checkout', '-b', 'other'); await f.write('a', 'other\n'); await f.commit();
    await f.git('checkout', initialBranch); await f.write('a', 'main\n'); await f.commit();
    await assert.rejects(f.git('merge', 'other'));
    await assert.rejects(collectChanges(f.root, 'auto'), /合并冲突/);
    await assert.rejects(collectChanges(f.root, 'auto', AbortSignal.abort()));
  } finally { await f.cleanup(); }
});

test('status parsing handles rename records and embedded newlines', () => {
  assert.deepEqual(parseStatus('R  new\0old\0?? line\nname\0'), [
    { status: 'R ', file: 'new', original: 'old' }, { status: '??', file: 'line\nname' }
  ]);
});

test('untracked symlinks never read content outside the repository', async () => {
  const f = await fixture();
  try {
    const { symlink } = await import('node:fs/promises');
    await mkdir(path.join(f.root, 'folder'));
    await symlink('/etc/hosts', path.join(f.root, 'folder', 'link'));
    await f.write('safe.txt', 'safe');
    const result = await collectChanges(f.root, 'auto');
    assert.equal(result.included, 1); assert.match(result.skipped.join(), /非普通文件/);
  } finally { await f.cleanup(); }
});

test('large changes preserve every file summary and allocate details to the last file beyond the old 100-file cutoff', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 120; i++) {
      await f.write(`${String(i).padStart(3, '0')}.ts`, i < 3 ? 'export const many = 1;\n'.repeat(4000) : `export const file${i} = ${i};\n`);
    }
    const result = await collectChanges(f.root, 'auto');
    assert.equal(result.total, 120); assert.equal(result.included, 120);
    assert.equal(result.summary.split('\n').length, 120);
    assert.match(result.summary, /119\.ts/); assert.match(result.text, /export const file119 = 119/);
    assert.equal(result.detailed, 120);
    assert.ok(result.summary.length + result.text.length <= 60_000);
    assert.equal(result.truncated, true);
  } finally { await f.cleanup(); }
});

test('tracked multi-megabyte patches are streamed within budget and do not hide later changes', async () => {
  const f = await fixture();
  try {
    await f.write('000-large.txt', 'old\n'); await f.write('zzz-last.ts', 'old\n'); await f.commit();
    await f.write('000-large.txt', 'large changed line\n'.repeat(300_000));
    await f.write('zzz-last.ts', 'LAST_FILE_CHANGE\n'); await f.git('add', '.');
    const result = await collectChanges(f.root, 'auto');
    assert.equal(result.total, 2); assert.equal(result.detailed, 2);
    assert.match(result.summary, /\+300000/); assert.match(result.text, /LAST_FILE_CHANGE/);
    assert.equal(result.truncated, true); assert.ok(result.summary.length + result.text.length <= 60_000);
  } finally { await f.cleanup(); }
});

test('history contains only the latest five redacted titles and remains optional for first commits', async () => {
  const f = await fixture();
  try {
    await f.write('first', 'first');
    assert.deepEqual((await collectChanges(f.root, 'auto')).recentCommits, []);
    await f.commit();
    for (let i = 1; i <= 6; i++) { await f.git('commit', '--allow-empty', '-m', `fix: style-${i}\n\nPRIVATE_BODY_${i}`); }
    await f.git('commit', '--allow-empty', '-m', 'chore: sk-123456789012345678901234');
    await f.write('first', 'changed');
    const result = await collectChanges(f.root, 'auto');
    assert.equal(result.recentCommits.length, 5);
    assert.match(result.recentCommits[0], /已移除密钥/);
    assert.equal(result.recentCommits[1], 'fix: style-6');
    assert.doesNotMatch(result.recentCommits.join('\n'), /PRIVATE_BODY|style-2|sk-123/);
  } finally { await f.cleanup(); }
});

test('large new files remain in the complete summary without reading their full contents', async () => {
  const f = await fixture();
  try {
    await f.write('big.txt', 'PRIVATE_HUGE_CONTENT\n'.repeat(20_000));
    await f.write('small.ts', 'small change');
    const result = await collectChanges(f.root, 'auto');
    assert.match(result.summary, /big\.txt.*仅摘要/); assert.match(result.text, /small change/);
    assert.doesNotMatch(result.text, /PRIVATE_HUGE_CONTENT/); assert.equal(result.truncated, true);
  } finally { await f.cleanup(); }
});

test('excluded staged content never falls back to unrelated unstaged changes', async () => {
  const f = await fixture();
  try {
    await f.write('code.ts', 'base'); await f.commit();
    await f.write('.env', 'secret'); await f.git('add', '.env');
    await f.write('code.ts', 'UNRELATED_UNSTAGED');
    await assert.rejects(collectChanges(f.root, 'auto'), /没有可发送/);
  } finally { await f.cleanup(); }
});

test('summary overflow fails explicitly instead of silently dropping files', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 320; i++) { await f.write(`${i}-${'x'.repeat(185)}.txt`, 'x'); }
    await assert.rejects(collectChanges(f.root, 'auto'), /文件摘要已超过上下文上限/);
  } finally { await f.cleanup(); }
});
