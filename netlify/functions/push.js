// netlify/functions/push.js
const ONESIGNAL_APP_ID = "ad0c2800-5d31-4ef7-9219-23e214add771"; // 与 index.html 里的 appId 保持一致，这个是公开的，没关系

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY;
  if (!REST_API_KEY) {
    console.error("缺少环境变量 ONESIGNAL_REST_API_KEY");
    return { statusCode: 500, body: JSON.stringify({ error: "服务器未配置 REST API Key" }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "请求体不是合法 JSON" }) };
  }

  const { title, body, delayMinutes = 0, subscriptionId } = payload;
  if (!subscriptionId || !body) {
    return { statusCode: 400, body: JSON.stringify({ error: "缺少 subscriptionId 或 body" }) };
  }

  // 核心改动：不在函数里等待，而是算出未来时间交给 OneSignal 自己排队
  const sendAtDate = new Date(Date.now() + Math.max(0, delayMinutes) * 60000);
  const send_after = sendAtDate.toISOString().replace("T", " ").replace(/\.\d+Z$/, " GMT+0000");

  try {
    const resp = await fetch("https://api.onesignal.com/notifications", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Key ${REST_API_KEY}`,
      },
      body: JSON.stringify({
        app_id: ONESIGNAL_APP_ID,
        target_channel: "push",
        include_subscription_ids: [subscriptionId],
        headings: { en: title || "新消息", zh: title || "新消息" },
        contents: { en: body, zh: body },
        send_after, // 关键参数：延迟发送时间，由 OneSignal 服务器负责，不依赖本函数存活
      }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      console.error("OneSignal 拒绝请求：", data);
      return { statusCode: resp.status, body: JSON.stringify(data) };
    }

    console.log(`[push] 已交给 OneSignal 排队，${delayMinutes} 分钟后发送，notification id: ${data.id}`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, id: data.id, send_after }) };
  } catch (e) {
    console.error("调用 OneSignal API 失败：", e);
    return { statusCode: 500, body: JSON.stringify({ error: String(e) }) };
  }
};
