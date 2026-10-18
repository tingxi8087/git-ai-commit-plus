import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { buildMessages, cleanCommit, requestDeepSeek } from '../src/provider';
import { defaults, parsePreferences } from '../src/types';

async function mock(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void) {
  const server: Server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/chat/completions`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  };
}
const messages = [{ role: 'user', content: 'test' }];

test('defaults and validation match Chinese concise staged-first requirements', () => {
  assert.deepEqual(defaults, { provider: 'deepseek', model: 'deepseek-flash', language: 'zh-CN', detail: 'concise', scope: 'auto' });
  assert.throws(() => parsePreferences({ ...defaults, detail: 'unknown' }), /有效/);
  for (const detail of ['concise', 'standard', 'detailed'] as const) {
    const prompt = buildMessages({ scope: 'staged', text: 'diff', summary: 'M test.ts | +1 / -1', total: 1, detailed: 1, recentCommits: ['fix: historical style'], included: 1, skipped: [], truncated: true }, { ...defaults, detail, language: 'en' });
    assert.match(prompt[0].content, /English/); assert.match(prompt[0].content, /不可信/); assert.match(prompt[1].content, /截断/);
  }
});

test('provider sends the documented model, bearer token, messages and returns text', async () => {
  let requestBody: Record<string, unknown> | undefined;
  let authorization: string | undefined;
  const server = await mock((req, res) => {
    authorization = req.headers.authorization;
    let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
      requestBody = JSON.parse(body); res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: 'feat: 测试' } }] }));
    });
  });
  try {
    assert.equal(await requestDeepSeek('fake-test-key', messages, undefined, { endpoint: server.endpoint }), 'feat: 测试');
    assert.equal(authorization, 'Bearer fake-test-key'); assert.equal(requestBody?.model, 'deepseek-flash');
    assert.deepEqual(requestBody?.messages, messages); assert.equal(requestBody?.stream, false);
  } finally { await server.close(); }
});

test('provider maps HTTP errors without exposing response bodies or credentials', async () => {
  for (const [code, expected] of [[401, /密钥无效/], [402, /余额不足/], [429, /频繁/], [503, /繁忙/], [418, /HTTP 418/]] as const) {
    const server = await mock((_req, res) => { res.statusCode = code; res.end('sensitive-body'); });
    try { await assert.rejects(requestDeepSeek('fake-test-key', messages, undefined, { endpoint: server.endpoint }), expected); }
    finally { await server.close(); }
  }
});

test('invalid response, empty text, timeout and cancellation are reported', async () => {
  for (const body of ['not-json', '{}', '{"choices":[{"message":{"content":""}}]}']) {
    const server = await mock((_req, res) => { res.end(body); });
    try { await assert.rejects(requestDeepSeek('fake', messages, undefined, { endpoint: server.endpoint }), /格式异常|有效文本/); }
    finally { await server.close(); }
  }
  const server = await mock(() => {});
  try {
    await assert.rejects(requestDeepSeek('fake', messages, undefined, { endpoint: server.endpoint, timeoutMs: 30 }), /超时/);
    await assert.rejects(requestDeepSeek('fake', messages, AbortSignal.abort(), { endpoint: server.endpoint }), /取消/);
  } finally { await server.close(); }
});

test('commit cleanup removes fences and enforces a single line in concise mode', () => {
  assert.equal(cleanCommit('```text\nfeat: 测试\n\n- detail\n```', 'concise'), 'feat: 测试');
  assert.equal(cleanCommit('feat: test\n\n- detail', 'standard'), 'feat: test\n\n- detail');
  assert.throws(() => cleanCommit('', 'concise'), /为空/);
});

test('prompt puts full-file summaries before details and treats historical messages as style-only data', () => {
  const prompt = buildMessages({
    scope: 'all', total: 2, included: 2, detailed: 1, summary: 'M a.ts | +2 / -1\nA z.ts | +10 / -0',
    text: 'DETAIL_ONLY_FOR_A', recentCommits: ['fix(core): old change'], skipped: [], truncated: true
  }, { ...defaults, language: 'en' });
  assert.ok(prompt[1].content.indexOf('<all_file_summaries>') < prompt[1].content.indexOf('<git_changes>'));
  assert.match(prompt[1].content, /z\.ts/); assert.match(prompt[1].content, /fix\(core\): old change/);
  assert.match(prompt[0].content, /输出语言以当前设置为准/); assert.match(prompt[0].content, /事实仅来自本次变更/);
  assert.match(prompt[0].content, /只有摘要的文件/);
});

test('uses the selected model and reports exact API usage once, including before invalid-content errors', async () => {
  let body: Record<string, unknown> = {};
  let content = 'feat: selected model';
  const reports: unknown[] = [];
  const server = await mock((req, res) => {
    let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => {
      body = JSON.parse(raw);
      res.end(JSON.stringify({ choices: [{ message: { content } }], usage: {
        prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40,
        completion_tokens_details: { reasoning_tokens: 10 }
      } }));
    });
  });
  try {
    const options = { endpoint: server.endpoint, model: 'deepseek-v4-pro' as const, onUsage: async (usage: unknown) => { reports.push(usage); } };
    await requestDeepSeek('fake', messages, undefined, options);
    assert.equal(body.model, 'deepseek-v4-pro'); assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.deepEqual(reports[0], { input: 100, output: 20, total: 120, cacheHit: 60, cacheMiss: 40 });
    content = '';
    await assert.rejects(requestDeepSeek('fake', messages, undefined, options), /有效文本/);
    assert.equal(reports.length, 2);
  } finally { await server.close(); }
});

test('model configuration validates provider/model combinations and migrates old preferences', () => {
  assert.deepEqual(parsePreferences({ language: 'en', detail: 'standard', scope: 'staged' }), { ...defaults, language: 'en', detail: 'standard', scope: 'staged' });
  assert.throws(() => parsePreferences({ ...defaults, provider: 'unknown' }), /来源和模型/);
  assert.throws(() => parsePreferences({ ...defaults, model: 'invented-model' }), /来源和模型/);
});
