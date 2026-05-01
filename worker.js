/**
 * worker.js — Cloudflare Worker 推送后端
 *
 * 路由：
 *   GET  /ping           健康检查
 *   GET  /vapid-public   返回 VAPID 公钥（供调试）
 *   POST /subscribe      保存浏览器 Push 订阅
 *   POST /push           触发推送（需 Authorization header）
 */

const CORS_HEADERS = {
    'Access-Control-Allow-Origin':  'https://moraleskento8-tech.github.io',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        // OPTIONS 预检
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        function respond(body, status = 200) {
            return new Response(JSON.stringify(body), {
                status,
                headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
            });
        }

        // GET /ping
        if (url.pathname === '/ping') {
            return respond({ ok: true, time: new Date().toISOString() });
        }

        // GET /vapid-public
        if (url.pathname === '/vapid-public' && request.method === 'GET') {
            return respond({ publicKey: env.VAPID_PUBLIC });
        }

        // POST /subscribe — 保存订阅信息
        if (url.pathname === '/subscribe' && request.method === 'POST') {
            try {
                const { subscription, userId } = await request.json();
                if (!subscription?.endpoint) {
                    return respond({ error: 'Missing subscription endpoint' }, 400);
                }
                const key = userId || btoa(subscription.endpoint).slice(0, 40).replace(/[+/=]/g, '');
                await env.PUSH_SUBS.put(key, JSON.stringify(subscription), {
                    expirationTtl: 60 * 60 * 24 * 365, // 1年
                });
                return respond({ ok: true, key });
            } catch (e) {
                return respond({ error: e.message }, 500);
            }
        }

        // POST /push — 触发推送
        if (url.pathname === '/push' && request.method === 'POST') {
            // 验证 secret
            const auth = request.headers.get('Authorization') || '';
            if (auth !== `Bearer ${env.PUSH_SECRET}`) {
                return respond({ error: 'Unauthorized' }, 401);
            }
            try {
                const body = await request.json();
                const { title = '静语·星降', message = '你有新消息', userId } = body;

                let keys;
                if (userId) {
                    keys = [userId];
                } else {
                    const list = await env.PUSH_SUBS.list();
                    keys = list.keys.map(k => k.name);
                }

                if (!keys.length) return respond({ ok: true, sent: 0, msg: 'No subscribers' });

                const results = await Promise.allSettled(
                    keys.map(async key => {
                        const raw = await env.PUSH_SUBS.get(key);
                        if (!raw) return;
                        const sub = JSON.parse(raw);
                        return sendPush(sub, { title, body: message }, env);
                    })
                );

                const sent = results.filter(r => r.status === 'fulfilled' && r.value).length;
                return respond({ ok: true, sent, total: keys.length });
            } catch (e) {
                return respond({ error: e.message }, 500);
            }
        }

        return respond({ error: 'Not Found' }, 404);
    },
};

// ═══════════════════════════════════════════
// Web Push 实现（VAPID + AES-128-GCM 加密）
// 完全使用 Workers 内置 SubtleCrypto，无需 npm 包
// ═══════════════════════════════════════════

async function sendPush(subscription, payload, env) {
    const { endpoint, keys } = subscription;
    const { p256dh, auth } = keys;

    const payloadJson = JSON.stringify({
        title:     payload.title,
        body:      payload.body,
        icon:      '/Lorstar121/icon-192.png',
        tag:       'chat-msg',
        renotify:  true,
    });

    // 加密 payload
    const encrypted = await encryptPayload(payloadJson, p256dh, auth);

    // 构建 VAPID JWT
    const jwt = await buildVapidJwt(endpoint, env);

    const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type':    'application/octet-stream',
            'Content-Encoding':'aes128gcm',
            'Authorization':   `vapid t=${jwt},k=${env.VAPID_PUBLIC}`,
            'TTL':             '86400',
            'Urgency':         'normal',
        },
        body: encrypted,
    });

    if (res.status === 410 || res.status === 404) {
        // 订阅已失效，可在此删除
        throw new Error(`Subscription gone: ${res.status}`);
    }
    if (!res.ok && res.status !== 201) {
        throw new Error(`Push failed: ${res.status}`);
    }
    return true;
}

// ── VAPID JWT ──
async function buildVapidJwt(endpoint, env) {
    const origin  = new URL(endpoint).origin;
    const header  = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const payload = b64url(JSON.stringify({
        aud: origin,
        exp: Math.floor(Date.now() / 1000) + 43200, // 12h
        sub: env.VAPID_SUBJECT || 'mailto:admin@example.com',
    }));

    const sigInput = `${header}.${payload}`;
    const keyBytes = b64decode(env.VAPID_PRIVATE);

    const key = await crypto.subtle.importKey(
        'pkcs8', keyBytes,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false, ['sign']
    );
    const sig = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        new TextEncoder().encode(sigInput)
    );
    return `${sigInput}.${b64urlRaw(new Uint8Array(sig))}`;
}

// ── AES-128-GCM payload 加密（RFC 8291 aes128gcm）──
async function encryptPayload(plaintext, p256dhB64, authB64) {
    const enc       = new TextEncoder();
    const plainBuf  = enc.encode(plaintext);
    const receiverPub  = b64decode(p256dhB64);
    const authSecret   = b64decode(authB64);

    // 生成本地 ECDH 密钥对
    const localKP = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
    );
    const localPubRaw = new Uint8Array(
        await crypto.subtle.exportKey('raw', localKP.publicKey)
    );

    // 导入接收者公钥
    const receiverKey = await crypto.subtle.importKey(
        'raw', receiverPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []
    );

    // ECDH 共享密钥
    const shared = new Uint8Array(
        await crypto.subtle.deriveBits({ name: 'ECDH', public: receiverKey }, localKP.privateKey, 256)
    );

    // 随机 salt
    const salt = crypto.getRandomValues(new Uint8Array(16));

    // HKDF: PRK = HKDF-Extract(auth_secret, ECDH_secret)
    const prk = await hkdfExtract(authSecret, shared);

    // IKM = HKDF-Expand(PRK, "WebPush: info\x00" + recv_pub + sender_pub, 32)
    const info = concat(
        enc.encode('WebPush: info\x00'),
        receiverPub, localPubRaw
    );
    const ikm = await hkdfExpand(prk, info, 32);

    // CEK + nonce
    const prkExpand  = await hkdfExtract(salt, ikm);
    const cekInfo    = enc.encode('Content-Encoding: aes128gcm\x00');
    const nonceInfo  = enc.encode('Content-Encoding: nonce\x00');
    const cek   = await hkdfExpand(prkExpand, cekInfo,   16);
    const nonce = await hkdfExpand(prkExpand, nonceInfo, 12);

    // AES-128-GCM 加密
    const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
    const padded = concat(plainBuf, new Uint8Array([2])); // delimiter
    const cipher = new Uint8Array(
        await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded)
    );

    // 拼装 aes128gcm Content
    const rs   = 4096;
    const out  = new Uint8Array(16 + 4 + 1 + 65 + cipher.byteLength);
    let off = 0;
    out.set(salt, off);              off += 16;
    new DataView(out.buffer).setUint32(off, rs, false); off += 4;
    out[off++] = 65;                 // keyid length = uncompressed P-256 = 65 bytes
    out.set(localPubRaw, off);       off += 65;
    out.set(cipher, off);
    return out;
}

// ── HKDF helpers ──
async function hkdfExtract(salt, ikm) {
    const key = await crypto.subtle.importKey(
        'raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, ikm));
}
async function hkdfExpand(prk, info, len) {
    const key = await crypto.subtle.importKey(
        'raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const t = new Uint8Array(await crypto.subtle.sign('HMAC', key, concat(info, new Uint8Array([1]))));
    return t.slice(0, len);
}

// ── Utility ──
function concat(...arrays) {
    const total = arrays.reduce((n, a) => n + a.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const a of arrays) { out.set(new Uint8Array(a.buffer ?? a), off); off += a.byteLength; }
    return out;
}
function b64url(str)    { return btoa(str).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,''); }
function b64urlRaw(u8)  { return btoa(String.fromCharCode(...u8)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,''); }
function b64decode(s)   {
    const p = '='.repeat((4 - s.length % 4) % 4);
    return Uint8Array.from(atob((s+p).replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
}
