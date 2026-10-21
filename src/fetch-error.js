// 搜图失败分类：把网络层的原始报错翻成**一句人话**（给模型/给用户）。
//
// 为什么要有它：以图搜图最常砸的不是"引擎挂了"，而是**出口网络**——
// DNS 被污染、代理没开、目标站在墙外、TLS 被中间人挡。而原始异常往往只有
// 一句 'fetch failed' 加一个 code，模型看到之后只会换个地址继续重试。
// 本模块把它翻成"人话 + 这次有没有走代理 + 是谁的问题"，调用方直接转述即可。
//
// 🔴 反向要求（判据 '测试-现行/test-搜图失败分类.mjs' 会扫输出）：
//    **输出里绝不允许出现裸的 'fetch failed' 字样** —— 原始 message 里有，
//    也一律替换成人话。裸报错会让人以为是代码坏了，其实是路不通。
//
// 纯函数：不 import 任何东西、不碰网络、不读配置。

// Cloudflare / 人机验证页的特征（与 src/cf-fetch.js 的 CHALLENGE_RE 同源口径）
const CHALLENGE_RE = /just a moment|checking your browser|verify you are human|challenge-platform|cf-chl|__cf_chl|attention required|请稍候/i;
// TLS 类：Node 的 code 是 CERT_HAS_EXPIRED / DEPTH_ZERO_SELF_SIGNED_CERT…，
// 而 undici/boringSSL 那一侧有时只给 UNABLE_TO_VERIFY_LEAF_SIGNATURE
const CERT_RE = /^(CERT_|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT|ERR_TLS)/;
// 超时类：undici 有几档不同的超时（连上、等头、等体），人话都是"超时"
const TIMEOUT_RE = /TIMEOUT|ETIMEDOUT/;
// 连接被重置/拒绝类
const RESET_RE = /^(UND_ERR_SOCKET|ECONNRESET|EPIPE|ECONNABORTED|ERR_SOCKET)/;
const REFUSED_RE = /^(ECONNREFUSED|EHOSTUNREACH|ENETUNREACH)/;
// DNS 类：ENOTFOUND = 这个域名不存在；EAI_AGAIN = DNS 服务器没答上来（国内很常见）
const DNS_RE = /^(ENOTFOUND|EAI_AGAIN|EAI_NODATA|EAI_NONAME)$/;

function codeOf(err) {
  const c = err?.cause?.code || err?.code || err?.cause?.errno || err?.errno || '';
  return String(c || '').trim().toUpperCase().slice(0, 40);
}

function statusOf(err) {
  const n = Number(err?.status ?? err?.statusCode ?? err?.cause?.status ?? 0);
  return Number.isInteger(n) && n >= 400 && n <= 599 ? n : 0;
}

/** 原始 message，但**先洗掉裸 'fetch failed'**（判据会扫），再压空白、限长。 */
function cleanMessage(err) {
  return String(err?.cause?.message || err?.message || '')
    .replace(/fetch\s+failed/gi, '连接没能建立')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

/**
 * 把一次搜图请求的失败翻成人话。
 * @param {unknown} err 原始异常（undici TypeError / Electron 错误 / {status} 都行）
 * @param {{host?: string, usedProxy?: boolean}} ctx 目标主机名与"这次有没有走代理"
 * @returns {string} 中文人话，一句话
 */
export function describeFetchError(err, { host = '', usedProxy = false } = {}) {
  const code = codeOf(err);
  const status = statusOf(err);
  const detail = cleanMessage(err);
  const target = host ? `目标 ${host}` : '目标主机（未提供）';
  const via = usedProxy ? '这次请求走了代理' : '这次请求没走代理（直连）';

  let what;
  let tag;
  if (CHALLENGE_RE.test(detail)) {
    what = '好像被 Cloudflare 的人机验证挡下了';
    tag = status ? `HTTP ${status}` : (code || '挑战页');
  } else if (DNS_RE.test(code)) {
    what = '域名解析不出来（DNS 没查到这个地址）';
    tag = code;
  } else if (TIMEOUT_RE.test(code)) {
    what = '连接超时（对方一直没回话）';
    tag = code;
  } else if (CERT_RE.test(code)) {
    what = 'TLS 证书没过（HTTPS 的证书有问题）';
    tag = code;
  } else if (REFUSED_RE.test(code)) {
    what = '连接被拒绝（对面那个端口没人接）';
    tag = code;
  } else if (RESET_RE.test(code) || /socket hang up/i.test(detail)) {
    what = '连接中途被重置';
    tag = code || 'socket hang up';
  } else if (status) {
    what = `对方返回 HTTP ${status}`;
    tag = `HTTP ${status}`;
  } else if (detail) {
    what = `请求没成功：${detail}`;
    tag = code;
  } else {
    what = '请求没成功（没拿到更具体的原因）';
    tag = code;
  }

  const detailTail = tag ? `，原始标识 ${tag}` : '';
  return `搜图失败：${what}（${target}；${via}${detailTail}）。这是出口网络的问题，不是搜图功能坏了。`;
}
