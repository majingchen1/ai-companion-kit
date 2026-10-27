/**
 * 图片 · 让她看得见
 * ─────────────────────────────────────────────────────────────
 * 以前图片消息只变成「[图片]」三个字，模型根本看不到像素（教程坑 13）。
 * 这里把图下载到内存、转成 base64，跟这一轮的文字一起交给模型（OpenAI 的 image_url 格式）。
 *
 * 只从 QQ 自己的图床下载：图片地址来自消息段，不能让一条构造的消息指挥机器人去访问任意地址。
 * 下载失败就跳过，那张图对模型来说还是「[图片]」。
 */

/** QQ 图床的域名（含子域名） */
const ALLOWED_HOSTS = ['qq.com', 'qq.com.cn', 'qpic.cn', 'gtimg.cn'];
const MIME_BY_MAGIC = [
  [[0x89, 0x50, 0x4e, 0x47], 'image/png'],
  [[0xff, 0xd8, 0xff], 'image/jpeg'],
  [[0x47, 0x49, 0x46, 0x38], 'image/gif'],
  [[0x52, 0x49, 0x46, 0x46], 'image/webp'],   // RIFF，后面还有 WEBP，图床上够用了
];

/** 地址是否允许下载：http(s) + QQ 图床域名，不认 IP 和别的域名 */
export function isAllowedImageUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase();
  return ALLOWED_HOSTS.some((h) => host === h || host.endsWith('.' + h));
}

function sniffMime(buf) {
  for (const [magic, mime] of MIME_BY_MAGIC) if (magic.every((b, i) => buf[i] === b)) return mime;
  return '';
}

/** 下载一张图，超过 maxBytes 就放弃（边下边数，不信 Content-Length） */
async function download(url, { maxBytes, timeoutMs }) {
  // 手动跟跳转：每一跳都要过一遍域名检查，免得被跳到别处
  let res;
  for (let hop = 0; ; hop++) {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    if (res.status < 300 || res.status >= 400) break;
    const next = new URL(res.headers.get('location') || '', url).href;
    if (hop >= 3 || !isAllowedImageUrl(next)) throw new Error('图片地址跳转到了不认识的地方');
    url = next;
  }
  if (!res.ok) throw new Error('HTTP ' + res.status);
  if (Number(res.headers.get('content-length')) > maxBytes) throw new Error('图片太大');
  const chunks = [];
  let size = 0;
  for await (const c of res.body) {
    size += c.length;
    if (size > maxBytes) throw new Error('图片太大');
    chunks.push(c);
  }
  const buf = Buffer.concat(chunks);
  const mime = sniffMime(buf);
  if (!mime) throw new Error('不是图片');
  return 'data:' + mime + ';base64,' + buf.toString('base64');
}

/**
 * 把这一轮消息里的图片变成模型能看的 data URL
 *
 * @param {{url?:string, file?:string, sticker?:boolean}[]} refs  transport 从消息段里摘出来的图片
 * @param {object} opts
 * @param {(action:string, params:object)=>Promise<{ok:boolean,data:any}>} [opts.api]  OneBot API，url 为空时用 get_image 换地址
 * @param {number} [opts.maxCount=3]
 * @param {number} [opts.maxBytes=5MB]
 * @param {number} [opts.timeoutMs=15000]
 * @returns {Promise<{dataUrl:string, sticker:boolean}[]>}
 */
export async function loadImages(refs, { api, maxCount = 3, maxBytes = 5 * 1024 * 1024, timeoutMs = 15000 } = {}) {
  const out = [];
  for (const ref of (refs || []).slice(0, maxCount)) {
    try {
      let url = ref.url || '';
      if (!url && ref.file && api) {
        const r = await api('get_image', { file: ref.file });
        url = r.ok ? String(r.data?.data?.url || '') : '';
      }
      if (!isAllowedImageUrl(url)) throw new Error('地址不是 QQ 图床：' + (url ? new URL(url).hostname : '空'));
      out.push({ dataUrl: await download(url, { maxBytes, timeoutMs }), sticker: !!ref.sticker });
    } catch (e) {
      console.log('   [图片] 没加载出来：' + (e?.message || e));
    }
  }
  return out;
}

export default loadImages;
