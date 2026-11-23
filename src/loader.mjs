// 交接资料装载：读取 fixtures 目录下的 CSV，并按业务字段完成数值转换。
// 空字符串保持为 null（数值字段），关系字段的 '-' 统一转为 null。
import { readFile } from 'node:fs/promises';
import { parseCsv } from './csv.mjs';

const num = value => (value === '' ? null : Number(value));
const ref = value => (value === '' || value === '-' ? null : value);

function convert(rows, numericFields, refFields) {
  return rows.map(row => {
    const out = { ...row };
    for (const field of numericFields) {
      if (field in out) out[field] = num(out[field]);
    }
    for (const field of refFields) {
      if (field in out) out[field] = ref(out[field]);
    }
    return out;
  });
}

export async function loadData(folder) {
  const base = folder.endsWith('/') ? folder : `${folder}/`;
  const read = async name => parseCsv(await readFile(`${base}${name}.csv`, 'utf8'));

  const [meter, production, quality, orders, allocationBasis, meterRevisions, stockMovements, releases] =
    await Promise.all([
      read('meter'),
      read('production'),
      read('quality'),
      read('orders'),
      read('allocation-basis'),
      read('meter-revisions'),
      read('stock-movements'),
      read('releases'),
    ]);

  return {
    meter: convert(meter, ['shift', 'opening', 'closing'], ['replaces']),
    production: convert(
      production,
      ['shift', 'input_kg', 'finished_kg', 'reuse_kg'],
      ['tank_in', 'tank_out'],
    ),
    quality: convert(quality, ['quantity_kg', 'known_shift'], ['parent']),
    orders: convert(orders, ['quantity_kg', 'max_kwh_per_t', 'max_m3_per_t', 'known_shift'], ['batch']),
    allocationBasis: convert(
      allocationBasis,
      ['shift', 'driver_amount', 'water_est_lower', 'water_est_upper', 'electric_est_lower', 'electric_est_upper'],
      [],
    ),
    meterRevisions: convert(meterRevisions, ['known_shift'], []),
    stockMovements: convert(stockMovements, ['shift', 'net_kg'], ['lot']),
    releases: convert(releases, ['signed_shift', 'kg'], ['quality_notice', 'electric_record']),
  };
}
