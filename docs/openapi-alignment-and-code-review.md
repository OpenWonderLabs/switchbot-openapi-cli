# OpenAPI 文档对齐与当前代码审查任务计划

## 基线与边界

- 官方文档固定到 [`dc9a6b0e4ad77882c72d186ecd5d134113acdad0`](https://github.com/OpenWonderLabs/SwitchBotAPI/commit/dc9a6b0e4ad77882c72d186ecd5d134113acdad0)，提交时间 2026-10-08；对照 README 与 84 个 `devices/**/*.md`。
- 最初审查基线：CLI `3.8.1`，HEAD `8b5243dbc3c2b1243346bb09bde2c2b8a98d560d`。本修复分支 `fix/openapi-alignment-and-plugin-runtime` 从 `origin/main` 的 `45f9a956013d066b441ad4902a6b23d91ca44028` 创建；候选 CLI `3.9.0`、四个既有包 `0.2.0` 尚未发布。
- Skills-only、ADR、Cloud MCP 提案与未归属本轮的文件保留在独立工作区 `../switchbot-openapi-cli-skills-wip`，原分支 `docs/skills-only-plugin-submission-review` 不变。完整分离前快照留在 Git stash；本分支 README/lockfile 不引入该 WIP 包。
- 用户选择全部 33 项分批实施；采用多 Agent 并行、纵向 TDD 与统一集成。未提交、推送、发布 npm、创建 tag/release 或执行真实设备 mutation。
- 证据分为：**已复现**（离线运行真实入口或真实模块）、**静态确认**（明确执行路径/文档合约）、**待验证**（需要实机、宿主或上游确认）。模拟 HTTP 响应不等于云端/真机验证。
- 优先级：**P0** 物理安全/凭据风险，**P1** 功能错误或核心兼容性，**P2** 发现元数据、文档和适用性澄清。勾选表示已实施且有本地证据；外部验收仍保持未勾选。下面各任务的“证据”段保留首次审查时的缺陷，不代表修复后的现状。

## 官方更新与已覆盖部分

| 官方变更 | 首次审查时 CLI 对比 |
| --- | --- |
| [2026-10-08：新增 MindClip transcript API](https://github.com/OpenWonderLabs/SwitchBotAPI/commit/8d94189657fa38ec847c7d5daad0b4b70088e9aa) | 新增独立 `/recordings/{recordingId}/transcript`；同时明确转写状态 1–5。CLI 尚无该入口。该提交只改 MindClip 文档，不能将下面全部历史差距归因于此次更新。 |
| [2026-09-16 合并：恢复拆分文档时丢失的内容](https://github.com/OpenWonderLabs/SwitchBotAPI/commit/72cdc7ad8009b6e67dd6f4b2220e19608ad0f952) | Lock Lite 恢复 `deadbolt`；Meter Plus / Plug Mini EU webhook 示例更正为 `WoMeterPlus` / `WoPlugEU`。本地尚未完整对齐。 |
| [2026-09-16 合并：Standing Fan 类型名修正](https://github.com/OpenWonderLabs/SwitchBotAPI/commit/089d2530e8bfecc8920cc6875b20a8cf0e088118) | 本地仍只识别产品展示名 `Standing Circulator Fan`，缺少实际 `deviceType: Standing Fan`。 |
| [2026-07-23：新增产品和功能文档](https://github.com/OpenWonderLabs/SwitchBotAPI/commit/9ec540a9ce589e5c871b377ddfadc7a52675ec10) | Permanent Outdoor Lights、RGBICWW Ceiling Light、Battery Circulator Fan 2 Pro、Kata Friends、AI MindClip 已有 catalog；不是重新添加这些设备。Kata diary 读取、部分参数校验和发现元数据仍有缺口。 |

无需重写的部分：API host、现有 HMAC 客户端、每日 10,000 次额度说明、设备 list/status/commands 主路径、Scenes 两个实际 REST 调用及四个 Webhook 管理调用已有实现。`events tail` 已按 `context.deviceMac/deviceId/deviceType` 提取和过滤，并保留原始 payload；Webhook 发现元数据错误不等于接收器不支持这些设备。Webhook 文档不能用来推断 MQTT 字段或事件分类。

## A：官方 API 对齐任务

### A01 · P0 · 门闩释放命令的安全闭环

**证据：** [Lock Lite](https://github.com/OpenWonderLabs/SwitchBotAPI/blob/dc9a6b0e4ad77882c72d186ecd5d134113acdad0/devices/locks-security/lock-lite.md#L35-L41)、[Lock](https://github.com/OpenWonderLabs/SwitchBotAPI/blob/dc9a6b0e4ad77882c72d186ecd5d134113acdad0/devices/locks-security/lock.md#L36-L42)、Lock Pro、Lock Ultra 都将 `deadbolt` 定义为 **disengage deadbolt or latch**。本地 `src/devices/catalog.ts:251-300` 缺 Lite 命令，将普通/Ultra 的语义写成 engage，且未列 destructive。`src/rules/destructive.ts:8-14` 的独立 denylist 也没有该命令。Matter Pro 的 catalog 标记已正确，不应回退。

**涉及：** `src/devices/catalog.ts`、`src/rules/destructive.ts`，以及 CLI/MCP/batch/plan/policy/rules 的既有安全消费者。依赖：无。

- [x] 为 Lite 补齐命令；普通 Lock/Pro/Ultra/Lite 均使用释放门闩的准确说明及 destructive tier，移除错误的“Pro only / engage / no deadbolt”说明。
- [x] 同步规则 lint、policy validation 和 action executor 的独立门禁，不能只修改 catalog。
- [x] 验收：所有相应型号/别名的 `deadbolt` 都进入现有确认/审批流程；规则中的该动作被拒绝，无法绕过 lint 后由 executor 执行；离线 `devices commands`/schema 明确提示物理解锁风险。不得用真实门锁执行验收。
- [x] 回归覆盖安全边界，而不是仅断言复制后的 catalog 常量；修复说明进入 CHANGELOG 和安全使用文档。

### A02 · P1 · 补齐 MindClip 独立 transcript 读取

**证据：** [官方 MindClip L121–249](https://github.com/OpenWonderLabs/SwitchBotAPI/blob/dc9a6b0e4ad77882c72d186ecd5d134113acdad0/devices/others/ai-mindclip.md#L121-L249) 将 recording detail 定义为元数据，新增 `GET /v1.1/mindclip/recordings/{recordingId}/transcript`。本地 `src/lib/mindclip.ts:29-89` 只有七个 API helper，`src/commands/mindclip.ts:21-28` 和 `src/commands/mcp.ts:1298-1342` 仍把 detail 描述为 metadata + transcript。

**涉及：** `src/lib/mindclip.ts`、`src/commands/mindclip.ts`、`src/commands/mcp.ts`、`src/commands/capabilities.ts`、`src/commands/completion.ts`；现有 MindClip lib/CLI/MCP 测试；README、agent-guide 和各插件中的实际 MindClip 使用说明。依赖：无。

- [x] 沿用现有客户端与输出方式，增加 `mindclip transcript <id>`；扩展现有 `mindclip_recordings` 的 `action: "transcript"`，不为同一资源再造一套 MCP 工具组。
- [x] 修正 `recording` / `action=get` 的说明；summary 仍可包含 transcript，不将独立接口与 summary 等同。
- [x] 原样保留 `transcribeStatus`、字符串 `transcribeResult`、`speakers`。示例中的 `transcribeResult` 是包含 JSON 的字符串，不应自动改成对象或丢掉原文；1/3/4/5 状态不能伪装成已完成的空转写。
- [x] 验收：CLI 和 MCP 均能读取官方成功样例；记录 ID 的 `/ ? #` 不改变 URL 路径结构；缺 ID 本地拒绝；API 错误保留现有结构化错误语义；capabilities/help/补全可发现新操作，MCP 原有工具数量不因新增 action 变化。

### A03 · P1 · 补齐 Kata Friends diary 读取

**证据：** [Kata Friends L46–147](https://github.com/OpenWonderLabs/SwitchBotAPI/blob/dc9a6b0e4ad77882c72d186ecd5d134113acdad0/devices/others/kata-friends.md#L46-L147) 定义 `GET /v1.1/devices/{deviceId}/diary`，必填毫秒 `startTimestamp/endTimestamp`，区间为 `[start,end)`，最长 31 天。本地只有 catalog 的六个控制命令及状态字段（`src/devices/catalog.ts:862-875`），没有 diary HTTP 路径。

**涉及：** `src/lib/devices.ts`、`src/commands/devices.ts`、`src/commands/mcp.ts`、tool-profiles、capabilities、completion 和对应使用文档。依赖：无；与 A02 的 MCP 文件修改由同一集成人处理。

- [x] 在既有 devices 资源下提供 `devices diary <deviceId> --start <ms> --end <ms>` 及只读 MCP 对应操作，复用已有设备 ID/别名解析规则，不把日记混入 `/status` 或本地 `device_history`。
- [x] 本地验证整数毫秒时间、先后顺序和 31 天边界；显式 ID 编码。原样保留 `diary`、`diaryAI`、`comicDiaryAI` 与其中的字符串 detail。
- [x] 验收：31 天窗口可用，31 天加 1ms/反向区间/缺参在请求前失败；空日记正常返回；三种日记均可读取；只读 profile 可发现该能力。`comicKey/thumbnailKey` 是存储键，不编造下载 URL 或增加未文档化图片下载功能。
- [x] 新工具实际加入后同步工具目录、profile 计数、help、README、agent-guide；计数取实现，不预先硬编码预期总数。

### A04 · P1 · 修复 Standing Fan wire 类型解析

**证据：** [Standing Fan L5–45](https://github.com/OpenWonderLabs/SwitchBotAPI/blob/dc9a6b0e4ad77882c72d186ecd5d134113acdad0/devices/climate-control/standing-circulator-fan.md#L5-L45)；`src/devices/catalog.ts:579-591` 缺此别名，`canonicalizeDeviceType` 只匹配已声明名称。

**涉及：** catalog、设备解析和参数消费者；现有 catalog/设备命令测试。依赖：无。

- [x] 添加准确的 `Standing Fan` 映射；产品展示别名 `Standing Circulator Fan` 可保留，因为它不是过渡 API shim。
- [x] 验收：使用 API 返回类型可唯一查到风扇能力；`setWindSpeed 0` 不再因类型未知而绕过校验；1/100 通过，`closeDelay` 使用该机型的既有范围。

### A05 · P1 · AI Art Frame 上传参数从标量改为对象合约

**证据：** [AI Art Frame L31–37](https://github.com/OpenWonderLabs/SwitchBotAPI/blob/dc9a6b0e4ad77882c72d186ecd5d134113acdad0/devices/others/ai-art-frame.md#L31-L37) 给出 `imageUrl` 或 `imageBase64` 二选一 JSON 对象；本地 catalog 的 uploadImage 仍宣传单个 URL，validator 没有专用分支。

**涉及：** catalog、param-validator、单命令/MCP 参数编码、示例及 CHANGELOG。依赖：无；批量消费者由 C 类任务处理。

- [x] 改为对象参数、二选一且非空；请求发送 JSON object 而非二次编码的 JSON string。移除“上游参数形状待明确”的旧说明。
- [x] 验收：两种官方样例通过；标量 URL、缺字段、同时传两种来源、畸形 JSON 本地失败；真实上传不作为自动验收要求。
- [x] 文档只给 HTTPS/JPEG data URI 示例，未明确所有允许协议/MIME；不得仅凭示例擅自增加 JPEG-only 等服务端限制。非示例格式的支持范围列入上游确认。

### A06 · P1 · 按机型区分 Vacuum 参数

**证据：** [K20 Pro](https://github.com/OpenWonderLabs/SwitchBotAPI/blob/dc9a6b0e4ad77882c72d186ecd5d134113acdad0/devices/robot-vacuum/k20-pro.md#L31-L39)、[K11](https://github.com/OpenWonderLabs/SwitchBotAPI/blob/dc9a6b0e4ad77882c72d186ecd5d134113acdad0/devices/robot-vacuum/robot-vacuum-k11.md#L33-L41) 的 `changeParam` 支持 `waterLevel:1..2`，K10 Pro Combo 不支持。本地 `catalog.ts:547-559` 将它们合并，`param-validator.ts:1022-1025` 统一拒绝水位。

**涉及：** catalog、canonicalization、param-validator 和设备/schema 消费者。依赖：无；与 A09 的型号拆分由同一 catalog 集成人处理。

- [x] 为不同参数合约保留真实机型身份，优先使用现有 catalog entry 机制拆分；可复用相同命令片段，不引入通用模型注册框架。
- [x] 验收：K11/K20 的 changeParam 水位 1/2 通过、0/3 拒绝；K10 Combo 仍拒绝；三者的 startClean 不因这一修复被擅自放开 waterLevel；CLI/schema 不再导出错误的统一参数说明。

### A07 · P1 · 明确参数范围的对齐

**证据：** [IR Air Conditioner](https://github.com/OpenWonderLabs/SwitchBotAPI/blob/dc9a6b0e4ad77882c72d186ecd5d134113acdad0/devices/others/virtual-infrared-remote-devices.md#L23-L28) 支持 mode 0/1 为 auto；本地仅接受 1–5。[RGBICWW Ceiling Light](https://github.com/OpenWonderLabs/SwitchBotAPI/blob/dc9a6b0e4ad77882c72d186ecd5d134113acdad0/devices/lighting/rgbicww-ceiling-light.md#L38-L50) 与 [Kata 控制表](https://github.com/OpenWonderLabs/SwitchBotAPI/blob/dc9a6b0e4ad77882c72d186ecd5d134113acdad0/devices/others/kata-friends.md#L31-L40) 已在 catalog 中，但 validator 缺少其分支。

**涉及：** param-validator、catalog 参数说明、参数展开入口及对应测试。依赖：无。

- [x] 接受 AC raw mode 0，保留语义 builder 的 `auto → 1` 默认；-1/6 仍拒绝。
- [x] RGBICWW 主灯/彩灯亮度 1–100、色温 2700–6500、RGB 每分量 0–255；Kata mode 严格匹配 `Normal|Standby|Sleep`，开关严格匹配 `on|off`。
- [x] 验收：有效边界、越界、非整数及错误枚举在 CLI/MCP 一致处理，非法参数不会发出控制请求。复用现有严格数字/RGB helper，不新增无关抽象。

### A08 · P1 · Keypad 条件必填与异步结果说明

**证据：** [Keypad L41–79](https://github.com/OpenWonderLabs/SwitchBotAPI/blob/dc9a6b0e4ad77882c72d186ecd5d134113acdad0/devices/locks-security/keypad.md#L41-L79) 要求 timeLimit/disposable 两种 passcode 都有 10 位秒时间戳 start/end；`param-validator.ts:1050-1075` 未校验，`resources.ts:309-315` 还将 disposable 时间标为 optional。官方另明确最终结果由 webhook 异步返回。

**涉及：** param-validator、resources、Keypad 命令说明、现有参数测试。依赖：无；Webhook 结果发现与 A10 联动。

- [x] 对文档明确的 Keypad/Keypad Touch 合约补齐两项条件必填和秒/毫秒边界；修正 disposable 元数据。
- [x] 验收：缺任一时间、毫秒误传失败；合法秒值通过；请求被受理与 webhook `eventName/commandId/result` 的最终成功分开说明，不承诺 POST 成功等于密码已创建。
- [x] Lock Vision/Pro 文档只有对象模板，未完整定义 Keypad 的 enum/password/time 规则；本次不能不加区分地将新增限制施加给 Vision。其共用 validator 的准确性进入 A13 澄清清单。

### A09 · P1 · 修正状态发现元数据与不等价型号合并

**证据：** 本地 `src/devices/catalog.ts` 的 `statusFields` 经 deriveStatusQueries、schema、describe、agent-bootstrap 暴露给用户；真实 `devices status` 保留上游 body，并不会按该列表过滤。下表是文档差异，不把“文档未列”自动等同于“云端绝不返回”。

| 型号/区域 | 官方与当前差异 | 后续处理 |
| --- | --- | --- |
| Hub 3 / AI Hub | Hub 3 漏 moveDetected/onlineStatus；AI Hub 漏 onlineStatus | 补齐已文档化字段。 |
| AI Art Frame / S10、S20 / Roller Shade | 分别漏 battery/displayMode/imageUrl、waterBaseBattery、calibrate | 补齐；S10 与 S20 文档都包含 waterBaseBattery，可保持这部分共用字段。 |
| Garage Door Opener | doorStatus 被列成 switchStatus | 对齐官方字段，原始响应不重命名。 |
| Relay Switch 2PM | 将两路独立电压/功率/电流/用电量列成通用字段，缺 online/version/calibrate/position/isStuck | 按官方通道字段导出。 |
| MeterPro(CO2) / 普通 Meter | 合并后 CO2 能力消失 | 拆分真正不同的状态合约，不给普通 Meter 虚加 CO2。 |
| Plug Mini EU vs US/JP；Relay 1 vs 1PM | aliases 隐去了各自不同的状态 schema | 按真实 wire 型号区分；可以共享控制命令片段。 |
| Humidifier2 / Air Purifier variants | Humidifier2 漏 drying/version，额外 temperature；Purifier 漏 version，额外 filterElement | 新增确定字段；额外字段先区分观察证据与历史误填。 |
| Strip Light / Ceiling Light / RGBICWW Strip/Floor / RGBIC Neon Rope/Wire Rope / Candle Warmer Lamp | 多个型号漏 onlineStatus；Strip Light 多列 colorTemperature | 补齐确定漏项；额外字段按证据处理，不扩大到灯具命令合约。 |
| Motion Sensor / Lock Lite / Blind Tilt / Keypad / S1 | 文档分别未列 openState / doorState / battery / version / version | 明确“未文档化”与“实测支持”的来源，不能凭缺项删除实测能力。 |
| Presence Sensor | 文档写 `Detected`，当前写 `detected`；同页 webhook 示例还有 WoContact 疑点 | 保留原始响应，采集脱敏 fixture/上游确认 casing 后改发现声明。 |
| Hub Mini | 文档未提供 status，现有 observed fixture 明确有 version | 保留现有观察证据，不照文档机械删除。 |

来源：[设备能力总表](https://github.com/OpenWonderLabs/SwitchBotAPI/blob/dc9a6b0e4ad77882c72d186ecd5d134113acdad0/README.md#L1564-L1698)、[Relay 2PM](https://github.com/OpenWonderLabs/SwitchBotAPI/blob/dc9a6b0e4ad77882c72d186ecd5d134113acdad0/devices/plugs-switches/relay-switch-2pm.md#L17-L38)、[Presence](https://github.com/OpenWonderLabs/SwitchBotAPI/blob/dc9a6b0e4ad77882c72d186ecd5d134113acdad0/devices/sensors/presence-sensor.md#L17-L57) 及该提交对应型号的 Device Status 表。

**涉及：** catalog、STATUS_FIELD_DESCRIPTIONS、schema/describe/agent-bootstrap；现有 observed fixture `tests/fixtures/catalog-fidelity.observed.json`。依赖：与 A06 协调型号拆分；形状变更遵循 D 类版本说明任务。

- [x] 导出准确的型号能力与字段说明，避免将一个型号的字段简单并入全部 aliases。
- [x] 保留真实观察 fixture 的来源；不可将文档值覆盖进去后仍称 observed。删除仅锁定历史数组复制的断言，改用具体消费者查询和型号隔离场景。
- [x] 验收：CO2 型号可发现 CO2，普通 Meter 不宣称 CO2；车库显示 doorStatus；2PM 分路值不混淆；新增字段在各发现入口一致；实时 status 原始输出不受影响。

### A10 · P1 · Webhook 发现模型对齐真实 envelope

**证据：** [官方通用 envelope](https://github.com/OpenWonderLabs/SwitchBotAPI/blob/dc9a6b0e4ad77882c72d186ecd5d134113acdad0/README.md#L1517-L1561) 是 `{eventType:"changeReport",eventVersion,context}`。本地 `resources.ts:46-49,76-80,141-284` 将 WoMeter 等设备类型当 eventType，并扁平化 context；schema/capabilities 会导出该错误信息。

**涉及：** resources、schema/capabilities 及资源消费者/文档。依赖：D 类 schema 版本说明；与 A08 共用 Keypad metadata。

- [x] 分开外层 eventType 与 context.deviceType，按机型描述 context，支持嵌套对象，不把所有设备强制套入同一个 MAC/时间/primitive 字段列表。
- [x] 纠正 Bot 的 WoHand、MeterPlus 的 WoMeterPlus、EU 的 WoPlugEU、CO2 的 MeterPro(CO2)；修正 Keypad 的 eventName、Doorbell 的 press:boolean、灯具/部分 Plug 的 powerState、漏水的 detectionState；准确区分 Plug/Relay/Robot/Hub 变体。
- [x] 补齐官方 Webhook 支持表中缺失的设备描述，包括 MindClip 嵌套 chargeUploadCompleted/transcription 与 dailySummary/weeklySummary，以及 Kata 使用 context.deviceId 的样例；无文档支持的 Blind Tilt 不宣称 webhook 能力。
- [x] 验收：官方嵌套样例无需改写即可被发现 schema 正确描述；本地 receiver 仍能按 context 类型/ID 过滤且原样保留 payload；不改 MQTT classifier 来迎合 Webhook 文档。

### A11 · P2 · 修正资源端点与不实限制

**证据：** [官方 Scenes](https://github.com/OpenWonderLabs/SwitchBotAPI/blob/dc9a6b0e4ad77882c72d186ecd5d134113acdad0/README.md#L1216-L1332) 只有 list/execute。`resources.ts:101-106` 宣称未文档化的 `GET /scenes/{sceneId}`，但真实 `scenes describe` 正确地从 list 选取。`resources.ts:286-289` 的 2048/单 webhook 上限及 help 的 only-one 断言未在当前官方合约中得到支持。

**涉及：** resources、webhook help、schema/capabilities 文档及资源测试。依赖：D 类 schema 版本说明。

- [x] 不再把 list-derived describe 冒充云端独立 API；保留实际 CLI describe 功能。
- [x] 未公开的 URL 长度/账户数量限制不作为官方硬约束导出；更新 webhook optional config 的说明。`queryDetails` 文档表写 url、例子写 urls，当前采用 urls 的实际请求不要因表格笔误改坏。
- [x] 验收：机器发现只列两个已文档化 Scenes REST 操作；describe 仍通过 list 工作；Webhook 四个实际请求路径与 payload 保持正确。

### A12 · P1 · 使用 REST power 修复规则重复执行抑制

**证据：** `src/rules/engine.ts:1002-1025` 用 live status 的 `powerState === 'on'/'off'` 判断，而 [Bot](https://github.com/OpenWonderLabs/SwitchBotAPI/blob/dc9a6b0e4ad77882c72d186ecd5d134113acdad0/devices/others/bot.md#L17-L29)、[Color Bulb](https://github.com/OpenWonderLabs/SwitchBotAPI/blob/dc9a6b0e4ad77882c72d186ecd5d134113acdad0/devices/lighting/color-bulb.md#L17-L30) 的 REST 字段为 power，允许 ON/OFF。现有 engine 测试提供的是 powerState fixture。

**涉及：** rules/engine 及 `tests/rules/engine.test.ts`；policy 使用说明。依赖：无。

- [x] 从 REST 合约读取 power，按字符串大小写比较；不创建把 MQTT/Webhook/REST 混在一起的通用转换层。
- [x] 验收：已 ON 的 turnOn / 已 OFF 的 turnOff 被抑制，反向状态继续执行；未知字段/取状态失败仍按既有 best-effort 策略处理；fixture 使用真实 REST 字段。

### A13 · P2 · 关闭文档歧义，不凭缺项删除既有能力

**涉及：** MindClip lib/CLI/MCP/help、catalog、相关文档。按用户要求以官方文档确认合约，不使用真实账号；文档未定义的行为明确记为未知，不把离线 fixture 当服务端证据。

- [x] MindClip CLI/lib/MCP 现在要求官方明确的 device/pagination/completion/date/week 字段；省略时在 HTTP 前失败，不再把服务端默认值未知当作保留可选入口的依据。
- [x] 额外 language/time/folder/category 与 completedNum/category 含义记录为待上游定义；不凭缺项断言已移除。
- [x] Curtain scalar、Blind Tilt/Roller Shade on/off、风扇 toggle 保留既有路径，明确未文档化，不添加 deprecated shim。
- [x] Vacuum volume 矛盾、Lock Vision 模板边界、Presence 文档/贡献者响应差异、Art Frame 格式缺项均有 pinned 来源与结论；Keypad Vision/Pro 的明确规则独立实现。
- [x] 验收：每项有文档证据和支持边界；未知项不是已证明兼容，但也不要求用户提供真实账号来完成文档审查。

## C：当前代码的 Bug 与使用问题

本轮为全量当前实现审查，不是只看工作区 diff。以下结论区分源码路径证据与实际离线复现；未向 SwitchBot 云端发送请求。P0 表示应先于新增设备能力修复的物理操作安全问题。

### C01 · P0 · 修复 batch 审批绕过与预检缺失

**证据：** `src/commands/batch.ts:303-338` 只在没有 `--yes` 时填充 blockedForDestructive，导致后面的 `--yes && !allowsDirectDestructiveExecution()` 分支永远不可达。默认 profile 的 `batch unlock --yes` 已离线复现进入 POST。同文件 `389-399` 直接调用 executeCommand，没有单设备命令的参数预检；`setWindSpeed 0` 也进入 POST。反过来，`--dry-run --emit-plan` 在 `350` 行之前就被缺少 `--yes` 的检查拦截。

- [x] 独立计算 destructive targets，再分别判断执行环境与授权；安全预览不得要求执行授权。
- [x] 在任何 dispatch 前，对全部目标运行既有命令/参数校验与规范化；未知目标沿用单设备命令的安全策略，不把缺少类型当作安全。
- [x] 验收：默认 profile 的 destructive batch 加不加 `--yes` 都不能直接 POST；dev profile 保持现有明确授权入口；dry-run emit-plan 返回计划且零 POST；已知型号的无效参数不会部分执行其他目标。
- [x] 涉及 batch、devices 公用执行/校验消费者及既有 batch 测试。与 A01/C02 共用安全定义，由同一集成人合并，避免三套判定。

### C02 · P0 · CLI/MCP plan 不得以缓存缺失绕过安全

**证据：** `src/commands/plan.ts:50-60,326-352`、`src/commands/mcp.ts:2056-2074` 只用 getCachedDevice 推断危险等级；未缓存的类型使 isDestructiveCommand 返回 false。已复现空缓存下 `plan run` 的 unlock 无需 `--yes` 就进入 POST。另有 `plan.ts:55,326` 未传 require-unique，违反导出 schema 的名字解析承诺：缓存同时含 Lamp/Lamp 2 时，默认策略直接选 Lamp，而 require-unique 正确报歧义。

- [x] 在执行任何步骤前完成目标解析、类型确认、命令/参数验证及危险等级计算；无法确认目标时 fail closed，不能先执行前面的 mutation 再发现后面的错误。
- [x] CLI/MCP plan 采用一致的 require-unique 解析；保存/审批/执行之间固定具体目标，不能在执行时悄悄换设备。require-unique 仍可接受唯一候选，不等同于禁止所有模糊匹配。
- [x] 验收：冷缓存、部分缓存、未知 ID、歧义名字都不能绕过审批或误操作设备；默认 profile 的未审批执行被拒绝；已批准计划正常执行；安全用例使用 fixture HTTP，不操作真实门锁。
- [x] 涉及 CLI/MCP plan 与公用 resolver/validator；依赖 A01/C01 的一致安全语义。

### C03 · P1 · 修复 plan dry-run 的结果与持久化状态

**证据：** `src/commands/plan.ts:304-321` 在 dry-run 中仍等待 wait，并把 scene 的 DryRunSignal 当作 error；`735-741` 只检查 error/skipped，将零实际执行的批准计划标为 executed。scene dry-run exit 1、批准计划 dry-run 后 status=executed 均已复现。

- [x] scene、command、wait 的预览均明确表示未执行；wait 预览不实际 sleep。
- [x] dry-run 不消耗 approved 状态、不写 executedAt/failedAt；保留正常执行的成功/失败状态转换。
- [x] 验收：混合 plan dry-run 立即完成、零云端 POST、exit 0；随后真实执行仍可使用原批准记录；正常失败不能误标成功。同步 plan 输出类型、文档及状态转换回归。

### C04 · P2 · plan validate 与公开 schema 一致

**证据：** `src/commands/plan.ts:65-123` 宣布 additionalProperties=false，`130-200` 的手写校验却忽略未知键；带有效 command 和误拼 `commmand` 的步骤已复现被接受。

- [x] 复用现有 JSON Schema 校验方式，或补齐根对象及每种步骤的未知属性拒绝；不建立第二套不一致 schema。
- [x] 验收：未知键、步骤类型不符、目标冲突、参数边界返回字段路径和 usage exit 2，且执行前没有 mutation；有效的现有 plan 保持可用。

### C05 · P1 · 幂等键必须绑定实际目标与请求形状

**证据：** `src/lib/devices.ts:246-250` 只签入 command/parameter，未含 deviceId/commandType。同 profile、同 key 连续操作 BOT-A 与 BOT-B 时，第二次返回 replayed=true，实际只有 BOT-A 的 POST。

- [x] 把 deviceId、commandType、实际 wire parameter 纳入请求形状；明确复用同 key 但变更目标的冲突行为，优先拒绝而非静默复用其他设备结果。
- [x] 验收：同目标同形状只执行一次；换设备/命令类型/参数按冲突合约处理；profile 间仍隔离；并发同 key 不重复发送；CLI/MCP/batch 消费者得到一致结果与 audit。
- [x] 涉及 devices lib、idempotency cache 和既有行为测试；不要只修 MCP 返回的 deviceId 标签。

### C06 · P1 · HTTP profile 路径与事件数据隔离

**证据：** `src/commands/mcp.ts:2816-2824` 接受 header/query 原值；`src/config.ts:46-58` 用 path.join 拼 profile。已复现 `../config` 与默认配置解析到同一路径。HTTP server 在 `mcp.ts:2728-2739` 只创建一个启动账号的 EventSubscriptionManager；`src/mcp/device-history.ts:45-48` 使用全局 history 目录，未按请求 profile 隔离。

这不是“匿名互联网可任意读文件”的结论：HTTP 已有 bind/auth 门禁；风险前提是能访问该服务并选择 profile，且对应数据存在。文件路径探针没有读取真实凭据。

- [x] 对 header/query/CLI 共用合法 profile 名约束，在文件访问与 rate-limit key 使用之前拒绝路径分隔符及 traversal；配置路径解析再做目录边界防御。
- [x] MQTT events、account_overview.mqtt 与 device_history 的读写均绑定实际 profile；采用按 profile 的实例/存储，或在尚不支持时明确拒绝非启动 profile 的事件资源，不能返回另一个账号的数据。
- [x] 为默认历史数据制定明确迁移归属；不能自动复制到所有 profile。
- [x] 验收：header/query traversal 均拒绝；并发 A/B fixture 请求不能互读事件、历史或串用连接状态；默认单账号路径继续工作。

### C07 · P1 · 长运行 MCP 的凭据更新可生效

**证据：** `src/credentials/prime.ts:69-72` 的 getPrimedCredentials 不检查时间；HTTP 只为显式 profile 再 prime，默认 HTTP/stdio 沿用启动时缓存。源码路径证明缓存刷新承诺未覆盖这些入口；本轮未轮换真实 keychain。

- [x] 在长运行工具请求的异步入口刷新过期的活动 profile 凭据，不能靠同步 loadConfig 静默永久复用旧 token。
- [x] 验收：默认 stdio、默认 HTTP、命名 HTTP profile 的 fixture keychain 轮换都能在约定刷新窗口后生效；env 与 `--config` 的既有优先级不变；并发刷新不串 profile、不泄露凭据。

### C08 · P2 · Shell completion 可发现性与 JSON 契约

**证据：** `src/commands/completion.ts:3-29` 的候选漏 reset/codex/claude-code/gemini/mindclip；`601-613` 无条件输出 shell 源码，已复现 `--json completion bash` exit 0 却以 `# switchbot bash completion` 开头。

- [x] 从既有 canonical command registry 产生顶层候选，避免维护第二份清单。
- [x] completion 是脚本生成器：保留默认 raw 输出，对 JSON mode 返回结构化 usage error 并提示去掉该标志；帮助文档说明例外。
- [x] 验收：在 Bash/Zsh/Fish/PowerShell 对实际注册命令进行补全交互 smoke；新增 MindClip 子命令可发现；JSON 请求不再成功返回非 JSON。

## P：插件适用性与安装、升级任务

### 当前适用性矩阵

下表是仓库声明加第一方文档核对，不等于所有宿主版本均已实测。所有 stdio/Skills-only 路径都要求执行环境能运行本地 CLI、访问相应凭据，并在实际调用时访问 SwitchBot Cloud API；不是离线直连设备方案。

| 分发路径 | 当前用途与适用条件 | 主要限制 / 对应任务 |
| --- | --- | --- |
| `packages/codex-plugin`，0.1.6 | Codex marketplace 插件，MCP-backed；有 npm/local Route A 与 Git Route B | `.codex-plugin/plugin.json` 仍受官方兼容支持，无须仅因新 portable 格式出现就强制迁移；清理所有权、真实宿主 gate 待修，见 P01/P08。 |
| `packages/switchbot-cli`，0.1.0，工作区 WIP | Codex Skills-only；模型调用 shell 中的 CLI，不注册 MCP server | 不等同于旧 MCP 插件已迁移/已上架；需要 shell 执行能力，不能推定 Web-only 环境可用；错误处理指导见 P02，适用性见 P09。 |
| `packages/claude-code-plugin`，0.1.4 | Claude Code marketplace/plugin-dir 载入 skill + stdio MCP | npm 全局安装或单独 mcp add 不会自动载入 skill；onInstall 文件不符合 hook 合约；本机 manifest validator 通过不证明 hook/skill 真正运行，见 P03/P04。 |
| `packages/gemini-extension`，0.1.1 | Gemini CLI 原生 extension，根目录 gemini-extension.json；本地 link/install 或支持的仓库源 | npm spec 不能直接作为 extensions install 源；doctor 未识别 extension 提供的 MCP；面向当前仍受支持的账号/客户端，见 P03/P05/P09。 |
| `packages/openclaw-skill`，0.1.2 | CLI bootstrap + `.mcp.json`；OpenClaw 可将 manifestless Claude 布局识别为 bundle | bundle 不等于 native in-process plugin；`${pluginDir}` 不是该格式已核实的路径变量；不能宣称已获 native channel 全能力。bootstrap/编辑器/路径见 P06/P07/P09。 |
| CLI 生成的 Cursor/Copilot/Claude/Gemini MCP-only recipe | 仅在目标宿主确实支持该 MCP 传输/配置作用域时可用 | recipe 生成成功不证明宿主载入，也不包含各插件的 skill/hook/commands；文档必须单列，不能用插件安装命令互换。 |

第一方来源：[Codex plugin format](https://developers.openai.com/plugins/build/plugins)、[Claude marketplace](https://code.claude.com/docs/en/plugin-marketplaces)、[Claude hooks](https://code.claude.com/docs/en/hooks)、[Gemini extension reference](https://geminicli.com/docs/extensions/reference/)、[OpenClaw bundles](https://docs.openclaw.ai/plugins/bundles)。OpenClaw 文档明确区分 bundle/native，并明确 Claude JSON hooks 只检测、不执行。

### P01 · P1 · Codex 安装清理必须验证归属

**证据：** `src/install/codex-checks.ts:363-368` 无条件删除 legacy plugin IDs 和 `switchbot/codex-plugin/switchbot-skill` marketplace。拦截 child_process 的离线探针确认删除之前没有查询来源；同名但不同来源的 marketplace 有被误删风险。

- [x] Route A/B 的迁移清理先读取现有注册项，匹配已知 SwitchBot source/ID/路径后才删除；名称碰撞应保留并报明确冲突，不默默覆盖。
- [x] 验收：无旧配置、已确认旧版本、第三方同名 marketplace、注册失败四类 fixture 均保持不属于本项目的配置；失败不能丢失原可用安装。不得用用户真实 Codex 配置做破坏性验证。

### P02 · P1 · 修正 Skills-only 的错误分流指导

**归属：** P02 的完整包及其已完成修复保留在独立 Skills-only WIP 工作区，不纳入本修复 PR；以下记录保留此前的实现与验证证据。

**证据：** WIP `packages/switchbot-cli/skills/switchbot-cli/SKILL.md:101-108` 按 error.kind=auth/quota/network/upstream/internal 分流；实际 `src/utils/output.ts:225-360` 只有 usage/api/runtime/guard，通过 subKind/errorClass 等补充。运行探针中 401/429 均为 kind=api，subKind 分别 auth-failed/quota-exceeded。

- [x] Skill 按真实 kind/subKind/errorClass/retryable/retryAfterMs 指导恢复；不得因看到 network 就盲目重试可能已完成的 mutation。
- [x] 验收：用真实结构化错误样本走通 usage、认证、限流、网络、guard 场景；不请求用户在聊天中粘贴 token/secret；destructive 不通过换入口绕过。
- [x] 保留已有正确行为：Skill 已明确要求自定义 audit.log_path 时传 `--audit-log-path`；`doctor --section credentials` 也是有效命令，二者不是本轮 Bug。

### P03 · P1 · 插件指令、默认工具 profile 与最低版本一致

**证据：** Gemini `GEMINI.md:78-89` 与 Claude skill 要求调用 policy_validate，但声明的 `switchbot mcp serve` 默认 profile 不暴露该 admin tool。包 peer 下限仍为 CLI >=3.7.1，而 skill 已引用 3.8.1 增加的 MindClip 工具。

- [x] 默认维持最小工具集合，移除“必须先调用不存在工具”的无条件指令；需要 admin 的工作流明确 opt-in，不为修文案默认扩大到 `--tools all`。
- [x] 按真正使用的 CLI/MCP 能力统一 peer range、bootstrap 检查、README 和安装提示的最低版本；新 A02/A03 能力落地后再次检查。
- [x] 验收：在声明最低 CLI 与当前 CLI 上执行插件的首次读取/控制流程，所有必需工具存在；未开放 admin 时有明确可执行路径，不幻觉调用缺失工具。

### P04 · P2 · Claude 安装路径与 hook 合约

**证据：** `packages/claude-code-plugin/README.md:5-17` 的 npm install + mcp add 不注册插件 skill；`plugins/switchbot/.claude-plugin/hooks.json:1-6` 使用 onInstall，而官方是 `{hooks:{事件:[...]}}`，默认位置为 hooks/hooks.json。本机 `claude plugin validate` 对 manifest 返回成功，未验证上述生命周期被执行。

- [x] 文档分别给出完整 plugin 的 marketplace/plugin-dir 路径与 MCP-only 路径；完整安装须让宿主实际发现 skill。
- [x] 采用支持的显式 setup 或幂等生命周期 hook，或删除“安装自动认证”承诺；推荐显式 setup，避免会话启动时未经用户授权安装 CLI/打开认证流程。
- [x] 验收：隔离宿主中安装、启动、升级、卸载后 skill/MCP 状态符合各自路径；未安装 CLI/未授权时有可操作提示，MCP stdout 不混入 setup 文本。

### P05 · P2 · Gemini 安装源、doctor 与凭据说明

**证据：** `src/commands/gemini.ts:101-105` 输出 `gemini extensions install @switchbot/gemini-extension`，而官方只支持仓库 URL/本地路径。`src/install/gemini-checks.ts:47-74` 只看 settings.json，忽略 extension 的 server；同名用户配置在 Gemini 中会覆盖 extension server。manifest 的设置提示还把 auth login 凭据一律说成 config.json，忽略 OS keychain。

- [x] 改用支持的本地安装目录或有效仓库源；不要捏造 monorepo 子目录 flag。
- [x] doctor/setup 区分 extension 与 MCP-only 安装，不给有效 extension 误报缺失并添加覆盖项。
- [x] 凭据指导按 env/keychain/file 优先级描述，优先复用 auth login，不要求从并不存在的配置文件复制秘密。
- [x] 验收：仅 extension、仅 MCP-only、二者冲突、无凭据四种状态给出正确诊断；升级/重启后加载实际期望配置。空 env 映射本身不视为阻止 keychain fallback。

### P06 · P1 · OpenClaw bootstrap 按真实 CLI 合约工作

**证据：** `packages/openclaw-skill/bin/start.js:48-67` 会往 MCP stdout 输出非 JSON-RPC setupRequired，默认路径没执行 setup 子命令的版本下限检查；Windows 的 execFile/execFileSync 不能直接执行 npm `.cmd` shim。`setup/check-credentials.js:7-44` 读取不存在的 data.credentials.configured，把全量 doctor 失败都当 token 问题，并把 keychain describe 成功误作凭据存在；`setup/check-daemon.js:32-35` 把 `{data:{rules:[...]}}` 当数组，阻止自动启动。

凭据发现需准确表述：真实 doctor 缺少凭据会 exit 1，因此不宣称本轮已证实“所有未认证安装都会通过”。已复现的是 credentials=ok、policy=fail 的报告被误判成需 logout/login。

- [x] 默认启动与显式 setup 共用最低版本检查；凭据检查使用 credentials section 的真实 checks 结构，区分其他健康检查失败，不以 describe backend 判断已登录。
- [x] 读取 data.rules，并检查 automation/rule 的启用状态；不能只因有一条禁用规则就启动 daemon。
- [x] 保持 stdout 仅 MCP JSON-RPC，setup/daemon 提示走 stderr；跨平台统一执行 npm shim，参照 [Node Windows 文档](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows)，不要用未转义 shell 拼接引入注入。
- [x] 文档/离线验收：缺 CLI、旧版本、无凭据、无关 doctor 失败、禁用/启用规则均有正确行为；Linux 精确归档的 local/global 安装完成 MCP initialize/listTools 与本地只读调用。Windows npm entry 路径有 Linux 模拟证据，原生 Windows/macOS 由 CI matrix 承接但未声称已运行。按用户要求不使用真实账号。

### P07 · P1 · OpenClaw policy editor 不得假保存或丢安全配置

**证据：** `packages/openclaw-skill/policy-editor/editor.js:54-59` 只能替换已有 aliases 块；`72-77` 只向空 always_confirm 添加 lock/unlock，对已有其他命令的列表不生效。`server.js:17-20` 在文件不存在时返回空文本，保存流程未阻止写入无 version 的无效 policy。本项为源码审查，未做浏览器实测。

- [x] 用现有 YAML/政策结构正确插入缺失段，合并确认列表且不删已有值；避免靠只匹配空数组的 regex 改安全设置。
- [x] 缺文件先产生合法政策模板；保存前校验 schema，失败不得覆盖原有效文件。
- [x] 验收：浏览器对版本-only、非空 confirmation 列表、新建文件执行 add/edit/save/reload，新增 alias 和锁确认持久存在，其他配置不丢；非法文档明确报错且原文件不变。

### P08 · P1 · 修复发布 smoke gate 与实际发布通道脱节

**证据：** `.github/workflows/publish.yml:160-178` 默认发布到 latest，而 `npm-published-smoke.yml:108-121` 等待 next；版本已存在时反而 skip。另 `scripts/smoke-codex-route-b-live.mjs:44-48` 缺宿主 exit 0；已在隔离 PATH 下观察到 skipped (optional)，不是宿主成功。当前 CI Node 18/20/22 只覆盖 Ubuntu，不等于 Windows/macOS 插件兼容证明。

- [x] 统一发布协议：优先先发布 next，验证该确切版本后 promote latest；明确未重新发布的包与刚发布包，不能凭版本存在就跳过后者。
- [x] 本地可选 smoke 与发布 required-host gate 分开；发布缺宿主/缺工具加载证据必须失败或显式阻断 promotion。
- [x] 按实际发布包扩充 smoke 覆盖，包含 Claude/Gemini；WIP Skills-only 尚未选择发布前，不把缺 publish workflow 判成现有生产 Bug。
- [x] 文档/本地验收：新版本/已发布版本/缺宿主/失败只读调用/候选错配均有回归；精确本地 tarball 隔离安装、加载、只读调用与卸载已观察。发布流程不依赖真实 SwitchBot 账号，也不为本轮验收实际 publish/promote。

### P09 · P2 · 发布可追溯的宿主适用范围

- [x] 记录实际验证的宿主版本、OS、CLI 下限、加载格式、传输、凭据来源、安装/升级/卸载命令；Node engine 声明、包静态结构检查与宿主运行证据分列。
- [x] OpenClaw 先验证 bundle 识别与 `${pluginDir}` 的实际展开；若不支持，采用该宿主文档允许的相对路径/变量，不能仅补一个 native manifest 就宣称集成完成。
- [x] Codex Desktop/CLI/其他 surface 分开记录 Skills-only shell 能力；不把可下载插件等同于可执行本地 CLI。
- [x] Gemini 适用用户必须更新：[Google 2026-05-19 公告](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/) 明确个人免费/Google AI Pro、Ultra 在 2026-06-18 转向 Antigravity CLI；Standard/Enterprise 及付费 API key 路径仍可用。保留受支持的 Gemini 路径，单独评估 Antigravity plugin 迁移，不承诺现有 gemini-extension 自动兼容。
- [x] 验收：每个宣称支持的格子都有版本化宿主的真实安装/加载证据；未测项明确标注。不得无证据把整个宿主或所有旧格式标为“不支持”。

## D：用户文档与合约一致性

### D01 · P1 · 明确版本边界后再改变机器可读形状

**证据：** `docs/schema-versioning.md:7-11,25` 将 payload 变化纳入 schemaVersion；`docs/json-contract.md:28-30,189-194` 又称只跟踪 envelope。后者 `91-124` 的事件示例宣称平铺 schemaVersion=1，而 events 实现输出 schemaVersion=1.2，内部 data.payloadVersion=1。runtime 原始数据、catalog 发现 schema 与 envelope 不是同一合约。

- [x] 明确 SCHEMA_VERSION、catalog/schema export 版本、event payloadVersion 的职责和 breaking/additive 判据，统一两份文档和实际例子。
- [x] A09/A10/A11 的字段改名/形状变更先据此做版本决策并迁移所有消费者；新增 A02/A03 endpoint 不自动等于 envelope breaking。
- [x] 验收：从真实 CLI 导出的单次输出、stream header、event 行均可按文档示例解析；版本规则无互相冲突表述；不能把旧实现形状测试改值后假称兼容。

### D02 · P2 · 修正首次使用、policy 与故障恢复说明

**证据：** WIP `README.md:212-215` 推荐的 `install --agent openclaw` 已复现 usage exit 2；当前可选值无 openclaw。`src/policy/load.ts:6-18` 实际默认路径为 `~/.config/openclaw/switchbot/policy.yaml`，环境变量 SWITCHBOT_POLICY_PATH，与 policy-reference 和 example 的另两种路径不一致。audit.log_path 的原生 CLI 自动应用承诺也需与实际显式 `--audit-log-path` 行为区分。

- [x] 优先把 README OpenClaw 指令改为已支持的安装路径，不为修文案凭空增加新 installer target；保留并协调工作区 WIP 的 Skills-only 定位。
- [x] policy 路径、环境变量、版本支持、audit flag/自定义路径说明均与 loader/flags 对齐；明确哪些是 agent 必须传递的值，不把 Skill 已正确传 flag 的行为报成 Bug。
- [x] 更新 SwitchBot App 获取 token 的当前 About/第三方服务入口说明；校正 401/429 文案，不把所有限流都断言为每日额度耗尽或只能等 UTC 零点；保留现有重试机制，不扩展重试策略。
- [x] 验收：临时 HOME 下逐条执行文档的离线 setup/policy/diagnostic 命令；缺凭据恢复不要求聊天泄密，不引导用户删除有效配置。

### D03 · P2 · 对外能力宣称与真实交付同步

- [x] A02/A03 未交付前，修正无条件 “Full API v1.1 coverage” 等绝对声明；用实际 endpoint/型号能力表说明边界。
- [x] 功能落地时同步 README、agent-guide、相关插件 skill/context、CLI help/completion 和 CHANGELOG；MCP 工具数量按实际注册与 profile 计算，不手写猜测。
- [x] 已按实际结果同步 CLI/plugin 版本、CLI 测试数量、MCP 工具数、doctor checks、audit version；未创建 tag/release，不将未执行的发布前云端/跨平台验证算作通过。

## 执行顺序与并行边界

| 波次 | 可并行的任务包 | 依赖 / 集成边界 |
| --- | --- | --- |
| 1：安全优先 | A01+C01+C02；C05；C06 | 安全入口包由一个集成人负责 CLI/MCP/batch/plan，防止各自修一半；幂等和 profile 可独立推进，涉及同一文件时提交给集成人合并。 |
| 2：稳定性与合约 | C03+C04；C07；A12；D01 | D01 的版本结论必须先于 A09/A10/A11 的破坏性发现模型变更。 |
| 3：明确 API 差异 | A02；A03；A04–A08；A09–A11 | MindClip 与 Kata 分别实现，mcp.ts/注册表统一集成；catalog 型号/validator 拆分由同一人维护。A13 外部澄清独立，不阻塞明确能力。 |
| 4：插件恢复 | P01+P02；P03+P04；P05；P06+P07 | 新工具/API 落地后再最终确定 P03 的最低版本。四种宿主可并行验证，各自隔离 HOME/配置。 |
| 5：用户与发布验收 | C08；D02+D03；P08+P09 | 所有支持声明、版本范围和发布 gate 以实际运行证据收口；不以 schema validate 或 mock pass 代替宿主加载。 |

33 项实现与文档/离线验收已落地：本修复分支承载 32 项，P02 Skills-only 指导随 WIP 隔离并保留，不丢弃或声称在当前 PR 发布。真实账号与实际发布不作为本轮阻塞；服务端未知行为、原生 Windows/macOS CI、云端认证与模型回合仍保持证据边界。

## 首次审查的 RED 基线

运行环境：Linux/WSL2 x64、Node v24.18.0。下表是实施前观察：临时 HOME/XDG、虚构凭据、Axios HTTP fixture，禁止真实云端 mutation。最初 plugin 注册探针只截获 child_process；实施后真实隔离宿主验证另列在后文。

| 已运行场景 | 观察结果 | 对应 |
| --- | --- | --- |
| MindClip help/transcript、devices diary | 七个既有 MindClip 子命令；transcript 与 diary 均 unknown command / exit 2 | A02/A03 |
| built-in catalog、MCP tools、schema export | catalog 64 项；缺新读取入口；导出 Garage Door 状态和资源元数据差异 | A04/A09–A11 |
| deadbolt 安全判定 + rules guard | Smart Lock/Lite/Ultra 为 false；Pro Wifi 为 true；rules guard 为 false | A01 |
| 默认 profile batch unlock --yes | exit 0，截获一条 unlock POST | C01 |
| batch dry-run emit-plan 不加 --yes | exit 2 guard，零 POST | C01 |
| batch setWindSpeed 0 | exit 0，截获无效参数 POST | C01 |
| 空缓存 plan run unlock 不加 --yes | exit 0，截获一条 unlock POST | C02 |
| Lamp/Lamp 2 名字解析、plan 未知键 | 默认策略选 LAMP1，require-unique 报歧义；commmand 额外字段被接受 | C02/C04 |
| scene plan dry-run | 零 POST，但 exit 1，step.status=error | C03 |
| approved plan execute --dry-run | 零 POST，dryRun=1，却落盘 status=executed | C03 |
| BOT-A/B 同幂等 key | 只有 A 的 POST，B 返回 replayed=true | C05 |
| profile ../config | 解析到默认 config.json；未读取真实凭据 | C06 |
| REST power=ON 的规则抑制 | 仍触发 status=dry，不是 already-desired/throttled | A12 |
| Codex 注册 child_process 捕获 | 查询来源前已发出三个 marketplace remove | P01 |
| 401/429 ErrorPayload | kind 均 api，subKind 分别 auth-failed/quota-exceeded | P02 |
| OpenClaw credentials=ok/policy=fail fixture | 返回需 logout/login 的 token 过期提示 | P06 |
| install --agent openclaw --dry-run | exit 2，列出的合法 agent 不含 openclaw | D02 |
| completion bash --json | exit 0，却返回 raw shell 脚本 | C08 |
| Codex live smoke，刻意清空 PATH | exit 0，明确输出 skipped (optional) | P08 |
| 本机 claude plugin validate，隔离配置 | manifest validation passed；不能证明 hook 执行或 skill 已载入 | P04 |

## 首轮实施后的验收证据

| 验证 | 观察结果 |
| --- | --- |
| CLI 全量回归 | 166 文件、3081 passed、0 failed；global setup 完成完整五阶段 build/typecheck |
| 全部插件 workspace | 173 passed、0 failed、0 skipped；含 Skills-only 8 项及 OpenClaw 精确归档行为回归 |
| release 边界回归 | 新版本/已发布候选/缺宿主/失败 smoke、错误 bundle 状态与格式均覆盖；7 项针对性回归通过 |
| 实际 CLI pack/install | CLI 3.9.0、policy new/validate、MCP policy_new 均通过 |
| 安全与 API 实际入口 | deadbolt/rules 阻断、全目标预检、冻结审批、幂等目标冲突、混合 plan 无等待预览；transcript/diary/机型参数经真实入口与外部 HTTP fixture 验证 |
| 长运行和隔离 | 真实配置文件轮换后 SDK 请求头刷新；跨 profile history/MQTT owner 边界拒绝；未用此替代原生 keychain 验证 |
| events/watch | 实际 localhost webhook、stdout 物理逐行解析；stream header 与单行 1.2 envelope 保持各自契约 |
| policy editor | Chromium 实际 add/edit/save/reload；缺文件生成合法模板、保留安全配置/注释；非法输入不覆盖有效文件且不终止服务 |
| 补全 | Bash、Zsh 原生 Tab、Fish 3.7.0、Linux PowerShell 7.6.6 的 transcript/diary 均返回实际候选 |
| OpenClaw 精确 tarball | 2026.10.2 实际 install/inspect/reinstall/uninstall；修复缺 YAML 后 loaded；实际宿主 loader 展开 argv，MCP initialize/listTools 18 项并执行本地只读 device_history |
| 其他精确归档宿主 | 从本地 npm tarball 安装 CLI 3.9.0 并提取各插件 0.2.0：Codex 0.162.1、Claude 2.1.238、Gemini 0.44.1 required gate 均 passed；各有独立 CLI MCP catalog 18 项；安装后实际 device_history 只读工具返回隔离空历史 |
| 首轮旧账号 gate（历史） | 当时缺账号会拒绝；用户随后改为文档/离线验收，该账号依赖已删除，不再作为当前发布或交付前提 |

额外 TDD 闭环：精确 OpenClaw 归档缺 `yaml` 的编辑器与宿主加载失败先 RED；按锁定依赖预打包并保留依赖许可证后 GREEN。发布 gate 不再将 `status: error`/错误格式当加载成功，也不把本地/archive 的 update skip 当升级成功。

**证据限制，不是账号阻塞：** A13 未定义的服务端行为仍为未知；原生 Windows/macOS matrix 未在此执行，原生 vault 轮换、宿主模型回合、Desktop/Web/mobile Shell、Antigravity 均未声明已通过。按用户要求不索取/使用真实账号，也不为本轮实际发布候选。见 [宿主边界](./host-compatibility.md) 与 [上游歧义](./openapi-alignment-ambiguities.md)。

Markdown：使用现有 `.gitignore` 排除依赖和本地文件，修复报告中的表格分隔线与代码 fence；全仓 `npm run lint:md` 已通过，没有关闭规则。

没有提交、推送、npm publication、dist-tag mutation 或真实设备控制。所有本地证据与外部阻塞均保留，不把 mock 当云端/真机兼容证明。

## 继续验收与并行执行评估

上游 HEAD 再核对仍为 `dc9a6b0e4ad77882c72d186ecd5d134113acdad0`。新增的已明确 Keypad Vision/Pro 文档要求进入校验；Lock Vision 的泛化对象模板不继承 Keypad 密码长度、类型或时间窗限制。Presence casing 的贡献者实测与未合并 PR 分开标记；MindClip 未定义默认值不再作为帮助说明里的服务端保证。剩余 A13 边界见专门歧义文档。

| 新发现问题 | RED | 修复与已观察 GREEN |
| --- | --- | --- |
| OpenClaw setup 缺 CLI 自动全局安装并污染 RPC stdout | 外部 npm fixture 被调用，stdout 出现安装进度 | 不再安装；缺 CLI 明确 stderr 退出；bootstrap 3 项回归通过 |
| daemon 人类输出进入 MCP stdout | 启用规则时 stdout 出现 daemon diagnostics | 输出转 stderr；启用/禁用与启动副作用 5 项联合回归通过 |
| Windows 全局 CLI 不在 bundle 的 module ancestry | 隔离 bundle 中 MODULE_NOT_FOUND | PATH 定位 npm JavaScript entry；真实 CLI 返回 3.9.0，含带空格前缀与自定义 gate shim；仅 Linux 模拟 Windows 选择 |
| 发布门禁只看 catalog 或接受其他版本候选 | 只读工具报错仍退出成功；错配候选仍创建 gates | 必须执行 device_history 并验证 devices 结果；版本绑定 publication outcomes；5 文件 11 项边界回归通过 |
| Keypad Vision 漏校验、Lock Vision 被过度校验 | 无时间窗 Vision 被接受；泛化 Lock Vision 对象被拒绝 | 模型隔离后的真实公共验证入口与 141 项参数回归通过 |
| 首日示例采用移除的 v0.1，automation 含无效 command action | cautious validate 返回 unsupported v0.1；automation v0.2 后仍不合法 | 五个示例均经实际 CLI validate 返回 valid；automation 保留 dry-run 的合法文件通知预览 |

并行切片：上游 primary-source 研究、发布 gate、原生 bootstrap 相互独立；研究 Scout 和发布专用 Agent 已交付。两个通用实现 Agent 均立即返回 `No model selected`；原生修复由主线程完成，未改变模型配置。没有串行基线，不声称倍率提升。

执行约束：共享 `dist/` 的 build/pack/runtime smoke 必须按阶段串行；一次探针与 build clean 重叠时观察到临时 MODULE_NOT_FOUND，构建后重新执行通过。无构建的 workspace 回归与文档 lint 可以独立并行。新增 Ubuntu/Windows/macOS bootstrap CI matrix 是验收入口，不是已运行的原生 Windows/macOS 证据。

### 用户确认的无真实账号验收

[OpenClaw 官方 bundle 文档](https://docs.openclaw.ai/plugins/bundles) 明确支持 Claude manifest 与 `.mcp.json` stdio MCP，JSON hooks 仅识别不执行，兼容 bundle 必须自带运行依赖，启动不自动 npm install。[SwitchBot 官方 Authentication](https://github.com/OpenWonderLabs/SwitchBotAPI/blob/dc9a6b0e4ad77882c72d186ecd5d134113acdad0/README.md#authentication) 定义的是访问云端私有数据的 token/signature 要求，不是本地 MCP 协议验收。

因此删除 workflow 的真实账号检查与云端 list/doctor gate，删除 promotion 的 obsolete live gate；宿主 smoke 固定使用隔离假凭据，不再支持用户 secret 转发。实际生产 CLI 的凭据发现与云端签名规则不变。新增本地启动/用户凭据不泄漏回归已观察 RED→GREEN。

### 分离前最新整体验证

| 验证 | 观察结果 |
| --- | --- |
| CLI 全量回归与五阶段 build | 168 文件、3080 passed、0 failed；typecheck、bundle、assets、binary 全部成功 |
| 插件 workspace | 175 passed、0 failed、0 skipped；Claude 22、Codex 45、Gemini 79、OpenClaw 21、Skills-only 8 |
| 原生 Linux OpenClaw bootstrap | 精确 CLI/plugin 归档，带空格路径、local `.bin` 与隔离 global prefix 两路均 initialize/listTools 18 项，并执行本地只读历史；自动清理 |
| 当前无账号宿主 smoke | Codex 0.162.1、Claude 2.1.238、Gemini 0.44.1 均完成隔离 lifecycle、18 项 catalog、device_history raw 返回 devices 形状及卸载 |
| OpenClaw 文档与本地边界 | 官方声明 Claude bundle/stdio 支持；实际 CLI 的假凭据只读调用与用户 secret 不转发回归通过；不重新安装宿主或调用云端来代替文档审查 |
| 真实 CLI 示例与 discovery | 五份 policy validate 均 valid；MindClip help 不承诺未定义默认值；Vision/Pro/Lock Vision passcode 操作均保持 destructive 分类 |
| 帮助文本可复制性 | 旧 doctor/device-list jq 示例实际 exit 5；从最终二进制 help 复制修正 filter，返回 LOCK1/FAN1 或合法分组；doctor 仅跑离线 catalog，overall=ok、70 types loaded。Quickstart 原有 `.data.overall` 字段正确，保留不改 |

### 独立分支验收

- 当前修复分支从 `origin/main` 的 `45f9a95` 创建，不继承 Skills-only 讨论提交；原分支及 WIP 留在独立 worktree。
- 172 个实现文件/删除项与分离前快照一致；37 个移动的 WIP 文件逐一 blob 校验一致。README 恢复出原始 WIP 段落，两个 lockfile 按各自 workspace 重建；完整快照 `1c48b90f0f3d46baf25816bfad5c1c6f10d4db82` 保留在 stash。
- 修复分支全量 168 文件、3080 tests 通过；四个既有插件 workspace 167 tests 通过。独立 WIP 的 Skills-only 8 tests 通过；它保留 CLI ≥3.9.0 的运行下限，不视为随当前 PR 发布。
- `npm ci --dry-run --offline --ignore-scripts`、五阶段 build、全仓 Markdown 与 release invariants 通过。精确归档的 Linux local/global 两路 bootstrap smoke 均列出 18 工具并成功调用本地只读 history，使用假凭据且清理隔离状态。
- 未提交、推送、发布或操作真实设备；本分支只保留本轮 API、安全、既有插件与发布门禁改动。

## 开放 issue 与官方文档再次复查

复查对象为当前仓库全部 3 个开放 issue，以及官方 [SwitchBotAPI `dc9a6b0`](https://github.com/OpenWonderLabs/SwitchBotAPI/tree/dc9a6b0e4ad77882c72d186ecd5d134113acdad0) 的 README 和全部 84 份设备文档。五个只读 Agent 并行覆盖发布/安装问题和设备分组；主线程统一实现、TDD 与验收，没有并发修改共享文件或重叠 build/pack。

| 范围 | 已完成核对与处理 |
| --- | --- |
| 22 份 climate/vacuum 文档 | 命令、别名、wire shape 与模型参数已支持；补齐缺失 Webhook 变体和 S10 字段 |
| 28 份 lock/light/curtain 文档 | 修复钥匙/夜锁自动化拦截、型号回调映射、Keypad Vision 资源支持、Floor Lamp online 和 Blind Tilt 空格参数 |
| 30 份 sensor/camera/hub/power/其他文档 | 修正 Relay 2PM 与 Doorbell REST 字段、Contact Sensor REST/Webhook 混用，补齐已明确的回调 |
| MindClip、Kata Friends、Art Frame、IR 及通用端点 | 覆盖通用 9、MindClip 8、Kata diary 1 个端点；转录、diary、图像上传与 IR 命令已支持；MindClip 必填字段改为实际强制要求 |
| [#75](https://github.com/OpenWonderLabs/switchbot-openapi-cli/issues/75) | 安装归档的 root/nested 两种布局均禁止 manifest hooks 与 hooks.json；四种污染归档均实际拒绝，合法归档通过 |
| [#74](https://github.com/OpenWonderLabs/switchbot-openapi-cli/issues/74) | 删除把手动 helper 误称 hook 的旧断言；保留源级 hook-free 验收，实际安装后运行手动 helper |
| [#68](https://github.com/OpenWonderLabs/switchbot-openapi-cli/issues/68) | npm 包、包内 marketplace、嵌入 plugin、GitHub root marketplace 统一 0.2.0；prepack 和 release gate 拒绝版本漂移 |

### 本轮额外修复

- MindClip CLI、lib、MCP 对官方必填字段先报 usage 错误再请求；真实 CLI 与 MCP stdio 均验证省略时零 HTTP、完整参数时请求正确。不再保留无文档保证的默认日期/分页入口。
- 规则禁止 `nightLatchUnlock`、`createKey`、`deleteKey`，policy `never_confirm` 同步禁止。实时 inventory 校验和执行前的型号安全检查拦截 Garage Door Opener 的 turnOn/turnOff，普通灯具仍可执行；未知设备/命令不能绕过检查。
- 补充 45 个 Webhook context，共导出 70 个。根据官方表格独立提取的 69 个明确 context 逐字段/类型比对，实际 `schema export --json` 无剩余缺项；MindClip 嵌套事件保留既有独立描述。两处型号冲突及字段类型矛盾记录于歧义文档，不伪造映射或重写 payload。
- 修正 Gemini open/close/set-position 对 Blind Tilt 使用反向百分比和错误 scalar wire form 的提示；7 组实际 CLI explain 验证模型参数，零设备请求。
- Codex/Claude 旧 pack smoke 仍依赖已删除的 hook/export；改为实际安装入口。Codex 临时 prefix 路线使用安装归档完成原生注册、列出和清理，不再靠 mock 调用序列判定通过。
- 全量测试发现 oversized Webhook 在 413 后立即 destroy 导致 ECONNRESET；改为先关闭写端并限时回收。实际本地 TCP smoke：25 个正常客户端均收到 413、无连接错误；持续发送的 half-open 客户端约 1 秒内被关闭，零规则 dispatch。
- 规则测试最初使用了错误的 `--config-path`，留下一个默认设备缓存夹具；已清除该夹具，改用正确的 `--config`、隔离 homedir 和 cache reset。未读取或改写真实凭据。

### 最终验证

| 验证 | 已观察结果 |
| --- | --- |
| 全量 CLI 回归及五阶段构建 | 168 文件、3083 passed、0 failed；typecheck/bundle/assets/binary 成功 |
| 四个既有插件 workspace | 169 passed、0 failed、0 skipped：Claude 25、Codex 44、Gemini 79、OpenClaw 21 |
| CLI/Codex/Claude pack-install | 精确本地归档安装通过；CLI 3.9.0；policy CLI/MCP 创建和校验、手动 helper、版本门禁通过 |
| 原生 Codex 临时 prefix | `--require-host` 通过注册/列出/卸载；宿主提示拒绝在临时目录生成辅助 alias，不影响验证的插件流程 |
| 原生 Gemini 0.44.1 | 隔离 link/list/update、18 工具 catalog、本地 readonly history 和卸载通过；不发送模型 prompt |
| HTTP/MCP/设备参数 smoke | 5 类 MindClip 查询的缺参/有效路径、真实 stdio、目录/资源导出、Blind Tilt/Curtain/Roller 参数与规则执行边界均通过 |

以上为提交前的复查记录：当时尚未关闭 issue、提交、推送、创建 PR、发布候选或修改 dist-tag，也未验证真实云端、设备或原生 Windows/macOS。随后在独立修复分支创建 PR #76；Skills-only/ADR WIP 仍留在原 worktree。后续 CI 验收见下节。

## PR #76 的 Windows CI 修复

[CI run 38354238458](https://github.com/OpenWonderLabs/switchbot-openapi-cli/actions/runs/38354238458) 在 `6bfeaf6` 上报告三个 Windows 失败；Node 18/20/22 回归、Ubuntu/macOS OpenClaw bootstrap 和其余检查通过。

- CLI preAction priming 和 doctor 在完整 env 凭据存在时仍读取系统钥匙串。改为跳过低优先级读取，保留 doctor 后端元数据；未增大超时，也未关闭诊断。
- OpenClaw `makeCheckCredentials(exec)` 保留逻辑命令边界，Windows npm 参数转换只在默认运行时 adapter 中进行。既有 healthy/missing/keychain 断言在 Windows 通过。
- 打包 editor 测试通过 Node 执行 npm entry；旧版 CLI 测试创建 Windows npm 布局和 shim，并验证仅调用 version、拒绝旧版本且 stdout 为空。测试不继承调用者凭据。
- 原生 Windows 验收继续发现 Codex version helper 直接执行 npm shim 的 ENOENT；与既有 credential helper 一致，Windows 默认执行器启用 cmd 解析。
- 隔离的 Windows Node 24.19.0 / Windows 10.0.26200 中，以假的慢钥匙串子进程重现诊断 10 秒超时；修复后约 316 ms 返回健康、零钥匙串读取。未访问真实 Credential Manager 条目。
- 全量 Linux CLI 168 文件、3085 passed、0 failed，包含两条 failing-before/passing-after 凭据优先级回归。Windows 工作区 169 tests、CLI/Codex/Claude 精确归档安装、editor、CLI 版本拦截、sparse checkout 通过；原生 OpenClaw local/global 两路均列出 18 工具并调用本地 readonly history。
- Windows fixture 没有安装 Codex host，原生注册被明确跳过；不把 npm 包安装成功当作宿主兼容证明。所有运行使用隔离目录和 dummy credentials，未登录、调用云端或操作设备。
