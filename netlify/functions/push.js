// netlify/functions/push.js
// 前端 scheduleOfflinePush() 已经在调用 /.netlify/functions/push，
// 但这个文件此前在项目里并不存在，所以请求一直是 404、静默失败——
// 这就是"信箱回复""日记提醒"经常收不到通知的根本原因。
//
// 用法：前端 POST { title, body, delayMinutes, subscriptionId }
// 本函数只负责"登记"一条未来发送的通知，真正的等待和发送交给 OneSignal
// 的 send_after 参数完成（Netlify 函数最多跑几秒到几十秒，没法自己 sleep 几分钟）。

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
                send_after: sendAfter
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
