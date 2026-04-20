// ===================================================
// cloudflare-worker.js — 静语·星降 推送后端
// 在 Cloudflare Workers 控制台粘贴此代码
// ===================================================

// ⚠️ 必须替换：你的 OneSignal REST API Key
// 获取方法：OneSignal 后台 → Settings → Keys & IDs → REST API Key
const ONESIGNAL_REST_API_KEY = 'YOUR_ONESIGNAL_REST_API_KEY_HERE';

// 不需要改，这是你的 App ID
const ONESIGNAL_APP_ID = 'ad0c2800-5d31-4ef7-9219-23e214add771';

// ===== CORS 响应头（允许你的 GitHub Pages 调用）=====
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': 'https://moraleskento8-tech.github.io',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

export default {
  async fetch(request) {
    // 处理预检请求（CORS）
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // 只允许 POST
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405, headers: CORS_HEADERS
      });
    }

    let title, body;
    try {
      const data = await request.json();
      title = data.title || '静语·星降';
      body  = data.body  || '你收到了一条新消息 ✨';
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
        status: 400, headers: CORS_HEADERS
      });
    }

    // 调用 OneSignal REST API 发推送
    const osResponse = await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${ONESIGNAL_REST_API_KEY}`,
      },
      body: JSON.stringify({
        app_id: ONESIGNAL_APP_ID,
        included_segments: ['All'],   // 推送给所有订阅者
        headings: { en: title, zh_CN: title },
        contents: { en: body,  zh_CN: body  },
        web_push_topic: 'chat-msg',
        priority: 10,
        ttl: 60,  // 60秒内没收到就丢弃
      }),
    });

    const result = await osResponse.json();
    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200, headers: CORS_HEADERS
    });
  }
};
