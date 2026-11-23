import assert from 'node:assert/strict';
import test from 'node:test';
import { buildModel } from '../src/model.mjs';
import { replay } from '../src/month-end.mjs';
import { interval, point, compareCap } from '../src/interval.mjs';

test('区间不提前压点：跨上限判 indeterminate，整体越界判 over', () => {
  assert.equal(compareCap(interval(180, 260), 230), 'indeterminate');
  assert.equal(compareCap(interval(300, 320), 290), 'over');
  assert.equal(compareCap(point(280), 290), 'pass');
});

test('月底重放三层口径齐全，待核差额按班次留痕不轧差', async () => {
  const model = await buildModel('fixtures', 5);
  const report = replay(model);
  assert.ok(report.meterCoverage.length >= 6);
  assert.ok(report.denominators.lots.length === 4);
  assert.equal(report.declarations.kg, 500);
  // 班3水缺表、声明变更等待核项都保留。
  const kinds = report.openItems.map(i => i.type);
  assert.ok(kinds.includes('shared_total_missing'));
  assert.ok(kinds.includes('声明依据变更待补发'));
});

test('不同截止班号重放：声明总量与分母随资料到达变化，历史差额不被后续抵消', async () => {
  const r1 = replay(await buildModel('fixtures', 1));
  const r3 = replay(await buildModel('fixtures', 3));
  const r5 = replay(await buildModel('fixtures', 5));
  assert.equal(r1.declarations.count, 0);
  assert.equal(r3.declarations.count, 1);
  assert.equal(r5.declarations.count, 1);
  // 班1的缺表待核项数量大于班5（资料陆续到达），但班1重放时必须原样保留。
  assert.ok(r1.openItems.length >= r5.openItems.length);
  // 班3重放中 L4 是 pending，班5才合格。
  const l4At3 = r3.denominators.lots.find(l => l.lot === 'L4');
  const l4At5 = r5.denominators.lots.find(l => l.lot === 'L4');
  assert.equal(l4At3.pendingKg, 600);
  assert.equal(l4At5.qualifiedKg, 600);
});

test('罐内在制品作为分母明细单列，不混入合格产量', async () => {
  const model = await buildModel('fixtures', 5);
  const report = replay(model);
  const tanks = report.denominators.tankWip.map(t => [t.tank, t.kg]);
  assert.deepEqual(tanks, [['T1', 70], ['T2', 80], ['T3', 220], ['T4', 150]]);
});
