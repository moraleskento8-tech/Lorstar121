// functions/api/sync-save.js
// Cloudflare Pages Function —— 对应原 netlify/functions/sync-save.js
// 前端每次保存本地数据时（防抖4秒），也会把同一份数据 POST 到这里，
// 写入 Cloudflare KV，作为"云端聊天记录备份"，同时把 subscriptionId
// 和 settings 存起来，供 scheduled-proactive worker 定时任务读取使用。
//
// 需要在 Cloudflare Pages 项目的 Settings → Functions → KV namespace bindings
// 里绑定一个叫 CHAT_BACKUPS 的 KV 命名空间（变量名必须叫 CHAT_BACKUPS，
// 和下面 env.CHAT_BACKUPS 对应）。

export async function onRequest(context) {
    const { request, env } = context;
    if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
    }

    let payload;
    try {
        payload = await request.json();
    } catch (e) {
        return new Response('Invalid JSON', { status: 400 });
    }

    const deviceId = payload.deviceId;
    if (!deviceId) {
        return new Response(JSON.stringify({ error: 'missing deviceId' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    try {
        const existingRaw = await env.CHAT_BACKUPS.get(deviceId);
        const existing = existingRaw ? JSON.parse(existingRaw) : null;

        const merged = {
            ...payload,
            // 保留服务器这边已经存在、但客户端不知道的字段（比如待推送队列、上次推送时间）
            _pendingMessages: existing?._pendingMessages || [],
            _lastPushAt: existing?._lastPushAt || 0,
            // 只要客户端还在正常保存数据，就说明 App 大概率是开着的（前台的"主动消息"定时器
            // 已经在负责这件事了）。记下这个时间，供 scheduled-proactive 判断要不要跳过本轮
            // 服务端推送，避免前台/后台两条通道同时触发、造成重复消息。
            _lastSeenAt: Date.now(),
            _updatedAt: Date.now()
        };

        await env.CHAT_BACKUPS.put(deviceId, JSON.stringify(merged));
        return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
