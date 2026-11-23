// 签批声明（交付单）与变更追溯。
//
// 口径要点：
// - 交付单在签发班号 snapshot 当时的资料（计量记录、质量通知、强度区间、限值结论），
//   原单据永远可按签发时的资料复核：按 signed_shift 独立重放一套模型还原快照，
//   新数据永不覆盖旧快照。
// - 复判（拆批/合批/降级）或总表补交（correction）引起声明依据变化时，
//   必须追到受影响的用量、订单和需补发的客户。
// - 已确认交付量占用实物，后续变更只产生“补发/更正”动作，不改动原交付数量。

import { basisType } from './interval.mjs';

export function buildReleases(data, model) {
  const { quality, ledger, cutoff, modelAt } = model;

  // 当前资料下的快照：原通知可能已被复判替换，沿质量台账找同级承接通知；
  // 原表具可能已被 correction 替代，沿 supersession 找替代表具。
  function currentSnapshot(release) {
    const order = data.orders.find(o => o.order === release.order);
    const direct = quality.noticeById(release.quality_notice);
    const supersessions = ledger.supersessions();

    let notice = direct;
    let noticePath = [];
    if (!notice) {
      const original = data.quality.find(n => n.notice === release.quality_notice);
      const state = original ? quality.lotState.get(original.batch) : null;
      if (state && state.replacedNotices.includes(release.quality_notice)) {
        const sameGrade = state.notices.filter(n => n.grade === original.grade);
        notice = sameGrade[0] ?? state.notices[0];
        noticePath = state.notices.map(n => n.notice);
      }
    }

    let meterRecord = release.electric_record;
    let meterPath = [];
    let meterState = ledger.effectiveView(cutoff).find(item => item.record === meterRecord);
    if (!meterState) {
      const chain = resolveMeterChain(release.electric_record, supersessions);
      meterPath = chain.map(item => item.replacement);
      const latest = chain[chain.length - 1];
      if (latest) {
        meterRecord = latest.replacement;
        meterState = ledger.effectiveView(cutoff).find(item => item.record === meterRecord);
      }
    }

    if (!notice) {
      return {
        document: release.document,
        atShift: cutoff,
        status: '当前资料下找不到承接实物',
        recoverable: false,
        grade: null,
        intensity: null,
        caps: null,
        electricRecordState: meterState
          ? { record: meterState.record, state: meterState.state, usage: meterState.usage }
          : { record: meterRecord, state: 'not_visible', usage: null },
      };
    }

    const caps = quality.evaluateCaps(notice, order);
    return {
      document: release.document,
      atShift: cutoff,
      order: order.order,
      client: order.client,
      notice: notice.notice,
      noticePath,
      batch: notice.batch,
      grade: notice.grade,
      kg: release.kg,
      signedShift: release.signed_shift,
      electricRecord: meterRecord,
      electricRecordPath: meterPath,
      electricRecordState: meterState
        ? { record: meterState.record, state: meterState.state, usage: meterState.usage }
        : { record: meterRecord, state: 'not_visible', usage: null },
      intensity: notice.intensity,
      basis: notice.basis,
      caps: {
        electric: { ...caps.electric, cap: order.max_kwh_per_t },
        water: { ...caps.water, cap: order.max_m3_per_t },
      },
    };
  }

  // 沿 correction 的 replaces 链从旧表具走到最新替代表具。
  function resolveMeterChain(recordId, supersessions) {
    const chain = [];
    let current = recordId;
    const guard = new Set();
    while (current && !guard.has(current)) {
      guard.add(current);
      const next = supersessions.find(item => item.superseded === current);
      if (!next) break;
      chain.push(next);
      current = next.replacement;
    }
    return chain;
  }

  // 按签发班号重放的原始快照（原单据复核用）。
  function snapshotAt(release, atShift) {
    const historical = modelAt(atShift);
    const order = data.orders.find(o => o.order === release.order);
    const notice = historical.quality.noticeById(release.quality_notice);
    const meterView = historical.ledger.effectiveView(atShift);
    const meterAtSign = meterView.find(item => item.record === release.electric_record);

    if (!notice) {
      return {
        document: release.document,
        atShift,
        status: '签发时通知在该截止班号下不可见',
        recoverable: true,
        grade: null,
        intensity: null,
        caps: null,
        electricRecordState: { record: release.electric_record, state: 'not_visible', usage: null },
      };
    }
    const caps = historical.quality.evaluateCaps(notice, order);
    return {
      document: release.document,
      atShift,
      order: order.order,
      client: order.client,
      notice: notice.notice,
      batch: notice.batch,
      grade: notice.grade,
      kg: release.kg,
      signedShift: release.signed_shift,
      electricRecord: release.electric_record,
      electricRecordState: meterAtSign
        ? { record: meterAtSign.record, state: meterAtSign.state, usage: meterAtSign.usage }
        : { record: release.electric_record, state: 'replaced_or_not_visible', usage: null },
      intensity: notice.intensity,
      basis: notice.basis,
      caps: {
        electric: { ...caps.electric, cap: order.max_kwh_per_t },
        water: { ...caps.water, cap: order.max_m3_per_t },
      },
    };
  }

  const documents = data.releases
    .filter(r => r.signed_shift <= cutoff)
    .sort((a, b) => a.signed_shift - b.signed_shift || a.document.localeCompare(b.document));

  const snapshots = documents.map(release => currentSnapshot(release));

  // 变更影响分析：当前快照 vs 按签发班号重放的原始快照。
  const impacts = documents.map(release => {
    const order = data.orders.find(o => o.order === release.order);
    const original = snapshotAt(release, release.signed_shift);
    const current = currentSnapshot(release);
    const changes = [];

    if (original.intensity && current.intensity) {
      for (const kind of ['kwh', 'm3']) {
        const before = original.intensity[kind];
        const after = current.intensity[kind];
        const moved = Math.abs(before.lo - after.lo) > 1e-9 || Math.abs(before.hi - after.hi) > 1e-9;
        if (moved) {
          changes.push({
            metric: kind === 'kwh' ? '单位电耗' : '取水强度',
            before,
            after,
            basisChanged: basisType(before) !== basisType(after),
            // 受影响用量 = 声明交付量对应的负担差额（kg × 强度差 / 1000）。
            affectedUsage: {
              unit: kind === 'kwh' ? 'kWh' : 'm3',
              lower: (release.kg * (after.lo - before.lo)) / 1000,
              upper: (release.kg * (after.hi - before.hi)) / 1000,
            },
          });
        }
      }
    }

    if (original.grade !== current.grade) {
      changes.push({ metric: '质量等级', before: original.grade, after: current.grade });
    }
    if (original.electricRecordState && current.electricRecordState &&
        (original.electricRecordState.record !== current.electricRecordState.record ||
        original.electricRecordState.usage !== current.electricRecordState.usage)) {
      changes.push({ metric: '计量记录', before: original.electricRecordState, after: current.electricRecordState });
    }

    const stillCompliant = current.caps
      ? ['electric', 'water'].every(kind => current.caps[kind].result === 'pass')
      : null;

    return {
      document: release.document,
      order: order.order,
      client: order.client,
      kg: release.kg,
      signedShift: release.signed_shift,
      hasChanges: changes.length > 0,
      changes,
      stillCompliant,
      reissueRequired: changes.length > 0,
      reissueTo: changes.length > 0 ? order.client : null,
      original,
      current,
    };
  });

  const meterSupersessions = ledger.supersessions().filter(item => item.knownShift <= cutoff);

  return { documents, snapshots, impacts, meterSupersessions, snapshotAt };
}
