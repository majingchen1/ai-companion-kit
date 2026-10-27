/**
 * 看图 · node --test packages/companion/test/media.test.mjs
 * 用替身 fetch，不连网。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isAllowedImageUrl, loadImages } from '../src/media.js';
import { imageRefs, segsToText } from '../src/transport-onebot.js';
import { Brain } from '../src/brain.js';
import { Memory } from '../src/memory.js';
import { Role } from '../src/role.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const QQ = 'https://multimedia.nt.qq.com.cn/download?appid=1407&rkey=x';

/** 临时把全局 fetch 换成 routes[url] 给的响应 */
async function withFetch(routes, fn) {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    const r = routes[String(url)];
    if (!r) throw new Error('没有这个地址：' + url);
    return typeof r === 'function' ? r() : r;
  };
  try { return await fn(seen); } finally { globalThis.fetch = real; }
}

const quiet = async (fn) => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };

test('只认 QQ 图床的地址', () => {
  assert.equal(isAllowedImageUrl(QQ), true);
  assert.equal(isAllowedImageUrl('https://gchat.qpic.cn/gchatpic_new/1/2/0'), true);
  assert.equal(isAllowedImageUrl('https://gxh.vip.qq.com/club/item/parcel/item/ab/abc/raw300.gif'), true);
  assert.equal(isAllowedImageUrl('http://127.0.0.1:8765/view'), false);
  assert.equal(isAllowedImageUrl('http://192.168.6.70:8848/'), false);
  assert.equal(isAllowedImageUrl('https://evilqq.com/x.png'), false);
  assert.equal(isAllowedImageUrl('https://qq.com.evil.cn/x.png'), false);
  assert.equal(isAllowedImageUrl('file:///E:/secret.png'), false);
});

test('消息段里摘图，表情包和图片分开', () => {
  const segs = [{ type: 'text', data: { text: '看' } }, { type: 'image', data: { url: QQ, file: 'a.png', sub_type: 0 } },
    { type: 'image', data: { url: '', file: 'b.gif', sub_type: 1, summary: '[动画表情]' } }];
  assert.equal(segsToText(segs), '看[图片][表情包]');
  assert.deepEqual(imageRefs(segs), [{ url: QQ, file: 'a.png', sticker: false }, { url: '', file: 'b.gif', sticker: true }]);
});

test('下载成 data URL；地址为空时用 get_image 换', async () => {
  const api = async (action, p) => ({ ok: action === 'get_image' && p.file === 'b.png', data: { data: { url: QQ + '2' } } });
  const imgs = await withFetch({ [QQ]: new Response(PNG), [QQ + '2']: new Response(PNG) },
    () => loadImages([{ url: QQ }, { url: '', file: 'b.png', sticker: true }], { api }));
  assert.equal(imgs.length, 2);
  assert.equal(imgs[0].dataUrl, 'data:image/png;base64,' + PNG.toString('base64'));
  assert.equal(imgs[1].sticker, true);
});

test('不是图床、太大、不是图片、跳转到别处：都跳过', async () => {
  const big = Buffer.concat([PNG, Buffer.alloc(2000)]);
  const routes = {
    [QQ + 'big']: () => new Response(big),
    [QQ + 'html']: () => new Response('<html>'),
    [QQ + 'jump']: () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8765/view' } }),
  };
  const imgs = await quiet(() => withFetch(routes, (seen) => loadImages(
    [{ url: 'http://127.0.0.1:8765/view' }, { url: QQ + 'big' }, { url: QQ + 'html' }, { url: QQ + 'jump' }],
    { maxCount: 5, maxBytes: 1000 }).then((r) => { assert.ok(!seen.includes('http://127.0.0.1:8765/view')); return r; })));
  assert.deepEqual(imgs, []);
});

test('每轮最多 maxCount 张', async () => {
  const imgs = await withFetch({ [QQ]: () => new Response(PNG) }, () => loadImages([{ url: QQ }, { url: QQ }, { url: QQ }], { maxCount: 2 }));
  assert.equal(imgs.length, 2);
});

test('Brain：有图时用户消息是「文字 + 图」', async () => {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => { calls.push(JSON.parse(b)); res.end(JSON.stringify({ choices: [{ message: { content: '红色方块' } }] })); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'role.md'), '你叫小鱼。');
    const brain = new Brain({ apiKey: 'x', baseUrl: 'http://127.0.0.1:' + srv.address().port,
      role: new Role({ cardPath: path.join(dir, 'role.md') }), memory: new Memory({ dir: path.join(dir, 'data') }) });
    const dataUrl = 'data:image/png;base64,AAAA';
    await brain.reply({ key: 'private:1', userId: '1', text: '道友：[图片]', images: [{ dataUrl }] });
    await brain.reply({ key: 'private:1', userId: '1', text: '在吗' });
    assert.deepEqual(calls[0].messages.at(-1).content, [{ type: 'text', text: '道友：[图片]' }, { type: 'image_url', image_url: { url: dataUrl } }]);
    assert.equal(calls[1].messages.at(-1).content, '在吗');                                // 没图还是纯文字
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
