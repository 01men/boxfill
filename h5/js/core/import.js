/**
 * PI / CSV 导入（H5 与 MCP 服务端共用）。
 *
 * 放在 core/ 而不是 server/ 是有理由的：这段逻辑原先只活在 dsh.js 的闭包里，
 * 服务端够不着，只能再抄一份——抄出来的两份迟早会在"缺尺寸的行怎么处理"
 * 这种细节上分叉，然后同一个 PI 在 H5 里 3 个柜、在 Agent 里 4 个柜，谁也说不清谁对。
 *
 * 放进 core 后：H5 的 window.BoxFiller.importCSV 与 MCP 的 import_pi 调的是同一个函数。
 * 本模块不碰 DOM、不碰 transport、不碰数据库，Node 下可直接测试。
 */

import { uid } from './units.js';
import { parseCSV, mapRow } from './store.js';

/**
 * 导入 CSV / PI：解析 → 建缺失的 SKU → 按订单号分组生成订单。
 *
 * 缺尺寸或缺毛重的行直接跳过并计数，不硬塞：半截数据进主数据比不导入更糟。
 *
 * @param {Store} store 目标 store（浏览器里是 localStorage 版，服务端是 SQLite 版）
 * @param {string} text CSV 文本
 * @returns {{ok:boolean, skus:number, orders:number, rows:number, skipped:number}}
 */
export function importCsvToStore(store, text, { makeOrders = true } = {}) {
  const rows = parseCSV(text).map(mapRow);
  let skus = 0, orders = 0, skipped = 0;
  const groups = new Map();

  for (const r of rows) {
    if (!r.dimsCm || !(r.weightKg > 0)) { skipped++; continue; }
    let sku = r.sku ? store.getSkuByCode(r.sku) : null;
    if (!sku) {
      sku = store.upsertSku({
        code: r.sku || `IMP_${uid('s')}`,
        nameCn: r.nameCn,
        dimsCm: r.dimsCm,
        weightKg: r.weightKg,
        packQty: r.packQty,
        unitValue: r.unitValue,
        changeReason: 'CSV 导入',
      });
      skus++;
    }
    if (!makeOrders || !(r.boxes > 0)) continue;
    const key = `${r.raw['订单号'] || r.raw['PO'] || r.raw['order'] || 'IMPORT'}|${r.customer || ''}|${r.port || ''}`;
    if (!groups.has(key)) groups.set(key, { meta: r, lines: [] });
    groups.get(key).lines.push({ skuId: sku.id, boxes: r.boxes });
  }

  for (const [key, g] of groups) {
    const [code, customer, port] = key.split('|');
    store.upsertOrder({
      code, customer, port,
      vessel: g.meta.vessel || '',
      cutOff: g.meta.cutOff || '',
      lines: g.lines,
    });
    orders++;
  }

  return { ok: true, skus, orders, rows: rows.length, skipped };
}