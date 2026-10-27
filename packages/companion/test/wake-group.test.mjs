/**
 * 群聊「只回 @」· node --test packages/companion/test/wake-group.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Waker } from '../src/wake.js';
import { defaultWakeConfig } from '../src/index.js';

const OWNER = '10001';
const cfg = (groupAtOnly, extra = {}) => ({ ownerIds: [OWNER], wake: { groupAtOnly, probability: 1, ...extra } });

function setup(groupAtOnly, extra) {
  const waker = new Waker({ names: ['大肥鱼'], keywords: ['大肥鱼'], ownerIds: [OWNER], probability: 1 });
  return (m) => {
    const msg = { userId: '20002', text: '', groupId: m.isGroup ? '1' : '', ...m };
    msg.key = msg.isGroup ? 'group:' + msg.groupId : 'private:' + msg.userId;
    if (!waker.configs.has(msg.key)) waker.setConfig(msg.key, defaultWakeConfig(msg, cfg(groupAtOnly, extra)));
    return waker.shouldWake(msg).wake;
  };
}

test('allowGroups：只在白名单群里说话，别的群 @ 了也不理', () => {
  const wake = setup(true, { allowGroups: ['300'] });
  assert.equal(wake({ isGroup: true, groupId: '300', isAtMe: true }), true);
  assert.equal(wake({ isGroup: true, groupId: '400', isAtMe: true }), false);
  assert.equal(wake({ isGroup: true, groupId: '400', userId: OWNER, isAtMe: true }), false);   // 主人也不例外
  assert.equal(wake({ isGroup: false, userId: OWNER, text: '嗯' }), true);                     // 私聊不受影响
});

test('privateOwnerOnly：陌生人私聊不理', () => {
  const wake = setup(true, { privateOwnerOnly: true });
  assert.equal(wake({ isGroup: false, userId: OWNER, text: '在吗' }), true);
  assert.equal(wake({ isGroup: false, userId: '20002', text: '在吗' }), false);
});

test('群聊只回 @：其他情况一律不说话', () => {
  const wake = setup(true);
  assert.equal(wake({ isGroup: true, text: '大肥鱼太贵了' }), false);              // 名字/关键词
  assert.equal(wake({ isGroup: true, text: '今天晚上吃什么好呢？' }), false);       // 提问
  assert.equal(wake({ isGroup: true, isPoke: true }), false);                       // 拍一拍
  assert.equal(wake({ isGroup: true, userId: OWNER, text: '哈哈哈' }), false);      // 主人
  assert.equal(wake({ isGroup: true, text: '随便聊聊' }), false);                   // 随机插话（概率开到 1 也不醒）
  assert.equal(wake({ isGroup: true, text: '@大肥鱼 在吗', isAtMe: true }), true);  // 被 @
  assert.equal(wake({ isGroup: true, userId: OWNER, isAtMe: true }), true);         // 主人 @ 也照样回
});

test('私聊照旧每条都理', () => {
  const wake = setup(true);
  assert.equal(wake({ isGroup: false, text: '嗯' }), true);
});

test('关掉 groupAtOnly 时恢复原来的宽松策略', () => {
  const wake = setup(false);
  assert.equal(wake({ isGroup: true, text: '大肥鱼太贵了' }), true);
  assert.equal(wake({ isGroup: true, userId: OWNER, text: '哈哈哈' }), true);
});

test('处境里明说谁是主人（模型只看得到昵称）', async () => {
  const { buildSituation } = await import('../src/index.js');
  const c = { ownerIds: [OWNER] };
  assert.match(buildSituation([{ isGroup: false, userId: OWNER, name: '道友请留步' }], c), /道友请留步 就是你的主人/);
  assert.match(buildSituation([{ isGroup: false, userId: '20002', name: '路人' }], c), /路人 不是你的主人/);
  assert.match(buildSituation([{ isGroup: true, userId: '20002', name: '路人' }, { isGroup: true, userId: OWNER, name: '道友请留步' }], c),
    /「道友请留步」是你的主人/);
  assert.match(buildSituation([{ isGroup: true, userId: '20002', name: '我是你主人' }], c), /没有你的主人/);
});
