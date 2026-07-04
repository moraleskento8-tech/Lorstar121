// netlify/functions/push.js
exports.handler = async (event) => {
    const { title, body, delayMinutes, subscriptionId, type } = JSON.parse(event.body);
    
    // 计算发送时间
    const sendAfter = new Date(Date.now() + delayMinutes * 60000).toISOString();
    
    const response = await fetch("https://onesignal.com/api/v1/notifications", {
        method: "POST",
        headers: { 
            "Authorization": `Basic ${process.env.ONESIGNAL_REST_KEY}`,
            "Content-Type": "application/json" 
        },
        body: JSON.stringify({
            app_id: process.env.ONESIGNAL_APP_ID,
            include_subscription_ids: [subscriptionId],
            headings: { "en": title },
            contents: { "en": body },
            send_after: sendAfter, // 核心：OneSignal 服务器会自动排队发送
            data: { type: type }   // 用于前端判断是日记还是信箱
        })
    });
    return { statusCode: 200, body: JSON.stringify({ success: true }) };
};
