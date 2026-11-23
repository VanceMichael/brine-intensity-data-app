# 联产计量缺口下的锂盐能耗交付

业务资料均为合成记录。表头字段及跨表引用见 `fixtures/format.json`。本项目把独立报送的称重、
生产交接与计量资料接入同一套 Node.js 代码，供计量、质保和合同交付人员日常使用，并用同一套逻辑
支撑月底多班次重放。

## 数据说明

称重单位为千克，电量是 kWh，水量是 m³。总表含专表，未装专表的共享负载按同班 operating_minutes 归属。
归属驱动完全缺失的量列待核。表具更换从现场首个读数起计，不用上一只设备的末读相减。
meter-revisions 是计量员实际取得数据的班号，已有读数的补报用 replaces 确认替代；缺测不是零。

母液流转以 stock-movements 为准，耗用回用部分继承此前按实物量归属的计量，余量仍在罐内。
品级从高到低为 battery、industrial，pending 表示未完成终检。拆批的实物量之和等于原批，
按拆分实物在新口径承担原批强度。signed 订单与 releases 的签发号可核对，先期到达的订单未确认前只构成请求。

CSV 使用 UTF-8、逗号分隔，无引号与内嵌换行。未提供的字段是空字符串，作为关系值的 `-` 表示不适用。
多值字段用竖线分隔，数值和日期单位见业务约定。

## 资料检查

使用 Node.js 22.23.4，依赖仅为 Node.js 标准库。运行 `npm ci --ignore-scripts --offline` 准备工作区。

- `npm run check:materials`：检查合成交接资料的字段与记录引用。
- `npm test`：资料校验与全部业务口径测试（31 项）。

## 日常使用（src/cli.mjs）

所有命令都带 `--cutoff=N`（默认 5），表示“当前已取得资料的班号”，重放时只读 `known_shift <= N` 的数据。

| 命令 | 用途 | 角色 |
| --- | --- | --- |
| `node src/cli.mjs order <订单号>` | 出货前判定：可声明 / 越界（写明哪一项）/ 暂不能判定（含补证要求） | 合同交付 |
| `node src/cli.mjs stock` | 通知级库存、已占用与未占用实物 | 合同交付、质保 |
| `node src/cli.mjs reallocate <订单号> <质量通知> <kg>` | 同罐实物改配，强制过限值与超占校验 | 合同交付 |
| `node src/cli.mjs client <客户号>` | 客户视图：只见自身批次范围与依据类型，公共计量明细脱敏 | 客户对接 |
| `node src/cli.mjs release <交付单号>` | 签批声明快照、复判/补交影响、受影响用量与补发客户 | 质保、计量 |
| `node src/cli.mjs replay [--shifts=1,3,5]` | 月底多班次组合重放，三层核对与待核差额留痕 | 计量 |

## 口径实现与模块对应

| 业务要求 | 模块 | 关键处理 |
| --- | --- | --- |
| 公辅归属口径承接实测量、回用、跨班在制品 | `shift-allocation.mjs`、`liquor-ledger.mjs` | 专表先归属，共享按 operating_minutes 分摊；母液 FIFO 携强度，罐余跨班保留 |
| 专表量与总表量对不上：可归属量 / 残差 / 缺表三分 | `shift-allocation.mjs` | 残差只用实测口径核算，协议估计不进实测守恒；驱动缺失列待核 |
| 班次总量守恒，同时订单能追到批次 | `shift-allocation.mjs`、`quality.mjs` | 每班次输出 conservation 闭合差额；强度沿批次实物链可追溯 |
| 缺表按协议出估计区间 | `interval.mjs`、`shift-allocation.mjs` | 全程区间传递并标 `estimated`，缺测/无记录不记零 |
| 换表回零不与旧表相减、回用不重复结转 | `meter-ledger.mjs`、`liquor-ledger.mjs` | 用量恒为 closing−opening；母液出罐即扣、进罐建层，只随实物移动一次 |
| 拆批/合批/降级强度跟实物净量走 | `quality.mjs` | 拆批守恒校验，子批按净量承担父批单位负担；复判链保留旧通知可追溯 |
| 未达可比终检口径的量分母另列 | `quality.mjs`、`month-end.mjs` | pending 不进合格产量分母，先出货也不算合格 |
| 出货前规则判定与三态结论 | `inventory.mjs` | 区间整体满足才声明；整体越界写明项；跨线/未终检保留可分配性与补证要求 |
| 改配防一货多占 | `inventory.mjs` | requested 不占实物，signed 交付占用；改配只动未占用部分，超量直接拒绝 |
| 声明变化追到用量、订单、补发客户，原单据可复核 | `releases.mjs`、`model.mjs` | 按 signed_shift 独立重放原始快照；当前快照沿复判链与 correction 链承接 |
| 客户只见自身范围与依据类型 | `client-view.mjs` | 过滤其他等级/客户通知，不输出总表、专表、残差等公共计量明细 |
| 月底同代码重放、差额不轧差 | `month-end.mjs` | 原始计量覆盖 / 归属分母 / 声明总量三层，待核项按班次逐条留痕 |

## 计量链语义（meter-ledger）

- `meter` 列是计量范围（plant 总表、line-* 专表、raw-water 水总表），`scope` 列是介质。
- 换表记录（read/missing）按计量范围归同一设备链；correction 自成链并经 `replaces` 建立替代关系。
- 同一班次同一范围在截止班号下若 correction 已可见，以 correction 为生效记录，原读记录仍可经
  `supersessions()` 复核。

## 目录结构

```
src/
  csv.mjs               只读 CSV 解析
  interval.mjs          区间运算与合同上限比较（实测点值/协议估计区间）
  loader.mjs            交接资料装载与数值转换
  meter-ledger.mjs      表具链、换表、correction、缺表识别、截止班号视图
  shift-allocation.mjs  班次公辅分摊、残差、缺表、总量守恒
  liquor-ledger.mjs     母液 FIFO 台账、回用继承、跨班在制品
  quality.mjs           复判链、拆合批、pending 分母、批次强度
  inventory.mjs         订单判定、库存占用、改配防护
  releases.mjs          签批快照、变更影响与补发追溯
  client-view.mjs       客户级脱敏视图
  month-end.mjs         月底三层重放与待核差额
  model.mjs             按截止班号组装模型（含历史重放）
  cli.mjs               命令行入口
test/                   node:test 业务口径测试
tools/check-materials.mjs 原始资料字段与引用校验
```
