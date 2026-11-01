# 续费日历 · Telegram 管理后台 v2.0

中文管理后台和季度续费机器人部署在同一个 VPS 上。**不需要编辑配置文件**：启动后创建管理员，在网页填写 Token、添加 A/B 群组、修改消息模板和重试设置，保存后自动生效。

使用 Node.js 24 内置 HTTP、SQLite 和测试框架，无第三方 Node.js 运行依赖。保留 v1 的发送历史、持久化防重和失败处理规则。

## 先看能做什么

- 总览：下次提醒时间、启用状态、群数量、成功和待处理任务、最近活动。
- 群组与设置：填写或更换机器人 Token；分别添加、移除 A/B 群组；编辑消息模板。
- 发现群组：从机器人的最近 Telegram 更新中查找群 ID，点击加入 A/B 类。
- 消息预览：按当前表单渲染变量，不保存、不发送。
- 权限检查：检查已保存的 Token 和群发言权限，不发送。
- 自动通知：保存启用或暂停状态，无需重启。
- 发送记录：查看最近 200 条任务，筛选状态，处理失败或结果待核查的任务。
- 账户安全：修改管理员密码、退出登录；密码更新后所有会话失效。

## 1. 在 VPS 启动（无需 .env）

VPS 需安装 Docker Engine 和 **Docker Compose 2.24.0 或更新版本**，并能访问 `api.telegram.org:443`。将整个项目目录上传到 VPS，进入项目目录：

```bash
docker compose up -d --build
docker compose exec bot node src/cli.js setup-key
```

第二条命令输出一次性初始化口令。复制它，稍后在网页创建管理员。口令只在尚未创建管理员时有效，创建成功后自动删除；不会预设通用用户名和密码。

默认后台仅在 VPS 本机的 `127.0.0.1:8080` 监听。**不需要域名**，在你自己的电脑开一个终端运行（把 `root@你的VPS地址` 换成实际 SSH 登录信息）：

```bash
ssh -N -L 8080:127.0.0.1:8080 root@你的VPS地址
```

保持这个窗口开启，在自己电脑浏览器访问：

[http://127.0.0.1:8080](http://127.0.0.1:8080)

填写初始化口令、管理员用户名、至少 12 位的密码，创建账户。用户名支持 3–32 位字母、数字、`_`、`.`、`-`。初始化口令来自上面的 VPS 命令，不是 Telegram Token。

## 2. 在网页里完成机器人设置

1. 在 Telegram 官方 `@BotFather` 使用 `/newbot` 创建机器人。
2. 将机器人加入你管理的 A/B 私人群，允许它发送文本消息。普通成员有发言权限即可；全员禁言群可赋予必要的管理员权限。
3. 打开后台「群组与设置」，粘贴 BotFather Token，先保持自动通知关闭，点击「保存设置」。
4. 在每个群发送 `/setup@你的机器人用户名`。回到后台点击「发现机器人所在群」，选择加入 A 类或 B 类。也可以手动输入真实负整数群 ID。
5. 编辑 A/B 消息模板，保存后点击「检查连接与群权限」。
6. 点击「预览消息」核对文字，勾选「启用发送」并保存。

不需要改 `.env`、JSON、数据库或重启容器。设置保存在持久化数据卷中，容器更新和重启后继续使用。

「发现群组」读取最近更新，不输出成员 ID 或消息正文，不确认消费 offset。若列表为空，请重新在群内发送带机器人用户名的命令。若机器人被其他服务设置了 webhook，发现接口会冲突；建议使用本项目专用机器人。本项目不自动删除 webhook，也不回复群内管理命令。

**Token 保存后不会再完整显示**；输入框留空表示保持现有 Token。更换时填写新值保存即可。当前任务正在发送期间不能更换 Token，请先暂停并等待任务完成。

## 3. 想直接用域名访问（可选 HTTPS）

如果你已有一个解析到 VPS 的域名，可使用附带的 Caddy 自动 HTTPS。确保域名 A/AAAA 记录指向当前 VPS，VPS 的 TCP 80/443 端口可访问且没有其他服务占用。将示例域名替换为自己的域名：

```bash
export ADMIN_DOMAIN=bot.example.com
docker compose -f compose.yaml -f compose.https.yaml up -d --build
```

然后访问 `https://bot.example.com`，无需 SSH 隧道。初始化口令仍通过以下命令读取：

```bash
docker compose exec bot node src/cli.js setup-key
```

这个组合启用 Secure Cookie、HSTS，并由 Caddy 处理证书。日后更新或重新创建服务时，继续使用上述两个 `-f` 文件参数和 `ADMIN_DOMAIN`；如果重新登录 SSH，请重新设置该环境变量。使用已有反向代理时，需要转发原始 Host，并将容器的 `COOKIE_SECURE` 设为 `true`。

不要把默认 HTTP 端口直接开放给公网传输管理员密码和 Token。无需域名的 SSH 隧道方案已经能安全访问后台。

## 4. 固定季度规则与模板

| 类别 | 日期 | 时间 |
| --- | --- | --- |
| A 类 | 3 月 31 日、6 月 30 日、9 月 30 日、12 月 31 日 | 北京时间 10:00 |
| B 类 | 同上 | 同上 |

时区显式固定为 `Asia/Shanghai`，不受 VPS 时区影响；日历检查默认每 15 秒执行一次。到点后依次发送，网络、群数和限流会带来延迟，不保证精确到秒。多个群之间至少间隔 1.1 秒。

默认只补发过去 **72 小时内**的到期通知，支持跨季度、跨年。首次开启自动通知也按这个规则处理，开启前页面会提示确认。暂停不创建或执行新发送任务；已经进入发送阶段的请求可能继续完成。暂停期间的补发截止时间仍会流逝，不会延长。

| 模板变量 | 含义 | 2026 年第四季度示例 |
| --- | --- | --- |
| `{year}` | 通知所属年份 | 2026 |
| `{quarter}` | 通知所属季度 | 4 |
| `{quarter_key}` | 季度标识 | 2026-Q4 |
| `{next_year}` | 下季度所属年份 | 2027 |
| `{next_quarter}` | 下季度 | 1 |
| `{due_date}` | 通知日期 | 2026-12-31 |
| `{class}` | 群类别 | A 或 B |
| `{group_name}` | 网页中填写的群名称 | A类合租群 |

直接在模板输入框回车换行；纯文本发送，不解析 HTML 或 Markdown。渲染后保守限制 4096 个 UTF-16 代码单元，未知变量会拒绝保存或预览。一个群只能属于一个类别，最多支持 100 个群；不支持频道、个人聊天或指定论坛话题。论坛群默认发送到默认话题，权限、话题关闭等由 Telegram API 返回结果。

金额、续费截止日期、联系人、付款方式均可直接写入模板。本项目不处理付款，不自动移除未付款成员。

修改模板只影响新生成的任务；已生成任务保留原正文和原补发期限。历史成功任务不会因改模板、更换 Token 或重启重新发送。同一季度里被移除并跳过的群，重新添加后也不会强制重发该任务。

## 5. 后台失败处理与防重边界

SQLite 的唯一键是「季度 + 群 ID」。任务通过原子领取和带 owner 的租约防止并发执行，使用 WAL 和 FULL 同步。

| 页面状态 | 内部状态 | 行为 |
| --- | --- | --- |
| 等待发送 | pending | 等待发送时间或重试时间 |
| 检查权限 | checking | 校验 Token、群 ID、群类型和发言权限 |
| 正在发送 | sending | 已进入 Telegram 发送阶段 |
| 发送成功 | sent | 保存成功回执或已人工确认，不再发送 |
| 发送失败 | failed | 明确拒绝或尝试次数用尽，等待处理 |
| 结果待核查 | uncertain | 可能已送达，等待人工核查 |
| 已跳过 | skipped | 过期、移除目标或人工跳过，不再发送 |

- 429 限流：按 `retry_after` 与指数退避的较长时间重试，附带 0–20% 抖动。
- 发送前的网络错误、超时、5xx：自动重试。
- 明确的 400/401/403 等请求错误：先修复配置或权限，再在后台处理。
- 发送阶段超时、连接中断、5xx、408、无效回执或发送后写库失败：标记「结果待核查」，不会自动重发。
- 崩溃时处于 checking 的任务可在租约到期后重新领取；sending 任务在租约到期后进入待核查。默认租约为 105 秒，可随请求超时参数变化。

在「发送记录」点击「处理任务」，可选择：确认群内已收到并标记成功；确认未收到并允许重试；本次跳过。允许重试需勾选核查与重复风险确认，补发窗口过期后禁止重试。人工处理会记录审计，重试重置尝试次数但不改变正文和截止时间。

Telegram 的 `sendMessage` 没有可供本项目使用的客户端幂等键，因此不能同时保证任意故障下绝不重复和绝不漏发。项目选择在结果未知时交给管理员核查。不要删除数据库来解除防重。

## 6. 账户、数据和运行日志

- 管理员密码使用随机盐与 scrypt 哈希保存。
- 会话有效期 12 小时，数据库只保存会话令牌哈希；Cookie 使用 HttpOnly 和 SameSite=Strict，HTTPS 模式另启用 Secure。
- 所有修改接口要求同源来源和 CSRF 校验；首次注册需要一次性初始化口令。
- 登录失败限制按来源持久化到 SQLite，5 次失败后限制 15 分钟；另有全局频率与并发保护。反向代理下多个来源可能共享限流额度。
- 支持一个管理员账户。忘记密码时本版没有邮件找回，请妥善保存密码与完整数据卷备份。
- Token 为调用 Telegram 所必需，保存在受文件权限保护的 SQLite 中；不做数据库静态加密。VPS、备份和数据卷应仅限可信管理员访问。
- 后台显示最近 100 条活动，数据库保留最近 1000 条活动。标准输出逐行 JSON，默认不记录通知正文或完整 Telegram 错误响应，并对 Token 脱敏。

常用运行检查：

```bash
docker compose ps
docker compose logs --tail=100 bot
docker compose exec bot node src/cli.js health
docker compose exec bot node src/cli.js status
```

健康检查要求心跳不超过 5 分钟，且没有 failed/uncertain 任务。首次未设置、自动通知暂停时可以是 healthy。它不代表 Telegram 实时可达；Docker 不会仅因 unhealthy 自动重启或给你发告警，可在 VPS 监控平台监测。

**数据卷包含发送历史、网页设置、Token、密码哈希及会话。不要运行 `docker compose down -v`。** 不同数据库不能互相防重，建议保持单实例和单 VPS 本地磁盘，不使用 NFS/跨主机 SQLite。

## 7. 备份、升级与旧版迁移

停服务后完整备份 SQLite、WAL 等数据文件：

```bash
docker compose stop bot
docker compose run --rm --no-deps --entrypoint tar bot -czf - -C /app/data . > bot-data-backup.tar.gz
docker compose start bot
```

恢复时停服务，优先恢复到空数据卷，不混合不同时间点的数据库和 WAL：

```bash
docker compose stop bot
docker compose run --rm --no-deps -T --entrypoint tar bot -xzf - -C /app/data < bot-data-backup.tar.gz
docker compose start bot
```

备份后已发送但备份中尚未记录的通知，恢复后可能被再次发送；恢复前核对本季度记录。旧会话也属于备份内容，恢复后建议通过网页更新密码，使旧会话全部失效。

普通更新：保留原项目目录、原数据卷，覆盖代码后运行 `docker compose up -d --build`。域名 HTTPS 部署则继续使用第 3 节中的两个 Compose 文件。更换目录名可能改变 Compose 默认卷名，请先确认挂载原卷。

从 v1 升级：

1. 备份原数据卷、`.env` 和 `config/`，停止原服务。
2. 在原项目目录覆盖 v2 代码。原 `config/config.json` 若自定义过，请保留原文件供首次导入；不要丢失 `.env` 和数据卷。
3. 保持相同 Compose 项目名称/目录，构建并启动。
4. 读取初始化口令并创建管理员。原 jobs/resolutions 表保留，不清空成功记录。
5. 如果旧 Token、群配置有效，会在首次运行时导入网页设置，但**默认暂停**，请在网页核对模板、群和权限后启用；导入失败时可直接在网页重新填写。

导入只在数据库还没有网页设置时发生。之后 `.env`/JSON 不会覆盖网页设置。`.env` 是可选的兼容导入来源，新部署无需创建。

## 8. 不用 Docker 的本地运行

安装 Node.js 24.x，进入项目目录：

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm start
```

保持程序运行，在另一个终端的同目录执行：

```bash
npm run setup-key
```

浏览器访问 [http://127.0.0.1:8080](http://127.0.0.1:8080) 创建管理员。首次无需任何配置。长期运行可交给 systemd，使用低权限用户和正确工作目录。

可选部署变量（通常无需修改）：`DATA_DIR`（默认 `./data`）、`ADMIN_HOST`（本地默认 `127.0.0.1`，容器内为 `0.0.0.0`）、`ADMIN_PORT`（默认 8080）、`COOKIE_SECURE`（HTTPS 设为 `true`）、`LOG_LEVEL`。Compose 将数据目录固定为 `/app/data`。

保留原 CLI 命令：`check`、`discover`、`dry-run`、`status`、`resolve`、`health`。已有网页设置时，前几个命令读取网页设置；`worker` 是只读旧环境变量/JSON 的兼容模式，请勿与网页服务同时启动。

## 9. 测试与验证范围

`npm test` 不需要真实 Token，不访问 Telegram，使用临时 SQLite 和模拟 API。覆盖原有季度/防重/重试测试，并新增实际本地 HTTP 接口的初始化、登录、CSRF、Cookie、持久化设置、Token 隐藏、限流、密码更新、任务处理和暂停检查等测试。Docker 构建也会运行测试。

交付前已做浏览器实测：登录、A/B 群添加与保存、跨年模板预览、手机与桌面布局。详细结果见 `VERIFICATION.md`。未连接真实 Telegram 群；当前交付环境没有可运行的 Docker 后台和 Compose 插件，所以未构建或启动容器，HTTPS 证书流程也尚未在线验证。

## 官方资料

- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Node.js 24 SQLite API](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)
- [Docker：可选 env_file 与 Compose 版本要求](https://docs.docker.com/compose/how-tos/environment-variables/set-environment-variables/)
- [Caddy 反向代理与 HTTPS](https://caddyserver.com/docs/quick-starts/reverse-proxy)
