import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { runGit } from '../src/git';
import { UsageStore } from '../src/usage';
import { defaults } from '../src/types';

async function until(check: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) { throw new Error('Timed out waiting for the extension host'); }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
}

// Isolated Extension Development Host with the real Git API, SecretStorage,
// webview and commit input. Only the DeepSeek endpoint is redirected to localhost.
export async function run() {
  const extension = vscode.extensions.getExtension('git-ai-commit-plus.git-ai-commit-plus');
  assert.ok(extension);
  await extension.activate();
  assert.equal(extension.isActive, true);
  assert.equal(extension.packageJSON.version, '0.3.1');
  const commands = await vscode.commands.getCommands(true);
  for (const command of ['generate', 'settings', 'cancel']) { assert.ok(commands.includes(`gitAiCommit.${command}`)); }
  assert.deepEqual(extension.packageJSON.contributes.menus['scm/title'].map((item: { command: string }) => item.command), ['gitAiCommit.generate', 'gitAiCommit.cancel']);
  const config = vscode.workspace.getConfiguration('gitAiCommit');
  assert.equal(config.get('detail'), 'concise'); assert.equal(config.get('scope'), 'auto'); assert.equal(config.get('language'), 'zh-CN');

  const settingsModule = require(path.join(extension.extensionPath, 'dist/src/settings.js'));
  const providerModule = require(path.join(extension.extensionPath, 'dist/src/provider.js'));
  const originalShow = settingsModule.SettingsPanel.prototype.show;
  const originalRequest = providerModule.requestDeepSeek;
  let extensionContext: vscode.ExtensionContext | undefined;
  let settingsInstance: { handleMessage(message: unknown): Promise<void> } | undefined;
  settingsModule.SettingsPanel.prototype.show = function (this: { context: vscode.ExtensionContext }) {
    extensionContext = this.context;
    settingsInstance = this as unknown as typeof settingsInstance;
    return originalShow.call(this);
  };
  const root = await mkdtemp(path.join(tmpdir(), 'git-ai-commit-host-'));
  const git = (...args: string[]) => runGit(root, args);
  const requests: { model: string; messages: { content: string }[] }[] = [];
  let pending: ServerResponse | undefined;
  let delay = false;
  const respond = (res: ServerResponse) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'feat: 宿主测试生成结果' } }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, prompt_cache_hit_tokens: 40, prompt_cache_miss_tokens: 60 } }));
  };
  const server = createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => { requests.push(JSON.parse(body)); if (delay) { pending = res; } else { respond(res); } });
  });
  try {
    await vscode.commands.executeCommand('gitAiCommit.settings');
    assert.ok(extensionContext, 'settings command exposes its actual context to this test wrapper');
    await until(() => vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => tab.label === 'AI Commit · 配置'));
    settingsModule.SettingsPanel.prototype.show = originalShow;
    await extensionContext.secrets.store(settingsModule.KEY_NAME, 'fake-isolated-host-key');
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/chat/completions`;
    providerModule.requestDeepSeek = (key: string, messages: { role: string; content: string }[], signal: AbortSignal, options: Record<string, unknown>) => originalRequest(key, messages, signal, { ...options, endpoint });
    await git('init'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.invalid');
    await writeFile(path.join(root, 'file.ts'), 'BASE\n'); await git('add', '.'); await git('commit', '-m', 'fix(core): history-style');
    await writeFile(path.join(root, 'file.ts'), 'STAGED_HOST_CONTENT\n'); await git('add', '.');
    await writeFile(path.join(root, 'file.ts'), 'UNSTAGED_HOST_CONTENT\n');
    await writeFile(path.join(root, '.env'), 'SECRET_HOST_CONTENT');
    const gitExtension = vscode.extensions.getExtension('vscode.git'); assert.ok(gitExtension);
    const api = (await gitExtension.activate()).getAPI(1);
    const repository = await api.openRepository(vscode.Uri.file(root)); assert.ok(repository);
    repository.inputBox.value = 'existing draft';
    await vscode.commands.executeCommand('gitAiCommit.generate', { rootUri: repository.rootUri });
    assert.equal(repository.inputBox.value, 'feat: 宿主测试生成结果');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].model, 'deepseek-flash');
    await config.update('model', 'deepseek-v4-pro', vscode.ConfigurationTarget.Global);
    assert.match(requests[0].messages[1].content, /STAGED_HOST_CONTENT/);
    assert.doesNotMatch(requests[0].messages[1].content, /UNSTAGED_HOST_CONTENT|SECRET_HOST_CONTENT/);
    assert.match(requests[0].messages[1].content, /history-style/);
    assert.match(requests[0].messages[1].content, /all_file_summaries/);
    delay = true;
    const second = vscode.commands.executeCommand('gitAiCommit.generate', { rootUri: repository.rootUri });
    await until(() => Boolean(pending));
    repository.inputBox.value = 'typed while waiting'; respond(pending!); pending = undefined;
    await second;
    assert.equal(requests[1].model, 'deepseek-v4-pro');
    assert.equal(repository.inputBox.value, 'typed while waiting');
    assert.ok(vscode.workspace.textDocuments.some(document => document.isUntitled && document.getText() === 'feat: 宿主测试生成结果'));
    const third = vscode.commands.executeCommand('gitAiCommit.generate', { rootUri: repository.rootUri });
    await until(() => Boolean(pending));
    await vscode.commands.executeCommand('gitAiCommit.cancel'); await third;
    assert.equal(repository.inputBox.value, 'typed while waiting');
    pending!.destroy(); pending = undefined;
    delay = false;
    await settingsInstance!.handleMessage({ type: 'test', preferences: { ...defaults, model: 'deepseek-v4-pro' } });
    assert.equal(requests[3].model, 'deepseek-v4-pro');
    const usage = await new UsageStore(extensionContext.globalStorageUri.fsPath).snapshot();
    const flash = usage.models.find(row => row.model === 'deepseek-flash')!;
    const pro = usage.models.find(row => row.model === 'deepseek-v4-pro')!;
    assert.ok(flash.requests >= 1); assert.ok(pro.tests >= 1);
    for (const row of [flash, pro]) {
      assert.equal(row.total, row.requests * 105); assert.equal(row.cacheHit, row.requests * 40);
      assert.equal(row.cacheMiss, row.requests * 60); assert.equal(row.input, row.requests * 100);
    }
    const reportDirectory = path.resolve(__dirname, '../../artifacts');
    await mkdir(reportDirectory, { recursive: true });
    await writeFile(path.join(reportDirectory, 'host-result-v0.3.1.json'), JSON.stringify({
      activated: true, version: extension.packageJSON.version, commandsAndMenuVerified: true, defaultsVerified: true,
      settingsTabOpened: true, secretStorageVerified: true, realGitIndexVerified: true,
      recentHistoryAndSummariesVerified: true, commitInputFilled: true, concurrentTypingPreserved: true,
      previewOpened: true, cancellationVerified: true, selectedModelsVerified: true, persistedCacheUsageVerified: true, connectionTestUsageVerified: true, localMockRequests: requests.length
    }, null, 2));
  } finally {
    settingsModule.SettingsPanel.prototype.show = originalShow;
    providerModule.requestDeepSeek = originalRequest;
    await config.update('model', undefined, vscode.ConfigurationTarget.Global);
    await extensionContext?.secrets.delete(settingsModule.KEY_NAME);
    pending?.destroy(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}
