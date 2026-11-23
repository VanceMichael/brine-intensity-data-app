// 母液流转台账（stock-movements + production 联动）。
//
// 口径要点：
// - 母液流转以 stock-movements 为准：consumed_liquid 从罐内实物按 FIFO 扣量，
//   被耗用的回用部分继承此前按实物量归属的计量负担；未耗用的余量仍在罐内，
//   连同其负担一起跨班结转为在制品，不做任何轧差。
// - 同一实物的负担（电 kWh、水 m³ 区间）按 kg 单价携带，回用不重复结转：
//   出罐即从罐层扣除，进罐即建立新层，负担只随实物移动一次。
// - 一个生产批次的单位负担 = （本班公辅归属 + 耗用母液继承负担）
//   ÷（终检成品 + 本班出罐母液等带负担实物口径），分母明细完整保留。

import { add, divide, point, scale, sum } from './interval.mjs';

function movementsByShift(data) {
  const map = new Map();
  for (const move of data.stockMovements) {
    if (!map.has(move.shift)) map.set(move.shift, []);
    map.get(move.shift).push(move);
  }
  return map;
}

export function buildLiquorLedger(data, allocations) {
  const moves = movementsByShift(data);
  const tanks = new Map(); // tank -> 层数组 [{ kg, burden: { electric, water }, originLot }]
  const lotBurden = new Map();
  const checks = [];

  const layersOf = tank => {
    if (!tanks.has(tank)) tanks.set(tank, []);
    return tanks.get(tank);
  };

  function consume(tank, kg, shift, movementId) {
    const layers = layersOf(tank);
    let need = kg;
    const inherited = { electric: point(0), water: point(0) };
    const traces = [];
    while (need > 1e-9) {
      const layer = layers[0];
      if (!layer) {
        throw new Error(`班次 ${shift} 母液耗用 ${movementId} 超出罐 ${tank} 存量（缺口 ${need.toFixed(3)} kg）`);
      }
      const take = Math.min(layer.kg, need);
      const fraction = take / layer.kg;
      inherited.electric = add(inherited.electric, scale(layer.burden.electric, fraction));
      inherited.water = add(inherited.water, scale(layer.burden.water, fraction));
      traces.push({ originLot: layer.originLot, tank, kg: take });
      layer.kg -= take;
      layer.burden = {
        electric: scale(layer.burden.electric, 1 - fraction),
        water: scale(layer.burden.water, 1 - fraction),
      };
      if (layer.kg <= 1e-9) layers.shift();
      need -= take;
    }
    return { inherited, traces };
  }

  function deposit(tank, kg, burden, originLot) {
    if (kg <= 1e-9) return;
    layersOf(tank).push({ kg, burden, originLot });
  }

  const ordered = [...data.production].sort((a, b) => a.shift - b.shift || a.id.localeCompare(b.id));

  for (const lot of ordered) {
    const shiftMoves = moves.get(lot.shift)?.filter(m => m.lot === lot.id) ?? [];
    const consumedMoves = shiftMoves.filter(m => m.kind === 'consumed_liquid');
    const returnedMoves = shiftMoves.filter(m => m.kind === 'returned_liquid');

    // 与 production.reuse_kg 交叉核对，不一致直接报错，不静默默认。
    const consumedKg = consumedMoves.reduce((acc, m) => acc + m.net_kg, 0);
    if (Math.abs(consumedKg - lot.reuse_kg) > 1e-9) {
      throw new Error(
        `批次 ${lot.id} 母液耗用量不一致：stock-movements ${consumedKg}kg vs production.reuse_kg ${lot.reuse_kg}kg`,
      );
    }
    checks.push({ lot: lot.id, reuseKg: consumedKg, matched: true });

    // 1) 先处理本班耗用（FIFO），继承历史负担。
    let inherited = { electric: point(0), water: point(0) };
    const inheritTraces = [];
    for (const move of consumedMoves) {
      const result = consume(move.tank, move.net_kg, lot.shift, move.movement);
      inherited = {
        electric: add(inherited.electric, result.inherited.electric),
        water: add(inherited.water, result.inherited.water),
      };
      inheritTraces.push(...result.traces);
    }

    // 2) 本班公辅归属（区间，缺表时带 estimated 标记）。
    const electricBurden = allocations.lineBurden(lot.shift, lot.line, 'electric').interval;
    const waterBurden = allocations.lineBurden(lot.shift, lot.line, 'water').interval;

    const direct = { electric: electricBurden, water: waterBurden };
    const totalBurden = {
      electric: add(direct.electric, inherited.electric),
      water: add(direct.water, inherited.water),
    };

    // 3) 负担落到承载实物：终检成品 + 本班出罐母液（按 kg 同单价）。
    const returnedKg = returnedMoves.reduce((acc, m) => acc + m.net_kg, 0);
    const carryingKg = lot.finished_kg + returnedKg;
    if (!(carryingKg > 0)) throw new Error(`批次 ${lot.id} 负担承载实物为 0，无法定义单位强度`);

    const rate = {
      electric: divide(totalBurden.electric, carryingKg),
      water: divide(totalBurden.water, carryingKg),
    };

    // 成品与出罐母液各自按实物量承担。
    const finishedBurden = {
      electric: scale(rate.electric, lot.finished_kg),
      water: scale(rate.water, lot.finished_kg),
    };

    for (const move of returnedMoves) {
      deposit(move.tank, move.net_kg, {
        electric: scale(rate.electric, move.net_kg),
        water: scale(rate.water, move.net_kg),
      }, lot.id);
    }

    lotBurden.set(lot.id, {
      lot: lot.id,
      shift: lot.shift,
      line: lot.line,
      finishedKg: lot.finished_kg,
      returnedKg,
      carryingKg,
      reuseKg: consumedKg,
      direct,
      inherited,
      inheritTraces,
      totalBurden,
      finishedBurden,
      ratePerKg: rate,
    });
  }

  // 罐内余量快照：跨班在制品，负担随实物保留。
  const tankRemainder = [];
  for (const [tank, layers] of tanks) {
    const kg = layers.reduce((acc, layer) => acc + layer.kg, 0);
    if (kg <= 1e-9) continue;
    tankRemainder.push({
      tank,
      kg,
      burden: {
        electric: sum(layers.map(layer => layer.burden.electric)),
        water: sum(layers.map(layer => layer.burden.water)),
      },
      layers: layers.map(layer => ({ originLot: layer.originLot, kg: layer.kg })),
    });
  }

  return { lotBurden, tankRemainder, checks };
}
