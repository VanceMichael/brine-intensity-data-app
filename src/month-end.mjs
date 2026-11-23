// 月底汇总与班次组合重放。
//
// 口径要点：
// - 同一套代码重放不同班次组合（截止班号集合），分别核对三层：
//   1) 原始计量覆盖：实测 / 缺表 / 无记录、换表链、残差与守恒差额；
//   2) 归属口径下的分母：合格产量、pending 另列、罐内在制品；
//   3) 实际声明总量：已签批交付的实物量与强度依据。
// - 汇总粒度（全厂/全月）与单批对外声明（批次粒度）严格分开；
//   任何只在汇总上抵消的差额都按班次留痕，交计量员追查，不做轧差。

import { basisType, sum as sumIntervals } from './interval.mjs';

function round(value) {
  return Math.round(value * 1e6) / 1e6;
}

export function replay(model) {
  const { cutoff, data, ledger, allocations, liquor, quality, releases } = model;

  // 第一层：原始计量覆盖。
  const meterCoverage = ledger.effectiveView(cutoff).map(item => ({
    shift: item.shift,
    meter: item.meter,
    scope: item.scope,
    unit: item.unit,
    state: item.state,
    record: item.record,
    usage: item.usage,
    estimated: item.estimated,
  }));

  // 第二层：班次守恒、残差、缺表（按班留痕，不轧差）。
  const shiftAudit = allocations.shifts.map(shift => {
    const block = allocations.byShift.get(shift);
    const entry = { shift, electric: auditKind(block.electric), water: auditKind(block.water) };
    return entry;
  });

  function auditKind(block) {
    return {
      unit: block.unit,
      totalState: block.totalState,
      totalMeter: block.totalMeter,
      total: block.total ? round(block.total.lo) : null,
      attributed: round(sumIntervals(block.lines.map(line => line.total)).lo),      residual: round(block.residual.lo),
      gaps: block.gaps.map(gap => ({ ...gap, estimate: gap.estimate ? {
        lo: round(gap.estimate.lo),
        hi: round(gap.estimate.hi),
      } : null })),
      conservation: block.conservation
        ? { ...block.conservation, difference: round(block.conservation.difference) }
        : null,
    };
  }

  // 归属分母明细：合格 / pending / 在制品。
  const denominators = {
    lots: [...quality.lotState.values()].map(state => ({
      lot: state.lot,
      shift: state.shift,
      finishedKg: state.finishedKg,
      qualifiedKg: state.qualifiedKg,
      pendingKg: state.pendingKg,
      conservationErrors: state.conservationErrors,
      qualifiedIntensity: state.qualifiedIntensity
        ? {
            kwhPerT: { lo: round(state.qualifiedIntensity.kwh.lo), hi: round(state.qualifiedIntensity.kwh.hi), basis: basisType(state.qualifiedIntensity.kwh) },
            m3PerT: { lo: round(state.qualifiedIntensity.m3.lo), hi: round(state.qualifiedIntensity.m3.hi), basis: basisType(state.qualifiedIntensity.m3) },
          }
        : null,
    })),
    tankWip: liquor.tankRemainder.map(tank => ({
      tank: tank.tank,
      kg: round(tank.kg),
      burden: {
        electric: round(tank.burden.electric.lo),
        water: round(tank.burden.water.lo),
      },
      layers: tank.layers,
    })),
  };

  // 第三层：实际声明总量。
  const declarations = {
    count: releases.documents.length,
    kg: round(releases.documents.reduce((acc, doc) => acc + doc.kg, 0)),
    documents: releases.impacts.map(impact => ({
      document: impact.document,
      order: impact.order,
      client: impact.client,
      kg: impact.kg,
      reissueRequired: impact.reissueRequired,
      stillCompliant: impact.stillCompliant,
      changeCount: impact.changes.length,
    })),
  };

  // 待追差额：守恒缺口、缺表、拆批不守恒、声明变更，逐条留痕。
  const openItems = [];
  for (const audit of shiftAudit) {
    for (const kind of ['electric', 'water']) {
      const block = audit[kind];
      if (block.conservation && !block.conservation.closes) {
        openItems.push({ level: '班次', shift: audit.shift, kind, type: '守恒缺口', detail: block.conservation });
      }
      for (const gap of block.gaps) {
        openItems.push({ level: '班次', shift: audit.shift, kind, type: gap.type, detail: gap.basisNote });
      }
      if (block.residual > 1e-9) {
        openItems.push({ level: '班次', shift: audit.shift, kind, type: '无法分开的残差', detail: `${block.residual} ${block.unit}` });
      }
    }
  }
  for (const lot of denominators.lots) {
    for (const error of lot.conservationErrors) {
      openItems.push({ level: '批次', lot: lot.lot, type: '拆批不守恒', detail: error });
    }
  }
  for (const impact of releases.impacts.filter(i => i.reissueRequired)) {
    openItems.push({
      level: '声明',
      document: impact.document,
      client: impact.client,
      type: '声明依据变更待补发',
      detail: impact.changes.map(c => c.metric).join('、'),
    });
  }

  return {
    cutoff,
    meterCoverage,
    shiftAudit,
    denominators,
    declarations,
    openItems,
  };
}
