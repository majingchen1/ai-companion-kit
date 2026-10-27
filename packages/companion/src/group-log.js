/**
 * 群聊短期记忆 · 被 @ 之前群里在聊什么
 * ─────────────────────────────────────────────────────────────
 * 群里只回 @ 时，没 @ 它的消息不会进大脑，被 @ 那一刻它不知道前面在聊什么。
 * 这里把白名单群里的每条消息（加上它自己发的）在内存里留一小段，回复时当作前文给模型；
 * 消息里的图只记链接，有人说「上面那张图」时再下载（见 turn-context.js）。
 *
 * 只在内存里，不落盘、不进长期记忆：长期记忆只记别人对它说的话和它的回复。
 *
 *   const log = new GroupLog();
 *   log.add('group:1', { text: '老张：今天好热', ref: msg, name: '老张', images: msg.images });
 *   log.recent('group:1', { exclude: items })  // → [{ isSelf, text }]
 */
export class GroupLog {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxPerGroup]  每个群最多留几条，默认 30
   * @param {number} [opts.maxAgeMs]     多久以前的不算前文，默认 30 分钟
   */
  constructor({ maxPerGroup = 30, maxAgeMs = 30 * 60 * 1000 } = {}) {
    this.maxPerGroup = maxPerGroup;
    this.maxAgeMs = maxAgeMs;
    /** @type {Map<string, {t:number, isSelf:boolean, text:string, ref?:object, name?:string, images?:object[]}[]>} */
    this.groups = new Map();
  }

  /** 记一条。ref 是原始消息对象，用来在回复时把「这一轮本身」排除掉 */
  add(key, { text, isSelf = false, ref = null, name = '', images = [], forwards = [], t = Date.now() }) {
    text = String(text || '').trim();
    if (!text) return;
    const rows = this.groups.get(key) || [];
    rows.push({ t, isSelf, text, ref, name, images, forwards });
    if (rows.length > this.maxPerGroup) rows.splice(0, rows.length - this.maxPerGroup);
    this.groups.set(key, rows);
  }

  /** 最近 maxAgeMs 内、不含 exclude 里那几条的记录（从早到晚） */
  #rows(key, exclude, now) {
    const skip = new Set(exclude);
    return (this.groups.get(key) || []).filter((r) => now - r.t <= this.maxAgeMs && !(r.ref && skip.has(r.ref)));
  }

  /**
   * 回复用的前文：不含 exclude 里的消息（这一轮合并的那几条），只要最近 maxAgeMs 内的
   * @returns {{isSelf:boolean, text:string}[]}
   */
  recent(key, { exclude = [], n = 15, now = Date.now() } = {}) {
    return this.#rows(key, exclude, now).slice(-n).map(({ isSelf, text }) => ({ isSelf, text }));
  }

  /**
   * 前文最近 lookback 条消息里的图，最新的在前（表情包不算）
   * @returns {{ref:object, name:string}[]}
   */
  recentImages(key, { exclude = [], lookback = 10, now = Date.now() } = {}) {
    const out = [];
    for (const r of this.#rows(key, exclude, now).slice(-lookback).reverse()) {
      for (const ref of (r.images || []).filter((i) => !i.sticker)) out.push({ ref, name: r.name });
    }
    return out;
  }

  /**
   * 把这一轮实际给模型看过的图 / 聊天记录挂到这一轮最后一条消息上。
   * 它们常常来自引用（原消息早就不在前文里了），不挂上的话，下一句「@它 截图意见」就又找不到了
   */
  attach(key, ref, { images = [], forwards = [] } = {}) {
    const row = (this.groups.get(key) || []).find((r) => r.ref === ref);
    if (!row) return;
    const has = new Set(row.images.map((i) => i.file || i.url));
    row.images = [...row.images, ...images.filter((i) => !has.has(i.file || i.url))];
    row.forwards = [...new Set([...row.forwards, ...forwards])];
  }

  /** 前文最近 lookback 条消息里的聊天记录 id，最新的在前 */
  recentForwards(key, { exclude = [], lookback = 10, now = Date.now() } = {}) {
    return this.#rows(key, exclude, now).slice(-lookback).reverse().flatMap((r) => [...(r.forwards || [])].reverse());
  }
}

export default GroupLog;
