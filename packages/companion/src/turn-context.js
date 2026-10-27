/**
 * 这一轮的额外上下文 · 引用的消息、前文里的图
 * ─────────────────────────────────────────────────────────────
 * 群友常这样让它评价上文：
 *   - 用 QQ 的「回复」引用某条消息再 @ 它 → 消息里只有一个引用 id，看不到引用的是什么
 *   - 「@大肥鱼 评价下上面那张图」     → 前文里只有「[图片]」三个字，看不到图
 * 这里把被引用的原文拼进这句话里（连同里面的图），以及在提到图时把前文最近的图找出来。
 */

/**
 * 把每条消息引用的原文拼到它前面：「（回复 老张：「今天吃火锅」）你觉得呢」
 *
 * @param {object[]} items  这一轮合并的消息
 * @param {(id:string)=>Promise<{userId:string, name:string, text:string, images:object[]}|null>} getMsg
 * @param {object} opts
 * @param {string} [opts.selfId]    机器人自己的 QQ（引用的是它自己说的话时写「你之前说的」）
 * @param {number} [opts.maxChars]  引用原文最多带多少字
 * @param {boolean}[opts.images]    被引用消息里的图也交给模型看
 * @returns {Promise<{items:object[], images:object[]}>}  改写后的消息（原对象不动）+ 引用里的图
 */
export async function attachQuotes(items, getMsg, { selfId = '', maxChars = 300, images = true } = {}) {
  const extraImages = [];
  const cache = new Map();
  const out = [];
  for (const m of items) {
    if (!m.replyTo) { out.push(m); continue; }
    if (!cache.has(m.replyTo)) cache.set(m.replyTo, await getMsg(m.replyTo).catch(() => null));
    const q = cache.get(m.replyTo);
    if (!q) { out.push({ ...m, text: '（回复了一条找不到的消息）' + m.text }); continue; }
    let body = String(q.text || '').replace(/\s+/g, ' ').trim();
    if (body.length > maxChars) body = body.slice(0, maxChars) + '…';
    const who = selfId && q.userId === selfId ? '你之前说的' : (q.name || q.userId || '某人') + ' 的消息';
    const qImages = images ? (q.images || []).filter((r) => !r.sticker) : [];
    extraImages.push(...qImages);
    const note = qImages.length ? '（这条里的图附在后面了）' : '';
    // 引用的是一条聊天记录：交给 expandForwards 一起展开
    const forwards = [...(m.forwards || []), ...(q.forwards || [])];
    out.push({ ...m, forwards, text: '（回复 ' + who + '：「' + (body || '[空]') + '」' + note + '）' + m.text });
  }
  return { items: out, images: extraImages };
}

/**
 * 把消息里的合并转发（聊天记录）展开，接在这条消息后面：
 *   老张：[聊天记录] 你们看看
 *   （转发的聊天记录，共 3 条：
 *     小王：明天几点集合
 *     小李：八点
 *   ）
 *
 * @param {object[]} items  这一轮的消息（带 forwards: id[]）
 * @param {(id:string)=>Promise<{name:string, text:string, images:object[], depth?:number}[]|null>} getForward
 * @param {object} opts
 * @param {number} [opts.maxMessages]  每段聊天记录最多展开几条
 * @param {number} [opts.maxChars]     每段聊天记录最多多少字
 * @param {boolean}[opts.images]       聊天记录里的图也交给模型看
 * @returns {Promise<{items:object[], images:object[]}>}
 */
export async function expandForwards(items, getForward, { maxMessages = 50, maxChars = 3000, images = true } = {}) {
  const extraImages = [];
  const seen = new Set();
  const out = [];
  for (const m of items) {
    const ids = (m.forwards || []).filter((id) => !seen.has(id));
    ids.forEach((id) => seen.add(id));
    if (!ids.length) { out.push(m); continue; }
    let text = m.text;
    for (const id of ids) {
      const list = await getForward(id).catch(() => null);
      if (!list?.length) { text += '\n（转发的聊天记录打不开）'; continue; }
      const lines = [];
      let used = 0;
      for (const r of list.slice(0, maxMessages)) {
        const line = '  '.repeat((r.depth || 0) + 1) + r.name + '：' + String(r.text || '').replace(/\s+/g, ' ').trim();
        if (used + line.length > maxChars) break;
        lines.push(line);
        used += line.length;
        if (images) extraImages.push(...(r.images || []).filter((i) => !i.sticker));
      }
      const rest = list.length - lines.length;
      text += '\n（转发的聊天记录，共 ' + list.length + ' 条：\n' + lines.join('\n')
        + (rest > 0 ? '\n  ……后面还有 ' + rest + ' 条太长没展开' : '') + '\n）';
    }
    out.push({ ...m, text });
  }
  return { items: out, images: extraImages };
}

/**
 * 这句话在说前文的聊天记录（「评价下上面的聊天记录」）、这一轮自己又没带时，找前文里最近的一段
 * @returns {string[]}  转发 id（最多一个）
 */
export function contextForwardIds(text, groupLog, key, { exclude = [], keywords = [], lookback = 10 } = {}) {
  const t = String(text || '');
  if (!groupLog || !keywords.some((k) => k && t.includes(k))) return [];
  return groupLog.recentForwards(key, { exclude, lookback }).slice(0, 1);
}

/**
 * 这句话在说前文的图（「上面那张图」「刚才的截图」）、这一轮自己又没带图时，从前文里找最近的图
 *
 * @param {string} text
 * @param {{recentImages:Function}} groupLog
 * @param {string} key
 * @param {object} opts
 * @param {object[]} [opts.exclude]   这一轮的消息（不算前文）
 * @param {string[]} [opts.keywords]  句子里有这些词才去找
 * @param {number} [opts.lookback]    往前看几条消息
 * @param {number} [opts.maxCount]    最多带几张
 * @returns {{refs:object[], from:string[]}}  图 + 发图的人
 */
export function contextImageRefs(text, groupLog, key, { exclude = [], keywords = [], lookback = 10, maxCount = 1 } = {}) {
  const t = String(text || '');
  if (!groupLog || !keywords.some((k) => k && t.includes(k))) return { refs: [], from: [] };
  const found = groupLog.recentImages(key, { exclude, lookback }).slice(0, maxCount);
  return { refs: found.map((f) => f.ref), from: found.map((f) => f.name) };
}
