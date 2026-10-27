/**
 * 联网搜索 · node --test packages/companion/test/web-search.test.mjs
 * 搜索接口用替身 fetch，模型接口用本地假服务，不连网。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WebSearch, format } from '../src/web-search.js';
import { Brain } from '../src/brain.js';
import { Memory } from '../src/memory.js';
import { RemoteMemory } from '../src/memory-remote.js';
import { Role } from '../src/role.js';

const RESP = {
  content: [
    { type: 'server_tool_use', name: 'web_search' },
    { type: 'web_search_tool_result', content: [
      { type: 'web_search_result', title: '北京天气预报', url: 'https://weather.example/bj', page_age: '2026-10-27' },
      { type: 'web_search_result', title: '重复的', url: 'https://weather.example/bj' },
      { type: 'web_search_result', title: '中国天气网', url: 'https://weather.example/cn' },
    ] },
    { type: 'text', text: '北京今天多云，最高 25 度。' },
  ],
};

test('把搜索结果整理成给模型看的文字', () => {
  const t = format('北京 天气', RESP);
  assert.match(t, /1\. 北京天气预报（2026-10-27） https:\/\/weather\.example\/bj/);
  assert.match(t, /2\. 中国天气网/);
  assert.doesNotMatch(t, /重复的/);
  assert.match(t, /摘要：北京今天多云/);
  assert.match(format('x', { content: [] }), /没搜到/);
});

test('请求格式、缓存、失败不抛', async () => {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1 ? new Response(JSON.stringify(RESP)) : new Response('busy', { status: 503 });
  };
  try {
    const web = new WebSearch({ apiKey: 'sk-test' });
    assert.match(await web.run({ query: '北京 天气' }), /北京天气预报/);
    assert.match(await web.run({ query: '  北京   天气 ' }), /北京天气预报/);       // 命中缓存
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.deepseek.com/anthropic/v1/messages');
    assert.equal(calls[0].init.headers['x-api-key'], 'sk-test');
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.tools[0].type, 'web_search_20250305');

    const failed = await web.run({ query: '别的' });
    assert.match(failed, /没搜到（搜索接口返回 503/);
    assert.doesNotMatch(failed, /sk-test/);                                       // key 不会出现在给模型的文字里
  } finally { globalThis.fetch = real; }
  assert.throws(() => new WebSearch({ apiKey: 'x', baseUrl: 'http://api.deepseek.com' }), /https/);
});

async function llmServer(reply) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      if (req.url === '/tools') { res.end(JSON.stringify({ tools: [{ type: 'function', function: { name: 'get_entity', parameters: {} } }] })); return; }
      if (req.url === '/context') { res.end(JSON.stringify({ memory: '记忆', recall: '', history: [] })); return; }
      if (req.url !== '/chat/completions') { res.end('{"ok":true}'); return; }
      const body = JSON.parse(b); calls.push(body);
      res.end(JSON.stringify({ choices: [{ message: reply(body, calls.length) }] }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: 'http://127.0.0.1:' + srv.address().port, calls, close: () => srv.close() };
}

test('群聊只给搜索工具，私聊记忆 + 搜索都给；搜索结果带回给模型', async () => {
  const llm = await llmServer((body, n) => (body.messages.at(-1).role === 'tool'
    ? { content: '北京今天多云' }
    : { content: '', tool_calls: [{ id: 's' + n, type: 'function', function: { name: 'web_search', arguments: '{"query":"北京 天气"}' } }] }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-test-'));
  const searched = [];
  const web = { tool: new WebSearch({ apiKey: 'x' }).tool, run: async (a) => { searched.push(a.query); return '搜索「北京 天气」的结果：多云'; } };
  try {
    fs.writeFileSync(path.join(dir, 'role.md'), '你叫小鱼。');
    const brain = new Brain({ apiKey: 'x', baseUrl: llm.url, role: new Role({ cardPath: path.join(dir, 'role.md') }),
      memory: new Memory({ dir: path.join(dir, 'data') }), remote: new RemoteMemory({ url: llm.url }), webSearch: web });

    const g = await brain.reply({ key: 'group:1', userId: '2', text: '@小鱼 北京天气咋样' });
    assert.equal(g.text, '北京今天多云');
    assert.deepEqual(g.toolCalls, [{ name: 'web_search', args: { query: '北京 天气' } }]);
    assert.deepEqual(llm.calls[0].tools.map((t) => t.function.name), ['web_search']);
    assert.match(llm.calls[0].messages[0].content, /web_search 上网查/);
    assert.match(llm.calls[1].messages.at(-1).content, /多云/);

    await brain.reply({ key: 'private:2', userId: '2', text: '北京天气咋样', record: false });
    assert.deepEqual(llm.calls[2].tools.map((t) => t.function.name), ['get_entity', 'web_search']);
    assert.deepEqual(searched, ['北京 天气', '北京 天气']);
  } finally { llm.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('没有记忆块时（群聊）提示词里也有今天的日期', async () => {
  const llm = await llmServer(() => ({ content: '嗯' }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'role.md'), '你叫小鱼。');
    const brain = new Brain({ apiKey: 'x', baseUrl: llm.url, role: new Role({ cardPath: path.join(dir, 'role.md') }),
      memory: new Memory({ dir: path.join(dir, 'data') }) });
    await brain.reply({ key: 'group:1', userId: '2', text: '今天几号' });
    const d = new Date();
    const today = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    assert.match(llm.calls[0].messages[0].content, new RegExp('现在是 ' + today));
  } finally { llm.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
