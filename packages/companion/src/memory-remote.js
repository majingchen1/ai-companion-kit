/**
 * 远程记忆 · 接外部的长期记忆服务
 * ─────────────────────────────────────────────────────────────
 * Memory（people.json）是本地的一本小账：只会追加、按条数裁剪。
 * 这里接的是一个独立的记忆服务（companion_memory 的 server.py），它会：
 *   - 每轮在后台抽取事实，会改口、会合并、会遗忘
 *   - 按对方这句话预先检索相关的记忆
 *   - 记得「上次聊了什么」「之后该问问的事」
 *
 * 服务挂了不影响聊天：所有方法失败都返回 null / false，Brain 会退回用本地 Memory。
 *
 *   const remote = new RemoteMemory({ url: 'http://127.0.0.1:8765' });
 *   const ctx = await remote.context({ userId: '123', text: '在吗' });
 *   // → { memory, recall, history } 或 null
 */
export class RemoteMemory {
  /**
   * @param {object} opts
   * @param {string} [opts.url]        记忆服务地址，默认 http://127.0.0.1:8765
   * @param {number} [opts.timeoutMs]  单次请求超时，默认 8000（检索要调一次 embedding）
   */
  constructor({ url = 'http://127.0.0.1:8765', timeoutMs = 8000 } = {}) {
    this.url = url.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.lastWarnAt = 0;
    this.toolDefs = null;
  }

  async #post(path, body) {
    const res = await fetch(this.url + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error('记忆服务返回 ' + res.status + '：' + raw.slice(0, 200));
    return JSON.parse(raw);
  }

  /** 服务连不上时一分钟最多提醒一次，免得刷屏 */
  #warn(what, e) {
    if (Date.now() - this.lastWarnAt < 60000) return;
    this.lastWarnAt = Date.now();
    console.error('[记忆服务] ' + what + '失败，先用本地记忆：' + (e?.message || e));
  }

  /** 服务在不在（启动时探一下） */
  async health() {
    try {
      const res = await fetch(this.url + '/health', { signal: AbortSignal.timeout(this.timeoutMs) });
      return res.ok ? await res.json() : null;
    } catch { return null; }
  }

  /**
   * 取这一轮要用的记忆
   * @param {object} q
   * @param {boolean} [q.tools]  这一轮会不会把记忆工具交给模型（影响提示词里怎么交代记忆的用法）
   * @returns {Promise<{memory:string, recall:string, history:{role:string, content:string}[]} | null>}
   */
  async context({ userId, text, tools = false }) {
    try { return await this.#post('/context', { user_id: String(userId), text: String(text || ''), tools }); }
    catch (e) { this.#warn('取记忆', e); return null; }
  }

  /**
   * 记忆工具的定义（OpenAI tools 格式），交给模型让它自己决定查不查、查什么。
   * 定义以服务端为准；取到一次就缓存，取不到返回 null（这一轮就不给模型工具）。
   */
  async tools() {
    if (this.toolDefs) return this.toolDefs;
    try {
      const res = await fetch(this.url + '/tools', { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!res.ok) throw new Error('记忆服务返回 ' + res.status);
      this.toolDefs = (await res.json()).tools || null;
      return this.toolDefs;
    } catch (e) { this.#warn('取记忆工具', e); return null; }
  }

  /** 执行模型发起的一次记忆工具调用，返回给模型看的文字（失败也返回文字，让模型知道没查到） */
  async callTool({ userId, name, args }) {
    try { return (await this.#post('/tool', { user_id: String(userId), name, arguments: args })).content; }
    catch (e) { this.#warn('查记忆', e); return '记忆暂时查不了：' + (e?.message || e); }
  }

  /** 记下一问一答（服务端在后台抽取，不用等） */
  async ingest({ userId, text, reply }) {
    try { await this.#post('/ingest', { user_id: String(userId), text: String(text || ''), reply: String(reply || '') }); return true; }
    catch (e) { this.#warn('写记忆', e); return false; }
  }

  /** 结束这段聊天（服务端也会自己按闲置时间归档，一般不用手动调） */
  async end(userId) {
    try { await this.#post('/end', { user_id: String(userId) }); return true; }
    catch (e) { this.#warn('归档聊天', e); return false; }
  }
}

export default RemoteMemory;
