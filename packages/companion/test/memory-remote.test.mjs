/**
 * Brain + RemoteMemory · node --test packages/companion/test
 * 起两个本地假服务（记忆服务 / 模型接口），不连网。
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

function listen(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const out = handler(req.url, body ? JSON.parse(body) : null);
        res.writeHead(out.status || 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out.body ?? out));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: 'http://127.0.0.1:' + srv.address().port }));
  });
}

async function setup() {
  const memCalls = [];
  const mem = await listen((url, body) => {
    memCalls.push({ url, body });
    if (url === '/context') {
      return {
        memory: '【你对 ta 的了解】ta 养了一只叫橘子的猫',
        recall: '【可能相关的记忆】\n[事实 2026-10-27] 用户养了一只叫橘子的橘猫',
        history: [{ role: 'user', content: '在吗' }, { role: 'assistant', content: '在呢' }],
      };
    }
    return { ok: true };
  });
  const llmCalls = [];
  const llm = await listen((url, body) => {
    llmCalls.push(body);
    return { choices: [{ message: { content: '橘子又干啥了' } }] };
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-test-'));
  const card = path.join(dir, 'role.md');
  fs.writeFileSync(card, '你叫小鱼。说话简短。不要用客服腔。');
  const make = (remote) => new Brain({
    apiKey: 'x', baseUrl: llm.url, role: new Role({ cardPath: card }),
    memory: new Memory({ dir: path.join(dir, 'data') }), remote,
  });
  const close = () => { mem.srv.close(); llm.srv.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { mem, memCalls, llmCalls, make, close };
}

const settle = () => new Promise((r) => setTimeout(r, 50));

test('私聊：注入记忆、带上历史、回复后写回', async () => {
  const t = await setup();
  try {
    const brain = t.make(new RemoteMemory({ url: t.mem.url }));
    const r = await brain.reply({ key: 'private:10001', userId: '10001', userName: '阿明', text: '橘子今天又捣乱了' });
    assert.equal(r.text, '橘子又干啥了');

    const msgs = t.llmCalls[0].messages;
    assert.match(msgs[0].content, /叫橘子的猫/);
    assert.match(msgs[0].content, /可能相关的记忆/);
    assert.deepEqual(msgs.slice(1).map((m) => [m.role, m.content]),
      [['user', '在吗'], ['assistant', '在呢'], ['user', '橘子今天又捣乱了']]);

    await settle();
    const ingest = t.memCalls.find((c) => c.url === '/ingest');
    assert.deepEqual(ingest.body, { user_id: '10001', text: '橘子今天又捣乱了', reply: '橘子又干啥了' });
  } finally { t.close(); }
});

test('群聊不走记忆服务', async () => {
  const t = await setup();
  try {
    const brain = t.make(new RemoteMemory({ url: t.mem.url }));
    await brain.reply({ key: 'group:20002', userId: '10001', text: '大家好' });
    await settle();
    assert.equal(t.memCalls.length, 0);
  } finally { t.close(); }
});

test('记忆服务挂了照样回复，退回本地账本', async () => {
  const t = await setup();
  try {
    const dead = new RemoteMemory({ url: 'http://127.0.0.1:1', timeoutMs: 500 });
    const brain = t.make(dead);
    brain.memory.remember('10001', { fact: '他喜欢吃辣' });
    const err = console.error; console.error = () => {};
    try {
      const r = await brain.reply({ key: 'private:10001', userId: '10001', text: '晚上吃啥' });
      assert.equal(r.text, '橘子又干啥了');
    } finally { console.error = err; }
    assert.match(t.llmCalls[0].messages[0].content, /他喜欢吃辣/);
    assert.equal(t.llmCalls[0].messages.length, 2);   // 没有历史：system + 本条
  } finally { t.close(); }
});
