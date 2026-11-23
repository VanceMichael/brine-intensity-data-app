// 只读 CSV 解析与序列化。交接资料约定：UTF-8、逗号分隔、无引号、无内嵌换行。
// 保持空字段为空字符串，关系值 '-' 由调用方按语义解释为“不适用”。

export function parseCsv(content) {
  const lines = content.trimEnd().split(/\r?\n/);
  if (lines.length === 0) return [];
  const header = lines.shift().split(',');
  return lines.map((line, index) => {
    const cells = line.split(',');
    if (cells.length !== header.length || line.includes('"')) {
      throw new Error(`第 ${index + 2} 行不是约定的字段格式（字段数 ${cells.length}，表头 ${header.length}）`);
    }
    return Object.fromEntries(header.map((field, position) => [field, cells[position]]));
  });
}

export function assertHeader(rows, fields, table) {
  // parseCsv 已按首行生成键，这里仅复核字段顺序与清单一致。
  const keys = Object.keys(rows[0] ?? {});
  if (keys.length !== fields.length || fields.some((field, i) => field !== keys[i])) {
    throw new Error(`${table} 的表头与格式约定不一致`);
  }
}

function escapeCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(text)) throw new Error('交接资料约定不允许引号、逗号或内嵌换行');
  return text;
}

export function toCsv(fields, rows) {
  const body = rows.map(row => fields.map(field => escapeCell(row[field])).join(','));
  return [fields.join(','), ...body].join('\n') + '\n';
}
