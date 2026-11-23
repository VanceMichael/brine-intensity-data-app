// 模型组装入口：同一套代码按截止班号重放，供日常查询与月底复核共用。
// cutoff 表示“当前已取得资料的班号”，所有模块只读取 known_shift <= cutoff 的数据。
import { loadData } from './loader.mjs';
import { buildMeterLedger } from './meter-ledger.mjs';
import { buildShiftAllocations } from './shift-allocation.mjs';
import { buildLiquorLedger } from './liquor-ledger.mjs';
import { buildQuality } from './quality.mjs';
import { buildInventory } from './inventory.mjs';
import { buildReleases } from './releases.mjs';

export const LATEST_CUTOFF = 5;

export async function buildModel(folder, cutoff = LATEST_CUTOFF) {
  const data = await loadData(folder);
  const maxKnown = Math.max(
    ...data.meterRevisions.map(row => row.known_shift),
    ...data.quality.map(row => row.known_shift),
  );
  if (cutoff > maxKnown) {
    throw new Error(`截止班号 ${cutoff} 超过资料中最大取得班号 ${maxKnown}`);
  }

  const ledger = buildMeterLedger(data);
  const allocations = buildShiftAllocations(data, ledger, cutoff);
  const liquor = buildLiquorLedger(data, allocations);
  const quality = buildQuality(data, liquor, cutoff);
  const inventory = buildInventory(data, quality, cutoff);
  const model = { cutoff, data, ledger, allocations, liquor, quality, inventory };
  // 历史重放只组装计量/质量核心，不再构建 releases，避免递归。
  model.modelAt = at => assembleCore(data, at);
  const releases = buildReleases(data, { quality, inventory, ledger, cutoff, modelAt: model.modelAt });
  model.releases = releases;

  return model;
}

function assembleCore(data, cutoff) {
  const ledger = buildMeterLedger(data);
  const allocations = buildShiftAllocations(data, ledger, cutoff);
  const liquor = buildLiquorLedger(data, allocations);
  const quality = buildQuality(data, liquor, cutoff);
  const inventory = buildInventory(data, quality, cutoff);
  return { cutoff, data, ledger, allocations, liquor, quality, inventory, modelAt: at => assembleCore(data, at) };
}
