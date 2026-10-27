/**
 * Brain 的记忆工具循环（agentic RAG）· node --test packages/companion/test/agentic.test.mjs
 * 假记忆服务 + 假模型接口，不连网。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Brain } from '../src/brain.js';
import { Memory } from '../src/memory.js';
import { RemoteMemory } from '../src/memory-remote.js';
import { Role } from '../src/role.js';

const TOOLS = [{ type: 'function', function: { name: 'get_entity', description: '查人', parameters: { type: 'object', properties: { name: { type: 'string' } } } } }];

function listen(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(handler(req.url, body ? JSON.parse(body) : null)));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: 'http://127.0.0.1:' + srv.address().port }));
  });
}

/** llmReply(body, n) 决定第 n 次调模型返回什么 message */
async function setup(llmReply) {
  const memCalls = [];
  const mem = await listen((url, body) => {
    memCalls.push({ url, body });
    if (url === '/tools') return { tools: TOOLS };
    if (url === '/tool') return { content: '「老王」（person，也叫：王哥）\n- 2026-10-20 老王经常帮用户改代码' };
    if (url === '/context') return { memory: '【你对 ta 的了解】ta 是程序员', recall: '', history: [] };
    return { ok: true };
  });
  const llmCalls = [];
  const llm = await listen((url, body) => {
    llmCalls.push(body);
    return { choices: [{ message: llmReply(body, llmCalls.length) }] };
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-test-'));
  fs.writeFileSync(path.join(dir, 'role.md'), '你叫小鱼。说话自然。');
  const brain = (opts = {}) => new Brain({
    apiKey: 'x', baseUrl: llm.url, role: new Role({ cardPath: path.join(dir, 'role.md') }),
    memory: new Memory({ dir: path.join(dir, 'data') }), remote: new RemoteMemory({ url: mem.url }), ...opts,
  });
  const close = () => { mem.srv.close(); llm.srv.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { brain, memCalls, llmCalls, close };
}

const callEntity = (id) => ({ content: '', tool_calls: [{ id, type: 'function', function: { name: 'get_entity', arguments: '{"name":"王哥"}' } }] });

test('模型自己查记忆：调工具 → 拿结果 → 再回答', async () => {
  const t = await setup((body, n) => (n === 1 ? callEntity('c1') : { content: '老王啊，就是常帮你改代码那个' }));
  try {
    const r = await t.brain().reply({ key: 'private:1', userId: '1', text: '你还记得王哥吗' });
    assert.equal(r.text, '老王啊，就是常帮你改代码那个');
    assert.deepEqual(r.toolCalls, [{ name: 'get_entity', args: { name: '王哥' } }]);

    assert.deepEqual(t.llmCalls[0].tools, TOOLS);                                 // 工具交给了模型
    assert.equal(t.memCalls.find((c) => c.url === '/context').body.tools, true);  // 提示词知道有工具
    assert.deepEqual(t.memCalls.find((c) => c.url === '/tool').body, { user_id: '1', name: 'get_entity', arguments: { name: '王哥' } });

    const second = t.llmCalls[1].messages.slice(-2);                              // 工具结果带回给模型
    assert.equal(second[0].role, 'assistant');
    assert.equal(second[0].tool_calls[0].id, 'c1');
    assert.equal(second[1].role, 'tool');
    assert.equal(second[1].tool_call_id, 'c1');
    assert.match(second[1].content, /帮用户改代码/);
  } finally { t.close(); }
});

test('一直要查也有上限：轮数用完后不许再调工具，直接回答', async () => {
  const t = await setup((body, n) => (body.tool_choice === 'none' ? { content: '想不起来了' } : callEntity('c' + n)));
  try {
    const r = await t.brain({ maxToolRounds: 2 }).reply({ key: 'private:1', userId: '1', text: '你还记得王哥吗' });
    assert.equal(r.text, '想不起来了');
    assert.equal(r.toolCalls.length, 2);
    assert.equal(t.llmCalls.length, 3);
    assert.equal(t.llmCalls[2].tool_choice, 'none');
  } finally { t.close(); }
});

test('maxToolRounds=0 不给模型工具；群聊也不给', async () => {
  const t = await setup(() => ({ content: '嗯' }));
  try {
    await t.brain({ maxToolRounds: 0 }).reply({ key: 'private:1', userId: '1', text: '在吗' });
    await t.brain().reply({ key: 'group:2', userId: '1', text: '在吗' });
    assert.equal(t.llmCalls[0].tools, undefined);
    assert.equal(t.llmCalls[1].tools, undefined);
  } finally { t.close(); }
});
