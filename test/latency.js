/* 确认延迟诊断（只读）模块测试：
 *   一、纯函数：暂停区间重叠与有效等待时长扣除（含暂停超出观察区间的裁剪）
 *   二、按 attemptId 重建轮次：第 1 版 / 撤回修订轮次 / 旧轮次拒绝归属
 *   三、瀑布行：按时 / 迟到（超时标记保留）/ 超时未确认 / 撤回时未确认
 *   四、替岗：确认计入接管岗位、超时标记随确认权移交
 *   五、暂停：deadline 顺延、有效等待扣除暂停、重复暂停 / 恢复
 *   六、汇总与筛选（按岗位、按结果）
 *   七、暂停归一：嵌套重复 / 连续恢复 / 相切重叠 / 跨轮次 / 未闭合
 *   八、只读页面：HTTP GET 静态页、不创建 WebSocket、无新增服务端接口
 *   九、快速切换场次的请求仲裁：乱序成功 / 过期失败静默丢弃 / 加载态
 *
 * 运行前提：服务已在 localhost:3000 启动（npm start）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; console.log(`  ✘ ${name}`); }
}

// 与 test/playlist.js 同一方式把浏览器脚本装入 Node；latency.js 依赖共享内核
// public/replay-core.js，先装入内核，再作为全局入参装入分析器
function loadBrowserModule(file, factoryName, globals = {}) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
  const withoutExport = src.replace(/\nif \(typeof module[\s\S]*$/, '');
  const fn = new Function(...Object.keys(globals),
    withoutExport.replace(`const ${factoryName} = (() => {`, 'return (() => {'));
  return fn(...Object.values(globals));
}

const ReplayCore = loadBrowserModule('replay-core.js', 'ReplayCore');
const L = loadBrowserModule('latency.js', 'CueLatency', { ReplayCore });

function httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:3000${urlPath}`, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = buf ? JSON.parse(buf) : null; } catch { json = null; }
        resolve({ status: res.statusCode, body: buf, json });
      });
    }).on('error', reject);
  });
}

function ev(t, event, detail) {
  return {
    line: t + 100,
    ts: new Date(Date.parse('2026-09-20T08:00:00.000Z') + t).toISOString(),
    t, event, detail: detail || {},
  };
}

// 合成场次（时限 10s）：
//  cue1 灯光/音响：灯光 2s 按时；音响在 3s 暂停至 8s（5s），9s 确认（有效等待 4s）
//  cue2 道具：10s 超时（标记保留），12s 替岗 道具→灯光，13s 替补迟到确认
//  cue3 灯光：v1 在 2s 撤回（旧轮次确认被拒、旧定时器回调被拒），v2 在 3s 完成
//  cue4 音响/道具：v1 5s 撤回（音响已确认、道具未确认且未超时），v2 两人均按时
function buildPayload() {
  const events = [
    ev(0, 'session-start', {}),
    ev(0, 'cue-started', { seq: 1, text: '甲', targets: ['灯光', '音响'], revision: 1, attemptId: 'a1' }),
    ev(2000, 'confirm', { seq: 1, position: '灯光', attemptId: 'a1' }),
    ev(2200, 'confirm-duplicate', { seq: 1, position: '灯光', attemptId: 'a1' }),
    ev(3000, 'cue-paused', { seq: 1, reason: '设备调试', attemptId: 'a1' }),
    ev(3500, 'paused-confirm-rejected', { seq: 1, position: '音响', attemptId: 'a1' }),
    ev(8000, 'cue-resumed', { seq: 1, attemptId: 'a1' }),
    ev(9000, 'confirm', { seq: 1, position: '音响', attemptId: 'a1' }),
    ev(9100, 'cue-completed', { seq: 1, attemptId: 'a1' }),

    ev(9100, 'cue-started', { seq: 2, text: '乙', targets: ['道具'], revision: 1, attemptId: 'b1' }),
    ev(19100, 'cue-timeout', { seq: 2, missing: ['道具'], attemptId: 'b1' }),
    ev(21100, 'position-substituted', { seq: 2, from: '道具', to: '灯光', attemptId: 'b1' }),
    ev(22100, 'confirm-late', { seq: 2, position: '灯光', attemptId: 'b1' }),
    ev(22200, 'cue-completed', { seq: 2, attemptId: 'b1' }),

    ev(22200, 'cue-started', { seq: 3, text: '丙', targets: ['灯光'], revision: 1, attemptId: 'c1' }),
    ev(24200, 'cue-recalled', { seq: 3, oldRevision: 1, newRevision: 2, oldAttemptId: 'c1', reason: '改词' }),
    ev(24200, 'cue-resent', { seq: 3, text: '丙二', reason: '改词', revision: 2, attemptId: 'c2' }),
    ev(24500, 'stale-confirm-ignored', { seq: 3, position: '灯光', sentAttemptId: 'c1', currentAttemptId: 'c2' }),
    ev(27200, 'confirm', { seq: 3, position: '灯光', attemptId: 'c2' }),
    ev(27300, 'cue-completed', { seq: 3, attemptId: 'c2' }),
    ev(32000, 'stale-timeout-ignored', { seq: 3, staleRevision: 2, staleAttemptId: 'c2', currentAttemptId: null }),

    ev(33000, 'cue-started', { seq: 4, text: '丁', targets: ['音响', '道具'], revision: 1, attemptId: 'd1' }),
    ev(35000, 'confirm', { seq: 4, position: '音响', attemptId: 'd1' }),
    ev(38000, 'cue-recalled', { seq: 4, oldRevision: 1, newRevision: 2, oldAttemptId: 'd1', reason: '补目标' }),
    ev(38000, 'cue-resent', { seq: 4, text: '丁二', reason: '补目标', revision: 2, attemptId: 'd2' }),
    ev(39000, 'confirm', { seq: 4, position: '音响', attemptId: 'd2' }),
    ev(40000, 'confirm', { seq: 4, position: '道具', attemptId: 'd2' }),
    ev(40100, 'cue-completed', { seq: 4, attemptId: 'd2' }),
    ev(40200, 'sequence-finished', {}),
  ];
  return {
    session: {
      fileId: '11111111-2222-3333-4444-555555555555', runId: 0,
      startedAt: events[0].ts, finishedAt: events[events.length - 1].ts,
      durationMs: 40200, cueCount: 4, eventCount: events.length, timeoutSec: 10,
    },
    timeoutSec: 10,
    sequence: [
      { seq: 1, text: '甲', targets: ['灯光', '音响'] },
      { seq: 2, text: '乙', targets: ['道具'] },
      { seq: 3, text: '丙', targets: ['灯光'] },
      { seq: 4, text: '丁', targets: ['音响', '道具'] },
    ],
    events,
    positions: [],
    warnings: [],
  };
}

async function main() {
  console.log('一、暂停区间重叠与有效等待时长（纯函数）');
  check('完全包含的暂停扣除 5000ms', L.activeWaitMs([{ startT: 3000, endT: 8000 }], 0, 9000) === 4000);
  check('无暂停时有效等待 = 墙钟', L.activeWaitMs([], 100, 2600) === 2500);
  check('暂停与区间部分相交按交集裁剪（前）',
    L.activeWaitMs([{ startT: 0, endT: 2000 }], 1000, 5000) === 3000);
  check('暂停与区间部分相交（后，未闭合恢复落在观察终点之后）',
    L.activeWaitMs([{ startT: 4000, endT: 9000 }], 0, 5000) === 4000);
  check('多段暂停累计扣除',
    L.activeWaitMs([{ startT: 1000, endT: 2000 }, { startT: 4000, endT: 6000 }], 0, 8000) === 5000);
  check('观察区间完全处于暂停中 → 有效等待 0',
    L.activeWaitMs([{ startT: 0, endT: 9000 }], 1000, 5000) === 0);
  check('overlapMs 相切区间重叠为 0', L.overlapMs(0, 1000, 1000, 2000) === 0);
  const segs = L.segmentsBetween([{ startT: 3000, endT: 8000 }], 0, 9000);
  check('瀑布段落切分为 active/pause/active 三段',
    segs.length === 3 && segs.map((s) => s.kind).join(',') === 'active,pause,active' &&
    segs[0].durationMs === 3000 && segs[1].durationMs === 5000 && segs[2].durationMs === 1000);

  console.log('二、按 attemptId 重建每次修订轮次');
  const a = L.analyzeSession(buildPayload());
  check('4 条口令、6 个轮次（cue3/cue4 各有一个撤回轮次）',
    a.cues.length === 4 && a.summary.roundCount === 6 && a.summary.revisionCount === 2);
  const cue3 = a.cues[2];
  check('cue3 按版本顺序重建两轮 v1 recalled / v2 completed',
    cue3.rounds.length === 2 &&
    cue3.rounds[0].revision === 1 && cue3.rounds[0].endState === 'recalled' &&
    cue3.rounds[1].revision === 2 && cue3.rounds[1].endState === 'completed' &&
    cue3.rounds[1].attemptId === 'c2');
  check('撤回原因保留在轮次与口令档案', cue3.rounds[0].reason === '改词' && cue3.recallReasons[0] === '改词');
  check('修订轮次使用各自 attemptId（c1 与 c2 不同）',
    cue3.rounds[0].attemptId === 'c1' && cue3.rounds[1].attemptId === 'c2');
  check('旧轮次迟到确认按 sentAttemptId 归属 v1（只拒绝、不计入 v2）',
    cue3.rounds[0].stale.some((s) => s.kind === 'stale-confirm') &&
    !cue3.rounds[1].stale.some((s) => s.kind === 'stale-confirm') &&
    cue3.rounds[1].rows[0].status === L.STATUS_CONFIRMED);
  check('整场结束后的旧定时器回调按 staleAttemptId 归属 v2',
    cue3.rounds[1].stale.some((s) => s.kind === 'stale-timeout'));

  console.log('三、确认瀑布行：按时 / 迟到保留超时标记 / 超时 / 撤回时未确认');
  const r1 = a.cues[0].rounds[0];
  check('cue1 deadline 顺延 5000ms（10s + 暂停补偿 = 15s）',
    r1.deadlineT - r1.startT === 15000 && r1.pausedTotalMs === 5000);
  const lightRow = r1.rows.find((x) => x.origin === '灯光');
  const audioRow = r1.rows.find((x) => x.origin === '音响');
  check('灯光 2s 按时确认', lightRow.status === L.STATUS_CONFIRMED && lightRow.waitMs === 2000);
  check('音响墙钟 9s、扣除暂停 5s、有效等待 4s',
    audioRow.status === L.STATUS_CONFIRMED && audioRow.wallMs === 9000 &&
    audioRow.pausedMs === 5000 && audioRow.waitMs === 4000);
  check('暂停中被拒确认不计入任何确认行', r1.stats.confirmed === 2 && r1.rejectedPauses.length === 1);
  check('重复确认记录为刻度而非新行', lightRow.duplicateEvents.length === 1 && r1.rows.length === 2);

  const r2 = a.cues[1].rounds[0];
  const subRow = r2.rows[0];
  check('替岗后确认计入接管岗位（槽位 origin=道具、position=灯光）',
    subRow.origin === '道具' && subRow.position === '灯光' && subRow.substituted);
  check('替补迟到确认：late 且超时标记保留（wasTimeout=true）',
    subRow.status === L.STATUS_LATE && subRow.wasTimeout === true);
  check('迟到行有效等待 = 13014 − 0（该轮无暂停）', subRow.pausedMs === 0 && subRow.waitMs === subRow.wallMs);
  check('点击跳转目标为迟到确认事件（t/line 指向 confirm-late，相对本场起点）',
    subRow.jumpT === 22100 && subRow.eventLine === 22100 + 100 && subRow.jumpLine === subRow.eventLine);

  const cue4v1 = a.cues[3].rounds[0];
  const pendingRow = cue4v1.rows.find((x) => x.origin === '道具');
  check('撤回时未确认（未走到超时）为 pending；已确认的音响仍保留在 v1',
    pendingRow.status === L.STATUS_PENDING &&
    cue4v1.rows.find((x) => x.origin === '音响').status === L.STATUS_CONFIRMED &&
    cue4v1.endState === 'recalled');
  check('v2 重新全员确认（确认不串轮次）',
    a.cues[3].rounds[1].rows.every((x) => x.status === L.STATUS_CONFIRMED));

  console.log('四、汇总');
  check('汇总计数（6 按时 + 1 迟到 + 2 撤回时未确认 = 9 岗次）',
    a.summary.confirmed === 6 && a.summary.late === 1 && a.summary.pending === 2 &&
    a.summary.timeout === 0 && a.summary.substitutions === 1 &&
    a.summary.pauses === 1 && a.summary.rejectedPauses === 1 &&
    a.summary.targetCount === 9 && a.summary.stale >= 2);
  check('最长有效等待为替补迟到行（13000ms）', a.summary.maxWaitMs === 13000);
  check('岗位列表含原岗位与接管岗位（灯光/音响/道具）',
    JSON.stringify(a.positions) === JSON.stringify(['灯光', '音响', '道具']));

  console.log('五、筛选（岗位 / 结果）');
  check('岗位筛选命中原岗位与接管岗位',
    L.rowMatchesPosition(subRow, '道具') && L.rowMatchesPosition(subRow, '灯光') &&
    !L.rowMatchesPosition(subRow, '音响'));
  check('结果筛选：cue2 命中 late、cue3/cue4 命中 revised、cue1 命中 paused、cue2 命中 substituted',
    L.cueMatchesResult(a.cues[1], 'late') &&
    L.cueMatchesResult(a.cues[2], 'revised') &&
    L.cueMatchesResult(a.cues[3], 'revised') &&
    L.cueMatchesResult(a.cues[0], 'paused') &&
    L.cueMatchesResult(a.cues[1], 'substituted'));
  check('结果筛选：仅最终全员按时的口令命中 ok（cue2 迟到不命中；cue3 撤回后 v2 按时命中）',
    L.cueMatchesResult(a.cues[0], 'ok') && !L.cueMatchesResult(a.cues[1], 'ok') &&
    L.cueMatchesResult(a.cues[2], 'ok') && L.cueMatchesResult(a.cues[3], 'ok'));
  check('cue4 最终全员按时 → finalResult=ok', a.cues[3].totals.finalResult === 'ok');
  check('timeout 筛选：最终轮结束时仍超时才命中（本场无）',
    a.cues.every((c) => !L.cueMatchesResult(c, 'timeout')));

  console.log('六、健壮性：无事件 / 空载荷不崩溃');
  const empty = L.analyzeSession({ session: {}, timeoutSec: 10, events: [], sequence: [] });
  check('空场次：0 口令 0 轮次', empty.cues.length === 0 && empty.rounds.length === 0 &&
    Array.isArray(empty.positions) && empty.summary.roundCount === 0);
  check('缺省 timeoutSec 回退 30s', L.analyzeSession({ events: [] }).timeoutSec === 30);
  // 未闭合暂停（异常中断日志）以轮次收口时刻截断，不产生负时长
  const openPause = L.analyzeSession({
    timeoutSec: 10,
    events: [
      ev(0, 'session-start'),
      ev(0, 'cue-started', { seq: 1, targets: ['灯光'], attemptId: 'x1' }),
      ev(2000, 'cue-paused', { attemptId: 'x1', reason: '挂起' }),
      ev(5000, 'cue-completed', { attemptId: 'x1' }),
      ev(5000, 'sequence-finished'),
    ],
  });
  const opr = openPause.cues[0].rounds[0];
  check('未闭合暂停按轮次收口截断（3000ms）且有效等待非负',
    opr.pauses[0].unclosed === true && opr.pausedTotalMs === 3000 &&
    opr.rows[0].waitMs >= 0);

  console.log('七、暂停归一：嵌套重复 / 连续恢复 / 相切重叠 / 跨轮次 / 未闭合');
  // 合成异常日志的辅助构造（时限 10s，单岗位「灯光」）
  function analyzePauses(pauseEvents) {
    const events = [
      ev(0, 'session-start'),
      ev(0, 'cue-started', { seq: 1, targets: ['灯光'], attemptId: 'p1' }),
      ...pauseEvents,
      ev(15000, 'cue-completed', { attemptId: 'p1' }),
      ev(15000, 'sequence-finished'),
    ];
    return L.analyzeSession({ timeoutSec: 10, events, sequence: [{ seq: 1, targets: ['灯光'] }] });
  }

  // 1) 嵌套重复：2000 与 3000 两次 pause、7000 一次 resume —— 旧逻辑会产生
  //    [2000,7000] + [3000,null] 两段，收口后重复扣减 9000ms
  {
    const a = analyzePauses([
      ev(2000, 'cue-paused', { attemptId: 'p1', reason: '首次' }),
      ev(3000, 'cue-paused', { attemptId: 'p1', reason: '重复' }),
      ev(7000, 'cue-resumed', { attemptId: 'p1' }),
      ev(10000, 'confirm', { position: '灯光', attemptId: 'p1' }),
    ]);
    const r = a.cues[0].rounds[0];
    const row = r.rows[0];
    check('嵌套重复 pause 归一为单段 [2000,7000]，不重复扣减',
      r.pauses.length === 1 && r.pauses[0].startT === 2000 && r.pauses[0].endT === 7000 &&
      r.pausedTotalMs === 5000);
    check('deadline 只顺延 5000ms（15s，而非被重复扣成 19s）',
      r.deadlineT - r.startT === 15000);
    check('行 waitMs = 10000 墙钟 − 5000 暂停 = 5000（非 1000）',
      row.wallMs === 10000 && row.pausedMs === 5000 && row.waitMs === 5000);
    check('瀑布段暂停斜纹与归一区间一致（active/pause/active 共 3 段）',
      row.segments.map((s) => s.kind).join(',') === 'active,pause,active' &&
      row.segments[1].durationMs === 5000);
    check('暂停原因取首次 pause（不被重复事件覆盖）', r.pauses[0].reason === '首次');
    check('汇总暂停次数与扣除时长共用归一结果',
      a.summary.pauses === 1 && a.summary.pausedTotalMs === 5000);
  }

  // 2) 连续孤立恢复：旧逻辑会补一条零长暂停，虚增次数
  {
    const a = analyzePauses([
      ev(2000, 'cue-paused', { attemptId: 'p1', reason: 'r' }),
      ev(6000, 'cue-resumed', { attemptId: 'p1' }),
      ev(7000, 'cue-resumed', { attemptId: 'p1' }),
      ev(9000, 'cue-resumed', { attemptId: 'p1' }),
      ev(12000, 'confirm', { position: '灯光', attemptId: 'p1' }),
    ]);
    const r = a.cues[0].rounds[0];
    check('连续 resume 不制造零长暂停：仅 1 段 4000ms',
      r.pauses.length === 1 && r.pausedTotalMs === 4000 &&
      r.pauses[0].startT === 2000 && r.pauses[0].endT === 6000);
    check('有效等待 8000ms、deadline 顺延 4000ms',
      r.rows[0].waitMs === 8000 && r.deadlineT - r.startT === 14000);
  }

  // 3) 未暂停先恢复：完全孤立的 resume 零区间
  {
    const a = analyzePauses([
      ev(1000, 'cue-resumed', { attemptId: 'p1' }),
      ev(11000, 'confirm', { position: '灯光', attemptId: 'p1' }),
    ]);
    const r = a.cues[0].rounds[0];
    check('未暂停先恢复不产生任何暂停：0 段、补偿 0、wait=wall=11000',
      r.pauses.length === 0 && r.pausedTotalMs === 0 &&
      r.rows[0].waitMs === 11000 && r.rows[0].pausedMs === 0 &&
      r.deadlineT - r.startT === 10000);
  }

  // 4) 相切两段（pause 2-5s，resume 5s 同一毫秒再 pause 5-8s）：取并集为一段
  {
    const a = analyzePauses([
      ev(2000, 'cue-paused', { attemptId: 'p1', reason: '甲' }),
      ev(5000, 'cue-resumed', { attemptId: 'p1' }),
      ev(5000, 'cue-paused', { attemptId: 'p1', reason: '乙' }),
      ev(8000, 'cue-resumed', { attemptId: 'p1' }),
      ev(12000, 'confirm', { position: '灯光', attemptId: 'p1' }),
    ]);
    const r = a.cues[0].rounds[0];
    check('相切区间取并集：1 段 [2000,8000] 共 6000ms（切点不重计）',
      r.pauses.length === 1 && r.pausedTotalMs === 6000 &&
      r.pauses[0].startT === 2000 && r.pauses[0].endT === 8000);
    check('瀑布暂停段连续成一段 6000ms',
      r.rows[0].segments.filter((s) => s.kind === 'pause').length === 1 &&
      r.rows[0].segments.find((s) => s.kind === 'pause').durationMs === 6000);
  }

  // 5) 跨轮次：撤回后携带旧 attemptId 的迟到恢复只闭合 / 截断旧轮区间，
  //    新轮 deadline 与 wait 不受影响
  {
    const events = [
      ev(0, 'session-start'),
      ev(0, 'cue-started', { seq: 1, targets: ['灯光'], attemptId: 'v1' }),
      ev(1000, 'cue-paused', { attemptId: 'v1', reason: '挂起' }),
      ev(5000, 'cue-recalled', { seq: 1, oldAttemptId: 'v1', newRevision: 2, reason: '改词' }),
      ev(5000, 'cue-resent', { seq: 1, text: '甲二', reason: '改词', revision: 2, attemptId: 'v2' }),
      ev(6000, 'cue-resumed', { attemptId: 'v1' }), // 旧轮迟到恢复（晚于 recall 收口）
      ev(6500, 'cue-resumed', { attemptId: 'v2' }), // 新轮从未暂停
      ev(9000, 'confirm', { position: '灯光', attemptId: 'v2' }),
      ev(9100, 'cue-completed', { attemptId: 'v2' }),
      ev(9200, 'sequence-finished'),
    ];
    const a = L.analyzeSession({
      timeoutSec: 10, events, sequence: [{ seq: 1, targets: ['灯光'] }],
    });
    const old = a.cues[0].rounds.find((x) => x.attemptId === 'v1');
    const neu = a.cues[0].rounds.find((x) => x.attemptId === 'v2');
    check('旧轮暂停截断到 recall 收口：4000ms（不含迟到的 6000ms）',
      old.pauses.length === 1 && old.pausedTotalMs === 4000 &&
      old.pauses[0].endT === 5000);
    check('新轮无暂停污染：0 段、deadline=10s、wait=4000ms',
      neu.pauses.length === 0 && neu.pausedTotalMs === 0 &&
      neu.rows[0].waitMs === 4000 && neu.deadlineT - neu.startT === 10000);
  }

  // 6) 未闭合暂停：以收口截断并保留 unclosed 标记，waitMs 非负
  {
    const a = L.analyzeSession({
      timeoutSec: 10,
      events: [
        ev(0, 'session-start'),
        ev(0, 'cue-started', { seq: 1, targets: ['灯光'], attemptId: 'u1' }),
        ev(2000, 'cue-paused', { attemptId: 'u1', reason: '挂起' }),
        ev(3000, 'cue-paused', { attemptId: 'u1', reason: '重复挂起' }),
        ev(5000, 'cue-completed', { attemptId: 'u1' }),
        ev(5000, 'sequence-finished'),
      ],
    });
    const r = a.cues[0].rounds[0];
    check('未闭合 + 重复 pause：归一 1 段 [2000,5000]、unclosed、waitMs=2000',
      r.pauses.length === 1 && r.pauses[0].unclosed === true &&
      r.pausedTotalMs === 3000 && r.rows[0].waitMs === 2000);
  }

  console.log('八、只读页面与接口（HTTP GET，无 WebSocket / 无新增写接口）');
  const page = await httpGet('/latency.html');
  check('GET /latency.html 200', page.status === 200);
  check('页面复用复盘只读 GET 接口（sessions 与单场）',
    page.body.includes('/api/replay/sessions') && page.body.includes('latency.js'));
  check('页面不创建 WebSocket、不加载 common.js 的 WS 封装',
    !/new\s+WebSocket\s*\(/.test(page.body) && !page.body.includes('common.js'));
  // 结果筛选状态深链：页面从 ?result= 恢复结果下拉（刷新 / 重新加载后仍只显示匹配口令）
  check('页面从 URL result 深链参数恢复结果筛选（RESULT_VALUES 白名单校验）',
    /params\.get\(['"]result['"]\)/.test(page.body) && /RESULT_VALUES/.test(page.body));
  check('筛选状态经 replaceState 写回地址栏（切回全部结果即移除参数恢复完整列表）',
    /history\.replaceState/.test(page.body) && /function syncUrl/.test(page.body));
  check('页面不含任何 POST/PUT/DELETE/PATCH 写请求',
    !/method\s*:\s*['"](POST|PUT|DELETE|PATCH)/i.test(page.body));
  const js = await httpGet('/latency.js');
  check('GET /latency.js 200 且脚本内无 WebSocket / fetch 写方法',
    js.status === 200 && !/new\s+WebSocket\s*\(/.test(js.body) &&
    !/method\s*:\s*['"](POST|PUT|DELETE|PATCH)/i.test(js.body) &&
    !/\/ws/.test(js.body));
  // 诊断模块不新增任何服务端接口：仅有 replay/compare/archive 三类只读 API
  const replayApi = await httpGet('/api/replay/sessions');
  check('仍通过既有复盘接口取数：GET /api/replay/sessions 200',
    replayApi.status === 200 && Array.isArray(replayApi.json.sessions));
  const noLatencyApi = await httpGet('/api/latency/sessions');
  check('不存在 /api/latency 写接口（模块完全复用复盘 GET）', noLatencyApi.status === 404);

  console.log('九、快速切换场次的请求仲裁（最后一次选择生效，过期响应静默丢弃）');
  // 竞态修复：旧场次的慢请求（成功或失败）晚返回时不得覆盖当前选择。
  // 仲裁逻辑为 latency.js 中的可注入纯编排函数 createDetailLoader（页面只做
  // DOM/fetch 接线），此处用可控的假 fetcher 直接构造乱序时序验证行为。
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  check('模块导出 createDetailLoader 仲裁器', typeof L.createDetailLoader === 'function');

  // 1) 乱序成功：先选 A（慢），立即改选 B（快）——A 的慢响应必须静默丢弃
  {
    const events = [];
    const loader = L.createDetailLoader({
      fetcher: (ref) => ref === 'A'
        ? sleep(30).then(() => ({ who: 'A' }))
        : sleep(5).then(() => ({ who: 'B' })),
      onLoading: (ref) => events.push(`loading:${ref}`),
      onSuccess: (p, ref) => events.push(`success:${ref}:${p.who}`),
      onError: (e, ref) => events.push(`error:${ref}`),
    });
    const pA = loader.select('A');
    const pB = loader.select('B');
    const [rA, rB] = await Promise.all([pA, pB]);
    check('旧选择 A 的慢响应标记 stale 且不触发 onSuccess',
      rA.stale === true && !events.includes('success:A:A'));
    check('当前选择 B 的响应落地（onSuccess 一次）',
      rB.stale === false && rB.payload.who === 'B' &&
      events.filter((e) => e === 'success:B:B').length === 1);
    check('每次选择同步进入加载态（A、B 各一次，顺序与选择一致）',
      events[0] === 'loading:A' && events[1] === 'loading:B');
    check('A 落地后再无任何回调：最终落地的只有 B（无错误回调）',
      events.length === 3 && !events.some((e) => e.startsWith('error')));
  }

  // 2) 旧选择失败同样静默：A 慢且 reject，B 快且成功——不得弹出 A 的错误
  {
    const events = [];
    const loader = L.createDetailLoader({
      fetcher: (ref) => ref === 'A'
        ? sleep(30).then(() => { throw new Error('boom-A'); })
        : sleep(5).then(() => ({ who: 'B' })),
      onLoading: (ref) => events.push(`loading:${ref}`),
      onSuccess: (p, ref) => events.push(`success:${ref}`),
      onError: (e, ref) => events.push(`error:${ref}:${e.message}`),
    });
    const pA = loader.select('A');
    const pB = loader.select('B');
    const [rA, rB] = await Promise.all([pA, pB]);
    check('过期的失败响应不触发 onError（错误提示只属于当前选择）',
      rA.stale === true && rA.error.message === 'boom-A' &&
      !events.some((e) => e.startsWith('error:A')));
    check('当前选择 B 仍正常成功', rB.stale === false && events.includes('success:B'));
  }

  // 3) 当前选择失败要如实报错（不被误判为过期）
  {
    const events = [];
    const loader = L.createDetailLoader({
      fetcher: () => sleep(5).then(() => { throw new Error('net'); }),
      onLoading: () => events.push('loading'),
      onSuccess: () => events.push('success'),
      onError: (e) => events.push(`error:${e.message}`),
    });
    const r = await loader.select('X');
    check('当前选择的失败响应触发一次 onError 且非 stale',
      r.stale === false && r.error.message === 'net' &&
      events.length === 2 && events[1] === 'error:net');
  }

  // 4) 连续三次切换：只有最后一次的响应落地
  {
    const landed = [];
    const loader = L.createDetailLoader({
      fetcher: (ref) => sleep(ref === 'C' ? 5 : 40).then(() => ({ who: ref })),
      onLoading: () => {},
      onSuccess: (p) => landed.push(p.who),
      onError: () => landed.push('ERR'),
    });
    await Promise.all([loader.select('A'), loader.select('B'), loader.select('C')]);
    check('A→B→C 连续切换后仅 C 落地一次',
      landed.length === 1 && landed[0] === 'C');
  }

  // 页面接线：复用仲裁器与既有只读 GET；切换期间有明确加载态；不新增接口
  check('页面通过 CueLatency.createDetailLoader 发起单场详情加载',
    /CueLatency\.createDetailLoader/.test(page.body));
  check('fetcher 仍只请求既有只读 GET /api/replay/sessions/:fileId/:runId',
    /\/api\/replay\/sessions\/\$\{encodeURIComponent\(f\)\}\/\$\{encodeURIComponent\(rParts\.join\('\/'\)\)\}/.test(page.body) &&
    !/\/api\/latency/.test(page.body));
  check('切换期间显示「正在读取场次详情」并禁用岗位 / 结果筛选，场次下拉保持可改选',
    /正在读取场次详情/.test(page.body) &&
    /positionFilter\.disabled\s*=\s*true/.test(page.body) &&
    /resultFilter\.disabled\s*=\s*true/.test(page.body) &&
    !/sessionSelect\.disabled\s*=\s*true/.test(page.body));
  check('页面不创建 WebSocket、无写请求',
    !/new\s+WebSocket\s*\(/.test(page.body) &&
    !/method\s*:\s*['"](POST|PUT|DELETE|PATCH)/i.test(page.body));

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
