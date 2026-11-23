// 订单判定与库存占用。
//
// 口径要点：
// - 出货前按客户用途对应的质量下限与能耗上限判定：
//   可声明（区间完全满足且有足额同级实物）、越界（写明哪一项）、
//   暂不能判定（缺表估计区间跨线、终检未完成等，保留实物可分配性与补证要求）。
// - 高质量等级不自动顶替低等级用途；改配必须显式操作并通过同一套判定。
// - requested 只是请求，不占用实物；signed 订单的已确认交付量占用通知库存，
//   同一罐/同一通知实物不得一货多占；改配只允许动未确认部分。

export function buildInventory(data, quality, cutoff) {
  // 通知级库存（按当前生效质量通知）。pending 通知不计入可分配合格库存。
  const stock = new Map();
  for (const state of quality.lotState.values()) {
    for (const notice of state.notices) {
      stock.set(notice.notice, {
        notice: notice.notice,
        lot: state.lot,
        batch: notice.batch,
        grade: notice.grade,
        kg: notice.quantityKg,
        qualified: notice.grade !== 'pending',
      });
    }
  }

  // 已签批交付（截止班号前签发）建立占用。
  // 质量复判拆批后，原通知可能已失效：按当前生效通知与实物净量映射占用，
  // 原交付单号保留，保证已确认交付量仍被同一实物承载、不会一货多占。
  const occupancy = new Map(); // notice -> [{ document, order, client, kg }]
  const occupiedKg = noticeId =>
    (occupancy.get(noticeId) ?? []).reduce((acc, item) => acc + item.kg, 0);

  const hold = (noticeId, item) => {
    if (!occupancy.has(noticeId)) occupancy.set(noticeId, []);
    occupancy.get(noticeId).push(item);
  };

  for (const release of data.releases.filter(r => r.signed_shift <= cutoff)) {
    const order = data.orders.find(o => o.order === release.order);
    if (!order) throw new Error(`交付单 ${release.document} 的订单 ${release.order} 不存在`);
    const baseItem = { document: release.document, order: release.order, client: order.client, kg: release.kg };

    if (stock.has(release.quality_notice)) {
      hold(release.quality_notice, baseItem);
      continue;
    }
    // 原通知已被复判替换：沿质量台账找承接实物的生效通知。
    // 已确认交付量只能由与原通知同级的承接通知占用；拆批后降级的部分不能顶替，
    // 若同级承接实物不足，直接报错交业务处理，不做静默占用。
    const replaced = findReplacementNotices(release.quality_notice);
    if (replaced.length === 0) {
      throw new Error(`交付占用引用的质量通知 ${release.quality_notice} 已失效且找不到承接实物`);
    }
    const originalGrade = data.quality.find(n => n.notice === release.quality_notice).grade;
    const sameGradeSuccessors = replaced.filter(n => n.grade === originalGrade);
    const successorKg = sameGradeSuccessors.reduce((acc, n) => acc + n.quantityKg, 0);
    if (release.kg > successorKg + 1e-9) {
      throw new Error(
        `交付单 ${release.document} 的 ${release.kg}kg ${originalGrade} 实物在复判后同级仅余 ${successorKg}kg，无法继续占用`,
      );
    }
    let allocated = 0;
    sameGradeSuccessors.forEach((notice, index) => {
      const kg = index === sameGradeSuccessors.length - 1
        ? release.kg - allocated
        : (release.kg * notice.quantityKg) / successorKg;
      allocated += kg;
      hold(notice.notice, { ...baseItem, kg, mappedFrom: release.quality_notice });
    });
  }

  function findReplacementNotices(noticeId) {
    const original = data.quality.find(n => n.notice === noticeId);
    if (!original) return [];
    const lotId = original.batch;
    const state = quality.lotState.get(lotId);
    if (!state || !state.replacedNotices.includes(noticeId)) return [];
    return state.notices;
  }

  // 超占防护（资料错误时直接暴露）。
  for (const [noticeId, items] of occupancy) {
    const held = items.reduce((acc, item) => acc + item.kg, 0);
    const available = stock.get(noticeId);
    if (!available) throw new Error(`交付占用引用了不存在的质量通知 ${noticeId}`);
    if (held > available.kg + 1e-9) {
      throw new Error(`质量通知 ${noticeId} 占用 ${held}kg 超过实物 ${available.kg}kg`);
    }
  }

  function availableNotices(lotId) {
    return [...stock.values()]
      .filter(item => item.lot === lotId && item.qualified)
      .map(item => ({ ...item, occupiedKg: occupiedKg(item.notice), freeKg: item.kg - occupiedKg(item.notice) }));
  }

  function decideOrder(order) {
    const state = quality.lotState.get(order.batch);
    if (!state) throw new Error(`订单 ${order.order} 引用了未知批次 ${order.batch}`);

    const blockers = [];
    const evidence = [];

    // 已签批订单的交付量已确认占用，出货前判定只针对未签发的请求；
    // 已签批订单的后续变化走声明变更追溯（releases），不在此重复判数量。
    if (order.state === 'signed') {
      const held = [...occupancy.values()]
        .flat()
        .filter(item => item.order === order.order)
        .reduce((acc, item) => acc + item.kg, 0);
      return {
        order: order.order,
        client: order.client,
        batch: order.batch,
        state: order.state,
        requestedKg: order.quantity_kg,
        minGrade: order.min_grade,
        verdict: '已签批',
        blockers: [],
        evidence: [{
          type: '签批提示',
          requirement: `已确认交付 ${held}kg；依据变化请查声明变更追溯，原单据按签发资料复核`,
        }],
        capChecks: [],
        sameGradeFree: [],
        allocatable: false,
      };
    }

    const sameGrade = state.notices.filter(
      n => n.grade === order.min_grade && n.grade !== 'pending',
    );
    const higherGrade = state.notices.filter(
      n => n.grade !== 'pending' && n.grade !== order.min_grade &&
        quality.gradeAtLeast(n.grade, order.min_grade),
    );
    const pending = state.pendingNotices;

    // 同级可用实物（扣已占用）。
    const sameGradeFree = sameGrade.map(n => ({
      notice: n.notice,
      grade: n.grade,
      quantityKg: n.quantityKg,
      occupiedKg: occupiedKg(n.notice),
      freeKg: n.quantityKg - occupiedKg(n.notice),
      detail: n,
    }));
    const freeKg = sameGradeFree.reduce((acc, item) => acc + Math.max(item.freeKg, 0), 0);

    let verdict = '可声明';
    if (sameGrade.length === 0 && pending.length > 0) {
      verdict = '暂不能判定';
      blockers.push({ item: '终检', reason: `批次 ${order.batch} 尚有 ${state.pendingKg}kg 未达到可比终检口径` });
      evidence.push({ type: '补证要求', requirement: '等待可比终检通知（pending 量不得计为合格产量）' });
    } else if (freeKg < order.quantity_kg - 1e-9) {
      verdict = '越界';
      blockers.push({
        item: '数量',
        reason: `同级 ${order.min_grade} 可用实物 ${freeKg}kg，不足订单 ${order.quantity_kg}kg（缺口 ${(order.quantity_kg - freeKg).toFixed(3)}kg）`,
      });
      if (higherGrade.length > 0) {
        evidence.push({
          type: '改配提示',
          requirement: `存在更高等级实物 ${higherGrade.map(n => `${n.notice}(${n.quantityKg}kg)`).join('、')}，如需顶替须显式改配并复核限值`,
        });
      }
    }

    // 强度逐项判定（按同级通知分别检查；任一通知越界即写明）。
    const capChecks = [];
    for (const notice of sameGrade) {
      const caps = quality.evaluateCaps(notice, order);
      capChecks.push({ notice: notice.notice, ...caps });
      for (const kind of ['electric', 'water']) {
        const check = caps[kind];
        if (check.result === 'over') {
          verdict = verdict === '暂不能判定' ? verdict : '越界';
          blockers.push({
            item: kind === 'electric' ? '单位电耗' : '取水强度',
            reason: `${notice.notice} 区间 [${check.interval.lo.toFixed(3)}, ${check.interval.hi.toFixed(3)}] 整体超过上限 ${check.cap}`,
          });
        } else if (check.result === 'indeterminate') {
          if (verdict !== '越界') verdict = '暂不能判定';
          blockers.push({
            item: kind === 'electric' ? '单位电耗' : '取水强度',
            reason: `${notice.notice} 区间 [${check.interval.lo.toFixed(3)}, ${check.interval.hi.toFixed(3)}] 跨越上限 ${check.cap}，补证前不能判定`,
          });
          evidence.push({
            type: '补证要求',
            requirement: `${check.basis}依据需补实测表量收窄区间（通知 ${notice.notice}）`,
          });
        }
      }
    }

    // 暂不能判定时保留实物可分配性。
    const allocatable = verdict !== '越界';

    return {
      order: order.order,
      client: order.client,
      batch: order.batch,
      state: order.state,
      requestedKg: order.quantity_kg,
      minGrade: order.min_grade,
      verdict,
      blockers,
      evidence,
      capChecks,
      sameGradeFree: sameGradeFree.map(({ detail, ...rest }) => rest),      allocatable,
    };
  }

  // 显式改配：把某通知的未占用实物分配给另一客户订单，先做同一套判定。
  function reallocate({ order, fromNotice, kg }) {
    const item = stock.get(fromNotice);
    if (!item) throw new Error(`改配失败：质量通知 ${fromNotice} 不存在`);
    if (!item.qualified) throw new Error(`改配失败：${fromNotice} 为 pending，未达可比终检口径`);
    const free = item.kg - occupiedKg(fromNotice);
    if (kg > free + 1e-9) {
      throw new Error(`改配失败：${fromNotice} 未占用实物仅 ${free}kg，申请 ${kg}kg（已确认交付不得一货多占）`);
    }
    const noticeDetail = quality.noticeById(fromNotice);
    const caps = quality.evaluateCaps(noticeDetail, order);
    const failed = ['electric', 'water'].filter(kind => caps[kind].result !== 'pass');
    if (failed.length > 0) {
      throw new Error(`改配失败：${fromNotice} 对订单 ${order.order} 的 ${failed.join('、')} 限值不满足`);
    }
    if (!quality.gradeAtLeast(item.grade, order.min_grade)) {
      throw new Error(`改配失败：${fromNotice} 等级 ${item.grade} 低于订单下限 ${order.min_grade}`);
    }
    return {
      order: order.order,
      client: order.client,
      notice: fromNotice,
      kg,
      caps,
      note: '改配仅登记意向；未签发交付单前不构成占用',
    };
  }

  return { stock, occupancy, occupiedKg, availableNotices, decideOrder, reallocate };
}
