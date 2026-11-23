// 质量复判与批次强度。
//
// 口径要点：
// - quality 通知按 known_shift 生效；同一对象（batch 或 parent 下的拆批）
//   出现后续通知即构成复判，旧通知被同实物量的新通知替代，原单据仍可按
//   签发时资料复核（声明模块保留快照）。
// - 拆批：子批 quantity_kg 之和必须等于父批实物量；各子批按自身实物净量
//   承担父批强度（强度 = 父批单位负担，负担 = 单位负担 × 子批净量）。
// - 合批：多个来源批次合为一个新 batch 时，强度按各来源实物净量加权。
// - grade=pending 表示尚未达到可比终检口径：该量在分母明细另列，
//   即使已经先出货也不得计为合格产量。
// - 强度区间带 estimated 标记（任一来源为协议估计即保留），不提前压点。

import { basisType, compareCap, scale, sum } from './interval.mjs';

const GRADE_RANK = { battery: 3, industrial: 2, pending: 1 };

export function gradeAtLeast(grade, minGrade) {
  return GRADE_RANK[grade] >= GRADE_RANK[minGrade];
}

export function buildQuality(data, liquor, cutoff) {
  const notices = data.quality
    .filter(row => row.known_shift <= cutoff)
    .sort((a, b) => a.known_shift - b.known_shift || a.notice.localeCompare(b.notice));

  // 父批 -> 子批通知（拆批/合批来源）。
  const childrenByParent = new Map();
  for (const notice of notices) {
    if (!notice.parent) continue;
    if (!childrenByParent.has(notice.parent)) childrenByParent.set(notice.parent, []);
    childrenByParent.get(notice.parent).push(notice);
  }

  const lotState = new Map();

  function lotRate(lotId) {
    const entry = liquor.lotBurden.get(lotId);
    if (!entry) throw new Error(`生产批次 ${lotId} 缺少母液台账负担记录`);
    return entry.ratePerKg;
  }

  function noticeBurden(notice) {
    // 拆批：父批单位强度 × 子批实物净量。
    if (notice.parent) {
      const rate = lotRate(notice.parent);
      return {
        electric: scale(rate.electric, notice.quantity_kg),
        water: scale(rate.water, notice.quantity_kg),
        sourceLots: [{ lot: notice.parent, kg: notice.quantity_kg }],
      };
    }
    const rate = lotRate(notice.batch);
    return {
      electric: scale(rate.electric, notice.quantity_kg),
      water: scale(rate.water, notice.quantity_kg),
      sourceLots: [{ lot: notice.batch, kg: notice.quantity_kg }],
    };
  }

  // 每个生产批次当前生效的通知集合：
  // - 拆批（有 parent）后父批整体被替换，全部子批通知生效；
  // - 同批次的直接通知构成复判链，只有最晚 known_shift 的一条生效，
  //   旧通知（如先 pending 后降级/转正）被同实物量替代，保留在 replacedNotices 可追溯。
  for (const lot of data.production) {
    const direct = notices.filter(n => !n.parent && n.batch === lot.id);
    const children = childrenByParent.get(lot.id) ?? [];
    let active;
    let replacedDirect = [];
    if (children.length > 0) {
      active = children;
      replacedDirect = direct.map(n => n.notice);
    } else if (direct.length > 1) {
      const latest = direct[direct.length - 1];
      active = [latest];
      replacedDirect = direct.slice(0, -1).map(n => n.notice);
    } else {
      active = direct;
    }

    const conservationErrors = [];
    if (children.length > 0) {
      const childSum = children.reduce((acc, n) => acc + n.quantity_kg, 0);
      const parentQty = direct.length > 0 ? direct[direct.length - 1].quantity_kg : lot.finished_kg;
      if (Math.abs(childSum - parentQty) > 1e-9) {
        conservationErrors.push(
          `批次 ${lot.id} 拆批实物量 ${childSum}kg 与原批 ${parentQty}kg 不守恒`,
        );
      }
    }

    const noticeDetails = active.map(notice => {
      const burden = noticeBurden(notice);
      const ratePerTonne = {
        kwh: scale(burden.electric, 1000 / notice.quantity_kg),
        m3: scale(burden.water, 1000 / notice.quantity_kg),
      };
      return {
        notice: notice.notice,
        batch: notice.batch,
        parent: notice.parent,
        quantityKg: notice.quantity_kg,
        grade: notice.grade,
        knownShift: notice.known_shift,
        burden,
        intensity: ratePerTonne,
        basis: {
          electric: basisType(ratePerTonne.kwh),
          water: basisType(ratePerTonne.m3),
        },
      };
    });

    const qualified = noticeDetails.filter(n => n.grade !== 'pending');
    const pending = noticeDetails.filter(n => n.grade === 'pending');
    const qualifiedKg = qualified.reduce((acc, n) => acc + n.quantityKg, 0);
    const pendingKg = pending.reduce((acc, n) => acc + n.quantityKg, 0);

    // 合格口径的加权强度（只对可比终检量加权；pending 另列，不进分母）。
    const qualifiedIntensity = qualifiedKg > 0
      ? {
          kwh: weighted(qualified, 'kwh', qualifiedKg),
          m3: weighted(qualified, 'm3', qualifiedKg),
        }
      : null;

    lotState.set(lot.id, {
      lot: lot.id,
      shift: lot.shift,
      finishedKg: lot.finished_kg,
      notices: noticeDetails,
      qualifiedNotices: qualified,
      pendingNotices: pending,
      qualifiedKg,
      pendingKg,
      qualifiedIntensity,
      conservationErrors,
      replacedNotices: replacedDirect,
    });
  }

  function weighted(details, key, totalKg) {
    const parts = details.map(n => scale(n.intensity[key], n.quantityKg / totalKg));
    return sum(parts);
  }

  function noticeById(noticeId) {
    for (const state of lotState.values()) {
      const found = state.notices.find(n => n.notice === noticeId);
      if (found) return found;
    }
    return null;
  }

  function noticesByLot(lotId, { includePending = true } = {}) {
    const state = lotState.get(lotId);
    if (!state) return [];
    return includePending ? state.notices : state.qualifiedNotices;
  }

  // 对客户合同限值做强度判定，返回逐项结论。
  function evaluateCaps(noticeDetail, order) {
    const electric = compareCap(noticeDetail.intensity.kwh, order.max_kwh_per_t);
    const water = compareCap(noticeDetail.intensity.m3, order.max_m3_per_t);
    return {
      electric: {
        result: electric,
        interval: noticeDetail.intensity.kwh,
        cap: order.max_kwh_per_t,
        basis: noticeDetail.basis.electric,
      },
      water: {
        result: water,
        interval: noticeDetail.intensity.m3,
        cap: order.max_m3_per_t,
        basis: noticeDetail.basis.water,
      },
    };
  }

  return { cutoff, notices, lotState, noticeById, noticesByLot, evaluateCaps, gradeAtLeast };
}
