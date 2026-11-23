// 班次公辅分摊。
//
// 归属口径（按资料约定）：
// - 总表（plant / raw-water）包含专表量；line-* 范围为该线专表，先全额归属该线。
// - 未装专表（或缺测）的共享负载，按同班 operating_minutes（driver_amount）归属；
//   驱动量完全缺失的量不臆造，列入待核。
// - 分摊结果区分三类：可归属的量（专表 + 已分摊共享）、无法分开的残差、缺表。
// - 残差只用实测口径核算：实测总表 − 实测专表 − 已按驱动分摊的共享实测，
//   协议估计不进入实测守恒。
// - 缺表按 allocation-basis 的协议区间给出估计，标记 estimated；不允许记成 0。

import { add, interval, point, sum } from './interval.mjs';

const TOTAL_METER = { electric: 'plant', water: 'raw-water' };
const UNIT = { electric: 'kWh', water: 'm3' };

// 产线对应的专表计量范围（资料中电表按 line-A/line-B 安装，水无专表）。
function dedicatedMeter(line, kind) {
  if (kind !== 'electric') return null;
  return `line-${line.slice(-1).toUpperCase()}`;
}

function basisIndex(data) {
  const map = new Map();
  for (const row of data.allocationBasis) {
    map.set(`${row.shift}|${row.line}`, row);
  }
  return map;
}

function protocolEstimate(basisRow, kind) {
  if (!basisRow) return null;
  if (kind === 'water') {
    return interval(basisRow.water_est_lower, basisRow.water_est_upper, true);
  }
  return interval(basisRow.electric_est_lower, basisRow.electric_est_upper, true);
}

export function buildShiftAllocations(data, ledger, cutoff) {
  const view = ledger.effectiveView(cutoff);
  const bases = basisIndex(data);
  const shifts = [...new Set(data.production.map(row => row.shift))].sort((a, b) => a - b);
  const lines = [...new Set(data.production.map(row => row.line))].sort();

  const findMeter = (shift, meterName) =>
    view.find(item => item.shift === shift && item.meter === meterName) ?? null;

  const summaries = [];

  for (const shift of shifts) {
    const summary = { shift, electric: buildKind('electric'), water: buildKind('water') };
    summaries.push(summary);

    function buildKind(kind) {
      const totalEntry = findMeter(shift, TOTAL_METER[kind]);
      const lineRows = data.production.filter(row => row.shift === shift);
      const drivers = lineRows.map(row => bases.get(`${shift}|${row.line}`) ?? null);

      const measuredDedicated = [];
      const lineResults = [];
      const gaps = [];

      for (const row of lineRows) {
        const basisRow = bases.get(`${shift}|${row.line}`);
        const dedicated = kind === 'electric' ? findMeter(shift, dedicatedMeter(row.line, kind)) : null;
        const result = {
          line: row.line,
          driver: basisRow ? basisRow.driver_amount : null,
          dedicated: null,
          shared: point(0),
          total: point(0),
          gap: null,
        };

        if (dedicated && dedicated.state === 'measured') {
          result.dedicated = point(dedicated.usage);
          measuredDedicated.push(result.dedicated);
        } else if (dedicated && dedicated.state !== 'measured') {
          // 专表缺测：按协议给估计区间，但不计入实测守恒。
          const estimate = protocolEstimate(basisRow, kind);
          result.gap = {
            type: 'dedicated_missing',
            meter: dedicated.record,
            state: dedicated.state,
            estimate,
            basisNote: estimate ? '协议估计区间' : '缺协议区间，待核',
          };
          gaps.push(result.gap);
        }

        lineResults.push(result);
      }

      // 共享实测量 = 实测总表 − 实测专表之和；总表缺测时没有共享实测可分。
      let sharedMeasured = null;
      let totalState = 'no_record';
      let totalMeter = null;
      if (totalEntry && totalEntry.state === 'measured') {
        totalState = 'measured';
        totalMeter = totalEntry.record;
        const dedicatedSum = sum(measuredDedicated);
        const sharedValue = totalEntry.usage - dedicatedSum.lo;
        if (sharedValue < -1e-9) {
          throw new Error(
            `班次 ${shift} ${kind} 专表量之和 ${dedicatedSum.lo} 超过总表量 ${totalEntry.usage}`,
          );
        }
        sharedMeasured = Math.max(sharedValue, 0);
      } else if (totalEntry) {
        totalState = totalEntry.state;
        totalMeter = totalEntry.record;
        gaps.push({
          type: 'total_missing',
          meter: totalMeter,
          state: totalState,
          estimate: null,
          basisNote: '总表缺测，共享负载待核',
        });
      } else {
        gaps.push({
          type: 'total_no_record',
          meter: null,
          state: 'no_record',
          estimate: null,
          basisNote: '截止班号下该范围尚无记录',
        });
      }

      // 按 operating_minutes 分摊共享实测；驱动完全缺失则该量列待核。
      let unattributed = point(0);
      if (sharedMeasured !== null && sharedMeasured > 0) {
        const driverTotal = lineResults.reduce((acc, item) => acc + (item.driver ?? 0), 0);
        if (driverTotal <= 0) {
          unattributed = point(sharedMeasured);
          gaps.push({
            type: 'driver_missing',
            meter: totalMeter,
            state: totalState,
            estimate: null,
            basisNote: '归属驱动完全缺失，共享量无法分开',
          });
        } else {
          let allocated = 0;
          lineResults.forEach((item, index) => {
            if (!drivers[index]) return;
            const share = sharedMeasured * (item.driver / driverTotal);
            item.shared = point(share);
            allocated += share;
          });
          // 浮点尾差归入残差，不丢量。
          const remainder = sharedMeasured - allocated;
          if (remainder > 1e-9) unattributed = point(remainder);
        }
      }

      // 总表缺测/无记录时，没有共享实测可分；按协议给各线别估计区间（缺表可按协议出估计区间）。
      if (sharedMeasured === null) {
        for (const item of lineResults) {
          if (item.gap) continue; // 专表自身已缺测并挂估计的不重复处理
          const basisRow = bases.get(`${shift}|${item.line}`);
          const estimate = protocolEstimate(basisRow, kind);
          item.gap = {
            type: 'shared_total_missing',
            meter: totalMeter,
            state: totalState,
            estimate,
            basisNote: estimate ? '总表缺测，按协议估计区间' : '总表缺测且无协议区间，待核',
          };
          gaps.push(item.gap);
        }
      }

      // 缺表线别补协议区间（用于订单判定时的最坏口径与补证提示）。
      for (const item of lineResults) {
        if (item.gap && item.gap.estimate) {
          item.total = add(item.dedicated ?? point(0), item.gap.estimate);
          item.totalEstimated = true;
        } else if (item.gap) {
          item.total = add(item.dedicated ?? point(0), point(0));
          item.totalEstimated = true;
        } else {
          item.total = add(item.dedicated ?? point(0), item.shared);
          item.totalEstimated = false;
        }
      }

      const attributedMeasured = sum(
        lineResults
          .filter(item => !item.totalEstimated)
          .map(item => item.total),
      );

      // 残差 = 实测总表 − 可归属实测（专表 + 已分摊共享）。
      let residual = point(0);
      let conservation = null;
      if (totalEntry && totalEntry.state === 'measured') {
        const residualValue = totalEntry.usage - attributedMeasured.lo;
        residual = point(Math.max(residualValue, 0));
        const checkTotal = attributedMeasured.lo + residual.lo;
        conservation = {
          total: totalEntry.usage,
          attributed: attributedMeasured.lo,
          residual: residual.lo,
          difference: totalEntry.usage - checkTotal,
          closes: Math.abs(totalEntry.usage - checkTotal) <= 1e-6,
        };
      }

      return {
        unit: UNIT[kind],
        total: totalEntry && totalEntry.state === 'measured' ? point(totalEntry.usage) : null,
        totalState,
        totalMeter,
        lines: lineResults,
        residual,
        gaps,
        conservation,
      };
    }
  }

  const byShift = new Map(summaries.map(item => [item.shift, item]));
  return {
    cutoff,
    shifts,
    byShift,
    lineBurden(shift, line, kind) {
      const block = byShift.get(shift)[kind];
      const found = block.lines.find(item => item.line === line);
      if (!found) throw new Error(`班次 ${shift} 不存在产线 ${line}`);
      return {
        interval: found.total,
        gap: found.gap,
        unit: block.unit,
      };
    },
  };
}
