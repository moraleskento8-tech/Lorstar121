// netlify/functions/scheduled-proactive.js
// 这是一个 Netlify Scheduled Function（定时任务，见 netlify.toml 里的 schedule 配置）。
// 它不依赖任何浏览器标签页运行，由 Netlify 平台按 cron 表达式自动触发。
//
// 逻辑：遍历所有已经同步过的设备 -> 如果这台设备开启了"主动消息"(settings.activeMsg)
// 且距离上次推送已经超过设定的间隔 -> 从这台设备的语料库里随机挑一句 ->
//   1) 通过 OneSignal 真正推送系统通知（人离开也能收到）
//   2) 把这句话写进该设备的 _pendingMessages 队列，等用户下次打开 App 时
//      由前端 (index.html 里 onMounted 的云端同步逻辑) 自动补进聊天记录里，
//      这样通知和实际聊天气泡能对上。
//
// ✅ 这次加了 url 字段：点击这条通知时，OneSignal 会打开/聚焦这个地址，
//    带上 ?openChat=1 参数，主程序检测到这个参数就会直接跳转到聊天界面，
//    而不是打开了却停在主页面，还要再手动点一次"聊天"。
//
// 注意：为了避免过于频繁地打扰用户 / 浪费 OneSignal 免费额度，
// 这里设置了一个"最短推送间隔"下限（见 MIN_GAP_MS），
// 不会完全照搬用户在前端设置的"几十秒一次"。

const { connectLambda, getStore } = require('@netlify/blobs');

const MIN_GAP_MS = 5 * 60 * 1000; // 离线主动消息最短间隔：5分钟，可自行调整

const pickRandomLine = (data) => {
    const pool = [
        ...(data.ungroupedReplies || []),
        ...((data.replyGroups || []).flatMap(g => g.replies || []))
    ];
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)].text;
};

const sendPush = async (subscriptionId, title, content, siteUrl) => {
    return fetch('https://onesignal.com/api/v1/notifications', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Key ${process.env.ONESIGNAL_REST_API_KEY}`
        },
        body: JSON.stringify({
            app_id: process.env.ONESIGNAL_APP_ID,
            include_subscription_ids: [subscriptionId],
            headings: { en: title || '新消息' },
            contents: { en: content },
            ...(siteUrl ? { url: `${siteUrl}/?openChat=1` } : {})
        })
    });
};

exports.handler = async (event) => {
    connectLambda(event);

    if (!process.env.ONESIGNAL_APP_ID || !process.env.ONESIGNAL_REST_API_KEY) {
        console.warn('[scheduled-proactive] 缺少 ONESIGNAL_APP_ID / ONESIGNAL_REST_API_KEY 环境变量，跳过本次');
        return { statusCode: 200 };
    }

    const siteUrl = process.env.URL || process.env.DEPLOY_URL || '';
    const store = getStore('chat-backups');
    const { blobs } = await store.list();
    const now = Date.now();

    for (const b of blobs) {
        let data;
        try {
            data = await store.get(b.key, { type: 'json' });
        } catch (e) { continue; }
        if (!data || !data.settings || !data.settings.activeMsg || !data.subscriptionId) continue;

        const intervalMs = Math.max(10, data.settings.activeInterval || 30) * 1000;
        const gapMs = Math.max(intervalMs, MIN_GAP_MS);
        const last = data._lastPushAt || 0;
        if (now - last < gapMs) continue;

        const line = pickRandomLine(data);
        if (!line) continue;

        const title = (data.profiles && data.profiles.them && data.profiles.them.name) || '新消息';
        try {
            await sendPush(data.subscriptionId, title, line, siteUrl);
        } catch (e) {
            console.warn('[scheduled-proactive] 推送失败', b.key, e);
            continue;
        }

        data._lastPushAt = now;
        data._pendingMessages = data._pendingMessages || [];
        data._pendingMessages.push({
            id: 'srv_' + now + '_' + Math.random().toString(36).slice(2, 6),
            type: 'text',
            content: line,
            timestamp: now
        });
        await store.setJSON(b.key, data);
    }

    return { statusCode: 200 };
};
