#!/usr/bin/env node
/**
 * 把「大肥鱼日常表情包」（github.com/diwer/ai-biaoqingbao，CC BY-NC-SA 4.0，非商业）导进表情包文件夹
 * ─────────────────────────────────────────────────────────────
 * 仓库里的图按编号命名（001.gif），含义在 README 的目录表里；这里按表把图存成「含义.gif」，
 * stickers.js 靠文件名告诉模型每张是什么。NOTICE.txt 一起拷过去，署名跟着素材走。
 *
 *   node scripts/import-dafeiyu-stickers.mjs                 240×240（每张几十 KB，默认）
 *   node scripts/import-dafeiyu-stickers.mjs --size 512      512×512（每张约 200KB）
 *   node scripts/import-dafeiyu-stickers.mjs --dir 别的文件夹 --force
 *
 * 走代理（设了 HTTPS_PROXY）时，Node 的 fetch 默认不认代理，要加环境变量：
 *   NODE_USE_ENV_PROXY=1 node scripts/import-dafeiyu-stickers.mjs
 *
 * 已经有的同名文件不覆盖（--force 才覆盖）；删掉的图重新跑会回来，不想要的用 --exclude 爱你,亲亲 跳过。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAW = 'https://raw.githubusercontent.com/diwer/ai-biaoqingbao/master/';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
};
const size = arg('size', '240');
const dir = path.resolve(arg('dir', path.join(__dirname, '..', 'packages', 'companion', 'stickers')));
const force = process.argv.includes('--force');
const exclude = new Set(String(arg('exclude', '')).split(/[,，]/).map((s) => s.trim()).filter(Boolean));
if (!['240', '512'].includes(size)) { console.error('--size 只能是 240 或 512'); process.exit(1); }

async function get(file) {
  const res = await fetch(RAW + file, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(file + ' 下载失败：' + res.status);
  return Buffer.from(await res.arrayBuffer());
}

// 目录表：|001|[不服气](docs/media/001.gif)|不服气|首批常用|
const readme = (await get('README.md')).toString('utf8');
const rows = [...readme.matchAll(/^\|(\d{3})\|\[([^\]]+)\]\(docs\/media\/\1\.gif\)\|([^|]*)\|([^|]*)\|/gm)]
  .map(([, no, label]) => ({ no, name: label.replace(/[\\/:*?"<>|！!。.\s]/g, '') }))
  .filter((r) => r.name && !exclude.has(r.name));
if (!rows.length) { console.error('README 里没找到目录表，仓库格式可能变了'); process.exit(1); }

fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'NOTICE-大肥鱼表情包.txt'), await get('NOTICE.txt'));

let added = 0, kept = 0;
const seen = new Set();
for (const r of rows) {
  let name = r.name;
  for (let i = 2; seen.has(name); i++) name = r.name + i;   // 含义重名就加个序号
  seen.add(name);
  const out = path.join(dir, name + '.gif');
  if (fs.existsSync(out) && !force) { kept++; continue; }
  const src = size === '512' ? 'stickers/512/' + r.no + '.gif' : 'docs/media/' + r.no + '.gif';
  fs.writeFileSync(out, await get(src));
  added++;
  process.stdout.write('\r  ' + added + ' 张  ' + name + '        ');
}
console.log('\n导入完成：新增 ' + added + ' 张，已有没动 ' + kept + ' 张 → ' + dir);
console.log('素材来自 github.com/diwer/ai-biaoqingbao，CC BY-NC-SA 4.0，只能非商业使用，署名见 NOTICE-大肥鱼表情包.txt');
