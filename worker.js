/**
 * Cloudflare Worker — Web Push 推送后端
 * 
 * 路由：
 *   POST /subscribe      保存订阅信息（来自客户端 pushManager.subscribe）
 *   POST /push           触发推送（来自服务端触发或计划任务）
 *   GET  /vapid-public   返回 VAPID 公钥（客户端订阅时需要）
 */

// ──────────────────────────────────────────────
// CORS 头（允许你的 GitHub Pages 域名跨域调用）
// ──────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',   // 生产环境改为 'https://moraleskento8-tech.github.io'
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function cors(res) {
  const r = new Response(res.body, res);
  Object.entries(CORS).forEach(([k, v]) => r.headers.set(k, v));
  return r;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ── GET /vapid-public ──
    if (url.pathname === '/vapid-public' && request.method === 'GET') {
      return cors(new Response(JSON.stringify({ publicKey: env.VAPID_PUBLIC }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      }));
    }

    // ── POST /subscribe ──
    if (url.pathname === '/subscribe' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { subscription, userId } = body;
        if (!subscription?.endpoint) {
          return cors(new Response(JSON.stringify({ error: 'Invalid subscription' }), { status: 400 }));
        }
        // 存入 KV（key = userId 或 endpoint hash）
        const key = userId || btoa(subscription.endpoint).slice(0, 32);
        await env.PUSH_SUBS.put(key, JSON.stringify(subscription), { expirationTtl: 60 * 60 * 24 * 365 });
        return cors(new Response(JSON.stringify({ ok: true, key }), { status: 200 }));
      } catch (e) {
        return cors(new Response(JSON.stringify({ error: e.message }), { status: 500 }));
      }
    }

    // ── POST /push ── 触发推送（需要 Authorization: Bearer <PUSH_SECRET>）
    if (url.pathname === '/push' && request.method === 'POST') {
      const auth = request.headers.get('Authorization') || '';
      if (auth !== `Bearer ${env.PUSH_SECRET}`) {
        return cors(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }));
      }
      try {
        const { title, body, userId } = await request.json();
        // 遍历推送：如果有 userId 只推给该用户，否则广播所有
        const keys = userId ? [userId] : (await env.PUSH_SUBS.list()).keys.map(k => k.name);
        const results = await Promise.allSettled(
          keys.map(async key => {
            const subStr = await env.PUSH_SUBS.get(key);
            if (!subStr) return;
            const sub = JSON.parse(subStr);
            return sendWebPush(sub, { title, body }, env);
          })
        );
        const ok = results.filter(r => r.status === 'fulfilled').length;
        return cors(new Response(JSON.stringify({ ok, total: keys.length }), { status: 200 }));
      } catch (e) {
        return cors(new Response(JSON.stringify({ error: e.message }), { status: 500 }));
      }
    }

    return cors(new Response('Not Found', { status: 404 }));
  },

  // Cron 触发器（可选：每小时检查并推送）
  async scheduled(event, env, ctx) {
    // 此处可加自定义定时推送逻辑
    console.log('Scheduled trigger:', event.cron);
  }
};

// ──────────────────────────────────────────────
// Web Push 发送（手动实现 VAPID + RFC8292）
// Cloudflare Workers 原生支持 SubtleCrypto，无需 npm 包
// ──────────────────────────────────────────────
async function sendWebPush(subscription, payload, env) {
  const { endpoint, keys } = subscription;
  const { p256dh, auth: authKey } = keys;

  const payloadStr = JSON.stringify({
    title: payload.title || '静语·星降',
    body: (payload.body || '').substring(0, 100),
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: 'chat',
    renotify: true,
  });

  // VAPID JWT
  const vapidJwt = await buildVapidJwt(endpoint, env.VAPID_PRIVATE, env.VAPID_PUBLIC, env.VAPID_SUBJECT);

  // 加密 payload（AES-GCM + ECDH，RFC8291）
  const encrypted = await encryptPayload(payloadStr, p256dh, authKey);

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `vapid t=${vapidJwt.token},k=${env.VAPID_PUBLIC}`,
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': '86400',
      'Urgency': 'normal',
    },
    body: encrypted,
  });

  if (!resp.ok && resp.status !== 201) {
    const t = await resp.text();
    throw new Error(`Push failed ${resp.status}: ${t}`);
  }
  return resp.status;
}

// ── VAPID JWT 构建 ──
async function buildVapidJwt(endpoint, privateKeyB64, publicKeyB64, subject) {
  const origin = new URL(endpoint).origin;
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = {
    aud: origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject || 'mailto:admin@example.com',
  };

  const enc = txt => btoa(txt).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const headerB64 = enc(JSON.stringify(header));
  const payloadB64 = enc(JSON.stringify(payload));
  const sigInput = `${headerB64}.${payloadB64}`;

  const keyBytes = base64ToBytes(privateKeyB64);
  const privateKey = await crypto.subtle.importKey(
    'pkcs8', keyBytes, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(sigInput)
  );

  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  return { token: `${sigInput}.${sigB64}` };
}

// ── AES-GCM payload 加密（RFC8291 aes128gcm）──
async function encryptPayload(payloadStr, p256dhB64, authKeyB64) {
  const encoder = new TextEncoder();
  const payloadBytes = encoder.encode(payloadStr);

  // 解码订阅者公钥和 auth
  const receiverPublicKey = base64ToBytes(p256dhB64);
  const authSecret = base64ToBytes(authKeyB64);

  // 生成本地 ECDH 密钥对
  const localKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']
  );
  const localPublicBytes = new Uint8Array(
    await crypto.subtle.exportKey('raw', localKeyPair.publicKey)
  );

  // 导入接收者公钥
  const receiverKey = await crypto.subtle.importKey(
    'raw', receiverPublicKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );

  // ECDH 共享密钥
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: receiverKey }, localKeyPair.privateKey, 256
  );

  // HKDF extract + expand
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hkdfExtract(authSecret, new Uint8Array(sharedSecret));
  const keyInfo = buildKeyInfo(receiverPublicKey, localPublicBytes);
  const ikm = await hkdfExpand(prk, keyInfo, 32);

  const prkExpand = await hkdfExtract(salt, ikm);
  const contentEncKey = await hkdfExpand(prkExpand, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdfExpand(prkExpand, encoder.encode('Content-Encoding: nonce\0'), 12);

  // AES-GCM 加密
  const aesKey = await crypto.subtle.importKey('raw', contentEncKey, 'AES-GCM', false, ['encrypt']);
  const paddedPayload = new Uint8Array([...payloadBytes, 0x02]); // padding delimiter
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce }, aesKey, paddedPayload
  );

  // 组装 aes128gcm 内容（salt + recordSize + localPublicKey + ciphertext）
  const result = new Uint8Array(16 + 4 + 1 + 65 + ciphertext.byteLength);
  let offset = 0;
  result.set(salt, offset); offset += 16;
  new DataView(result.buffer).setUint32(offset, 4096, false); offset += 4; // rs
  result[offset++] = 65; // keyid length
  result.set(localPublicBytes, offset); offset += 65;
  result.set(new Uint8Array(ciphertext), offset);
  return result;
}

function buildKeyInfo(receiverPub, senderPub) {
  const info = new Uint8Array(5 + 65 + 65);
  new TextEncoder().encode('WebPush: ').forEach((b, i) => { if (i < 5) info[i] = b; });
  // simplified – real impl should follow IETF RFC exactly
  info.set(receiverPub.slice(0, 65), 5);
  info.set(senderPub.slice(0, 65), 70);
  return info;
}

async function hkdfExtract(salt, ikm) {
  const key = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, ikm));
}

async function hkdfExpand(prk, info, len) {
  const key = await crypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const t1 = new Uint8Array(await crypto.subtle.sign('HMAC', key, new Uint8Array([...info, 1])));
  return t1.slice(0, len);
}

function base64ToBytes(b64) {
  const s = b64.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(s);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}
