import * as vscode from 'vscode';
import path from 'node:path';
import { collectChanges } from './git';
import { buildMessages, cleanCommit, requestDeepSeek } from './provider';
import { getPreferences, KEY_NAME, SettingsPanel } from './settings';
import { UsageStore } from './usage';

// Small structural subset of the built-in vscode.git API v1.
interface Repository { rootUri: vscode.Uri; inputBox: { value: string }; ui: { selected: boolean } }
interface GitAPI { git: { path: string }; repositories: Repository[] }
interface GitExtension { getAPI(version: 1): GitAPI }

async function chooseRepository(api: GitAPI, source: unknown): Promise<Repository | undefined> {
  const candidate = source as { rootUri?: vscode.Uri } | undefined;
  if (candidate?.rootUri) {
    const match = api.repositories.find(repo => repo.rootUri.toString() === candidate.rootUri!.toString());
    if (match) { return match; }
  }
  if (api.repositories.length === 1) { return api.repositories[0]; }
  if (!api.repositories.length) { throw new Error('当前工作区没有 Git 仓库，请先打开或初始化仓库。'); }
  const selected = api.repositories.filter(repo => repo.ui.selected);
  if (selected.length === 1) { return selected[0]; }
  const items = api.repositories.map(repo => ({ label: path.basename(repo.rootUri.fsPath), description: repo.rootUri.fsPath, repo }));
  return (await vscode.window.showQuickPick(items, { title: '选择生成提交说明的仓库', placeHolder: '每次仅分析一个仓库的变更' }))?.repo;
}

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('Git AI Commit');
  const usage = new UsageStore(context.globalStorageUri.fsPath, () => { void settings.refreshUsage().catch(() => {}); });
  const settings = new SettingsPanel(context, usage);
  const settingsEntry = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  settingsEntry.text = '$(settings-gear) AI Commit';
  settingsEntry.tooltip = '打开 AI Commit 配置 · DeepSeek、语言与详细程度';
  settingsEntry.command = 'gitAiCommit.settings';
  settingsEntry.show();
  const active = new Map<string, AbortController>();
  context.subscriptions.push(settings, output, settingsEntry, { dispose: () => { active.forEach(controller => controller.abort()); } });
  const status = (message: string) => { vscode.window.setStatusBarMessage(`AI Commit：${message}`, 5000); };
  context.subscriptions.push(vscode.commands.registerCommand('gitAiCommit.settings', () => settings.show()));
  context.subscriptions.push(vscode.commands.registerCommand('gitAiCommit.cancel', () => {
    active.forEach(controller => controller.abort());
  }));
  context.subscriptions.push(vscode.commands.registerCommand('gitAiCommit.generate', async (source?: unknown) => {
    let repositoryId: string | undefined;
    let controller: AbortController | undefined;
    try {
      if (!vscode.workspace.isTrusted) { throw new Error('请先信任当前工作区后再生成提交说明。'); }
      const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
      if (!extension) { throw new Error('请启用 VS Code 内置 Git 扩展。'); }
      const exports = extension.isActive ? extension.exports : await extension.activate();
      const api = exports.getAPI(1);
      const repository = await chooseRepository(api, source);
      if (!repository) { return; }
      repositoryId = repository.rootUri.toString();
      if (active.has(repositoryId)) { return; }
      controller = new AbortController();
      active.set(repositoryId, controller);
      await vscode.commands.executeCommand('setContext', 'gitAiCommit.generating', true);
      const key = await context.secrets.get(KEY_NAME);
      if (!key) {
        void vscode.window.showErrorMessage('尚未配置 DeepSeek API Key，请先通过状态栏 AI Commit 打开配置。', '打开配置').then(choice => {
          if (choice === '打开配置') { void settings.show(); }
        });
        return;
      }
      const preferences = getPreferences();
      const initialInput = repository.inputBox.value;
      const requestController = controller;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl, title: 'AI Commit：正在生成提交说明' }, async () => {
        const changes = await collectChanges(repository.rootUri.fsPath, preferences.scope, requestController.signal, api.git.path);
        requestController.signal.throwIfAborted();
        output.appendLine(`范围：${changes.scope === 'staged' ? '已暂存' : '全部变更'}；文件摘要 ${changes.total}，详细 diff ${changes.detailed}，参考历史提交 ${changes.recentCommits.length}。`);
        if (changes.skipped.length || changes.truncated) {
          output.appendLine(`部分内容已过滤或按预算缩减，全部文件路径及状态摘要已保留。\n${changes.skipped.join('\n')}`);
        }
        const result = cleanCommit(await requestDeepSeek(key, buildMessages(changes, preferences), requestController.signal, {
          model: preferences.model,
          onUsage: async tokens => {
            try { await usage.record(preferences.provider, preferences.model, 'generate', tokens); }
            catch { output.appendLine('本次用量保存失败，提交说明仍可正常生成。'); }
          }
        }), preferences.detail);
        requestController.signal.throwIfAborted();
        if (repository.inputBox.value !== initialInput) {
          // Preserve concurrent typing without introducing another confirmation dialog.
          const document = await vscode.workspace.openTextDocument({ content: result, language: 'git-commit' });
          await vscode.window.showTextDocument(document, { preview: true, preserveFocus: true });
          status('已保留你新输入的文字，生成结果已打开预览');
          return;
        }
        repository.inputBox.value = result;
        status('已填入提交说明');
      });
    } catch (error) {
      if (controller?.signal.aborted) { status('已取消生成'); }
      else {
        const message = error instanceof Error ? error.message : '生成失败，请稍后重试。';
        output.appendLine(message);
        void vscode.window.showErrorMessage(message);
      }
    } finally {
      if (repositoryId && controller && active.get(repositoryId) === controller) { active.delete(repositoryId); }
      await vscode.commands.executeCommand('setContext', 'gitAiCommit.generating', active.size > 0);
    }
  }));
}
