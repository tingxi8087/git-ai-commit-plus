/* global acquireVsCodeApi */
(() => {
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  let hasKey = false;
  let busy = false;
  let loaded = false;
  let dirty = false;
  let catalog = [];
  let activeTab = 'config';
  const number = value => new Intl.NumberFormat('zh-CN').format(value);
  function preferences() {
    return { provider: $('provider').value, model: $('model').value, language: $('language').value, scope: $('scope').value, detail: document.querySelector('input[name=detail]:checked').value };
  }
  function options(select, items, selected) {
    select.replaceChildren(...items.map(item => { const option = document.createElement('option'); option.value = item.id; option.textContent = item.label; return option; }));
    if (items.some(item => item.id === selected)) select.value = selected;
  }
  function models(selected) { options($('model'), catalog.find(item => item.id === $('provider').value)?.models || [], selected); }
  function render() {
    $('key-state').textContent = hasKey ? '已保存' : '未配置';
    $('api-key').placeholder = hasKey ? '留空保留已保存密钥' : '输入密钥';
    $('settings-form').querySelectorAll('button, input, select').forEach(element => { element.disabled = busy || !loaded; });
    $('clear-key').disabled = busy || !hasKey || !loaded;
  }
  function status(text, error = false) {
    const target = $(activeTab === 'config' ? 'config-status' : 'usage-status');
    target.textContent = text; target.classList.toggle('error', error);
  }
  function switchTab(tab, focus = false) {
    activeTab = tab;
    for (const id of ['config', 'usage']) {
      const selected = id === tab;
      $(`tab-${id}`).setAttribute('aria-selected', String(selected));
      $(`tab-${id}`).tabIndex = selected ? 0 : -1;
      $(`panel-${id}`).hidden = !selected;
    }
    if (focus) $(`tab-${tab}`).focus();
    if (tab === 'usage') vscode.postMessage({ type: 'refreshUsage' });
  }
  for (const id of ['config', 'usage']) {
    $(`tab-${id}`).addEventListener('click', () => switchTab(id));
    $(`tab-${id}`).addEventListener('keydown', event => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); switchTab(event.key === 'Home' ? 'config' : event.key === 'End' ? 'usage' : activeTab === 'config' ? 'usage' : 'config', true);
      }
    });
  }
  function usage(snapshot) {
    const rows = snapshot?.models || [];
    $('usage-rows').replaceChildren();
    const sums = { requests: 0, unreported: 0, tests: 0, input: 0, cacheHit: 0, cacheMiss: 0, cacheUnknown: 0, output: 0, total: 0 };
    function row(data, total = false) {
      const tr = document.createElement('tr');
      const name = document.createElement('td');
      const provider = catalog.find(item => item.id === data.provider);
      name.textContent = total ? '合计' : provider?.models.find(item => item.id === data.model)?.label || data.model;
      if (!total) { const sub = document.createElement('small'); sub.textContent = provider?.label || data.provider; name.append(sub); }
      tr.append(name);
      for (const key of ['requests', 'input', 'cacheHit', 'cacheMiss', 'cacheUnknown', 'output', 'total']) {
        const td = document.createElement('td'); td.textContent = number(data[key]);
        if (key === 'requests') {
          td.title = `${data.tests} 次连接测试`;
          if (data.unreported) { const sub = document.createElement('small'); sub.textContent = `${number(data.unreported)} 次未上报`; td.append(sub); }
        }
        tr.append(td);
      }
      return tr;
    }
    for (const data of rows) { for (const key of Object.keys(sums)) sums[key] += data[key]; $('usage-rows').append(row(data)); }
    $('usage-sum').replaceChildren(row(sums, true));
    $('usage-table').hidden = !rows.length; $('usage-empty').hidden = Boolean(rows.length);
    $('usage-total').textContent = rows.length ? `${number(sums.total)} Token · ${number(sums.requests)} 次` : '用量';
    $('usage-status').textContent = ''; $('usage-status').classList.remove('error');
  }
  $('settings-form').addEventListener('submit', event => {
    event.preventDefault(); vscode.postMessage({ type: 'save', preferences: preferences(), key: $('api-key').value });
  });
  $('provider').addEventListener('change', () => models());
  $('settings-form').addEventListener('change', () => { dirty = true; render(); status('未保存'); });
  $('api-key').addEventListener('input', () => { dirty = true; status('未保存'); });
  $('test').addEventListener('click', () => { status('测试中…'); vscode.postMessage({ type: 'test', key: $('api-key').value, preferences: preferences() }); });
  $('clear-key').addEventListener('click', () => { vscode.postMessage({ type: 'clearKey' }); });
  $('refresh').addEventListener('click', () => { vscode.postMessage({ type: 'refreshUsage' }); });
  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'state') {
      hasKey = message.hasKey; catalog = message.providers;
      if (!dirty) {
        options($('provider'), catalog, message.preferences.provider); models(message.preferences.model);
        $('language').value = message.preferences.language; $('scope').value = message.preferences.scope;
        document.querySelector(`input[name=detail][value="${message.preferences.detail}"]`).checked = true;
      }
      if (!loaded) status('');
      loaded = true; render(); usage(message.usage);
      if (message.usageError) { $('usage-status').textContent = message.usageError; $('usage-status').classList.add('error'); }
    } else if (message.type === 'usage') usage(message.usage);
    else if (message.type === 'busy') { busy = message.value; render(); }
    else if (message.type === 'saved') { $('api-key').value = ''; dirty = false; }
    else if (message.type === 'status') status(message.text, message.error);
  });
  render(); vscode.postMessage({ type: 'ready' });
})();
