/**
 * 大脑 · 把消息变成回复
 * ─────────────────────────────────────────────────────────────
 * 这一层只做三件事：
 *   1. 组装上下文（角色卡 + 记忆 + 最近的对话 + 当前处境）
 *   2. 调模型
 *   3. 把这一轮写回记忆
 *
 * 它不关心消息从哪来（QQ / 微信 / 命令行都行），
 * 也不关心怎么发出去（那是 transport 的事）。
 */
import { Memory } from './memory.js';
import { Role } from './role.js';

/** 「2026-10-27 14:50 星期一」，按本机时区 */
function nowText(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    + ' 星期' + '日一二三四五六'[d.getDay()];
}

/** 给了搜索工具时附在提示词末尾 */
const WEB_RULES = `你可以用 web_search 上网查。
- 天气、新闻、最近发生的事、你不确定的事实，先查再答，别凭印象编；闲聊和关于对方本人的事不用查。
- 查到了就用自己的话简短说，像朋友转述，不要贴链接列表、不要表格，对方要链接再给。
- 查不到或者说法不一，就直说。`;

export class Brain {
  /**
   * @param {object} opts
   * @param {string}  opts.apiKey
   * @param {string}  [opts.baseUrl]   默认 https://api.deepseek.com/v1
   * @param {string}  [opts.model]     默认 deepseek-chat
   * @param {number}  [opts.timeoutMs] 默认 120000
   * @param {Role}    opts.role
   * @param {Memory}  opts.memory
   * @param {import('./memory-remote.js').RemoteMemory} [opts.remote]  长期记忆服务（可选，目前只用于私聊）
   * @param {number}  [opts.maxToolRounds]  模型最多连着调几轮工具（查记忆、搜索），默认 3；0 = 不给模型工具
   * @param {import('./web-search.js').WebSearch} [opts.webSearch]  联网搜索（可选，私聊和群聊都给）
   */
  constructor({ apiKey, baseUrl = 'https://api.deepseek.com/v1', model = 'deepseek-chat', timeoutMs = 120000, role, memory, remote, maxToolRounds = 3, webSearch }) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.role = role || new Role({ cardPath: 'role.md' });
    this.memory = memory || new Memory({ dir: './data' });
    this.remote = remote || null;
    this.maxToolRounds = maxToolRounds;
    this.webSearch = webSearch || null;
  }

  /** 调一次模型。tools 给了就允许它调工具；toolChoice='none' 时带着工具定义但不让调（用来收尾） */
  async #complete(messages, tools = null, toolChoice = undefined) {
    const body = { model: this.model, messages, temperature: 1.1, stream: false };
    if (tools) { body.tools = tools; if (toolChoice) body.tool_choice = toolChoice; }
    const res = await fetch(this.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + this.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error('模型返回 ' + res.status + '：' + raw.slice(0, 300));
    try { return JSON.parse(raw); } catch { throw new Error('模型返回不是 JSON：' + raw.slice(0, 200)); }
  }

  /**
   * 生成一条回复
   *
   * @param {object} input
   * @param {string} input.key         会话标识
   * @param {string} input.userId      对方 id
   * @param {string} [input.userName]
   * @param {string} input.text        对方说的话（可以是合并后的一批）
   * @param {string} [input.situation] 处境描述（"你在群里，刚才在聊……"）
   * @param {Array}  [input.history]   该会话最近的消息（可选，通常靠 memory 就够）
   * @param {boolean}[input.record=true] 是否把这一轮写回记忆
   * @param {{dataUrl:string, sticker?:boolean}[]} [input.images] 这一轮的图片（media.loadImages 的结果），只在这一轮给模型看
   * @returns {Promise<{text:string, reasoning?:string, raw:any, toolCalls:{name:string, args:object}[]}>}
   */
  async reply(input) {
    const { key, userId, userName, text, situation = '', history = [], record = true, images = [] } = input;

    // 长期记忆服务目前只接私聊：群里一段话是好几个人说的，记到谁头上还没处理
    const useRemote = this.remote && !String(key || '').startsWith('group:');
    // 记忆工具：自动检索之外，模型觉得不够还能自己查（agentic RAG）；只在私聊给
    let memTools = useRemote && this.maxToolRounds > 0 ? await this.remote.tools() : null;
    const ctx = useRemote ? await this.remote.context({ userId, text, tools: !!memTools }) : null;
    if (!ctx) memTools = null;   // 服务挂了：记忆工具也用不了
    // 联网搜索：私聊、群聊都给
    const web = this.webSearch && this.maxToolRounds > 0 ? this.webSearch : null;
    const tools = [...(memTools || []), ...(web ? [web.tool] : [])];
    const runTool = (name, args) => (web && name === web.tool.function.name
      ? web.run(args)
      : memTools ? this.remote.callTool({ userId, name, args }) : Promise.resolve('没有这个工具：' + name));
    // 记忆块里自带「现在是…」；没有记忆块（群聊、服务挂了）时补上，不然模型不知道今天几号，搜新闻会带错年份
    const platform = [ctx ? '' : '现在是 ' + nowText() + '。', input.platform || '', web ? WEB_RULES : '']
      .filter(Boolean).join('\n');
    const memLine = ctx
      ? [ctx.memory, ctx.recall].filter(Boolean).join('\n\n')
      : this.memory.renderPerson(userId);
    // 服务还会给出这段聊天之前的几轮（本地 Memory 只有跨场合的对话流，没有当前这段）
    const turns = !history.length && ctx?.history?.length
      ? ctx.history.map((m) => ({ isSelf: m.role === 'assistant', text: m.content }))
      : history;
    const recent = this.memory.renderRecent(20, { excludeWhere: key });
    const sys = this.role.build({
      situation,
      memory: memLine,
      recent,
      platform,
    });

    const messages = [{ role: 'system', content: sys }];
    for (const h of turns.slice(-20)) {
      messages.push({ role: h.isSelf ? 'assistant' : 'user', content: String(h.text || '') });
    }
    // 有图就用多模态格式：文字 + 图。图只给这一轮看，历史和记忆里还是「[图片]」文字
    messages.push({
      role: 'user',
      content: images.length
        ? [{ type: 'text', text: String(text || '') },
           ...images.map((img) => ({ type: 'image_url', image_url: { url: img.dataUrl } }))]
        : String(text || ''),
    });

    // 模型要查记忆 / 上网就去查，查完接着想；最多 maxToolRounds 轮，用完了带着工具定义但不许再调，逼它直接回答
    const toolCalls = [];
    const offered = tools.length ? tools : null;
    let json;
    for (let round = 0; ; round++) {
      const last = offered && round >= this.maxToolRounds;
      json = await this.#complete(messages, offered, last ? 'none' : undefined);
      const msg = json.choices?.[0]?.message;
      const calls = !offered || last ? [] : (msg?.tool_calls || []);
      if (!calls.length) break;
      messages.push({
        role: 'assistant', content: msg.content || null, tool_calls: calls,
        // 思考模式的模型（如 deepseek-flash）调工具时要把思考内容原样带回去
        ...(msg.reasoning_content ? { reasoning_content: msg.reasoning_content } : {}),
      });
      for (const c of calls) {
        let args = {};
        try { args = JSON.parse(c.function?.arguments || '{}'); } catch { /* 参数坏了就空着查，服务端会报参数错误 */ }
        const name = c.function?.name || '';
        toolCalls.push({ name, args });
        messages.push({ role: 'tool', tool_call_id: c.id, content: String(await runTool(name, args)) });
      }
    }
    const msg = json.choices?.[0]?.message;
    const out = String(msg?.content || '').trim();

    if (record) {
      this.memory.remember(userId, { name: userName, topic: (text || '').slice(0, 40) + ' → ' + out.slice(0, 40) });
      this.memory.logTurn({ where: key, who: userName || userId, text, reply: out });
      // 不等：服务端在后台抽取，失败也不影响这次回复
      if (ctx && out) this.remote.ingest({ userId, text, reply: out });
    }
    return { text: out, reasoning: msg?.reasoning_content, raw: json, toolCalls };
  }

  /**
   * 让它自己写一条记忆（对应暴露给 AI 的 remember 工具）
   */
  remember(userId, { trait, fact, topic, pending, name }) {
    return this.memory.remember(userId, { trait, fact, topic, pending, name });
  }
}

export default Brain;
