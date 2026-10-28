/**
 * 表情包 · node --test packages/companion/test/stickers.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Stickers } from '../src/stickers.js';
import { handleTurn, loadConfig } from '../src/index.js';
import { SendGate } from '../src/send-gate.js';

function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stickers-test-'));
  fs.writeFileSync(path.join(dir, '无语.gif'), 'GIF89a');
  fs.writeFileSync(path.join(dir, '干饭.png'), 'PNG');
  fs.writeFileSync(path.join(dir, '说明.txt'), '不是图');
  fs.writeFileSync(path.join(dir, '太大.png'), Buffer.alloc(64));
  return Promise.resolve(fn(dir)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

test('只认文件夹里的图片，超大的不要', () => withDir((dir) => {
  const s = new Stickers({ dir, maxBytes: 32 });
  assert.deepEqual([...s.list().keys()].sort(), ['干饭', '无语'].sort());
  assert.match(s.prompt('k'), /干饭/);
  assert.equal(s.file('干饭'), 'base64://' + Buffer.from('PNG').toString('base64'));
  assert.equal(s.file('../../etc/passwd'), null);
  assert.equal(new Stickers({ dir: path.join(dir, '没有') }).prompt('k'), '');
}));

test('摘标签：只发对得上的第一张，标签从文字里去掉', () => withDir((dir) => {
  const s = new Stickers({ dir });
  assert.deepEqual(s.take('k', '行吧\n【表情:无语】'), { text: '行吧', name: '无语' });
  assert.deepEqual(s.take('k', '【表情：干饭】'), { text: '', name: '干饭' });
  assert.deepEqual(s.take('k', '[表情:不存在] 好'), { text: '好', name: null });
  assert.deepEqual(s.take('k', '【表情:干饭】【表情:无语】'), { text: '', name: '干饭' });
  assert.deepEqual(s.take('k', '收到[表情]了'), { text: '收到[表情]了', name: null });   // 收到的表情占位不是标签
}));

test('冷却：发过一张后不再给清单，写出来的标签也不发；别的会话不受影响', () => withDir((dir) => {
  const s = new Stickers({ dir, cooldownMinutes: 20 });
  s.mark('a');
  assert.equal(s.prompt('a'), '');
  assert.deepEqual(s.take('a', '哈【表情:无语】'), { text: '哈', name: null });
  assert.notEqual(s.prompt('b'), '');
  assert.ok(s.ready('a', Date.now() + 21 * 60000));
}));

test('handleTurn：文字照常发，表情包按图片另发，并进入冷却', () => withDir(async (dir) => {
  const cfg = loadConfig(path.join(dir, '没有.json'));
  const stickers = new Stickers({ dir });
  const calls = [];
  const bot = { selfId: '999', setTyping: async () => {},
                send: async (key, m) => { calls.push(['text', m]); return { ok: true }; },
                sendImage: async (key, file, opts) => { calls.push(['image', file, opts]); return { ok: true }; } };
  let platform = null;
  const brain = { reply: async (input) => { platform = input.platform; return { text: '笑死\n【表情:无语】' }; } };
  const human = { say: async (text, { send }) => { await send(text); }, gapMs: () => 0 };
  const memory = { touch: () => {} };
  const waker = { wake: () => {} };
  const msg = { key: 'private:1', isGroup: false, userId: '1', name: '主人', text: '哈哈' };
  await handleTurn({ bot, brain, human, memory, waker, gate: new SendGate(), stickers }, [msg], cfg);

  assert.match(platform, /【表情:名字】/);
  assert.deepEqual(calls[0], ['text', '笑死']);
  assert.equal(calls[1][0], 'image');
  assert.match(calls[1][1], /^base64:\/\//);
  assert.deepEqual(calls[1][2], { sticker: true });
  assert.equal(stickers.prompt('private:1'), '');
}));
