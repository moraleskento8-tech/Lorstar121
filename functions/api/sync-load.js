// functions/api/sync-load.js
// Cloudflare Pages Function —— 对应原 netlify/functions/sync-load.js
// 前端打开页面时 GET 这里，取回：
//   1. 云端完整备份（本地数据丢失时兜底恢复用）
//   2. 离开期间由 scheduled-proactive 代发的"待处理消息"（读取后即清空，避免重复合并）

export async function onRequest(context) {
    const { request, env } = context;
    if (request.method !== 'GET') {
        return new Response('Method Not Allowed', { status: 405 });
    }

    const url = new URL(request.url);
    const deviceId = url.searchParams.get('deviceId');
    if (!deviceId) {
        return new Response(JSON.stringify({ error: 'missing deviceId' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    try {
        const raw = await env.CHAT_BACKUPS.get(deviceId);
        if (!raw) {
            return new Response(JSON.stringify({}), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const data = JSON.parse(raw);
        const pendingMessages = data._pendingMessages || [];

        // 取走待处理消息后立刻清空，防止用户下次打开重复收到同一批消息
        if (pendingMessages.length) {
            data._pendingMessages = [];
            await env.CHAT_BACKUPS.put(deviceId, JSON.stringify(data));
        }

        return new Response(JSON.stringify({ ...data, pendingMessages }), {
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
