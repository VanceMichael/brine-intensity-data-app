// 区间运算。计量口径中同时存在实测点值与协议估计区间，
// 全程以 [下限, 上限] 传递，点值表示 lo === hi，不提前压成单一数字。
// estimated 标记该区间是否来自协议估计（缺表），用于依据类型展示与补证要求。

export function point(value, estimated = false) {
  if (!Number.isFinite(value)) throw new Error('区间端点必须是有限数');
  return { lo: value, hi: value, estimated };
}

export function interval(lo, hi, estimated = true) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) {
    throw new Error(`非法区间 [${lo}, ${hi}]`);
  }
  return { lo, hi, estimated };
}

export function isPoint(x) {
  return x.lo === x.hi;
}

export function add(a, b) {
  return {
    lo: a.lo + b.lo,
    hi: a.hi + b.hi,
    estimated: a.estimated || b.estimated,
  };
}

export function sum(intervals) {
  return intervals.reduce((acc, item) => add(acc, item), point(0));
}

export function scale(x, factor) {
  if (factor < 0) throw new Error('实物量系数不能为负');
  return { lo: x.lo * factor, hi: x.hi * factor, estimated: x.estimated };
}

// 除以实物量（kg、t 等），分母为 0 时调用方应已拦截，这里不臆造结果。
export function divide(x, denominator) {
  if (!(denominator > 0)) throw new Error('分摊分母必须为正数');
  return scale(x, 1 / denominator);
}

// 与合同上限比较：
//   pass         区间整体不越界（含贴线）
//   over         区间整体越界（连下限都高于上限）
//   indeterminate 区间跨越上限，补证前不能判定
export function compareCap(x, cap) {
  if (x.hi <= cap) return 'pass';
  if (x.lo > cap) return 'over';
  return 'indeterminate';
}

export function basisType(x) {
  return x.estimated ? '协议估计' : '实测';
}
