// 客户视图：客户只能看到自己批次的范围与计量依据类型。
// 公共计量明细（总表、其他产线专表、残差、其他客户订单）一律脱敏，
// 客户无法通过公共计量明细反推其他客户的订单。

export function buildClientView(data, model, clientId) {
  const { quality, inventory, releases, cutoff } = model;
  const ownOrders = data.orders.filter(o => o.client === clientId);
  if (ownOrders.length === 0) {
    return { client: clientId, cutoff, found: false, orders: [], batches: [], declarations: [] };
  }

  const ownOrderIds = new Set(ownOrders.map(o => o.order));
  const batchIds = new Set(ownOrders.map(o => o.batch));

  const orders = ownOrders.map(order => {
    const decision = inventory.decideOrder(order);
    return {
      order: order.order,
      state: order.state,
      batch: order.batch,
      quantityKg: order.quantity_kg,
      minGrade: order.min_grade,
      limits: {
        maxKwhPerT: order.max_kwh_per_t,
        maxM3PerT: order.max_m3_per_t,
      },
      verdict: decision.verdict,
      blockers: decision.blockers,
      // 跨等级改配提示点名的通知可能被其他客户占用，对外只保留不点名的规则说明，
      // 避免客户借提示反推他人订单与库存。
      evidence: decision.evidence.map(item =>
        item.type === '改配提示'
          ? { type: item.type, requirement: '存在更高等级实物，如需顶替须由工厂显式改配并复核限值' }
          : item,
      ),
      // 仅返回本订单批次、本订单等级的可用范围，不带任何公共计量明细。
      available: decision.sameGradeFree.map(item => ({
        notice: item.notice,
        grade: item.grade,
        freeKg: item.freeKg,
      })),
    };
  });

  const batches = [...batchIds].map(lotId => {
    const state = quality.lotState.get(lotId);
    // 客户只能看与自己订单等级相关的通知；其他等级的实物可能属于其他客户，不点名暴露。
    const allowedGrades = new Set(ownOrders.filter(o => o.batch === lotId).map(o => o.min_grade));
    const visibleNotices = state.notices.filter(
      notice => allowedGrades.has(notice.grade) || notice.grade === 'pending',
    );
    const visibleQualifiedKg = visibleNotices
      .filter(n => n.grade !== 'pending')
      .reduce((acc, n) => acc + n.quantityKg, 0);
    return {
      lot: lotId,
      visibleQualifiedKg,
      pendingKg: state.pendingKg,
      otherGradeKgHidden: Math.max(state.qualifiedKg - visibleQualifiedKg, 0),
      notices: visibleNotices.map(notice => ({
        notice: notice.notice,
        grade: notice.grade,
        quantityKg: notice.quantityKg,
        intensityRange: {
          kwhPerT: { lo: round(notice.intensity.kwh.lo), hi: round(notice.intensity.kwh.hi) },
          m3PerT: { lo: round(notice.intensity.m3.lo), hi: round(notice.intensity.m3.hi) },
        },
        // 依据类型可见，依据背后的公共表量不可见。
        basis: notice.basis,
        sources: notice.burden.sourceLots.map(s => ({ lot: s.lot, kg: s.kg })),
      })),
    };
  });

  const declarations = releases.impacts
    .filter(impact => ownOrderIds.has(impact.order))
    .map(impact => ({
      document: impact.document,
      order: impact.order,
      kg: impact.kg,
      signedShift: impact.signedShift,
      reissueRequired: impact.reissueRequired,
      stillCompliant: impact.stillCompliant,
      changes: impact.changes.map(change => ({
        metric: change.metric,
        before: scalarOf(change.before),
        after: scalarOf(change.after),
        affectedUsage: change.affectedUsage ?? null,
      })),
    }));

  return { client: clientId, cutoff, found: true, orders, batches, declarations };
}

function scalarOf(value) {
  if (value && typeof value === 'object' && 'lo' in value) {
    return { lo: round(value.lo), hi: round(value.hi), basis: value.estimated ? '协议估计' : '实测' };
  }
  return value;
}

function round(value) {
  return Math.round(value * 1e6) / 1e6;
}
