/**
 * 传输层 · OneBot v11 适配
 * ─────────────────────────────────────────────────────────────
 * OneBot v11 是一个被广泛实现的机器人协议：
 *   NapCat / Lagrange / LLOneBot / go-cqhttp / SnowLuma 都实现了它。
 *
 * 这一层负责：
 *   - 连上 OneBot 的 WebSocket，收消息
 *   - 把 OneBot 的原始事件翻译成统一格式
 *   - 提供「发消息」「发图」「正在输入」等动作
 *
 * 如果你想接别的平台（微信/Telegram/自研），照着这个接口再写一个就行。
 */

/**
 * 把 OneBot 消息段数组拼成纯文本。
 * 给了 selfId 时 @ 自己的那段去掉：它只是在叫机器人（有没有被 @ 另看 isAtMe），
 * 留成「如何评价@123456」模型会以为要评价 123456 这个人
 */
function segsToText(segs, selfId = '') {
  if (!Array.isArray(segs)) return String(segs || '');
  const out = [];
  for (const s of segs) {
    if (!s) continue;
    switch (s.type) {
      case 'text': out.push(s.data?.text || ''); break;
      case 'at': if (!selfId || String(s.data?.qq) !== selfId) out.push('@' + (s.data?.qq || '')); break;
      case 'image': out.push(isSticker(s.data) ? '[表情包]' : '[图片]'); break;
      case 'face': out.push('[表情]'); break;
      case 'reply': break;   // 引用单独处理
      // 下面这些以前直接丢掉：只发一条语音/卡片时会变成空消息，私聊里照样唤醒，模型对着空白回话
      case 'record': out.push('[语音]'); break;
      case 'video': out.push('[视频]'); break;
      case 'file': out.push('[文件' + (s.data?.name ? '：' + s.data.name : '') + ']'); break;
      case 'forward': out.push('[聊天记录]'); break;
      case 'json': out.push(cardText(s.data?.data)); break;
      default: break;
    }
  }
  return out.join('').trim();
}

/** 动画表情 / 商城表情包（sub_type=1 或带 emoji_id），跟正经图片区分开 */
function isSticker(d) {
  return Number(d?.sub_type) === 1 || !!d?.emoji_id;
}

/** 摘出消息里的图片，交给 media.loadImages 下载 */
function imageRefs(segs) {
  if (!Array.isArray(segs)) return [];
  return segs.filter((s) => s?.type === 'image')
    .map((s) => ({ url: String(s.data?.url || ''), file: String(s.data?.file || ''), sticker: isSticker(s.data) }));
}

/** 摘出消息里的合并转发（聊天记录）id，交给 getForward 展开 */
function forwardIds(segs) {
  if (!Array.isArray(segs)) return [];
  return segs.filter((s) => s?.type === 'forward' && s.data?.id).map((s) => String(s.data.id));
}

/** 分享卡片（json 段）→ 标题 + 描述 + 链接，让模型知道分享的是什么（教程 FAQ Q6） */
function cardText(raw) {
  try {
    const j = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const d = j?.meta?.detail_1 || j?.meta?.news || Object.values(j?.meta || {})[0] || {};
    const url = d.qqdocurl || d.jumpUrl || d.url || '';
    const parts = [d.title, d.desc && d.desc !== d.title ? '（' + d.desc + '）' : '', url].filter(Boolean);
    return parts.length ? '[卡片] ' + parts.join(' ') : '[卡片]';
  } catch {
    return '[卡片]';
  }
}

/** 从消息段里找引用 */
function findReply(segs) {
  if (!Array.isArray(segs)) return null;
  for (const s of segs) if (s?.type === 'reply') return String(s.data?.id || '');
  return null;
}

export class OneBot {
  /**
   * @param {object} opts
   * @param {string} opts.wsUrl       例如 ws://127.0.0.1:3001
   * @param {string} [opts.httpUrl]   例如 http://127.0.0.1:3000（发消息用）
   * @param {string} [opts.accessToken]
   * @param {string} [opts.httpAccessToken]  HTTP 和 WS 的 token 不一样时填（比如 SnowLuma 分开配置），默认同 accessToken
   * @param {(msg:object)=>void} [opts.onMessage]
   */
  constructor({ wsUrl, httpUrl, accessToken = '', httpAccessToken = '', onMessage }) {
    this.wsUrl = wsUrl;
    this.httpUrl = (httpUrl || '').replace(/\/+$/, '');
    this.accessToken = accessToken;
    this.httpAccessToken = httpAccessToken || accessToken;
    this.onMessage = onMessage;
    this.selfId = '';
    this.ws = null;
    this.connected = false;
    this.#connect();
  }

  #headers(token = this.accessToken) {
    const h = {};
    if (token) h.authorization = 'Bearer ' + token;
    return h;
  }

  async #connect() {
    const { WebSocket } = await import('ws').catch(() => ({ WebSocket: globalThis.WebSocket }));
    const sock = new WebSocket(this.wsUrl, { headers: this.#headers() });
    this.ws = sock;

    sock.on?.('open', () => { this.connected = true; console.log('[onebot] 已连接 ' + this.wsUrl); });
    sock.on?.('close', () => {
      this.connected = false;
      console.log('[onebot] 断开，5 秒后重连');
      setTimeout(() => this.#connect(), 5000);
    });
    sock.on?.('error', (e) => console.log('[onebot] 出错 ' + (e?.message || e)));
    sock.on?.('message', (data) => {
      let ev;
      try { ev = JSON.parse(String(data)); } catch { return; }
      this.#handle(ev);
    });
  }

  #handle(ev) {
    if (ev.post_type === 'meta_event' && ev.meta_event_type === 'lifecycle') {
      this.selfId = String(ev.self_id || '');
      return;
    }
    if (ev.post_type !== 'message') return;
    if (ev.self_id) this.selfId = String(ev.self_id);

    const isGroup = ev.message_type === 'group';
    const segs = ev.message;
    const replyId = findReply(segs);
    // 有没有 @ 我
    const atMe = Array.isArray(segs) && segs.some((s) => s?.type === 'at' && String(s.data?.qq) === this.selfId);

    const msg = {
      key: isGroup ? 'group:' + ev.group_id : 'private:' + ev.user_id,
      isGroup,
      groupId: isGroup ? String(ev.group_id) : '',
      userId: String(ev.user_id),
      name: String(ev.sender?.card || ev.sender?.nickname || ev.user_id),
      text: segsToText(segs, this.selfId) || (atMe ? '（@了你一下）' : ''),
      images: imageRefs(segs),
      forwards: forwardIds(segs),
      raw: segs,
      isAtMe: atMe,
      isQuoteMe: false,   // 需要额外查询被引用消息的发送者，见 resolveQuote
      replyTo: replyId,
      messageId: String(ev.message_id || ''),
      time: (ev.time || Math.floor(Date.now() / 1000)) * 1000,
    };
    this.onMessage?.(msg);
  }

  /** 调 OneBot 的 HTTP API */
  async api(action, params = {}) {
    if (!this.httpUrl) return { ok: false, error: '没配 httpUrl' };
    try {
      const r = await fetch(this.httpUrl + '/' + action, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.#headers(this.httpAccessToken) },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(30000),
      });
      const t = await r.text();
      let j; try { j = JSON.parse(t); } catch { j = { raw: t }; }
      return { ok: r.ok && j.status !== 'failed', data: j, error: j.message || j.wording };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }

  /**
   * 发一条纯文本
   * 用消息段数组而不是字符串：字符串会被 OneBot 当 CQ 码解析，模型（或被群友诱导）说出
   * 「[CQ:at,qq=all]」就真的 @全体，说出「[CQ:image,file=本地路径]」就真的把本机文件发出去
   */
  send(key, text, { atUserId } = {}) {
    const isGroup = key.startsWith('group:');
    const id = key.split(':')[1];
    const message = [];
    if (atUserId) message.push({ type: 'at', data: { qq: String(atUserId) } }, { type: 'text', data: { text: ' ' } });
    message.push({ type: 'text', data: { text: String(text) } });
    return isGroup
      ? this.api('send_group_msg', { group_id: id, message })
      : this.api('send_private_msg', { user_id: id, message });
  }

  /** 发一张图（本地文件或 URL）—— 只给程序自己调，别把模型输出直接传进来 */
  sendImage(key, file) {
    const isGroup = key.startsWith('group:');
    const id = key.split(':')[1];
    const message = [{ type: 'image', data: { file: String(file) } }];
    return isGroup
      ? this.api('send_group_msg', { group_id: id, message })
      : this.api('send_private_msg', { user_id: id, message });
  }

  /**
   * 「正在输入…」
   * OneBot 扩展接口，部分实现支持（SnowLuma 是 set_input_status）
   */
  async setTyping(key, on) {
    const isGroup = key.startsWith('group:');
    const id = key.split(':')[1];
    return this.api('set_input_status', isGroup
      ? { group_id: id, event_type: on ? 1 : 0 }
      : { user_id: id, event_type: on ? 1 : 0 });
  }

  /** 取一条消息的内容（被引用的消息）：谁发的、文字、图；查不到返回 null */
  async getMsg(messageId) {
    const r = await this.api('get_msg', { message_id: messageId });
    const d = r.ok ? r.data?.data : null;
    if (!d) return null;
    return {
      userId: String(d.sender?.user_id || d.user_id || ''),
      name: String(d.sender?.card || d.sender?.nickname || d.user_id || ''),
      text: segsToText(d.message, this.selfId),
      images: imageRefs(d.message),
      forwards: forwardIds(d.message),
    };
  }

  /**
   * 展开一条合并转发（聊天记录）：每条是谁说的、说了什么、带的图。
   * 转发里套着的转发再展开 depth 层，更深的只留「[聊天记录]」。查不到返回 null
   * @returns {Promise<{name:string, text:string, images:object[], depth:number}[]|null>}
   */
  async getForward(id, { depth = 1 } = {}) {
    const r = await this.api('get_forward_msg', { id, message_id: id });
    const list = r.ok ? (r.data?.data?.messages || r.data?.data?.message || null) : null;
    if (!Array.isArray(list)) return null;
    const out = [];
    for (const n of list) {
      const segs = n.message || n.content || [];
      out.push({
        name: String(n.sender?.card || n.sender?.nickname || n.user_id || '某人'),
        text: segsToText(segs),
        images: imageRefs(segs),
        depth: 0,
      });
      for (const fid of depth > 0 ? forwardIds(segs) : []) {
        const inner = await this.getForward(fid, { depth: depth - 1 });
        for (const m of inner || []) out.push({ ...m, depth: m.depth + 1 });
      }
    }
    return out;
  }

  /** 查一条消息是谁发的（用来判断引用的是不是我） */
  async whoSent(messageId) {
    const r = await this.api('get_msg', { message_id: messageId });
    return r.ok ? String(r.data?.data?.user_id || '') : '';
  }
}

export { segsToText, imageRefs, forwardIds };
export default OneBot;
