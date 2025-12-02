const WEBHOOK = '/endpoint'

const NOTIFY_INTERVAL = 3600 * 1000
const fraudDb = 'https://raw.githubusercontent.com/LloydAsp/nfd/main/data/fraud.db'
const notificationUrl = 'https://raw.githubusercontent.com/LloydAsp/nfd/main/data/notification.txt'
const startMsgUrl = 'https://raw.githubusercontent.com/a153315062/nfd/refs/heads/main/data/startMessage.md'
const enable_notification = true

// ================= Telegram 工具函数 =================

function apiUrl (config, methodName, params = null) {
  let query = ''
  if (params) {
    query = '?' + new URLSearchParams(params).toString()
  }
  return `https://api.telegram.org/bot${config.TOKEN}/${methodName}${query}`
}

function requestTelegram (config, methodName, body, params = null) {
  return fetch(apiUrl(config, methodName, params), body).then(r => r.json())
}

function makeReqBody (body) {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  }
}

function sendMessage (config, msg = {}) {
  return requestTelegram(config, 'sendMessage', makeReqBody(msg))
}

function copyMessage (config, msg = {}) {
  return requestTelegram(config, 'copyMessage', makeReqBody(msg))
}

function forwardMessage (config, msg) {
  return requestTelegram(config, 'forwardMessage', makeReqBody(msg))
}

// ================= Worker 入口 =================

export default {
  async fetch (request, env, ctx) {
    const url = new URL(request.url)

    const config = {
      TOKEN: env.ENV_BOT_TOKEN,
      SECRET: env.ENV_BOT_SECRET,
      ADMIN_UID: env.ENV_ADMIN_UID
    }

    if (!config.TOKEN || !config.SECRET || !config.ADMIN_UID) {
      return new Response(
        'ENV_BOT_TOKEN / ENV_BOT_SECRET / ENV_ADMIN_UID 未配置',
        { status: 500 }
      )
    }

    if (url.pathname === WEBHOOK) {
      return handleWebhook(request, env, ctx, config)
    } else if (url.pathname === '/registerWebhook') {
      return registerWebhook(request, config)
    } else if (url.pathname === '/unRegisterWebhook') {
      return unRegisterWebhook(config)
    } else {
      return new Response('No handler for this request')
    }
  }
}

// ================= Webhook 处理 =================

async function handleWebhook (request, env, ctx, config) {
  if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== config.SECRET) {
    return new Response('Unauthorized', { status: 403 })
  }

  const update = await request.json()
  ctx.waitUntil(onUpdate(update, env, config))

  return new Response('Ok')
}

async function onUpdate (update, env, config) {
  if ('message' in update) {
    await onMessage(update.message, env, config)
  }
}

async function onMessage (message, env, config) {
  if (message.text === '/start') {
    const startMsg = await fetch(startMsgUrl).then(r => r.text())
    return sendMessage(config, {
      chat_id: message.chat.id,
      text: startMsg
    })
  }

  if (message.chat.id.toString() === config.ADMIN_UID) {
    if (!message?.reply_to_message?.chat) {
      return sendMessage(config, {
        chat_id: config.ADMIN_UID,
        text: '使用方法：回复转发的消息，并发送回复消息，或使用 /block /unblock /checkblock'
      })
    }

    if (/^\/block$/.exec(message.text)) {
      return handleBlock(message, env, config)
    }
    if (/^\/unblock$/.exec(message.text)) {
      return handleUnBlock(message, env, config)
    }
    if (/^\/checkblock$/.exec(message.text)) {
      return checkBlock(message, env, config)
    }

    const guestChantId = await env["1nfd"].get(
      'msg-map-' + message?.reply_to_message.message_id,
      { type: 'json' }
    )

    return copyMessage(config, {
      chat_id: guestChantId,
      from_chat_id: message.chat.id,
      message_id: message.message_id
    })
  }

  return handleGuestMessage(message, env, config)
}

async function handleGuestMessage (message, env, config) {
  const chatId = message.chat.id

  const isblocked = await env["1nfd"].get('isblocked-' + chatId, { type: 'json' })
  if (isblocked) {
    return sendMessage(config, {
      chat_id: chatId,
      text: 'You are blocked'
    })
  }

  const forwardReq = await forwardMessage(config, {
    chat_id: config.ADMIN_UID,
    from_chat_id: message.chat.id,
    message_id: message.message_id
  })

  if (forwardReq.ok) {
    await env["1nfd"].put('msg-map-' + forwardReq.result.message_id, chatId)
  }

  return handleNotify(message, env, config)
}

async function handleNotify (message, env, config) {
  const chatId = message.chat.id

  if (await isFraud(chatId)) {
    return sendMessage(config, {
      chat_id: config.ADMIN_UID,
      text: `检测到骗子：UID ${chatId}`
    })
  }

  if (enable_notification) {
    const lastMsgTime = await env["1nfd"].get('lastmsg-' + chatId, { type: 'json' })
    if (!lastMsgTime || Date.now() - lastMsgTime > NOTIFY_INTERVAL) {
      await env["1nfd"].put('lastmsg-' + chatId, Date.now())
      return sendMessage(config, {
        chat_id: config.ADMIN_UID,
        text: await fetch(notificationUrl).then(r => r.text())
      })
    }
  }
}

async function handleBlock (message, env, config) {
  const guestChantId = await env["1nfd"].get(
    'msg-map-' + message.reply_to_message.message_id,
    { type: 'json' }
  )

  if (guestChantId === config.ADMIN_UID) {
    return sendMessage(config, {
      chat_id: config.ADMIN_UID,
      text: '不能屏蔽自己'
    })
  }

  await env["1nfd"].put('isblocked-' + guestChantId, true)

  return sendMessage(config, {
    chat_id: config.ADMIN_UID,
    text: `UID:${guestChantId} 屏蔽成功`
  })
}

async function handleUnBlock (message, env, config) {
  const guestChantId = await env["1nfd"].get(
    'msg-map-' + message.reply_to_message.message_id,
    { type: 'json' }
  )

  await env["1nfd"].put('isblocked-' + guestChantId, false)

  return sendMessage(config, {
    chat_id: config.ADMIN_UID,
    text: `UID:${guestChantId} 解除了屏蔽`
  })
}

async function checkBlock (message, env, config) {
  const guestChantId = await env["1nfd"].get(
    'msg-map-' + message.reply_to_message.message_id,
    { type: 'json' }
  )
  const blocked = await env["1nfd"].get('isblocked-' + guestChantId, { type: 'json' })

  return sendMessage(config, {
    chat_id: config.ADMIN_UID,
    text: `UID:${guestChantId} ` + (blocked ? '已被屏蔽' : '未屏蔽')
  })
}

async function registerWebhook (request, config) {
  const requestUrl = new URL(request.url)
  const webhookUrl = `${requestUrl.protocol}//${requestUrl.hostname}${WEBHOOK}`

  const r = await (
    await fetch(apiUrl(config, 'setWebhook', {
      url: webhookUrl,
      secret_token: config.SECRET
    }))
  ).json()

  return new Response('ok' in r && r.ok ? 'Ok' : JSON.stringify(r, null, 2))
}

async function unRegisterWebhook (config) {
  const r = await (
    await fetch(apiUrl(config, 'setWebhook', { url: '' }))
  ).json()

  return new Response('ok' in r && r.ok ? 'Ok' : JSON.stringify(r, null, 2))
}

async function isFraud (id) {
  id = id.toString()
  const db = await fetch(fraudDb).then(r => r.text())
  const arr = db.split('\n').filter(v => v)
  const flag = arr.includes(id)
  return flag
}
