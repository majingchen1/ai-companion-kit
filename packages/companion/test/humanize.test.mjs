/**
 * 拟人化切分 · node --test packages/companion/test/humanize.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Humanizer } from '../src/humanize.js';

const CODE = 'def bubble_sort(arr):\n    n = len(arr)\n    for i in range(n):\n        pass\n    return arr';

test('代码块整段一条，去掉围栏，缩进保留', () => {
  const parts = new Humanizer().split('行吧，给你写了：\n```python\n' + CODE + '\n```\n拿去');
  assert.deepEqual(parts, ['行吧，给你写了：', CODE, '拿去']);
});

test('条数超量时代码也不会被压成一行', () => {
  const parts = new Humanizer({ burstMax: 2 }).split('第一句\n第二句话说完\n```\n' + CODE + '\n```');
  assert.equal(parts.length, 2);
  assert.ok(parts[1].includes(CODE), parts[1]);
});

test('没有代码时切分照旧', () => {
  assert.deepEqual(new Humanizer().split('在呢\n刚吃完饭'), ['在呢刚吃完饭']);
  assert.deepEqual(new Humanizer().split('今天外面下大雨了\n记得带伞出门啊'), ['今天外面下大雨了', '记得带伞出门啊']);
});
