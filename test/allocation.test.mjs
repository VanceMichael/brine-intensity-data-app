import assert from 'node:assert/strict';
import test from 'node:test';
import { buildModel } from '../src/model.mjs';

const approx = (actual, expected, tol = 1e-6) => assert.ok(Math.abs(actual - expected) < tol,
  `期望 ${expected}，实际 ${actual}`);

test('班次1共享电耗按 operating_minutes 分摊，总量守恒无残差', async () => {
  const model = await buildModel('fixtures', 5);
  const block = model.allocations.byShift.get(1).electric;
  const [lineA, lineB] = block.lines;
  approx(lineA.total.lo, 62 + (240 - 62) * 240 / 420);
  approx(lineB.total.lo, (240 - 62) * 180 / 420);
  approx(block.lines.reduce((a, l) => a + l.total.lo, 0) + block.residual.lo, 240);
  assert.equal(block.conservation.closes, true);
  assert.equal(block.residual.lo, 0);
});

test('总表含专表：专表量先全额归属，不参与共享二次分摊', async () => {
  const model = await buildModel('fixtures', 5);
  const lineA = model.allocations.byShift.get(1).electric.lines.find(l => l.line === 'line-A');
  assert.ok(lineA.dedicated.lo >= 62);
  approx(lineA.dedicated.lo, 62);
});

test('班3水总表缺测：给协议估计区间且标记 estimated，不记零、不进实测守恒', async () => {
  const model = await buildModel('fixtures', 5);
  const water = model.allocations.byShift.get(3).water;
  const lineB = water.lines[0];
  assert.equal(lineB.total.estimated, true);
  assert.equal(lineB.total.lo, 7);
  assert.equal(lineB.total.hi, 14);
  assert.equal(water.total, null);
  assert.equal(water.conservation, null);
  assert.ok(water.gaps.some(g => g.type === 'shared_total_missing'));
});

test('补交后实测值低于协议区间下限时，区间改按实测，差额留给月底追查', async () => {
  const model = await buildModel('fixtures', 5);
  const electric = model.allocations.byShift.get(3).electric;
  // 协议区间 160-230，M5 补交实测 130。
  assert.equal(electric.total.lo, 130);
  assert.equal(electric.total.estimated, false);
});

test('缺表在取得资料前的重放中保持 no_record，不会被提前当成估计', async () => {
  const model = await buildModel('fixtures', 2);
  const water3 = model.allocations.byShift.get(3);
  assert.equal(water3.water.totalState, 'no_record');
});
