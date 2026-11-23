import assert from 'node:assert/strict';
import test from 'node:test';
import { buildModel } from '../src/model.mjs';

const approx = (actual, expected, tol = 1e-6) => assert.ok(Math.abs(actual - expected) < tol,
  `期望 ${expected}，实际 ${actual}`);

test('母液回用按实物量携带强度，罐内余量跨班保留且不重复结转', async () => {
  const model = await buildModel('fixtures', 5);
  const { tankRemainder, lotBurden } = model.liquor;

  // T1：L1 出罐 385，L3 耗用 315，余 70。
  const t1 = tankRemainder.find(t => t.tank === 'T1');
  approx(t1.kg, 70);
  assert.equal(t1.layers[0].originLot, 'L1');

  // L3 继承的电耗 = L1 单位电耗 × 315。
  const l1Rate = lotBurden.get('L1').ratePerKg.electric.lo;
  const l3 = lotBurden.get('L3');
  approx(l3.inherited.electric.lo, l1Rate * 315);
  assert.ok(l3.inheritTraces.some(t => t.originLot === 'L1' && t.kg === 315));
});

test('跨班在制品 T2 余量随 L2 实物保留，L4 耗用后才转移负担', async () => {
  const model = await buildModel('fixtures', 5);
  const t2 = model.liquor.tankRemainder.find(t => t.tank === 'T2');
  approx(t2.kg, 80); // 270 - 190
  const l4 = model.liquor.lotBurden.get('L4');
  const l2Rate = model.liquor.lotBurden.get('L2').ratePerKg.electric.lo;
  approx(l4.inherited.electric.lo, l2Rate * 190);
});

test('拆批实物量之和等于原批，子批按实物净量承担父批强度', async () => {
  const model = await buildModel('fixtures', 5);
  const q4 = model.quality.noticeById('Q4');
  const q5 = model.quality.noticeById('Q5');
  assert.equal(q4.quantityKg + q5.quantityKg, 880);
  // 两个子批单位强度相同，都等于 L3 父批单位负担。
  approx(q4.intensity.kwh.lo, q5.intensity.kwh.lo);
  const l3Rate = model.liquor.lotBurden.get('L3').ratePerKg.electric.lo * 1000;
  approx(q4.intensity.kwh.lo, l3Rate);
  // 负担按净量切分。
  approx(q4.burden.electric.lo + q5.burden.electric.lo,
    model.liquor.lotBurden.get('L3').finishedBurden.electric.lo);
});

test('复判后旧通知失效：Q6(pending) 被 Q7(industrial) 替代，pending 不进合格分母', async () => {
  const at4 = await buildModel('fixtures', 4);
  const l4At4 = at4.quality.lotState.get('L4');
  assert.equal(l4At4.qualifiedKg, 0);
  assert.equal(l4At4.pendingKg, 600);
  assert.ok(l4At4.replacedNotices.includes('Q6') === false);

  const at5 = await buildModel('fixtures', 5);
  const l4At5 = at5.quality.lotState.get('L4');
  assert.equal(l4At5.qualifiedKg, 600);
  assert.equal(l4At5.pendingKg, 0);
  assert.ok(l4At5.replacedNotices.includes('Q6'));
  assert.equal(at5.quality.noticeById('Q6'), null);
});

test('L4 水强度保留协议估计区间，电耗为实测点值', async () => {
  const model = await buildModel('fixtures', 5);
  const q7 = model.quality.noticeById('Q7');
  assert.equal(q7.intensity.kwh.estimated, false);
  assert.equal(q7.intensity.m3.estimated, true);
  assert.ok(q7.intensity.m3.lo < q7.intensity.m3.hi);
  assert.deepEqual(q7.basis, { electric: '实测', water: '协议估计' });
});

test('母液耗用与 production.reuse_kg 不一致时直接报错', async () => {
  const model = await buildModel('fixtures', 5);
  const tampered = structuredClone(model.data);
  tampered.production.find(p => p.id === 'L3').reuse_kg = 300;
  const { buildMeterLedger } = await import('../src/meter-ledger.mjs');
  const { buildShiftAllocations } = await import('../src/shift-allocation.mjs');
  const { buildLiquorLedger } = await import('../src/liquor-ledger.mjs');
  const ledger = buildMeterLedger(tampered);
  const allocations = buildShiftAllocations(tampered, ledger, 5);
  assert.throws(() => buildLiquorLedger(tampered, allocations), /母液耗用量不一致/);
});
