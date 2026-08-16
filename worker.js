// worker.js —— 纯后台版：只负责 存/取聊天云备份 + 定时主动推送。
// 网站本身还是 Netlify 那个不动，这个 Worker 只是网站背后悄悄调用的一个"小助手"。
//
// 需要在 Cloudflare 这个 Worker 项目的 设置 → 变量和机密 里配置：
//   RELAY_SECRET             一串你自己定的密码（选"密钥/Secret"类型）
//                             要跟 index.html 里 CLOUD_RELAY_SECRET 填的完全一样
//   ONESIGNAL_APP_ID         你的 OneSignal App ID（普通文本即可）
//   ONESIGNAL_REST_API_KEY   你的 OneSignal REST API Key（一定选"密钥/Secret"类型）
//   SITE_URL                可选，填 https://lorstar0121.netlify.app
// 并且要绑定一个 KV 命名空间，变量名叫 CHAT_BACKUPS（见同目录 wrangler.toml 里的说明）。

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Relay-Secret'
};
// 用 '*' 是因为所有请求都要先过密码校验，谁都调不通除非知道密码，
// 所以放开跨域来源本身不会降低安全性，反而省掉自己维护"允许哪些域名"的麻烦。

const json = (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });

// ── 密码校验：所有 /api/ 请求都要带对 X-Relay-Secret 请求头 ──
const checkSecret = (request, env) => {
    if (!env.RELAY_SECRET) return true; // 没设置密码就先放行（不建议，但方便你第一次联调）
    return request.headers.get('X-Relay-Secret') === env.RELAY_SECRET;
};

// ── 调用 OneSignal 发送/预约通知 ──
const sendOneSignalPush = async (env, { subscriptionId, title, content, sendAfter, siteUrl }) => {
    const payload = {
        app_id: env.ONESIGNAL_APP_ID,
        include_subscription_ids: [subscriptionId],
        headings: { en: title || '新消息' },
        contents: { en: content || '你有一条新消息' },
        ...(sendAfter ? { send_after: sendAfter } : {}),
        ...(siteUrl ? { url: `${siteUrl}/?openChat=1` } : {})
    };
    return fetch('https://onesignal.com/api/v1/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Key ${env.ONESIGNAL_REST_API_KEY}` },
        body: JSON.stringify(payload)
    });
};

// ── /api/sync-save ──
const handleSyncSave = async (request, env) => {
    let payload;
    try { payload = await request.json(); } catch (e) { return json({ error: 'invalid json' }, 400); }
    const deviceId = payload.deviceId;
    if (!deviceId) return json({ error: 'missing deviceId' }, 400);

    try {
        const existingRaw = await env.CHAT_BACKUPS.get(deviceId);
        const existing = existingRaw ? JSON.parse(existingRaw) : null;
        const merged = {
            ...payload,
            _pendingMessages: existing?._pendingMessages || [],
            _lastPushAt: existing?._lastPushAt || 0,
            _lastSeenAt: Date.now(),
            _updatedAt: Date.now()
        };
        await env.CHAT_BACKUPS.put(deviceId, JSON.stringify(merged));
        return json({ ok: true });
    } catch (e) {
        return json({ error: String(e) }, 500);
    }
};

// ── /api/sync-load ──
const handleSyncLoad = async (url, env) => {
    const deviceId = url.searchParams.get('deviceId');
    if (!deviceId) return json({ error: 'missing deviceId' }, 400);
    try {
        const raw = await env.CHAT_BACKUPS.get(deviceId);
        if (!raw) return json({});
        const data = JSON.parse(raw);
        const pendingMessages = data._pendingMessages || [];
        if (pendingMessages.length) {
            data._pendingMessages = [];
            await env.CHAT_BACKUPS.put(deviceId, JSON.stringify(data));
        }
        return json({ ...data, pendingMessages });
    } catch (e) {
        return json({ error: String(e) }, 500);
    }
};

// ── /api/push ──
const handlePush = async (request, env) => {
    let body;
    try { body = await request.json(); } catch (e) { return json({ error: 'invalid json' }, 400); }
    const { title, body: content, delayMinutes, subscriptionId } = body;
    if (!subscriptionId) return json({ error: 'missing subscriptionId' }, 400);
    if (!env.ONESIGNAL_APP_ID || !env.ONESIGNAL_REST_API_KEY) {
        return json({ error: 'server missing ONESIGNAL_APP_ID / ONESIGNAL_REST_API_KEY' }, 500);
    }
    const sendAfter = new Date(Date.now() + Math.max(1, delayMinutes || 1) * 60000).toISOString();
    const siteUrl = env.SITE_URL || '';
    try {
        const r = await sendOneSignalPush(env, { subscriptionId, title, content, sendAfter, siteUrl });
        const data = await r.json();
        return json(data, r.ok ? 200 : 500);
    } catch (e) {
        return json({ error: String(e) }, 500);
    }
};

// ── 定时任务：每 5 分钟检查一次，给太久没打开的设备主动补一条消息 ──
const MIN_GAP_MS = 5 * 60 * 1000;
const ACTIVE_SKIP_MS = 3 * 60 * 1000;

const pickRandomLine = (data) => {
    const pool = [
        ...(data.ungroupedReplies || []),
        ...((data.replyGroups || []).flatMap(g => g.replies || []))
    ];
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)].text;
};

const runProactiveCheck = async (env) => {
    if (!env.ONESIGNAL_APP_ID || !env.ONESIGNAL_REST_API_KEY) {
        console.warn('[scheduled] 缺少 ONESIGNAL_APP_ID / ONESIGNAL_REST_API_KEY，跳过本次');
        return;
    }
    const siteUrl = env.SITE_URL || '';
    const now = Date.now();
    let cursor;
    do {
        const page = await env.CHAT_BACKUPS.list({ cursor });
        cursor = page.list_complete ? undefined : page.cursor;
        for (const k of page.keys) {
            let data;
            try {
                const raw = await env.CHAT_BACKUPS.get(k.name);
                data = raw ? JSON.parse(raw) : null;
            } catch (e) { continue; }
            if (!data || !data.settings || !data.settings.activeMsg || !data.subscriptionId) continue;

            const lastSeen = data._lastSeenAt || 0;
            if (now - lastSeen < ACTIVE_SKIP_MS) continue;

            const intervalMs = Math.max(10, data.settings.activeInterval || 30) * 1000;
            const gapMs = Math.max(intervalMs, MIN_GAP_MS);
            const last = data._lastPushAt || 0;
            if (now - last < gapMs) continue;

            const line = pickRandomLine(data);
            if (!line) continue;

            const title = (data.profiles && data.profiles.them && data.profiles.them.name) || '新消息';
            try {
                await sendOneSignalPush(env, { subscriptionId: data.subscriptionId, title, content: line, siteUrl });
            } catch (e) {
                console.warn('[scheduled] 推送失败', k.name, e);
                continue;
            }

            data._lastPushAt = now;
            data._pendingMessages = data._pendingMessages || [];
            data._pendingMessages.push({
                id: 'srv_' + now + '_' + Math.random().toString(36).slice(2, 6),
                type: 'text', content: line, timestamp: now
            });
            await env.CHAT_BACKUPS.put(k.name, JSON.stringify(data));
        }
    } while (cursor);
};

// ── 入口 ──
export default {
    async scheduled(event, env, ctx) {
        ctx.waitUntil(runProactiveCheck(env));
    },

    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // 浏览器发自定义请求头之前会先发一个 OPTIONS 探路请求，直接放行
        if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

        // 一个不需要密码的健康检查，方便你在浏览器直接打开测试有没有部署成功
        if (url.pathname === '/' || url.pathname === '/ping') {
            return json({ ok: true, message: 'lorstar0121 relay worker is running' });
        }

        if (!checkSecret(request, env)) return json({ error: 'wrong or missing X-Relay-Secret' }, 401);

        if (url.pathname === '/api/sync-save' && request.method === 'POST') return handleSyncSave(request, env);
        if (url.pathname === '/api/sync-load' && request.method === 'GET') return handleSyncLoad(url, env);
        if (url.pathname === '/api/push' && request.method === 'POST') return handlePush(request, env);
        if (url.pathname === '/run-now') { await runProactiveCheck(env); return json({ ok: true }); }

        return json({ error: 'not found' }, 404);
    }
};
