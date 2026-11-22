# 联产计量缺口下的锂盐能耗交付

业务资料均为合成记录。表头字段及跨表引用见 `fixtures/format.json`。

## 数据说明

称重单位为千克，电量是 kWh，水量是 m³。总表含专表，未装专表的共享负载按同班 operating_minutes 归属。归属驱动完全缺失的量列待核。表具更换从现场首个读数起计，不用上一只设备的末读相减。meter-revisions 是计量员实际取得数据的班号，已有读数的补报用 replaces 确认替代；缺测不是零。
母液流转以 stock-movements 为准，耗用回用部分继承此前按实物量归属的计量，余量仍在罐内。品级从高到低为 battery、industrial，pending 表示未完成终检。拆批的实物量之和等于原批，按拆分实物在新口径承担原批强度。signed 订单与 releases 的签发号可核对，先期到达的订单未确认前只构成请求。

CSV 使用 UTF-8、逗号分隔，无引号与内嵌换行。未提供的字段是空字符串，作为关系值的 `-` 表示不适用。多值字段用竖线分隔，数值和日期单位见业务约定。

## 资料检查

使用 Node.js 22.23.4，依赖仅为 Node.js 标准库。运行 `npm ci --ignore-scripts --offline` 准备工作区。

运行 `npm run check:materials` 检查合成交接资料的字段与记录引用。运行 `npm test` 检查交接资料的读取和校验。
