/**
 * 群聊前文、引用、前文里的图 · node --test packages/companion/test/group-log.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GroupLog } from '../src/group-log.js';
import { attachQuotes, contextForwardIds, contextImageRefs, expandForwards } from '../src/turn-context.js';
import { handleTurn, loadConfig } from '../src/index.js';

const img = (n) => ({ url: 'https://gchat.qpic.cn/' + n, file: n, sticker: false });

test('前文不含这一轮本身，也不含太久以前的', () => {
  const log = new GroupLog({ maxAgeMs: 60000 });
  const now = Date.now();
  const at = { text: '@小鱼 你说呢' };
  log.add('group:1', { text: '老张：很久以前', t: now - 120000 });
  log.add('group:1', { text: '老张：今天好热' });
  log.add('group:1', { text: '我：是啊', isSelf: true });
  log.add('group:1', { text: '小李：' + at.text, ref: at });
  log.add('group:2', { text: '别的群' });

  assert.deepEqual(log.recent('group:1', { exclude: [at], now }), [
    { isSelf: false, text: '老张：今天好热' },
    { isSelf: true, text: '我：是啊' },
  ]);
});

test('每个群只留最近 maxPerGroup 条', () => {
  const log = new GroupLog({ maxPerGroup: 3 });
  for (let i = 0; i < 5; i++) log.add('group:1', { text: 'a：' + i });
  assert.deepEqual(log.recent('group:1').map((r) => r.text), ['a：2', 'a：3', 'a：4']);
});

test('引用：原文拼进这句话，引用里的图交出来，引用自己说的话写「你之前说的」', async () => {
  const msgs = {
    10: { userId: '2', name: '老张', text: '我新买的键盘', images: [img('a'), { ...img('s'), sticker: true }] },
    11: { userId: '999', name: '小鱼', text: '挺好看的', images: [] },
  };
  const items = [
    { name: '小李', text: '你觉得呢', replyTo: '10' },
    { name: '小李', text: '真的吗', replyTo: '11' },
    { name: '小李', text: '找不到的', replyTo: '12' },
    { name: '小李', text: '没引用' },
  ];
  const r = await attachQuotes(items, async (id) => msgs[id] || null, { selfId: '999', maxChars: 4 });
  assert.deepEqual(r.items.map((m) => m.text), [
    '（回复 老张 的消息：「我新买的…」（这条里的图附在后面了））你觉得呢',
    '（回复 你之前说的：「挺好看的」）真的吗',
    '（回复了一条找不到的消息）找不到的',
    '没引用',
  ]);
  assert.deepEqual(r.images, [img('a')]);        // 表情包不算
  assert.equal(items[0].text, '你觉得呢');       // 原消息不动
});

test('前文里的图：句子提到图才找，最新的在前，最多 maxCount 张', () => {
  const log = new GroupLog();
  const cur = { text: '@小鱼 评价下上面那张图' };
  log.add('group:1', { text: '老张：[图片]', name: '老张', images: [img('old')] });
  log.add('group:1', { text: '小李：[图片]', name: '小李', images: [img('new')] });
  log.add('group:1', { text: '小王：[表情包]', name: '小王', images: [{ ...img('s'), sticker: true }] });
  log.add('group:1', { text: '小李：' + cur.text, ref: cur, name: '小李', images: [img('self')] });
  const opts = { exclude: [cur], keywords: ['图'], lookback: 10, maxCount: 1 };

  assert.deepEqual(contextImageRefs('评价下上面那张图', log, 'group:1', opts), { refs: [img('new')], from: ['小李'] });
  assert.deepEqual(contextImageRefs('你好', log, 'group:1', opts), { refs: [], from: [] });
  assert.equal(contextImageRefs('图呢', log, 'group:1', { ...opts, lookback: 1 }).refs.length, 0);  // 只看最近 1 条（表情包）
});

test('handleTurn：引用和前文的图都交给大脑，前文条数按配置', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-test-'));
  const cfgFile = path.join(dir, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ groupContext: { historyCount: 1 } }));
  const cfg = { ...loadConfig(cfgFile), dryRun: true };
  try {
    const seen = [];
    const brain = { reply: async (input) => { seen.push(input); return { text: '' }; } };
    const bot = { selfId: '999', api: async () => ({ ok: false }),
                  getMsg: async () => ({ userId: '2', name: '老张', text: '我新买的键盘', images: [] }) };
    const log = new GroupLog();
    log.add('group:1', { text: '小王：早', name: '小王' });
    log.add('group:1', { text: '老张：[图片]', name: '老张', images: [img('kb')] });
    const deps = { bot, brain, human: null, memory: null, waker: null, groupLog: log };
    const base = { key: 'group:1', isGroup: true, userId: '3', name: '小李' };

    await handleTurn(deps, [{ ...base, text: '@小鱼 你觉得呢', replyTo: '10' }], cfg);
    assert.equal(seen[0].text, '小李：（回复 老张 的消息：「我新买的键盘」）@小鱼 你觉得呢');
    assert.deepEqual(seen[0].history, [{ isSelf: false, text: '老张：[图片]' }]);   // historyCount=1

    await handleTurn(deps, [{ ...base, text: '@小鱼 上面那张图咋样' }], cfg);
    assert.equal(seen[1].text, '小李：@小鱼 上面那张图咋样\n（附上了前文里 老张 发的图）');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('聊天记录：展开成「谁：说了什么」，嵌套缩进，超长截断，图交出来', async () => {
  const fwd = {
    f1: [{ name: '小王', text: '明天几点集合', images: [] },
         { name: '小李', text: '[聊天记录]', images: [img('x')] },
         { name: '老刘', text: '套娃里的话', images: [], depth: 1 },
         { name: '小李', text: '八点', images: [] }],
  };
  const items = [{ name: '老张', text: '[聊天记录] 你们看看', forwards: ['f1'] },
                 { name: '老张', text: '打不开的', forwards: ['bad'] }];
  const r = await expandForwards(items, async (id) => fwd[id] || null, { maxMessages: 3 });
  assert.equal(r.items[0].text, '[聊天记录] 你们看看\n（转发的聊天记录，共 4 条：\n  小王：明天几点集合\n  小李：[聊天记录]\n    老刘：套娃里的话\n  ……后面还有 1 条太长没展开\n）');
  assert.equal(r.items[1].text, '打不开的\n（转发的聊天记录打不开）');
  assert.deepEqual(r.images, [img('x')]);

  const short = await expandForwards(items.slice(0, 1), async (id) => fwd[id], { maxChars: 12 });
  assert.match(short.items[0].text, /共 4 条：\n  小王：明天几点集合\n  ……后面还有 3 条/);
});

test('聊天记录：引用一条聊天记录、或说「上面的聊天记录」都能找到', async () => {
  const q = await attachQuotes([{ name: '小李', text: '评价下', replyTo: '9' }],
    async () => ({ userId: '2', name: '老张', text: '[聊天记录]', images: [], forwards: ['f9'] }));
  assert.deepEqual(q.items[0].forwards, ['f9']);

  const log = new GroupLog();
  log.add('group:1', { text: '老张：[聊天记录]', forwards: ['old'] });
  log.add('group:1', { text: '小王：[聊天记录]', forwards: ['new'] });
  const opts = { keywords: ['聊天记录'], lookback: 10 };
  assert.deepEqual(contextForwardIds('评价下上面的聊天记录', log, 'group:1', opts), ['new']);
  assert.deepEqual(contextForwardIds('你好', log, 'group:1', opts), []);
});

test('handleTurn：聊天记录展开给模型看，但不进长期记忆', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-test-'));
  const cfgFile = path.join(dir, 'config.json');
  fs.writeFileSync(cfgFile, '{}');
  const cfg = { ...loadConfig(cfgFile), dryRun: true };
  try {
    const seen = [];
    const brain = { reply: async (input) => { seen.push(input); return { text: '' }; } };
    const bot = { selfId: '999', api: async () => ({ ok: false }),
                  getForward: async () => [{ name: '小王', text: '明天八点集合', images: [] }] };
    const deps = { bot, brain, human: null, memory: null, waker: null, groupLog: new GroupLog() };
    await handleTurn(deps, [{ key: 'group:1', isGroup: true, userId: '3', name: '小李',
                              text: '[聊天记录] @小鱼 评价下', forwards: ['f1'] }], cfg);
    assert.equal(seen[0].text, '小李：[聊天记录] @小鱼 评价下\n（转发的聊天记录，共 1 条：\n  小王：明天八点集合\n）');
    assert.equal(seen[0].memoryText, '小李：[聊天记录] @小鱼 评价下');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('追问时找回上一轮给模型看过的图（比如来自引用、早就不在前文里的截图）', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-test-'));
  const cfgFile = path.join(dir, 'config.json');
  fs.writeFileSync(cfgFile, '{}');
  const cfg = { ...loadConfig(cfgFile), dryRun: true };
  try {
    const seen = [];
    const brain = { reply: async (input) => { seen.push(input); return { text: '' }; } };
    // 图床下载换成假的：返回一张 1x1 png
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
    t.after(() => { globalThis.fetch = realFetch; });
    const bot = { selfId: '999', api: async () => ({ ok: false }),
                  getMsg: async () => ({ userId: '2', name: '老张', text: '[图片]', images: [img('shot')] }) };
    const log = new GroupLog();
    const deps = { bot, brain, human: null, memory: null, waker: null, groupLog: log };
    const base = { key: 'group:1', isGroup: true, userId: '3', name: '道友' };
    const first = { ...base, text: '如何评价', replyTo: '10' };
    const second = { ...base, text: '截图意见' };
    log.add('group:1', { text: '道友：如何评价', ref: first, name: '道友' });
    await handleTurn(deps, [first], cfg);
    log.add('group:1', { text: '道友：截图意见', ref: second, name: '道友' });
    await handleTurn(deps, [second], cfg);

    assert.equal(seen[0].images.length, 1);
    assert.equal(seen[1].images.length, 1, '第二轮应该找回第一轮引用里的截图');
    assert.match(seen[1].text, /附上了前文里 道友 发的图/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('@ 机器人自己那段不进文本，@ 别人的保留；只 @ 一下也不是空消息', async () => {
  const { segsToText } = await import('../src/transport-onebot.js');
  const segs = [{ type: 'text', data: { text: '如何评价' } }, { type: 'at', data: { qq: '999' } },
                { type: 'text', data: { text: ' 和' } }, { type: 'at', data: { qq: '123' } }];
  assert.equal(segsToText(segs, '999'), '如何评价 和@123');
  assert.equal(segsToText(segs), '如何评价@999 和@123');
});
