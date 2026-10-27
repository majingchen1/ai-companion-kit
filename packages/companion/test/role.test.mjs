/**
 * 角色卡注入 · node --test packages/companion/test/role.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Role } from '../src/role.js';

test('记忆和最近对话再长，角色卡也完整注入', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'role-test-'));
  try {
    const card = path.join(dir, 'role.md');
    fs.writeFileSync(card, '你叫大肥鱼。' + '说话简短。'.repeat(200) + '【卡尾】');
    const role = new Role({ cardPath: card, maxChars: 2000 });
    const sys = role.build({ memory: '记'.repeat(3000), recent: '聊'.repeat(13000) });
    assert.match(sys, /【卡尾】/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('角色卡本身超过上限才截断', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'role-test-'));
  try {
    const card = path.join(dir, 'role.md');
    fs.writeFileSync(card, '设'.repeat(500) + '【卡尾】');
    const sys = new Role({ cardPath: card, maxChars: 100 }).build({});
    assert.doesNotMatch(sys, /【卡尾】/);
    assert.ok(sys.includes('设'.repeat(100)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
