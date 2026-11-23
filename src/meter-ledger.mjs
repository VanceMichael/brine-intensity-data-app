// 计量台账：按 (班次, 计量范围 meter) 维护表具链与某一截止班号下的有效记录。
//
// 字段语义：meter 是计量范围（plant 总表 / line-* 专表 / raw-water 水总表），
// scope 是介质（electric / water）。
//
// 口径要点：
// 1. 表具更换（replaces）后，新表从现场首个读数起计，用量 = closing - opening，
//    绝不与上一只设备的末读相减；回零（opening=0）是正常现象。
// 2. meter-revisions 是计量员“实际取得数据”的班号；某截止班号 k 的重放，
//    只能使用 known_shift <= k 的记录。correction 以 replaces 确认替代旧记录。
// 3. 缺测不是零：记录存在但 opening/closing 为空，状态是 missing；
//    截止班号下连记录都没有，状态是 no_record。两者都进缺表口径，不参与实测守恒。

function byId(rows) {
  return new Map(rows.map(row => [row.id, row]));
}

export function buildMeterLedger(data) {
  const records = data.meter;
  const index = byId(records);
  const revision = new Map(data.meterRevisions.map(row => [row.entry, row]));

  function knownShiftOf(id) {
    const rev = revision.get(id);
    if (!rev) throw new Error(`meter-revisions 缺少表具 ${id} 的取得班号`);
    return rev.known_shift;
  }

  function statusOf(id) {
    return revision.get(id).batch_status;
  }

  function usageOf(row) {
    if (row.opening === null || row.closing === null) return null;
    const value = row.closing - row.opening;
    if (value < 0) throw new Error(`表具 ${row.id} 读数倒挂（closing < opening）`);
    return value;
  }

  // correction（补交/更正）自成一链；换表记录（read/missing）按计量范围归同一设备链。
  function chainKeyOf(row) {
    if (statusOf(row.id) === 'correction') return `correction|${row.shift}|${row.meter}|${row.id}`;
    return `device|${row.meter}`;
  }

  const chains = new Map();
  for (const row of records) {
    const key = chainKeyOf(row);
    if (!chains.has(key)) chains.set(key, []);
    chains.get(key).push(row);
  }

  // (班次, 计量范围) -> 相关链。
  const scopeIndex = new Map();
  for (const [chainKey, members] of chains) {
    for (const row of members) {
      const key = `${row.shift}|${row.meter}`;
      if (!scopeIndex.has(key)) {
        scopeIndex.set(key, { shift: row.shift, meter: row.meter, scope: row.scope, unit: row.unit, chainKeys: [] });
      }
      const item = scopeIndex.get(key);
      if (!item.chainKeys.includes(chainKey)) item.chainKeys.push(chainKey);
    }
  }
  const scopes = [...scopeIndex.values()].sort(
    (a, b) => a.shift - b.shift || a.meter.localeCompare(b.meter),
  );

  // 同一 (班次, 计量范围)：更正链可见时 correction 生效，否则取设备链本班记录。
  function effectiveInScope(item, cutoff) {
    const visible = item.chainKeys
      .flatMap(chainKey => chains.get(chainKey))
      .filter(row => row.shift === item.shift && knownShiftOf(row.id) <= cutoff);
    if (visible.length === 0) return null;
    const corrections = visible.filter(row => statusOf(row.id) === 'correction');
    const pool = corrections.length > 0 ? corrections : visible;
    return [...pool].sort((a, b) => knownShiftOf(b.id) - knownShiftOf(a.id) || a.id.localeCompare(b.id))[0];
  }

  function effectiveView(cutoff) {
    const view = [];
    for (const item of scopes) {
      const row = effectiveInScope(item, cutoff);
      if (!row) {
        view.push({ shift: item.shift, meter: item.meter, scope: item.scope, unit: item.unit, state: 'no_record', record: null, usage: null, estimated: true });
        continue;
      }
      const usage = usageOf(row);
      view.push({
        shift: item.shift,
        meter: row.meter,
        scope: row.scope,
        unit: row.unit,
        state: usage === null ? 'missing' : 'measured',
        record: row.id,
        replaces: row.replaces,
        revisionStatus: statusOf(row.id),
        knownShift: knownShiftOf(row.id),
        usage,
        estimated: usage === null,
      });
    }
    return view;
  }

  // 替代追溯：correction 按 replaces 指向被替代记录（允许跨班次）。
  function supersessions() {
    return records
      .filter(row => statusOf(row.id) === 'correction' && row.replaces)
      .map(row => ({
        shift: row.shift,
        meter: row.meter,
        scope: row.scope,
        superseded: row.replaces,
        supersededUsage: usageOf(index.get(row.replaces)),
        replacement: row.id,
        replacementUsage: usageOf(row),
        knownShift: knownShiftOf(row.id),
      }));
  }

  return { scopes, effectiveView, supersessions, knownShiftOf, usageOf };
}
