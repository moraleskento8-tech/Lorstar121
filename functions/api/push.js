// functions/api/push.js
// Cloudflare Pages Function —— 对应原 netlify/functions/push.js
// 前端 scheduleOfflinePush() 调用这里，登记一条未来发送的通知，
// 真正的等待和发送交给 OneSignal 的 send_after 参数完成。
//
// 需要在 Cloudflare Pages 项目的 Settings → Environment variables 里配置：
//   ONESIGNAL_APP_ID         （明文即可）
//   ONESIGNAL_REST_API_KEY   （务必加密/Secret 方式保存，不要明文）

export async function onRequest(context) {
    const { request, env } = context;
    if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
    }

    let body;
    try {
        body = await request.json();
    } catch (e) {
        return new Response('Invalid JSON', { status: 400 });
    }

    const { title, body: content, delayMinutes, subscriptionId } = body;
    if (!subscriptionId) {
        return new Response(JSON.stringify({ error: 'missing subscriptionId' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }
    if (!env.ONESIGNAL_APP_ID || !env.ONESIGNAL_REST_API_KEY) {
        return new Response(JSON.stringify({ error: 'server missing ONESIGNAL_APP_ID / ONESIGNAL_REST_API_KEY env vars' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    const sendAfter = new Date(Date.now() + Math.max(1, delayMinutes || 1) * 60000).toISOString();
    // Cloudflare Pages 会自动注入 CF_PAGES_URL（本次部署的访问地址）；
    // 也可以直接用请求本身的 origin 作兜底，效果一样，不需要手动写死域名。
    const siteUrl = env.CF_PAGES_URL || new URL(request.url).origin;

    try {
        const r = await fetch('https://onesignal.com/api/v1/notifications', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Key ${env.ONESIGNAL_REST_API_KEY}`
            },
            body: JSON.stringify({
                app_id: env.ONESIGNAL_APP_ID,
                include_subscription_ids: [subscriptionId],
                headings: { en: title || '新消息' },
                contents: { en: content || '你有一条新消息' },
                send_after: sendAfter,
                ...(siteUrl ? { url: `${siteUrl}/?openChat=1` } : {})
            })
        });
        const data = await r.json();
        return new Response(JSON.stringify(data), {
            status: r.ok ? 200 : 500,
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
