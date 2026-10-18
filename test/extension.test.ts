import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';
import path from 'node:path';
import { defaults } from '../src/types';
import * as realProvider from '../src/provider';

function harness(options: { key?: boolean; repoCount?: number; deferred?: boolean; reduced?: boolean; fail?: boolean; openSettings?: boolean } = {}) {
  const commands = new Map<string, (...args: unknown[]) => Promise<void>>();
  const repos = Array.from({ length: options.repoCount ?? 1 }, (_, index) => ({
    rootUri: { fsPath: `/repo${index}`, toString: () => `file:///repo${index}` }, inputBox: { value: '' }, ui: { selected: false }
  }));
  const calls: string[] = [];
  const notices: string[] = [];
  const statusMessages: string[] = [];
  const previews: { content: string }[] = [];
  const outputLines: string[] = [];
  const statusEntries: { text?: string; command?: string; tooltip?: string; show(): void; dispose(): void }[] = [];
  let settingsOpened = 0;
  let resolveRequest: ((value: string) => void) | undefined;
  let resolveRequestStarted!: () => void;
  const requestStarted = new Promise<void>(resolve => { resolveRequestStarted = resolve; });
  const vscode = {
    workspace: { isTrusted: true, openTextDocument: async (data: { content: string }) => { previews.push(data); return data; } },
    StatusBarAlignment: { Left: 1 },
    extensions: { getExtension: () => ({ isActive: true, exports: { getAPI: () => ({ repositories: repos, git: { path: 'git' } }) } }) },
    commands: {
      registerCommand: (id: string, callback: (...args: unknown[]) => Promise<void>) => { commands.set(id, callback); return { dispose() {} }; },
      executeCommand: async () => {}
    },
    ProgressLocation: { SourceControl: 1 },
    window: {
      showQuickPick: async (items: { repo: unknown }[]) => items[1],
      createOutputChannel: () => ({ appendLine: (text: string) => outputLines.push(text), dispose() {} }),
      createStatusBarItem: () => { const entry = { show() {}, dispose() {} }; statusEntries.push(entry); return entry; },
      setStatusBarMessage: (text: string) => { statusMessages.push(text); return { dispose() {} }; },
      showTextDocument: async () => {},
      showWarningMessage: async () => { throw new Error('Unexpected confirmation dialog'); },
      showInformationMessage: async (text: string) => { notices.push(text); return '了解并生成'; },
      showErrorMessage: async (text: string) => { notices.push(text); return options.openSettings ? '打开配置' : undefined; },
      withProgress: async (progressOptions: { location: number }, callback: () => Promise<void>) => { assert.equal(progressOptions.location, 1); return callback(); }
    }
  };
  const moduleObject = { exports: {} as { activate: (context: unknown) => void } };
  const wrapper = runInThisContext(`(function(require,module,exports){${readFileSync(path.join(__dirname, '../src/extension.js'), 'utf8')}\n})`);
  wrapper((id: string) => {
    if (id === './usage') { return require('../src/usage'); }
    if (id === 'vscode') { return vscode; }
    if (id === './settings') { return {
      KEY_NAME: 'test-key', getPreferences: () => defaults,
      SettingsPanel: class { async show() { settingsOpened++; } async refreshUsage() {} dispose() {} }
    }; }
    if (id === './git') { return { collectChanges: async (root: string) => {
      calls.push(root); return { scope: 'staged', included: 1, text: 'diff', summary: 'M code.ts | +1 / -1', total: 1, detailed: 1, recentCommits: ['fix: recent style'], skipped: options.reduced ? ['lock file'] : [], truncated: Boolean(options.reduced) };
    } }; }
    if (id === './provider') { return { ...realProvider, requestDeepSeek: async () => {
      resolveRequestStarted();
      if (options.fail) { throw new Error('模拟网络错误'); }
      if (options.deferred) { return new Promise<string>(resolve => { resolveRequest = resolve; }); }
      return 'feat: 生成结果';
    } }; }
    return require(id);
  }, moduleObject, moduleObject.exports);
  moduleObject.exports.activate({
    globalStorageUri: { fsPath: '/tmp/git-ai-commit-mock-usage' },
    subscriptions: [], secrets: { get: async () => options.key === false ? undefined : 'fake-key' },
    globalState: { get: () => true, update: async () => {} }
  });
  return {
    repos, calls, notices, previews, statusMessages, outputLines, statusEntries, requestStarted,
    generate: (source?: unknown) => commands.get('gitAiCommit.generate')!(source),
    cancel: () => commands.get('gitAiCommit.cancel')!(), finish: () => resolveRequest?.('feat: 生成结果'),
    settingsOpened: () => settingsOpened
  };
}

test('generation fills the selected repository input and leaves other repositories untouched', async () => {
  const h = harness({ repoCount: 2 });
  await h.generate({ rootUri: h.repos[0].rootUri });
  assert.equal(h.repos[0].inputBox.value, 'feat: 生成结果'); assert.equal(h.repos[1].inputBox.value, '');
  assert.deepEqual(h.calls, ['/repo0']);
  await h.generate();
  assert.equal(h.repos[1].inputBox.value, 'feat: 生成结果');
});

test('missing credentials show one actionable error without automatically opening configuration', async () => {
  const h = harness({ key: false }); await h.generate();
  assert.equal(h.settingsOpened(), 0); assert.equal(h.notices.length, 1); assert.deepEqual(h.calls, []); assert.equal(h.repos[0].inputBox.value, '');
});

test('one click replaces existing text and handles reduced context without confirmation or success popups', async () => {
  const h = harness({ reduced: true }); h.repos[0].inputBox.value = 'handwritten';
  await h.generate(); assert.equal(h.repos[0].inputBox.value, 'feat: 生成结果');
  assert.equal(h.calls.length, 1); assert.deepEqual(h.notices, []);
  assert.ok(h.outputLines.some(line => line.includes('过滤')));
  assert.equal(h.statusEntries[0].command, 'gitAiCommit.settings');
});

test('the missing-key action opens settings only when explicitly selected', async () => {
  const h = harness({ key: false, openSettings: true }); await h.generate();
  assert.equal(h.settingsOpened(), 1); assert.deepEqual(h.calls, []);
});

test('failed generation preserves the old message and displays one error', async () => {
  const h = harness({ fail: true }); h.repos[0].inputBox.value = 'my draft'; await h.generate();
  assert.equal(h.repos[0].inputBox.value, 'my draft'); assert.equal(h.notices.length, 1);
});

test('typing during generation is preserved and the result opens as a preview without a dialog', async () => {
  const h = harness({ deferred: true }); const task = h.generate(); await h.requestStarted;
  h.repos[0].inputBox.value = 'typed while waiting'; h.finish(); await task;
  assert.equal(h.repos[0].inputBox.value, 'typed while waiting');
  assert.deepEqual(h.previews, [{ content: 'feat: 生成结果', language: 'git-commit' }]); assert.deepEqual(h.notices, []);
});

test('cancellation and duplicate invocation do not overwrite or start a second request', async () => {
  const h = harness({ deferred: true }); const task = h.generate(); await h.requestStarted;
  await h.generate(); assert.equal(h.calls.length, 1);
  h.cancel(); h.finish(); await task;
  assert.equal(h.repos[0].inputBox.value, ''); assert.ok(h.statusMessages.some(text => text.includes('已取消'))); assert.deepEqual(h.notices, []);
});
