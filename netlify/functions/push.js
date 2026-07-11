// netlify/functions/push.js
// 前端 scheduleOfflinePush() 调用 /.netlify/functions/push，
// 登记一条未来发送的通知，真正的等待和发送交给 OneSignal 的 send_after 参数完成
// （Netlify 函数最多跑几秒到几十秒，没法自己 sleep 几分钟）。
//
// ✅ 这次加了 url 字段：点击这条通知时，OneSignal 会打开/聚焦这个地址，
//    带上 ?openChat=1 参数，主程序启动/恢复时检测到这个参数就会直接跳转到聊天界面。
//    process.env.URL 是 Netlify 自动注入的"这个站点自己的部署地址"，不用手动写死域名。

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    let body;
    try {
        body = JSON.parse(event.body || '{}');
    } catch (e) {
        return { statusCode: 400, body: 'Invalid JSON' };
    }

    const { title, body: content, delayMinutes, subscriptionId } = body;
    if (!subscriptionId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'missing subscriptionId' }) };
    }
    if (!process.env.ONESIGNAL_APP_ID || !process.env.ONESIGNAL_REST_API_KEY) {
        return { statusCode: 500, body: JSON.stringify({ error: 'server missing ONESIGNAL_APP_ID / ONESIGNAL_REST_API_KEY env vars' }) };
    }

    const sendAfter = new Date(Date.now() + Math.max(1, delayMinutes || 1) * 60000).toISOString();
    const siteUrl = process.env.URL || process.env.DEPLOY_URL || '';

    try {
        const r = await fetch('https://onesignal.com/api/v1/notifications', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Key ${process.env.ONESIGNAL_REST_API_KEY}`
            },
            body: JSON.stringify({
                app_id: process.env.ONESIGNAL_APP_ID,
                include_subscription_ids: [subscriptionId],
                headings: { en: title || '新消息' },
                contents: { en: content || '你有一条新消息' },
                send_after: sendAfter,
                ...(siteUrl ? { url: `${siteUrl}/?openChat=1` } : {})
            })
        });
        const data = await r.json();
        return {
            statusCode: r.ok ? 200 : 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        };
    } catch (e) {
        return { statusCode: 500, body: JSON.stringify({ error: String(e) }) };
    }
};
