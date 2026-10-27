/**
 * 联网搜索 · 让她知道今天发生了什么
 * ─────────────────────────────────────────────────────────────
 * 聊天用的 /chat/completions 不会联网。DeepSeek 的 Anthropic 兼容端点有个服务端工具
 * web_search_20250305：把搜索词交给它，它在 DeepSeek 那边搜完，返回结构化结果。
 * 用的是同一个 DeepSeek key，搜索词也只发给 DeepSeek（本来就在处理对话的同一家）。
 *
 * 作为工具交给聊天模型，由模型自己决定什么时候搜：
 *   const web = new WebSearch({ apiKey });
 *   web.tool               → OpenAI tools 格式的定义
 *   await web.run({ query }) → 给模型看的文字（失败也返回文字，不抛）
 */

const DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic/v1';
const CACHE_TTL_MS = 5 * 60 * 1000;

export const WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: '上网搜索实时或你不确定的信息：天气、新闻、最近发生的事、价格、某个人/作品/游戏的最新情况、需要查证的事实。闲聊和关于对方本人的事不用搜。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '搜索词，简短具体，比如「北京 今天 天气」「原神 最新版本」' } },
      required: ['query'],
    },
  },
};

/** 只认 https，免得把 key 发到明文地址 */
function checkBaseUrl(raw) {
  const u = new URL(raw);
  if (u.protocol !== 'https:') throw new Error('搜索端点必须是 https：' + raw);
  return u.href.replace(/\/+$/, '');
}

export class WebSearch {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey
   * @param {string} [opts.baseUrl]     Anthropic 兼容端点，默认 DeepSeek 的
   * @param {string} [opts.model]       默认 deepseek-chat（不思考，搜得快）
   * @param {number} [opts.maxUses]     一次调用里最多搜几次，默认 2
   * @param {number} [opts.maxResults]  给模型看几条结果，默认 6
   * @param {number} [opts.timeoutMs]   默认 30000
   */
  constructor({ apiKey, baseUrl = DEFAULT_BASE_URL, model = 'deepseek-chat', maxUses = 2, maxResults = 6, timeoutMs = 30000 } = {}) {
    this.apiKey = apiKey;
    this.baseUrl = checkBaseUrl(baseUrl);
    this.model = model;
    this.maxUses = maxUses;
    this.maxResults = maxResults;
    this.timeoutMs = timeoutMs;
    this.cache = new Map();   // query → { at, text }，同一个问题几分钟内别重复花钱
    this.tool = WEB_SEARCH_TOOL;
  }

  /** 执行一次搜索，返回给模型看的文字 */
  async run({ query } = {}) {
    const q = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!q) return '搜索词是空的。';
    const hit = this.cache.get(q);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.text;
    try {
      const text = format(q, await this.#request(q), this.maxResults);
      this.cache.set(q, { at: Date.now(), text });
      if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value);
      return text;
    } catch (e) {
      // key 不会出现在这里：报错信息只来自 HTTP 状态和响应体
      return '这次没搜到（' + (e?.message || e) + '）。不确定的就直说不确定，别编。';
    }
  }

  async #request(query) {
    const res = await fetch(this.baseUrl + '/messages', {
      method: 'POST',
      headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 2048,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Perform a web search for the query: ' + query }] }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: this.maxUses }],
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: 'error',
    });
    const raw = await res.text();
    if (!res.ok) throw new Error('搜索接口返回 ' + res.status + '：' + raw.slice(0, 150));
    return JSON.parse(raw);
  }
}

/** Anthropic 响应 → 给模型看的文字：结果列表 + 搜索模型写的摘要（摘要里有具体数字，列表里常常只有标题） */
export function format(query, resp, maxResults = 6) {
  const blocks = Array.isArray(resp?.content) ? resp.content : [];
  const seen = new Set();
  const results = [];
  for (const b of blocks) {
    if (b?.type !== 'web_search_tool_result') continue;
    for (const r of b.content || []) {
      if (r?.type !== 'web_search_result' || !r.url || seen.has(r.url)) continue;
      seen.add(r.url);
      results.push(r);
    }
  }
  const summary = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('').trim().slice(0, 1500);
  if (!results.length && !summary) return '「' + query + '」没搜到相关结果。';
  const lines = ['搜索「' + query + '」的结果：'];
  results.slice(0, maxResults).forEach((r, i) => {
    lines.push((i + 1) + '. ' + String(r.title || '').slice(0, 80) + (r.page_age ? '（' + r.page_age + '）' : '') + ' ' + r.url);
  });
  if (summary) lines.push('', '摘要：' + summary);
  lines.push('', '（用你自己的话简短说给对方听，别贴链接列表和表格，除非对方要链接；网上说法不一致就说不一致）');
  return lines.join('\n');
}

export default WebSearch;
