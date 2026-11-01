export class TelegramError extends Error {
  constructor(kind, code = null, retryAfter = 0) {
    super(`Telegram ${kind}${code === null ? '' : ` (${code})`}`);
    this.kind = kind;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export class TelegramClient {
  constructor(token, timeoutMs = 15000, fetchImpl = fetch) {
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }
  async call(method, payload = {}) {
    let response;
    let body;
    try {
      response = await this.fetchImpl(`${process.env.TELEGRAM_API_BASE || 'https://api.telegram.org'}/bot${this.token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error',
      });
      body = await response.json();
    } catch {
      // 不记录原始 fetch 异常，其 URL 可能包含 token。
      throw new TelegramError('transport');
    }
    if (!response.ok || body?.ok !== true) {
      const code = Number.isInteger(body?.error_code) ? body.error_code : response.status;
      const seconds = Number(body?.parameters?.retry_after);
      throw new TelegramError('api', code, Number.isFinite(seconds) && seconds > 0 ? seconds : 0);
    }
    return body.result;
  }
  async assertCanSend(chatId) {
    const me = await this.call('getMe');
    if (!me?.is_bot || !Number.isSafeInteger(me.id)) throw new TelegramError('invalid_response');
    const chat = await this.call('getChat', { chat_id: chatId });
    if (!['group', 'supergroup', 'channel', 'private'].includes(chat?.type) || String(chat.id) !== chatId) throw new TelegramError('wrong_chat');
    // 个人聊天没有成员权限可查；对方未点过“开始”时 getChat 已经失败。
    if (chat.type === 'private') return { botId: me.id, chatId, title: chat.first_name, status: 'private' };
    const member = await this.call('getChatMember', { chat_id: chatId, user_id: me.id });
    if (chat.type === 'channel') {
      if (member?.status !== 'creator' && !(member?.status === 'administrator' && member.can_post_messages === true)) throw new TelegramError('permission_denied');
      return { botId: me.id, chatId, title: chat.title, status: member.status };
    }
    const privileged = ['creator', 'administrator'].includes(member?.status);
    const normal = member?.status === 'member' && chat.permissions?.can_send_messages === true;
    const restricted = member?.status === 'restricted' && member.is_member === true && member.can_send_messages === true;
    if (!privileged && !normal && !restricted) throw new TelegramError('permission_denied');
    return { botId: me.id, chatId, title: chat.title, status: member.status };
  }
  send(chatId, text) {
    return this.call('sendMessage', { chat_id: chatId, text, link_preview_options: { is_disabled: true } });
  }
}

export function failurePolicy(error, sending = false) {
  if (error instanceof TelegramError) {
    if (error.code === 429) return 'retry';
    if (sending && error.code === 408) return 'uncertain';
    if (error.kind === 'api' && error.code >= 400 && error.code < 500) return 'failed';
    if (['permission_denied', 'wrong_chat'].includes(error.kind)) return 'failed';
  }
  // getMe/getChat/getChatMember 可安全重试；发送结果未知时需人工核查。
  return sending ? 'uncertain' : 'retry';
}
