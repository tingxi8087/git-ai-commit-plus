export type Language = 'zh-CN' | 'en';
export type Detail = 'concise' | 'standard' | 'detailed';
export type Scope = 'auto' | 'staged' | 'all';
export const providers = [{ id: 'deepseek', label: 'DeepSeek', models: [
  { id: 'deepseek-flash', label: 'DeepSeek Flash' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }
] }] as const;
export type ProviderId = typeof providers[number]['id'];
export type ModelId = typeof providers[number]['models'][number]['id'];
export interface Preferences { provider: ProviderId; model: ModelId; language: Language; detail: Detail; scope: Scope }
export interface ChangeContext {
  scope: 'staged' | 'all';
  text: string;
  summary: string;
  total: number;
  detailed: number;
  recentCommits: string[];
  included: number;
  skipped: string[];
  truncated: boolean;
}
export const defaults: Preferences = { provider: 'deepseek', model: 'deepseek-flash', language: 'zh-CN', detail: 'concise', scope: 'auto' };
export function parsePreferences(value: unknown): Preferences {
  if (!value || typeof value !== 'object') { throw new Error('配置格式无效。'); }
  const p = value as Record<string, unknown>;
  const provider = p.provider ?? defaults.provider;
  const model = p.model ?? defaults.model;
  if (provider !== 'deepseek' || !providers[0].models.some(item => item.id === model)) { throw new Error('请选择有效的来源和模型。'); }
  if (!['zh-CN', 'en'].includes(String(p.language)) ||
      !['concise', 'standard', 'detailed'].includes(String(p.detail)) ||
      !['auto', 'staged', 'all'].includes(String(p.scope))) { throw new Error('请选择有效的生成配置。'); }
  return { provider, model: model as ModelId, language: p.language as Language, detail: p.detail as Detail, scope: p.scope as Scope };
}
