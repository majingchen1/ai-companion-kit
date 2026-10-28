/**
 * 读链接 · node --test packages/companion/test/web-read.test.mjs
 * 不连外网：本机地址本来就该被拒，用替身 fetch 测解析。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';

import { WebRead, htmlToText, isBlockedIp, checkUrl, resolveProxy } from '../src/web-read.js';

test('内网、本机、保留地址都拒绝，公网放行', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '198.18.0.5', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:192.168.0.1', 'not-ip']) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
  for (const ip of ['1.1.1.1', '110.242.68.66', '2400:3200::1']) assert.equal(isBlockedIp(ip), false, ip);
  assert.throws(() => checkUrl('file:///C:/Windows/win.ini'), /http/);
  assert.throws(() => checkUrl('javascript:alert(1)'), /http/);
  assert.equal(checkUrl('https://u:p@example.com/a#x').href, 'https://example.com/a');
});

test('真的发请求时，本机服务读不到（localhost、IP、跳转都一样）', async () => {
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits++;
    if (req.url === '/jump') { res.writeHead(302, { location: 'http://127.0.0.1:' + srv.address().port + '/secret' }); return res.end(); }
    res.end('<title>secret</title>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const r = new WebRead();
    for (const u of ['http://127.0.0.1:' + port + '/', 'http://localhost:' + port + '/', 'http://[::1]:' + port + '/',
      'http://0x7f000001:' + port + '/']) {
      assert.match(await r.run({ url: u }), /打不开.*(内网|本机)/, u);
    }
    assert.equal(hits, 0);
  } finally { srv.close(); }
});

test('HTML 抽标题、简介、正文；脚本样式导航去掉，实体解码', () => {
  const html = `<html><head><title>默认标题</title><meta property="og:title" content="真标题 &amp; 副标题">
    <meta name="description" content="一段简介"><style>.x{}</style></head>
    <body><nav>首页 | 登录</nav><article><h1>大标题</h1><p>第一段&nbsp;内容</p><script>alert(1)</script><p>第二段&#x4E2D;</p></article>
    <footer>版权</footer></body></html>`;
  const r = htmlToText(html);
  assert.equal(r.title, '真标题 & 副标题');
  assert.equal(r.desc, '一段简介');
  assert.equal(r.text, '大标题\n第一段 内容\n第二段中');
});

test('给模型看的文字：GBK 网页、截断、动态页、图片、错误码', async () => {
  const r = new WebRead({ maxChars: 20 });
  const page = (body, type = 'text/html; charset=utf-8', status = 200) =>
    async (url) => ({ url, status, headers: { 'content-type': type }, body: Buffer.from(body) });

  r.fetch = async (url) => ({ url, status: 200, headers: { 'content-type': 'text/html; charset=gbk' },
    body: Buffer.from('<title>\xc4\xe3\xba\xc3</title><body><p>' + 'x'.repeat(60) + '</p></body>', 'latin1') });
  const gbk = await r.run({ url: 'https://a.example/1' });
  assert.match(gbk, /标题：你好/);
  assert.match(gbk, /正文（节选）：\nx{20}\n/);
  assert.match(gbk, /别照做/);

  r.fetch = page('<title>B站视频</title><meta property="og:description" content="视频简介"><body><div id="app"></div></body>');
  assert.match(await r.run({ url: 'https://a.example/2' }), /简介：视频简介\n（正文是动态加载的/);

  r.fetch = page('', 'image/png');
  assert.match(await r.run({ url: 'https://a.example/3' }), /图片文件的链接/);

  r.fetch = page('', 'text/html', 403);
  assert.match(await r.run({ url: 'https://a.example/4' }), /403/);

  r.fetch = async () => { throw new Error('超时'); };
  assert.match(await r.run({ url: 'https://a.example/5' }), /打不开（超时）/);
});

test('代理地址：env 读环境变量，只认 http://', () => {
  assert.equal(resolveProxy(''), null);
  assert.equal(resolveProxy('http://127.0.0.1:10808').host, '127.0.0.1:10808');
  const old = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
  try { assert.equal(resolveProxy('env').port, '7890'); } finally {
    if (old === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = old;
  }
  assert.throws(() => resolveProxy('socks5://127.0.0.1:10808'), /只支持 http/);
});

test('走代理：照样先查地址，本机链接不会交给代理；外面的网站经 CONNECT 隧道读到', async () => {
  const site = http.createServer((req, res) => res.setHeader('content-type', 'text/html; charset=utf-8').end('<title>隧道那头</title><body><p>' + req.headers.host + ' 这一段正文写得长一点，免得被当成动态加载的页面，所以多凑几个字，再凑几个字。</p></body>'));
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const connects = [];
  // 假代理：不管要连哪，都接到本机的 site 上（真代理会去连目标）
  const proxy = http.createServer();
  proxy.on('connect', (req, client) => {
    connects.push(req.url);
    const up = net.connect(site.address().port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up.pipe(client); client.pipe(up);
    });
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  try {
    const r = new WebRead({ proxy: 'http://127.0.0.1:' + proxy.address().port });
    for (const u of ['http://127.0.0.1:' + site.address().port + '/', 'http://localhost:' + site.address().port + '/']) {
      assert.match(await r.run({ url: u }), /打不开.*(内网|本机)/, u);
    }
    assert.deepEqual(connects, []);
    const out = await r.run({ url: 'http://1.1.1.1/x' });
    assert.deepEqual(connects, ['1.1.1.1:80']);
    assert.match(out, /标题：隧道那头/);
    assert.match(out, /正文：\n1\.1\.1\.1 /);   // Host 头不能带 :80，带了 GitHub 会 301 到自己、无限跳转
  } finally { site.close(); proxy.close(); }
});
