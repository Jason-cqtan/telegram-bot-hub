// 配置向导的步骤与状态由服务端算出，页面只负责显示。
export function botGuide(bot, type, targets) {
  const username = bot.username;
  const steps = [
    {
      id: 'token', title: '在 Telegram 创建机器人，拿到 Token', done: bot.hasToken, tab: 'settings',
      status: bot.hasToken ? (username ? `已连接 @${username}` : 'Token 已保存，尚未验证') : '未配置',
      items: [
        '打开 Telegram App，点顶部搜索框，搜索 @BotFather（带蓝色认证标记的官方账号），点「开始」。',
        '发送 /newbot，按提示依次输入显示名称和用户名（用户名必须以 bot 结尾，例如 my_renewal_bot）。',
        'BotFather 回复的消息里有一串形如 123456789:AAH… 的 Token，复制它。',
        '回到本后台「参数设置」，粘贴到「机器人 Token」并保存。保存时会自动验证 Token。',
      ],
      links: [{ label: '打开 @BotFather', url: 'https://t.me/BotFather' }],
      note: '不需要去 my.telegram.org 申请 api_id / api_hash，那是开发用户端 App 用的，机器人只要 Token。Token 相当于密码，泄露后在 @BotFather 发 /revoke 换新的。',
    },
    {
      id: 'botfather', title: '检查 BotFather 里的机器人设置', optional: true, done: false,
      status: '按需设置',
      items: [
        '在 @BotFather 发送 /mybots，选择你的机器人，进入 Bot Settings。',
        'Allow Groups? 要保持开启（Turn groups on），否则机器人进不了群。对应命令 /setjoingroups。',
        'Group Privacy 保持开启即可（默认值）。只发送通知不需要读群消息，对应命令 /setprivacy。',
        '可选：/setname 改名称，/setuserpic 设头像，/setdescription 写简介。',
      ],
    },
    {
      id: 'chats', title: '把机器人加进群或频道，填入 ID', done: targets.length > 0, tab: 'settings',
      status: targets.length ? `已添加 ${targets.length} 个目标` : '还没有目标',
      items: [
        '群：打开群 → 点群名称 → 添加成员 → 搜索机器人用户名 → 添加。普通成员能发言即可；全员禁言的群需要设为管理员。',
        '频道：打开频道 → 频道信息 → 管理员 → 添加管理员 → 搜索机器人 → 开启「发布消息」。',
        '加好后回到本页点「发现机器人所在群」，选择要加入的计划。没有列出时，在群里发一条 /start@机器人用户名 再试。',
        '个人：对方先给机器人点「开始」，再手动填对方的数字 ID（可向 @userinfobot 查询）。',
      ],
      links: username ? [
        { label: '选择群并添加机器人', url: `https://t.me/${username}?startgroup=setup` },
        { label: '选择频道并添加机器人', url: `https://t.me/${username}?startchannel=setup&admin=post_messages` },
      ] : [],
      action: 'discover', actionNeedsToken: true,
    },
  ];
  if (type?.guide) steps.push({
    id: 'type', title: type.guide.title, done: targets.length > 0, tab: 'settings',
    status: targets.length ? '已配置' : '待配置', items: [type.guide.body],
    note: '执行时间支持 cron 表达式，输入框下方会实时显示含义和接下来 5 次触发时间，时区在同一页设置。',
  });
  steps.push(
    {
      id: 'check', title: '检查连接与发送权限', done: bot.checked,
      status: bot.checked ? '全部通过' : (targets.length ? '尚未检查，或 Token / 目标已变化' : '需要先添加目标'),
      items: ['点下面的按钮，后台会逐个核对机器人是否在目标里、有没有发言权限。这一步不发送任何消息。'],
      action: 'check', actionNeedsToken: true,
    },
    {
      id: 'test', title: '发一条测试消息', optional: true, done: false, status: '',
      items: ['选一个目标发送「【测试】+ 渲染后的消息」，确认文字和排版。这条会真实发到群里，但不计入发送记录。'],
      action: 'test', actionNeedsToken: true,
    },
    {
      id: 'enable', title: '启用机器人', done: bot.enabled,
      status: bot.enabled ? '运行中' : '已暂停',
      items: ['启用后从此刻起按 cron 执行。启用、修改 cron 或恢复暂停都不会补发已经过去的时间点。'],
      action: 'enable',
    },
  );
  const required = steps.filter(step => !step.optional);
  return { steps, doneCount: required.filter(step => step.done).length, totalCount: required.length };
}

export const HELP = [
  {
    title: '整体怎么工作',
    items: [
      '一个 Telegram 机器人（一个 Token）对应后台一条「机器人」记录，每条记录选一种类型，可以有多个计划。',
      '后台进程每秒检查一次到点的计划，生成发送任务并依次发出，同一个时间点同一个目标只会生成一个任务，重启也不会重复。',
      '发送结果未知（比如请求超时）时不会自动重发，任务会标记「结果待核查」，由你在「发送记录」里处理。',
    ],
  },
  {
    title: 'Telegram 里需要设置什么',
    items: [
      '只需要 @BotFather：创建机器人（/newbot）、拿 Token、必要时调整 Allow Groups（/setjoingroups）。Telegram App 的「设置」页面没有机器人相关选项。',
      '不需要 my.telegram.org 的 api_id / api_hash，不需要 webhook，也不需要给 VPS 开放端口给 Telegram。',
      '机器人不能主动给没互动过的人发消息；发给个人时，对方要先点机器人的「开始」。',
      '普通群升级成超级群后 ID 会变（变成 -100 开头）。如果发送失败提示群 ID 不正确，重新发现一次即可。',
    ],
  },
  {
    title: 'cron 表达式',
    items: ['五段依次是：分 时 日 月 周，时间按机器人设置的时区计算。'],
    table: [
      ['0 10 L 3,6,9,12 *', '每季度最后一天 10:00（L 表示当月最后一天）'],
      ['0 9 * * *', '每天 9:00'],
      ['0 9 * * 1-5', '工作日 9:00'],
      ['30 8 * * 1', '每周一 8:30'],
      ['0 12 1 * *', '每月 1 日 12:00'],
      ['*/30 * * * *', '每 30 分钟'],
      ['@daily', '每天 0:00（还支持 @hourly @weekly @monthly @quarterly @yearly）'],
    ],
    note: '日和周同时指定时，满足任一条件就触发（标准 cron 规则）。最小粒度是 1 分钟。修改 cron 后，新时间点视为新任务，所以把已发送的 10:00 改成当天 10:05 会再发一次。',
  },
  {
    title: '任务状态和补发规则',
    items: [
      '等待发送 / 检查权限 / 正在发送：正常流转中。',
      '发送失败：Telegram 明确拒绝或重试次数用尽，修好配置后在「发送记录」里处理。',
      '结果待核查：消息可能已送达。先看群里有没有收到，再选择「标记成功」或「允许重试」。',
      '服务停机恢复后，只补发补发窗口内最近一次错过的时间点，更早的会跳过并记录到活动里。',
    ],
  },
  {
    title: '常见问题',
    items: [
      '发现不到群：Telegram 只保留 24 小时内的更新。在群里发一条 /start@机器人用户名，再点发现。',
      '提示机器人被其他服务占用：这个 Token 设置过 webhook，或别的程序正在用它收消息。建议给本后台单独建一个机器人。',
      '提示没有发送权限：群里开了全员禁言，或频道没给「发布消息」权限。把机器人设为管理员后重新检查。',
      '想新增机器人类型：在 src/bot-types/ 加一个文件并重新部署，后台会自动出现这个类型和它的配置表单，写法见仓库 docs/bot-types.md。',
    ],
  },
];
