import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramClient, TelegramError, failurePolicy } from '../src/telegram.js';
import { createLogger } from '../src/logger.js';

function clientFor(chat, member) {
  return new TelegramClient('test', 1000, async url => {
    const method = url.split('/').at(-1);
    const result = method === 'getMe' ? { is_bot: true, id: 123 } : method === 'getChat' ? chat : member;
    return { ok: true, json: async () => ({ ok: true, result }) };
  });
}
test('允许可发言成员、管理员和可发言的受限成员', async () => {
  const chat = { id: -100, type: 'supergroup', permissions: { can_send_messages: true } };
  for (const member of [{ status: 'member' }, { status: 'administrator' }, { status: 'restricted', is_member: true, can_send_messages: true }]) {
    assert.equal((await clientFor(chat, member).assertCanSend('-100')).chatId, '-100');
  }
});
test('拒绝禁言、退群、被踢、无权限与群 ID 不符', async () => {
  const chat = { id: -100, type: 'supergroup', permissions: { can_send_messages: false } };
  for (const status of ['member', 'left', 'kicked', 'restricted', 'unknown']) {
    await assert.rejects(clientFor(chat, { status }).assertCanSend('-100'), /permission_denied/);
  }
  await assert.rejects(clientFor(chat, { status: 'administrator' }).assertCanSend('-200'), /wrong_chat/);
  await assert.rejects(clientFor({ ...chat, permissions: undefined }, { status: 'member' }).assertCanSend('-100'), /permission_denied/);
});
test('频道要求管理员且有发布权限；个人聊天只要 getChat 成功', async () => {
  const channel = { id: -100, type: 'channel' };
  assert.equal((await clientFor(channel, { status: 'administrator', can_post_messages: true }).assertCanSend('-100')).status, 'administrator');
  await assert.rejects(clientFor(channel, { status: 'administrator', can_post_messages: false }).assertCanSend('-100'), /permission_denied/);
  await assert.rejects(clientFor(channel, { status: 'member' }).assertCanSend('-100'), /permission_denied/);
  assert.equal((await clientFor({ id: 42, type: 'private', first_name: 'x' }, null).assertCanSend('42')).status, 'private');
});
test('置顶权限：群看置顶消息，频道看编辑消息，个人聊天总是可以', async () => {
  const group = { id: -100, type: 'supergroup', permissions: { can_send_messages: true } };
  const channel = { id: -100, type: 'channel' };
  const canPin = async (chat, member) => (await clientFor(chat, member).assertCanSend(String(chat.id))).canPin;
  assert.equal(await canPin(group, { status: 'administrator', can_pin_messages: true }), true);
  assert.equal(await canPin(group, { status: 'administrator', can_pin_messages: false }), false);
  assert.equal(await canPin(group, { status: 'member' }), false);
  assert.equal(await canPin(channel, { status: 'administrator', can_post_messages: true, can_edit_messages: true }), true);
  assert.equal(await canPin(channel, { status: 'administrator', can_post_messages: true, can_pin_messages: true }), false);
  assert.equal(await canPin({ id: 42, type: 'private', first_name: 'x' }, null), true);
});
test('置顶请求不通知群成员', async () => {
  let call;
  const client = new TelegramClient('test', 1000, async (url, options) => {
    call = { method: url.split('/').at(-1), body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ ok: true, result: true }) };
  });
  await client.pin('-100', 7);
  assert.deepEqual(call, { method: 'pinChatMessage', body: { chat_id: '-100', message_id: 7, disable_notification: true } });
});
test('429 解析 retry_after，错误中不泄露 token', async () => {
  const token = '123456:secretsecretsecretsecretsecret';
  const client = new TelegramClient(token, 1000, async () => ({
    ok: false, status: 429, json: async () => ({ ok: false, error_code: 429, description: token, parameters: { retry_after: 120 } }),
  }));
  await assert.rejects(client.send('-100', 'text'), error => {
    assert.equal(error.retryAfter, 120);
    assert.equal(error.message.includes(token), false);
    assert.equal(failurePolicy(error, true), 'retry');
    return true;
  });
});
test('传输异常、5xx、坏 JSON 的发送结果保守处理，前置查询可重试', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('token in URL'); },
    async () => ({ ok: false, status: 502, json: async () => ({}) }),
    async () => ({ ok: true, json: async () => { throw new Error('bad JSON'); } }),
  ]) {
    const client = new TelegramClient('test', 1000, fetchImpl);
    await assert.rejects(client.send('-100', 'x'), error => {
      assert.equal(failurePolicy(error, true), 'uncertain');
      assert.equal(failurePolicy(error, false), 'retry');
      return true;
    });
  }
  assert.equal(failurePolicy(new TelegramError('api', 403), true), 'failed');
  assert.equal(failurePolicy(new TelegramError('api', 408), true), 'uncertain');
});
test('发送只用纯文本、目标群 ID 和禁用链接预览', async () => {
  let sent;
  const client = new TelegramClient('test', 1000, async (url, options) => {
    sent = JSON.parse(options.body);
    assert.equal(options.redirect, 'error');
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  });
  await client.send('-100', '<hello>');
  assert.deepEqual(sent, { chat_id: '-100', text: '<hello>', link_preview_options: { is_disabled: true } });
});
test('JSON 日志等级过滤与 token 脱敏', () => {
  let output = '';
  const logger = createLogger('info', ['special-secret'], line => { output += line; });
  logger.debug('hidden');
  logger.error('test', { text: 'special-secret 123456:secretsecretsecretsecretsecret' });
  const parsed = JSON.parse(output);
  assert.equal(parsed.text, '[REDACTED] [REDACTED]');
  assert.equal(parsed.event, 'test');
});
