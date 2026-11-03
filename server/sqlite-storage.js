/**
 * SQLite 存储适配器（Node 侧）。
 *
 * ── 为什么是这层，而不是把 Store 改成 SQL ──────────────────────────
 * H5 的 Store 只用了同步的 getItem/setItem/removeItem 三个方法（见 store.js），
 * 并且把整套主数据当成**一个 JSON 文档**存。这带来两个好处：审计快照、
 * 导入导出、版本留痕都是原子的一次读写，不必担心写到一半崩溃。
 *
 * 所以这里不重写 Store，只把它塞进的这块存储换成 SQLite —— 主数据格式、
 * 版本号、备份策略全部原样保留，改动面小到可以在一条测试里验完。
 *
 * ── 为什么用 node:sqlite 而不是 better-sqlite3 ──────────────────────
 * Node 22.5+ 自带 node:sqlite，服务端因此**零外部依赖**，与 H5「零依赖、
 * 不用构建」的取向一致。代价是要求 Node ≥ 22.5（22.5~23 还需 --experimental-sqlite，
 * 24 起默认可用）。
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { Store } from '../h5/js/core/store.js';

/**
 * 把 Store 的三个方法映射到一张 kv 表。
 * @param {string} file 数据库路径；':memory:' 用于测试
 */
export function openSqliteStore(file, opts = {}) {
  const db = new DatabaseSync(file);
  // busy_timeout：并发写入时的等待窗口。同一时刻很可能有两个进程碰这个库
  // （比如 Agent 起了两个会话，或 H5 导出同时在写）——没有它，第二个立刻报
  // "database is locked"，而 SQLite 本身完全能等。给 5 秒足够覆盖一次写事务。
  db.exec('PRAGMA busy_timeout = 5000');
  // WAL 让读写不互相阻塞：读的同时另一个进程可以写
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  const select = db.prepare('SELECT value FROM kv WHERE key = ?');
  const upsert = db.prepare(
    'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) '
    + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  );
  const del = db.prepare('DELETE FROM kv WHERE key = ?');
  const keys = db.prepare('SELECT key FROM kv ORDER BY updated_at DESC');

  const storage = {
    getItem(k) {
      const row = select.get(k);
      return row ? row.value : null;
    },
    setItem(k, v) {
      upsert.run(k, String(v), Date.now());
    },
    removeItem(k) {
      del.run(k);
    },
    /** 存储层扩展能力：H5 用不到，服务端运维/备份用得上 */
    _listKeys() {
      return keys.all().map(r => r.key);
    },
    _db: db,
  };
  if (opts.readOnly) {
    // 只读模式用于「别让 Agent 顺手删库」的场景
    db.exec('PRAGMA query_only = ON');
  }
  return storage;
}

/**
 * 打开一个装好业务主数据的 Store。
 * 路径默认落在用户数据目录，避免把 .db 文件写进代码仓库。
 */
export function openStore({ file, now, online = true } = {}) {
  const path = file || defaultDbPath();
  const storage = openSqliteStore(path);
  return new Store({ storage, now, online });
}

/** 默认库位置：$BOXFILL_DB 覆盖，否则 ~/.boxfill/boxfill.db */
export function defaultDbPath() {
  if (process.env.BOXFILL_DB) return process.env.BOXFILL_DB;
  const home = process.env.HOME || process.env.USERPROFILE || '.';
  const dir = `${home}/.boxfill`;
  // mkdirSync 在这里做而不是让调用方各自处理：两个 server 入口都要用到
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // 目录已存在，或环境不允许创建（此时 sqlite 打开会自己报错）
  }
  return `${dir}/boxfill.db`;
}