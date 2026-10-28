/**
 * 表情包 · 让她偶尔甩一张图
 * ─────────────────────────────────────────────────────────────
 * stickers/ 文件夹里放图，文件名（不带扩展名）就是含义：无语.gif、干饭.png。
 * 模型在回复里写【表情:无语】，这里把它摘出来，换成真的图发出去。
 *
 * - 只能发文件夹里有的：名字对不上就丢掉，模型（或被群友诱导）写什么路径都没用。
 * - 「偶尔」靠冷却兜底：同一个会话发过一张后，cooldownMinutes 内不再把表情包清单给模型，
 *   这期间它照猫画虎写出来的标签也会被摘掉不发。
 * - 文件夹 30 秒重新扫一次，往里加图不用重启。
 */
import fs from 'node:fs';
import path from 'node:path';

const EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
// 【表情:无语】，也认半角括号和中文冒号；「[表情]」「[表情包]」（收到的表情占位）没有冒号，不会被当成标签
const TAG = /[【[]表情[:：]\s*([^】\]\n]{1,30}?)\s*[】\]]/g;

export class Stickers {
  /**
   * @param {object} opts
   * @param {string} opts.dir               表情包文件夹
   * @param {number} [opts.cooldownMinutes] 同一个会话发过一张后，多久内不再发，默认 20
   * @param {number} [opts.maxBytes]        单张上限，超过的不用，默认 2MB
   */
  constructor({ dir, cooldownMinutes = 20, maxBytes = 2 * 1024 * 1024 } = {}) {
    this.dir = dir;
    this.cooldownMs = cooldownMinutes * 60000;
    this.maxBytes = maxBytes;
    this.lastAt = new Map();
    this.cache = null;
    this.cacheAt = 0;
  }

  /** 名字 → 文件路径 */
  list() {
    const now = Date.now();
    if (this.cache && now - this.cacheAt < 30000) return this.cache;
    const out = new Map();
    let files = [];
    try { files = fs.readdirSync(this.dir, { withFileTypes: true }); } catch { /* 没有文件夹就是没有表情包 */ }
    for (const f of files) {
      const ext = path.extname(f.name).toLowerCase();
      if (!f.isFile() || !EXTS.has(ext)) continue;
      const file = path.join(this.dir, f.name);
      try { if (fs.statSync(file).size > this.maxBytes) continue; } catch { continue; }
      out.set(path.basename(f.name, path.extname(f.name)).trim(), file);
    }
    this.cache = out;
    this.cacheAt = now;
    return out;
  }

  /** 这个会话现在能不能发（有图、且不在冷却里） */
  ready(key, now = Date.now()) {
    return this.list().size > 0 && now - (this.lastAt.get(key) ?? -Infinity) >= this.cooldownMs;
  }

  /** 给模型的说明；冷却中或没有图时返回空串，模型就不知道能发 */
  prompt(key) {
    if (!this.ready(key)) return '';
    return '【表情包】\n你手边有一些表情包，可以偶尔发一张：在回复最后单独一行写【表情:名字】，名字只能从这里选：'
      + [...this.list().keys()].join('、') + '\n'
      + '- 大多数回复不用发。聊得轻松、正好有一张对得上当时的情绪时才发，一次最多一张。\n'
      + '- 对方难过、在说正事、认真问问题，或者你在写代码、查资料时，不要发。\n'
      + '- 也可以只发表情包不说话：整条回复就是【表情:名字】。';
  }

  /**
   * 把回复里的标签摘掉；name 只在文件夹里有、且这个会话不在冷却时才给
   * @returns {{text:string, name:string|null}}
   */
  take(key, out) {
    let name = null;
    const files = this.list();
    const text = String(out || '').replace(TAG, (_, n) => {
      if (!name && files.has(n)) name = n;
      return '';
    }).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return { text, name: name && this.ready(key) ? name : null };
  }

  /** 发送用的 file 参数（base64，不依赖 OneBot 那边能不能读到本机路径） */
  file(name) {
    const p = this.list().get(name);
    return p ? 'base64://' + fs.readFileSync(p).toString('base64') : null;
  }

  /** 记下这个会话刚发过一张 */
  mark(key, now = Date.now()) { this.lastAt.set(key, now); }
}

export default Stickers;
