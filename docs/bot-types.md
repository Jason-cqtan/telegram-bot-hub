# 新增机器人类型

一个类型就是 `src/bot-types/` 下的一个文件。放进去、重新部署，后台的「新建机器人」里就会出现它，配置表单、校验、cron 调度、重试、防重、发送记录都不用另外写。

文件名以 `_` 开头的不会被注册，用来放共用代码。

## 最小例子

`src/bot-types/daily-quote.js`：每个计划按 cron 发一句随机的话。

```js
import { newPlan, planField, planSchedules, planTargets } from './_plans.js';

const quotes = ['今天也要好好吃饭。', '先做最重要的事。'];

export default {
  id: 'daily-quote',
  name: '每日一句',
  description: '按 cron 随机发一句话。',
  fields: [planField({
    itemLabel: '任务', defaultCron: '0 8 * * *', defaultTemplate: '（内容由程序生成，这里不用填）',
    templateHelp: '这个类型不使用模板。',
  })],
  defaults: () => ({ plans: [newPlan('早安', '0 8 * * *', '（内容由程序生成，这里不用填）')] }),
  schedules: planSchedules,
  targets: planTargets,
  plan({ schedule, config }) {
    const plan = config.plans.find(item => item.id === schedule.key);
    const text = quotes[Math.floor(Math.random() * quotes.length)];
    return plan ? plan.chats.map(chat => ({ chatId: chat.chatId, chatName: chat.name, label: plan.name, text })) : [];
  },
};
```

`npm test` 会自动对新类型跑一遍契约测试（默认配置能通过校验、能生成计划），写错了部署脚本会在同步代码前停下。

## 类型要提供什么

| 成员 | 说明 |
| --- | --- |
| `id` | 2–32 位小写字母、数字、`-`。存进数据库，上线后不要改 |
| `name` / `description` | 显示在新建机器人的类型选择里 |
| `fields` | 配置表单的声明，见下表 |
| `defaults()` | 新建时的默认配置 |
| `schedules(config)` | 返回 `[{ key, label, cron }]`。`key` 要稳定，它是防重键的一部分 |
| `targets(config)` | 返回 `[{ chatId, name }]`。权限检查和测试消息用它；任务的目标不在这里时，等待中的任务会被跳过 |
| `plan(context)` | 到点时调用，返回要发的消息 `[{ chatId, chatName?, label?, text }]`，可以是 async |
| `validate(config)` | 可选。保存时做额外校验，抛错即拒绝保存，错误文字会显示给用户 |
| `guide` | 可选。`{ title, body }`，插入配置向导的类型专属步骤 |

`plan` 收到的 `context`：

| 字段 | 说明 |
| --- | --- |
| `schedule` | 本次触发的计划 `{ key, label, cron }` |
| `occurrence` | 本次触发时间，已按机器人时区换算：`at`（毫秒）、`year` `month` `day` `hour` `minute`、`date`（2026-12-31）、`time`（10:00）、`weekday`（周四）、`key` |
| `config` | 校验后的配置 |
| `bot` | `{ id, name, username, timeZone }`，不含 Token |
| `telegram` | 这个机器人的客户端，`telegram.call('getChat', {...})` 可调用任意 Bot API。预览时为 `null` |
| `logger` | `logger.info('event', {...})` 写进活动记录 |
| `preview` | 后台预览和测试消息时为 `true`。此时不要产生副作用（比如扣库存、写外部系统） |

`plan` 抛错时，这个时间点不重试，错误写入活动记录，下个时间点照常。需要访问外部接口时自己控制超时：`plan` 卡住会拖慢整个调度循环。

## 字段类型

| type | 值 | 常用属性 |
| --- | --- | --- |
| `text` | 字符串 | `required` `maxLength` `placeholder` `help` |
| `textarea` | 字符串 | 同上，加 `rows` |
| `number` | 数字 | `required` `min` `max` `default` |
| `boolean` | true/false | `default` |
| `select` | 选项值 | `options: [{ value, label }]` |
| `cron` | cron 表达式 | `required` `default`。自带常用选项、中文含义和接下来 5 次时间 |
| `chats` | `[{ name, chatId }]` | `maxItems` |
| `list` | 对象数组 | `fields` `itemLabel` `minItems` `maxItems`。`keyed: true` 时每项带稳定的 `id`，适合做 `schedule.key` |

每个字段都要有 `key` 和 `label`。声明之外的输入字段会被丢弃。

## 复用

`_plans.js` 封装了最常见的形态（若干计划，每个一个 cron、一份模板、若干目标）：`planField`、`newPlan`、`planSchedules`、`planTargets`、`planMessages`、`validatePlanTemplates`。`renewal.js` 和 `scheduled-message.js` 都建立在它上面，只相差模板变量。

## 当前的边界

类型目前只由 cron 驱动，也就是定时发送。机器人不接收、不回复用户消息（后台也没有在跑 `getUpdates` 轮询或 webhook），所以「用户发命令、机器人回复」这种交互式类型还需要先给平台加上收消息的循环。
