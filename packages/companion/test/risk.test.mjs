/**
 * 防风控 + 消息段 · node --test packages/companion/test/risk.test.mjs
 * 对应教程第十三章（重试风暴 / 正在输入太勤 / 发送太勤）和第九章、FAQ Q6。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SendGate } from '../src/send-gate.js';
import { Humanizer } from '../src/humanize.js';
import { OneBot, segsToText } from '../src/transport-onebot.js';

test('限频：每分钟、每小时超量就不发', () => {
  const g = new SendGate({ perMinute: 2, perHour: 3 });
  const t = 1_000_000;
  g.record(true, t); g.record(true, t + 1);
  assert.equal(g.allow(t + 2).ok, false);              // 一分钟内第 3 条
  assert.equal(g.allow(t + 61_000).ok, true);          // 过了一分钟
  g.record(true, t + 61_000);
  assert.equal(g.allow(t + 122_000).ok, false);        // 一小时内第 4 条
  assert.equal(g.allow(t + 3_601_000).ok, true);
});

test('熔断：连续失败 3 次停 3 分钟，成功会清零', () => {
  const g = new SendGate({ perMinute: 100, perHour: 1000 });
  const t = 1_000_000;
  g.record(false, t); g.record(false, t); g.record(true, t); g.record(false, t); g.record(false, t);
  assert.equal(g.allow(t).ok, true);                   // 中间成功过一次，没到连续 3 次
  g.record(false, t);
  assert.match(g.allow(t + 1000).reason, /熔断/);
  assert.equal(g.allow(t + 180_001).ok, true);
});

test('「正在输入」限频上报，且不发「停止输入」', async () => {
  const h = new Humanizer({ minMs: 0, maxMs: 0, gapRange: [0, 0], longGapChance: 0, typingProbability: 1 });
  const typing = [];
  const io = { setTyping: async (on) => typing.push(on), send: async () => {}, sleep: async () => {} };
  await h.say(['短', '这一句足够长，超过二十个字了，应该会上报一次正在输入的状态', '这一句也够长，但是离上一次上报还不到四十五秒，所以不报'], io);
  assert.deepEqual(typing, [true]);
});

test('发消息用消息段：模型说出 CQ 码也只是普通文字', async () => {
  const calls = [];
  const fake = { api: async (action, params) => { calls.push({ action, params }); return { ok: true }; } };
  await OneBot.prototype.send.call(fake, 'group:1', '[CQ:at,qq=all] 大家好');
  await OneBot.prototype.send.call(fake, 'private:2', '在呢', { atUserId: '3' });
  assert.deepEqual(calls[0], { action: 'send_group_msg', params: { group_id: '1', message: [{ type: 'text', data: { text: '[CQ:at,qq=all] 大家好' } }] } });
  assert.deepEqual(calls[1].params.message.map((s) => s.type), ['at', 'text', 'text']);
});

test('语音 / 卡片 / 文件不再变成空消息', () => {
  assert.equal(segsToText([{ type: 'record', data: {} }]), '[语音]');
  assert.equal(segsToText([{ type: 'file', data: { name: 'a.pdf' } }]), '[文件：a.pdf]');
  const card = JSON.stringify({ meta: { detail_1: { title: '哔哩哔哩', desc: '猫猫视频', qqdocurl: 'https://b23.tv/x' } } });
  assert.equal(segsToText([{ type: 'json', data: { data: card } }]), '[卡片] 哔哩哔哩 （猫猫视频） https://b23.tv/x');
  assert.equal(segsToText([{ type: 'json', data: { data: '不是json' } }]), '[卡片]');
});
