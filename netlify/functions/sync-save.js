// netlify/functions/sync-save.js
// 前端每次保存本地数据时（防抖4秒），也会把同一份数据 POST 到这里，
// 写入 Netlify Blobs，作为"云端聊天记录备份"，同时把 subscriptionId
// 和 settings 存起来，供 scheduled-proactive.js 定时任务读取使用。

const { connectLambda, getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
    connectLambda(event);
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    let payload;
    try {
        payload = JSON.parse(event.body || '{}');
    } catch (e) {
        return { statusCode: 400, body: 'Invalid JSON' };
    }

    const deviceId = payload.deviceId;
    if (!deviceId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'missing deviceId' }) };
    }

    try {
        const store = getStore('chat-backups');
        // 保留服务器这边已经存在、但客户端不知道的字段（比如待推送队列、上次推送时间）
        const existing = await store.get(deviceId, { type: 'json' }).catch(() => null);

        const merged = {
            ...payload,
            _pendingMessages: existing?._pendingMessages || [],
            _lastPushAt: existing?._lastPushAt || 0,
            _updatedAt: Date.now()
        };

        await store.setJSON(deviceId, merged);
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    } catch (e) {
        return { statusCode: 500, body: JSON.stringify({ error: String(e) }) };
    }
};
