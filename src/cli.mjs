// 命令行入口，供计量、质保、合同交付人员日常使用。
// 用法：
//   node src/cli.mjs order <订单号> [--cutoff N] [--dir fixtures]
//   node src/cli.mjs stock [--cutoff N]
//   node src/cli.mjs reallocate <订单号> <质量通知> <kg> [--cutoff N]
//   node src/cli.mjs client <客户号> [--cutoff N]
//   node src/cli.mjs release <交付单号> [--cutoff N]
//   node src/cli.mjs replay [--cutoff N]
//   node src/cli.mjs replay --shifts=1,2,3
import { resolve } from 'node:path';
import { buildModel, LATEST_CUTOFF } from './model.mjs';
import { buildClientView } from './client-view.mjs';
import { replay } from './month-end.mjs';

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (const token of argv) {
    if (token.startsWith('--')) {
      const [key, value] = token.slice(2).split('=');
      flags[key] = value ?? true;
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, ...rest] = positional;
  const cutoff = flags.cutoff ? Number(flags.cutoff) : LATEST_CUTOFF;
  const dir = resolve(flags.dir ?? 'fixtures');
  const model = await buildModel(dir, cutoff);

  switch (command) {
    case 'order': {
      const order = model.data.orders.find(o => o.order === rest[0]);
      if (!order) throw new Error(`订单 ${rest[0]} 不存在`);
      print(model.inventory.decideOrder(order));
      break;
    }
    case 'stock': {
      print([...model.inventory.stock.values()].map(item => ({
        ...item,
        occupiedKg: model.inventory.occupiedKg(item.notice),
        freeKg: item.kg - model.inventory.occupiedKg(item.notice),
      })));
      break;
    }
    case 'reallocate': {
      const [orderId, noticeId, kgText] = rest;
      const order = model.data.orders.find(o => o.order === orderId);
      if (!order) throw new Error(`订单 ${orderId} 不存在`);
      print(model.inventory.reallocate({ order, fromNotice: noticeId, kg: Number(kgText) }));
      break;
    }
    case 'client': {
      print(buildClientView(model.data, model, rest[0]));
      break;
    }
    case 'release': {
      const impact = model.releases.impacts.find(item => item.document === rest[0]);
      if (!impact) throw new Error(`交付单 ${rest[0]} 在截止班号 ${cutoff} 下不可见或不存在`);
      print(impact);
      break;
    }
    case 'replay': {
      if (flags.shifts) {
        const cutoffs = flags.shifts.split(',').map(value => Number(value.trim()));
        const results = [];
        for (const at of cutoffs) {
          // 不同班次组合各自独立重放，互不覆盖。
          // eslint-disable-next-line no-await-in-loop
          const partial = await buildModel(dir, at);
          results.push(replay(partial));
        }
        print(results);
      } else {
        print(replay(model));
      }
      break;
    }
    default:
      throw new Error(`未知命令 ${command ?? ''}，可选：order|stock|reallocate|client|release|replay`);
  }
}

main().catch(error => {
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
});
