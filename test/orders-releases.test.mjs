import assert from 'node:assert/strict';
import test from 'node:test';
import { buildModel } from '../src/model.mjs';
import { buildClientView } from '../src/client-view.mjs';

test('O1 已签批：不再重判数量，引导走声明变更追溯', async () => {
  const model = await buildModel('fixtures', 5);
  const order = model.data.orders.find(o => o.order === 'O1');
  const decision = model.inventory.decideOrder(order);
  assert.equal(decision.verdict, '已签批');
});

test('O2 工业级实物不足：判越界并写明数量缺口，电池级不自动顶替', async () => {
  const model = await buildModel('fixtures', 5);
  const order = model.data.orders.find(o => o.order === 'O2');
  const decision = model.inventory.decideOrder(order);
  assert.equal(decision.verdict, '越界');
  assert.ok(decision.blockers.some(b => b.item === '数量' && b.reason.includes('缺口 40')));
  assert.ok(decision.evidence.some(e => e.type === '改配提示'));
});

test('O3 班4终检未完成判暂不能判定并保留可分配性，班5转可声明', async () => {
  const at4 = await buildModel('fixtures', 4);
  const d4 = at4.inventory.decideOrder(at4.data.orders.find(o => o.order === 'O3'));
  assert.equal(d4.verdict, '暂不能判定');
  assert.equal(d4.allocatable, true);
  assert.ok(d4.blockers.some(b => b.item === '终检'));

  const at5 = await buildModel('fixtures', 5);
  const d5 = at5.inventory.decideOrder(at5.data.orders.find(o => o.order === 'O3'));
  assert.equal(d5.verdict, '可声明');
});

test('已确认交付占用实物：Q4 仅余 80kg，超量改配被拒（防一货多占）', async () => {
  const model = await buildModel('fixtures', 5);
  const order = model.data.orders.find(o => o.order === 'O2');
  assert.throws(
    () => model.inventory.reallocate({ order, fromNotice: 'Q4', kg: 100 }),
    /未占用实物仅 80kg/,
  );
  // 未超量且限值、等级满足时可登记改配意向。
  const ok = model.inventory.reallocate({ order, fromNotice: 'Q5', kg: 100 });
  assert.equal(ok.kg, 100);
});

test('requested 订单不占用实物，只有签批交付才建立占用', async () => {
  const model = await buildModel('fixtures', 5);
  const q5 = model.inventory.stock.get('Q5');
  assert.equal(model.inventory.occupiedKg('Q5'), 0);
  assert.equal(q5.kg, 300);
  assert.equal(model.inventory.occupiedKg('Q4'), 500); // D01 经拆批承接占用
});

test('D01 声明变更可追溯：强度、受影响用量、表具替代、补发客户齐全，原单据可复核', async () => {
  const model = await buildModel('fixtures', 5);
  const impact = model.releases.impacts.find(i => i.document === 'D01');
  assert.equal(impact.hasChanges, true);
  assert.equal(impact.reissueTo, 'C01');
  assert.equal(impact.stillCompliant, true);
  const kwh = impact.changes.find(c => c.metric === '单位电耗');
  assert.ok(kwh.after.lo > kwh.before.lo);
  assert.ok(Math.abs(kwh.affectedUsage.lower - 22.72727273) < 1e-6);
  const meter = impact.changes.find(c => c.metric === '计量记录');
  assert.equal(meter.before.record, 'M3');
  assert.equal(meter.after.record, 'M8');
  // 原始快照按班3资料：Q3、M3、234.93 kWh/t。
  assert.equal(impact.original.notice, 'Q3');
  assert.equal(impact.original.electricRecordState.record, 'M3');
  assert.ok(Math.abs(impact.original.intensity.kwh.lo - 234.92957746) < 1e-6);
});

test('客户视图隔离：C02 看不到 C01 订单、Q4 实物及任何公共表量', async () => {
  const model = await buildModel('fixtures', 5);
  const view = buildClientView(model.data, model, 'C02');
  const text = JSON.stringify(view);
  assert.ok(!text.includes('O1'));
  assert.ok(!text.includes('C01'));
  assert.ok(!text.includes('Q4'));
  assert.ok(!text.includes('plant'));
  // 表号以独立 token 出现（"M1"/"W2" 等），字段名 maxM3PerT 不算泄露。
  assert.ok(!/(^|[^A-Za-z])(M|W)[0-9]+([^A-Za-z]|$)/.test(text));
  // 只能看到依据类型。
  assert.ok(text.includes('实测') || text.includes('协议估计'));
});

test('客户查不到自己时返回 found=false，不泄露任何批次信息', async () => {
  const model = await buildModel('fixtures', 5);
  const view = buildClientView(model.data, model, 'C99');
  assert.equal(view.found, false);
  assert.deepEqual(view.batches, []);
});
