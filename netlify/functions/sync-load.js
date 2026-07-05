// netlify/functions/sync-load.js
// 前端打开页面时 GET 这里，取回：
//   1. 云端完整备份（本地数据丢失时兜底恢复用）
//   2. 离开期间由 scheduled-proactive.js 代发的"待处理消息"（读取后即清空，避免重复合并）

const { connectLambda, getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
    connectLambda(event);
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const deviceId = event.queryStringParameters?.deviceId;
    if (!deviceId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'missing deviceId' }) };
    }

    try {
        const store = getStore('chat-backups');
        const data = await store.get(deviceId, { type: 'json' });
        if (!data) {
            return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) };
        }

        const pendingMessages = data._pendingMessages || [];

        // 取走待处理消息后立刻清空，防止用户下次打开重复收到同一批消息
        if (pendingMessages.length) {
            data._pendingMessages = [];
            await store.setJSON(deviceId, data);
        }

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...data, pendingMessages })
        };
    } catch (e) {
        return { statusCode: 500, body: JSON.stringify({ error: String(e) }) };
    }
};
