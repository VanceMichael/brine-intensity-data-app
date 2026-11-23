import assert from 'node:assert/strict';
import test from 'node:test';
import { loadData } from '../src/loader.mjs';
import { buildMeterLedger } from '../src/meter-ledger.mjs';

const data = await loadData('fixtures');
const ledger = buildMeterLedger(data);

test('换表后从新表首读起计，回零不与旧表末读相减', () => {
  const view3 = ledger.effectiveView(3);
  const m3 = view3.find(item => item.record === 'M3');
  assert.equal(m3.usage, 210); // 0 -> 210，而不是与 M1 末读 1240 相减
  assert.equal(m3.replaces, 'M1');
});

test('correction 在取得班号后替代原读，原读记录仍可经追溯复核', () => {
  const before = ledger.effectiveView(4).find(item => item.shift === 2 && item.meter === 'plant');
  assert.equal(before.record, 'M3');
  assert.equal(before.usage, 210);
  const after = ledger.effectiveView(5).find(item => item.shift === 2 && item.meter === 'plant');
  assert.equal(after.record, 'M8');
  assert.equal(after.usage, 260);
  const session = ledger.supersessions().find(s => s.replacement === 'M8');
  assert.equal(session.superseded, 'M3');
  assert.equal(session.supersededUsage, 210);
});

test('缺测不是零：空读数为 missing，晚到的 correction 为 measured', () => {
  const view4 = ledger.effectiveView(4);
  const shift3 = view4.find(item => item.shift === 3 && item.meter === 'plant');
  assert.equal(shift3.state, 'missing');
  assert.equal(shift3.usage, null);
  assert.equal(shift3.estimated, true);
  const view5 = ledger.effectiveView(5);
  const corrected = view5.find(item => item.shift === 3 && item.meter === 'plant');
  assert.equal(corrected.record, 'M5');
  assert.equal(corrected.usage, 130); // 260 -> 390
});

test('截止班号重放只能看到当时已取得的资料', () => {
  const view1 = ledger.effectiveView(1);
  // 班2、班3的计量范围在班1重放中应是 no_record，而不是彻底缺席。
  const laterScopes = view1.filter(item => item.shift >= 2);
  assert.ok(laterScopes.length > 0);
  assert.ok(laterScopes.every(item => item.state === 'no_record'));
  const m1 = view1.find(item => item.record === 'M1');
  assert.equal(m1.usage, 240);
});

test('读数倒挂直接报错，不产生负用量', () => {
  const bad = {
    meter: [{ id: 'X1', shift: 1, meter: 'plant', scope: 'electric', opening: 100, closing: 90, unit: 'kWh', replaces: null }],
    meterRevisions: [{ entry: 'X1', known_shift: 1, batch_status: 'read' }],
  };
  assert.throws(() => buildMeterLedger(bad).effectiveView(1), /读数倒挂/);
});
