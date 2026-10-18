import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { defaults, parsePreferences, Preferences, providers } from './types';
import { requestDeepSeek } from './provider';
import { UsageSnapshot, UsageStore } from './usage';

export const KEY_NAME = 'gitAiCommit.deepseek.apiKey';
export function getPreferences(): Preferences {
  const config = vscode.workspace.getConfiguration('gitAiCommit');
  try { return parsePreferences({ provider: config.get('provider', defaults.provider), model: config.get('model', defaults.model), language: config.get('language', 'zh-CN'), detail: config.get('detail', 'concise'), scope: config.get('scope', 'auto') }); }
  catch { return { ...defaults }; }
}

export class SettingsPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private busy = false;
  private testController?: AbortController;
  private readonly subscriptions: vscode.Disposable[];
  constructor(private readonly context: vscode.ExtensionContext, private readonly usage: UsageStore) {
    this.subscriptions = [
      vscode.workspace.onDidChangeConfiguration(event => {
        if (!this.busy && event.affectsConfiguration('gitAiCommit')) { void this.sendState().catch(() => {}); }
      }),
      context.secrets.onDidChange(event => { if (!this.busy && event.key === KEY_NAME) { void this.sendState().catch(() => {}); } })
    ];
  }
  async show(): Promise<void> {
    if (this.panel) { this.panel.reveal(); return; }
    const panel = vscode.window.createWebviewPanel('gitAiCommit.settings', 'AI Commit · 配置', vscode.ViewColumn.One, {
      enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')], retainContextWhenHidden: true
    });
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icon.png');
    this.panel = panel;
    panel.onDidDispose(() => {
      this.testController?.abort();
      if (this.panel === panel) { this.panel = undefined; }
    });
    panel.webview.onDidReceiveMessage(message => { void this.handleMessage(message); });
    const nonce = randomBytes(24).toString('base64');
    let html = await readFile(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'settings.html').fsPath, 'utf8');
    for (const [placeholder, value] of Object.entries({
      '{{version}}': String(this.context.extension.packageJSON.version),
      '{{cspSource}}': panel.webview.cspSource, '{{nonce}}': nonce,
      '{{styleUri}}': panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'settings.css')).toString(),
      '{{scriptUri}}': panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'settings.js')).toString()
    })) { html = html.replaceAll(placeholder, value); }
    if (this.panel === panel) { panel.webview.html = html; }
  }
  async refreshUsage() {
    if (this.panel) { await this.panel.webview.postMessage({ type: 'usage', usage: await this.usage.snapshot() }); }
  }
  private async sendState() {
    if (!this.panel) { return; }
    const hasKey = Boolean(await this.context.secrets.get(KEY_NAME));
    let usage: UsageSnapshot | undefined;
    try { usage = await this.usage.snapshot(); } catch { /* Statistics must not block configuration. */ }
    await this.panel?.webview.postMessage({ type: 'state', preferences: getPreferences(), hasKey, providers, usage,
      usageError: usage ? undefined : '读取用量失败，请刷新重试。' });
  }
  private async handleMessage(message: unknown) {
    if (!message || typeof message !== 'object') { return; }
    const data = message as Record<string, unknown>;
    if (data.type === 'ready' || data.type === 'refreshUsage') {
      try { if (data.type === 'ready') { await this.sendState(); } else { await this.refreshUsage(); } }
      catch { await this.status('读取用量失败，请刷新重试。', true); }
      return;
    }
    if (!['save', 'clearKey', 'test'].includes(String(data.type)) || this.busy) { return; }
    this.busy = true;
    await this.panel?.webview.postMessage({ type: 'busy', value: true });
    try {
      const key = typeof data.key === 'string' ? data.key.trim() : '';
      if (key.length > 512 || /[\r\n\s]/.test(key)) { throw new Error('密钥格式无效，请粘贴完整的 API Key。'); }
      if (data.type === 'save') {
        const preferences = parsePreferences(data.preferences);
        const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
        const config = vscode.workspace.getConfiguration('gitAiCommit');
        for (const field of ['provider', 'model', 'language', 'detail', 'scope'] as const) { await config.update(field, preferences[field], target); }
        if (key) { await this.context.secrets.store(KEY_NAME, key); }
        await this.panel?.webview.postMessage({ type: 'saved' });
        await this.sendState();
        await this.status('已保存');
      } else if (data.type === 'clearKey') {
        await this.context.secrets.delete(KEY_NAME);
        await this.sendState();
        await this.status('已清除');
      } else {
        const candidate = key || await this.context.secrets.get(KEY_NAME);
        if (!candidate) { throw new Error('请先输入或保存 DeepSeek API Key。'); }
        this.testController = new AbortController();
        const preferences = parsePreferences(data.preferences);
        let recorded = true;
        await requestDeepSeek(candidate, [{ role: 'user', content: 'Reply with OK.' }], this.testController.signal, {
          model: preferences.model, timeoutMs: 20_000, maxTokens: 8,
          onUsage: async tokens => {
            try { await this.usage.record(preferences.provider, preferences.model, 'test', tokens); }
            catch { recorded = false; }
          }
        });
        await this.status(recorded ? '连接成功' : '连接成功，用量保存失败', !recorded);
      }
    } catch (error) {
      await this.status(error instanceof Error ? error.message : '操作失败，请重试。', true);
    } finally {
      this.testController = undefined;
      this.busy = false;
      await this.panel?.webview.postMessage({ type: 'busy', value: false });
    }
  }
  private async status(text: string, error = false) { await this.panel?.webview.postMessage({ type: 'status', text, error }); }
  dispose() {
    this.testController?.abort();
    this.panel?.dispose();
    this.subscriptions.forEach(item => item.dispose());
  }
}
