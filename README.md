# Bot Hub · Telegram 机器人管理后台

在一个网页后台统一管理多个 Telegram 机器人：每个机器人选一种类型，用 cron 决定什么时候执行，后台一步步告诉你要在 Telegram 里设置什么。

使用 Node.js 24 内置的 HTTP、SQLite 和测试框架，没有第三方运行依赖。

## 能做什么

- **多个机器人**：一个 Token 一条记录，各自独立的类型、时区、计划和重试设置。
- **可扩展的类型**：内置「续费提醒」和「定时消息」。新增类型只要在 `src/bot-types/` 加一个文件，配置表单会自动生成，写法见 [docs/bot-types.md](docs/bot-types.md)。
- **cron 调度**：标准 5 段表达式，支持 `L`（当月最后一天）和 `@daily` 等宏，按机器人设置的时区计算。编辑时实时显示中文含义和接下来 5 次时间。
- **配置向导**：每个机器人有一份逐步清单，说明去 @BotFather 做什么、怎么把机器人加进群、怎么拿到群 ID，并实时显示每步是否完成。
- **可靠发送**：同一时间点同一目标只发一次，重启不重复；限流和网络错误自动重试；结果未知时不自动重发，交给你核查。

## 部署

线上环境：`ssh hk`，域名 `bot.mdyrbz.com`。

```bash
deploy/deploy.sh
```

脚本会先跑测试，然后在 VPS 上安装 Node.js（校验官方 SHA256）、创建低权限用户 `tgbot`、同步代码到 `/opt/telegram-bot-hub/app`、注册 systemd 服务 `telegram-bot-hub`，并在现有 Caddy 配置末尾追加后台域名。服务只监听 `127.0.0.1:8090`，外部通过 Caddy 的 HTTPS 访问。数据在 `/var/lib/telegram-bot-hub`。

**前提**：DNS 里有一条 `bot` A 记录指向 VPS，否则 Caddy 拿不到证书。

换服务器或域名：

```bash
SSH_TARGET=my-vps DOMAIN=bot.example.com deploy/deploy.sh
```

### 首次使用

在 VPS 上获取一次性初始化口令：

```bash
ssh hk tg-bot-hub setup-key
```

打开后台，填口令、用户名和至少 12 位的密码创建管理员，然后新建机器人，跟着「配置向导」走。

### 日常运维

```bash
ssh hk systemctl status telegram-bot-hub
```

```bash
ssh hk journalctl -u telegram-bot-hub -n 100 --no-pager
```

```bash
ssh hk tg-bot-hub health
```

`health` 要求心跳在 5 分钟内，且没有失败或待核查的任务。

### 备份

数据库和机器人 Token 都在 `/var/lib/telegram-bot-hub`。停服务后整个目录打包：

```bash
ssh hk 'systemctl stop telegram-bot-hub && tar -czf - -C /var/lib/telegram-bot-hub . ; systemctl start telegram-bot-hub' > bot-hub-backup.tar.gz
```

恢复时停服务、解压回原目录并保持属主为 `tgbot`。备份之后才发送的消息，恢复后可能再发一次。

## 调度规则

- 启用、修改 cron 或恢复暂停，都从此刻起算，**不补发已经过去的时间点**。
- 服务停机后恢复，只补发「补发窗口」（默认 72 小时）内**最近一次**错过的时间点，更早的跳过并写入活动记录。
- 修改 cron 后，新时间点算新任务。把今天已发送的 10:00 改成 10:05，今天 10:05 会再发一次。
- 日和周同时指定时，满足任一条件就触发（标准 cron 规则）。
- 夏令时跳过的时刻当天不触发，回拨重复的时刻只发一次。
- 多个目标之间至少间隔 1.1 秒。到点后依次发送，不保证精确到秒。

## 任务状态

| 状态 | 含义 |
| --- | --- |
| 等待发送 | 等待发送时间或重试时间 |
| 检查权限 | 正在核对机器人是否有发言权限 |
| 正在发送 | 已进入 Telegram 发送阶段 |
| 发送成功 | 有成功回执，或已人工确认 |
| 发送失败 | Telegram 明确拒绝，或重试次数用尽 |
| 结果待核查 | 可能已送达（比如发送超时），不会自动重发 |
| 已跳过 | 超过补发窗口、目标被移除、机器人被删除或人工跳过 |

Telegram 的 `sendMessage` 没有幂等键，任何系统都无法同时保证绝不重复和绝不漏发。这里选择在结果未知时交给人判断。不要靠删数据库来解除防重。

## 安全

- 管理员密码用 scrypt 加盐哈希；会话 12 小时，数据库只存令牌哈希；Cookie 是 HttpOnly、SameSite=Strict、Secure。
- 所有修改接口要求同源和 CSRF 校验。登录失败按客户端 IP 限流（5 次后锁 15 分钟），经 Caddy 转发时取 Caddy 写入的真实 IP。
- 后台只支持一个管理员，没有邮件找回密码，请保存好密码。
- Token 明文保存在受文件权限保护的 SQLite 里，接口不会返回。VPS 和备份只能交给可信的人。
- 日志和活动记录不含消息正文，Token 会被脱敏。

## 本地开发

需要 Node.js 24。

```bash
npm test
```

```bash
npm start
```

然后在另一个终端运行 `npm run setup-key` 拿初始化口令，访问 <http://127.0.0.1:8090>。

可选环境变量：`DATA_DIR`（默认 `./data`）、`ADMIN_HOST`、`ADMIN_PORT`（默认 8090）、`COOKIE_SECURE`、`TRUST_PROXY`、`LOG_LEVEL`、`TELEGRAM_API_BASE`（默认官方 API，可指向自建 Bot API 服务或测试替身）。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/bot-types/` | 机器人类型，放文件即注册 |
| `src/cron.js` | cron 解析、下次时间、中文描述 |
| `src/scheduler.js` | 把到点的计划变成发送任务 |
| `src/worker.js` | 领取任务、检查权限、发送、重试 |
| `src/schema.js` | 类型字段声明的校验 |
| `src/guide.js` | 配置向导和使用指南的内容 |
| `src/admin-server.js` | 后台接口 |
| `public/` | 后台页面，表单由类型的字段声明生成 |
| `deploy/` | 部署脚本、systemd 服务 |

## 参考

- [Telegram Bot API](https://core.telegram.org/bots/api)
- [BotFather 说明](https://core.telegram.org/bots/features#botfather)
- [Node.js SQLite API](https://nodejs.org/api/sqlite.html)
