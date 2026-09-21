// ---------- generic helpers ----------
const appEl = () => document.getElementById('app');

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('unauthorized');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || `request failed: ${res.status}`);
  return data;
}

function fmtDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function fmtNum(n) {
  if (n === null || n === undefined || n === '') return '';
  return Number(n).toLocaleString('ja-JP');
}

// All chip amounts are denominated in big blinds (BB is fixed at 1).
function fmtRatio(n) {
  if (n === null || n === undefined || n === '') return '';
  return String(Number(Number(n).toFixed(2)));
}
function fmtBB(n) {
  const r = fmtRatio(n);
  return r === '' ? '' : `${r}BB`;
}

const STREET_ORDER = ['preflop', 'flop', 'turn', 'river'];
const STAGE_LABELS = { preflop: 'プリフロップ', flop: 'フロップ', turn: 'ターン', river: 'リバー' };
const ACTION_LABELS = { fold: 'フォールド', check: 'チェック', call: 'コール', bet: 'ベット', raise: 'レイズ', allin: 'オールイン' };

// ---------- table geometry ----------
// A real poker table has a dealer's spot dealing into the other 9 seats, which
// sit 3-3-3 along the left/bottom/right edges (not evenly around a circle).
// The physical seats never move; only the BTN/SB/BB markers shown on them do.
// "Me" sits at whichever of the 9 slots the player picked (session.my_slot).
// A-H run counter-clockwise from there, which (since this path is indexed
// clockwise) means decreasing slot index.
const SEAT_COUNT = 9;
const SLOT_POSITIONS = [
  { left: 90, top: 12 }, // 0: right-top
  { left: 95, top: 50 }, // 1: right-mid
  { left: 90, top: 88 }, // 2: right-bottom
  { left: 70, top: 98 }, // 3: bottom-right
  { left: 50, top: 98 }, // 4: bottom-center
  { left: 30, top: 98 }, // 5: bottom-left
  { left: 10, top: 88 }, // 6: left-bottom
  { left: 5, top: 50 },  // 7: left-mid
  { left: 10, top: 12 }, // 8: left-top
];
function slotPosition(slot) { return SLOT_POSITIONS[slot]; }
function seatSlot(mySlot, seatNo) {
  return ((mySlot - seatNo) % SEAT_COUNT + SEAT_COUNT) % SEAT_COUNT;
}
function seatPosition(mySlot, seatNo) {
  return slotPosition(seatSlot(mySlot, seatNo));
}
const DEALER_SPOT_HTML = '<div class="dealer-spot">ディーラー</div>';

// ---------- card helpers ----------
const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
const SUITS = [
  { code: 's', tag: 'S', color: '#c7cdd8' },
  { code: 'h', tag: 'H', color: '#e59a9a' },
  { code: 'd', tag: 'D', color: '#e3c07f' },
  { code: 'c', tag: 'C', color: '#84cdc0' },
];

function cardTile(code) {
  if (!code) return '<span class="card-tile empty">-</span>';
  const rank = code[0];
  const suit = SUITS.find((s) => s.code === code[1]);
  const color = suit ? suit.color : '#eef1f5';
  return `<span class="card-tile" style="color:${color}">${rank}<sub>${suit ? suit.tag : ''}</sub></span>`;
}

function cardsToTiles(str, slots) {
  const codes = (str || '').split(' ').filter(Boolean);
  const out = [];
  for (let i = 0; i < slots; i += 1) out.push(cardTile(codes[i]));
  return out.join('');
}

function boardCodes(hand) {
  return [hand.board_flop, hand.board_turn, hand.board_river].filter(Boolean).join(' ').split(' ').filter(Boolean);
}

// ---------- poker hand evaluator (for auto-picking the showdown winner) ----------
const RANK_VALUE = { 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };

function parseCard(code) { return { rank: RANK_VALUE[code[0]], suit: code[1] }; }

function combinations(arr, k) {
  const results = [];
  const combo = [];
  (function helper(start) {
    if (combo.length === k) { results.push(combo.slice()); return; }
    for (let i = start; i < arr.length; i += 1) {
      combo.push(arr[i]);
      helper(i + 1);
      combo.pop();
    }
  }(0));
  return results;
}

// Returns a comparable [handRank, ...tiebreakers] array; higher compares better.
function evaluate5(cards) {
  const ranks = cards.map((c) => c.rank).sort((a, b) => b - a);
  const suits = cards.map((c) => c.suit);
  const isFlush = suits.every((s) => s === suits[0]);
  const counts = {};
  ranks.forEach((r) => { counts[r] = (counts[r] || 0) + 1; });
  const groups = Object.entries(counts)
    .map(([r, c]) => ({ rank: Number(r), count: c }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);
  const uniqueRanks = [...new Set(ranks)];
  let isStraight = false;
  let straightHigh = 0;
  if (uniqueRanks.length === 5) {
    if (uniqueRanks[0] - uniqueRanks[4] === 4) { isStraight = true; straightHigh = uniqueRanks[0]; }
    else if (uniqueRanks.join(',') === '14,5,4,3,2') { isStraight = true; straightHigh = 5; }
  }
  if (isStraight && isFlush) return [8, straightHigh];
  if (groups[0].count === 4) return [7, groups[0].rank, groups[1].rank];
  if (groups[0].count === 3 && groups[1].count === 2) return [6, groups[0].rank, groups[1].rank];
  if (isFlush) return [5, ...ranks];
  if (isStraight) return [4, straightHigh];
  if (groups[0].count === 3) return [3, groups[0].rank, ...groups.slice(1).map((g) => g.rank)];
  if (groups[0].count === 2 && groups[1].count === 2) {
    const pairRanks = [groups[0].rank, groups[1].rank].sort((a, b) => b - a);
    return [2, ...pairRanks, groups[2].rank];
  }
  if (groups[0].count === 2) return [1, groups[0].rank, ...groups.slice(1).map((g) => g.rank)];
  return [0, ...ranks];
}

function compareHandValues(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function bestHandValue(sevenCards) {
  let best = null;
  combinations(sevenCards, 5).forEach((c) => {
    const val = evaluate5(c);
    if (!best || compareHandValues(val, best) > 0) best = val;
  });
  return best;
}

// Only returns a result once the board is complete and every non-folded seat
// has both hole cards recorded (otherwise we can't know for sure who wins).
function determineShowdownWinners(participants, boardCards) {
  if (boardCards.length < 5) return null;
  const remaining = participants.filter((p) => !p.folded);
  const withCards = remaining.filter((p) => (p.hole_cards || '').split(' ').filter(Boolean).length === 2);
  if (withCards.length !== remaining.length || remaining.length < 2) return null;
  const board = boardCards.map(parseCard);
  let bestVal = null;
  let winners = [];
  remaining.forEach((p) => {
    const hole = p.hole_cards.split(' ').filter(Boolean).map(parseCard);
    const val = bestHandValue([...hole, ...board]);
    const cmp = bestVal ? compareHandValues(val, bestVal) : 1;
    if (cmp > 0) { bestVal = val; winners = [p]; }
    else if (cmp === 0) { winners.push(p); }
  });
  return winners;
}

function collectKnownCards(hand, participants, excludeField) {
  const set = new Set();
  ['board_flop', 'board_turn', 'board_river'].forEach((f) => {
    if (f === excludeField) return;
    (hand[f] || '').split(' ').filter(Boolean).forEach((c) => set.add(c));
  });
  participants.forEach((p) => {
    if (excludeField === `hole:${p.seat_id}`) return;
    (p.hole_cards || '').split(' ').filter(Boolean).forEach((c) => set.add(c));
  });
  return set;
}

// ---------- modal root (shared by card picker + seat sheet) ----------
function modalRoot() { return document.getElementById('picker-root'); }
function closeModalRoot() { const el = modalRoot(); if (el) el.innerHTML = ''; }

// ---------- card picker modal ----------
let pickerState = null;

function openCardPicker({ title, min, max, excluded, initial, allowSkip, skipLabel, onConfirm }) {
  pickerState = {
    title, min, max, excluded: excluded || new Set(),
    selected: (initial || []).slice(),
    allowSkip: !!allowSkip,
    skipLabel: skipLabel || 'マック(不明)',
    onConfirm,
  };
  renderPicker();
}

function closeCardPicker() {
  pickerState = null;
  closeModalRoot();
}

function renderPicker() {
  const root = modalRoot();
  if (!pickerState) { root.innerHTML = ''; return; }
  const { title, min, max, excluded, selected } = pickerState;
  const rows = SUITS.map((suit) => {
    const cells = RANKS.map((rank) => {
      const code = rank + suit.code;
      const isSel = selected.includes(code);
      const isExcluded = excluded.has(code) && !isSel;
      return `<button type="button" class="${isSel ? ' selected' : ''}" style="color:${suit.color}"
        ${isExcluded ? 'disabled' : ''} onclick="pickerToggle('${code}')">${rank}</button>`;
    }).join('');
    return `<div class="picker-suit-row">
      <div class="picker-suit-label" style="color:${suit.color}">${suit.tag}</div>
      <div class="picker-grid">${cells}</div>
    </div>`;
  }).join('');

  const canConfirm = selected.length >= min;
  root.innerHTML = `
    <div class="modal-overlay" onclick="if(event.target===this) pickerCancel()">
      <div class="modal-sheet">
        <h2>${escapeHtml(title)}</h2>
        <div style="color:var(--muted);font-size:13px;margin-bottom:10px;">${selected.length}/${max} 選択中${min < max ? `(最低${min}件)` : ''}</div>
        ${rows}
        <div class="row spacer-top">
          <button type="button" class="btn secondary" onclick="pickerCancel()">キャンセル</button>
          ${selected.length ? '<button type="button" class="btn secondary" onclick="pickerClear()">クリア</button>' : ''}
          ${pickerState.allowSkip ? `<button type="button" class="btn secondary" onclick="pickerSkip()">${escapeHtml(pickerState.skipLabel)}</button>` : ''}
          <button type="button" class="btn" ${canConfirm ? '' : 'disabled'} onclick="pickerConfirm()">決定</button>
        </div>
      </div>
    </div>`;
}

function pickerToggle(code) {
  const { selected, max } = pickerState;
  const idx = selected.indexOf(code);
  if (idx >= 0) selected.splice(idx, 1);
  else if (selected.length < max) selected.push(code);
  renderPicker();
}
function pickerClear() { pickerState.selected = []; renderPicker(); }
function pickerCancel() { closeCardPicker(); }
function pickerSkip() { const cb = pickerState.onConfirm; closeCardPicker(); cb(null); }
function pickerConfirm() {
  const cb = pickerState.onConfirm;
  const cards = pickerState.selected.slice();
  closeCardPicker();
  cb(cards.join(' '));
}

// ---------- seat sheet modal (tapping a player, in the idle view or during a hand) ----------
const QUICK_TAGS = ['日本人', 'ルースアグレッシブ', 'タイトアグレッシブ', 'ルースパッシブ', 'タイトパッシブ', 'ブラファー', 'コーリングステーション', '初心者'];
let seatSheetState = null;

async function openSeatSheet(sessionId, seat) {
  let justRegistered = false;
  if (seat.status === 'empty') {
    // tapping an empty seat registers a new occupant immediately
    const detail = await api('POST', `/api/sessions/${sessionId}/seats/${seat.seat_no}/reset`);
    seat = detail.seats.find((s) => s.seat_no === seat.seat_no);
    justRegistered = true;
    renderSessionDetail(sessionId, true);
  }
  seatSheetState = {
    sessionId, seat, history: null, vpip: null, memoDraft: seat.memo || '', justRegistered, showMemo: false,
  };
  renderSeatSheet();
  const data = await api('GET', `/api/sessions/${sessionId}/seats/${seat.seat_no}/history`);
  if (!seatSheetState) return;
  seatSheetState.history = data.hands;
  seatSheetState.vpip = data.vpip;
  renderSeatSheet();
}

function closeSeatSheet() {
  seatSheetState = null;
  closeModalRoot();
}

function renderSeatSheet() {
  const root = modalRoot();
  if (!seatSheetState) { root.innerHTML = ''; return; }
  const { seat, history, vpip, memoDraft, justRegistered, showMemo } = seatSheetState;
  const vpipHtml = vpip && vpip.percent != null
    ? `<div class="meta">VPIP: ${vpip.percent}% (${vpip.hands}ハンド中)</div>` : '';

  // 在席に戻す/一時離席・終了・交代: all offered as equal-weight options
  const statusOptions = seat.status === 'away'
    ? [{ label: '在席に戻す', action: "seatSheetSetStatus('active')" }]
    : [{ label: '一時離席', action: "seatSheetSetStatus('away')" }];
  statusOptions.push({ label: '終了', action: "seatSheetSetStatus('empty')" });
  statusOptions.push({ label: '交代', action: 'seatSheetReset()' });
  const statusButtonsHtml = statusOptions.map((o) => `<button type="button" class="btn secondary small" onclick="${o.action}">${o.label}</button>`).join('');

  const memoSection = showMemo ? `
    <div class="row">${QUICK_TAGS.map((t) => `<button type="button" class="btn secondary small" onclick="seatSheetAppendTag('${t}')">${t}</button>`).join('')}</div>
    <textarea id="seat-memo" oninput="seatSheetState.memoDraft=this.value" placeholder="タップして候補を追加、または自由入力">${escapeHtml(memoDraft)}</textarea>
    <button type="button" class="btn small" onclick="seatSheetSaveMemo()">メモを保存</button>
  ` : `
    <div class="row between" style="align-items:center;">
      <div class="meta">${seat.memo ? escapeHtml(seat.memo) : '未設定'}</div>
      <button type="button" class="btn secondary small" onclick="seatSheetShowMemo()">メモ</button>
    </div>
  `;

  const historyHtml = history === null ? '<div class="empty-state">読み込み中...</div>'
    : history.length === 0 ? '<div class="empty-state">まだ記録がありません</div>'
    : history.slice(0, 10).map((h) => `
      <button class="list-item" onclick="closeSeatSheet(); nav('#/hand/${h.id}')">
        <div><strong>#${h.hand_no}</strong>${h.hole_cards ? ' ' + cardsToTiles(h.hole_cards, 2) : ''}${h.folded ? ' ・途中で降り' : ''}</div>
        <div class="meta">${h.pot_size ? `合計 ${fmtBB(h.pot_size)}` : ''}</div>
      </button>`).join('');

  root.innerHTML = `
    <div class="modal-overlay" onclick="if(event.target===this) closeSeatSheet()">
      <div class="modal-sheet">
        <h2>${seat.label}</h2>
        ${vpipHtml}
        ${justRegistered ? '<div class="notice">新規登録しました</div>' : ''}
        <div class="row">${statusButtonsHtml}</div>
        <div class="spacer-top"></div>
        <label>スタック (BB, 任意)</label>
        <div class="row">
          <input type="number" inputmode="decimal" step="0.01" id="seat-stack" value="${seat.stack != null ? seat.stack : ''}" style="flex:1;margin-bottom:0;">
          <button type="button" class="btn secondary small" onclick="seatSheetSaveStack()">保存</button>
        </div>
        <div class="spacer-top"></div>
        <label>メモ</label>
        ${memoSection}
        <div class="spacer-top"></div>
        <h3>これまでの記録</h3>
        ${historyHtml}
        <div class="row spacer-top">
          <button type="button" class="btn secondary block" onclick="closeSeatSheet()">閉じる</button>
        </div>
      </div>
    </div>`;
}

async function seatSheetSetStatus(status) {
  const { sessionId, seat } = seatSheetState;
  const { seats } = await api('PATCH', `/api/sessions/${sessionId}/seats/${seat.seat_no}`, { status });
  seatSheetState.seat = seats.find((s) => s.seat_no === seat.seat_no);
  seatSheetState.justRegistered = false;
  renderSeatSheet();
  renderSessionDetail(sessionId, true);
}

function seatSheetShowMemo() {
  seatSheetState.showMemo = true;
  renderSeatSheet();
}

function seatSheetAppendTag(tag) {
  const cur = seatSheetState.memoDraft.trim();
  seatSheetState.memoDraft = !cur ? tag : cur.split(/,\s*/).includes(tag) ? cur : `${cur}, ${tag}`;
  renderSeatSheet();
}

async function seatSheetSaveMemo() {
  const { sessionId, seat, memoDraft } = seatSheetState;
  await api('PATCH', `/api/sessions/${sessionId}/seats/${seat.seat_no}`, { memo: memoDraft });
  closeSeatSheet();
  renderSessionDetail(sessionId, true);
}

async function seatSheetSaveStack() {
  const { sessionId, seat } = seatSheetState;
  const raw = document.getElementById('seat-stack').value;
  const { seats } = await api('PATCH', `/api/sessions/${sessionId}/seats/${seat.seat_no}`, { stack: raw ? Number(raw) : null });
  seatSheetState.seat = seats.find((s) => s.seat_no === seat.seat_no);
  renderSeatSheet();
  renderSessionDetail(sessionId, true);
}

async function seatSheetReset() {
  if (!confirm(`${seatSheetState.seat.label} の記録をリセットします。よろしいですか？`)) return;
  const { sessionId, seat } = seatSheetState;
  await api('POST', `/api/sessions/${sessionId}/seats/${seat.seat_no}/reset`);
  closeSeatSheet();
  renderSessionDetail(sessionId, true);
}

// ---------- AI analysis modal ----------
let aiAnalysisState = null;

async function runAiAnalysis(handId) {
  aiAnalysisState = { loading: true, error: null, result: null };
  renderAiAnalysis();
  try {
    const result = await api('POST', `/api/hands/${handId}/ai-analysis`);
    aiAnalysisState = { loading: false, error: null, result };
  } catch (e) {
    aiAnalysisState = { loading: false, error: e.message, result: null };
  }
  renderAiAnalysis();
}

function closeAiAnalysis() {
  aiAnalysisState = null;
  closeModalRoot();
}

function renderAiAnalysis() {
  const root = modalRoot();
  if (!aiAnalysisState) { root.innerHTML = ''; return; }
  const { loading, error, result } = aiAnalysisState;
  let body;
  if (loading) {
    body = '<div class="empty-state">分析中...(数秒〜数十秒かかります)</div>';
  } else if (error) {
    body = `<div class="notice">${escapeHtml(error)}</div>`;
  } else if (result) {
    const sr = result.self_review || {};
    const opponentsHtml = (result.opponents || []).map((o) => `
      <div class="action-panel compact">
        <div class="name-row"><strong>${escapeHtml(o.seat)}</strong>${o.tags && o.tags.length ? `<span class="meta">${o.tags.map((t) => escapeHtml(t)).join(', ')}</span>` : ''}</div>
        <div class="meta">${escapeHtml(o.exploit_tips || '')}</div>
      </div>`).join('');
    body = `
      <h3>自己評価</h3>
      <div class="current-actor-tag">${sr.score != null ? sr.score : '-'}点</div>
      <div class="meta" style="margin-bottom:8px;">${escapeHtml(sr.summary || '')}</div>
      <div class="meta" style="white-space:pre-wrap;">${escapeHtml(sr.details || '')}</div>
      <div class="spacer-top"></div>
      <h3>対戦相手の分析</h3>
      ${opponentsHtml || '<div class="empty-state">データがありません</div>'}
      <div class="notice">タグは各プレイヤーのメモに自動反映されています。</div>
    `;
  }
  root.innerHTML = `
    <div class="modal-overlay" onclick="if(event.target===this && !${loading}) closeAiAnalysis()">
      <div class="modal-sheet">
        <h2>AI分析</h2>
        ${body}
        <div class="row spacer-top">
          <button type="button" class="btn secondary block" onclick="closeAiAnalysis()">閉じる</button>
        </div>
      </div>
    </div>`;
}

// ---------- router ----------
window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', () => {
  if (!document.getElementById('picker-root')) {
    const d = document.createElement('div');
    d.id = 'picker-root';
    document.body.appendChild(d);
  }
  route();
});

function route() {
  const hash = window.location.hash || '#/';
  const parts = hash.replace(/^#\//, '').split('/').filter(Boolean);
  if (parts.length === 0) return renderHome();
  if (parts[0] === 'new-session') return renderNewSession();
  if (parts[0] === 'session') return renderSessionDetail(parts[1]);
  if (parts[0] === 'hand') return renderHandStandalone(parts[1]);
  return renderHome();
}

function nav(hash) { window.location.hash = hash; }
// Like nav(), but also works when we're already on that hash (hashchange
// otherwise wouldn't fire), which happens a lot now that the session screen
// re-renders itself in place as a hand progresses.
function goToSession(sessionId, keepScroll) {
  const target = `#/session/${sessionId}`;
  if (window.location.hash === target) renderSessionDetail(sessionId, keepScroll);
  else nav(target);
}

// ---------- home ----------
async function renderHome() {
  appEl().innerHTML = `<div class="topbar"><h1>Notes</h1><span></span></div><div class="empty-state">読み込み中...</div>`;
  const sessions = await api('GET', '/api/sessions');
  const list = sessions.length ? sessions.map((s) => `
    <button class="list-item" onclick="nav('#/session/${s.id}')">
      <div><strong>${escapeHtml(s.title)}</strong></div>
      <div class="meta">${fmtDateTime(s.created_at)} ・ ${s.hand_count}件
        ${s.big_blind ? ` ・ SB${fmtRatio(s.small_blind)} (BB=1)` : ''}</div>
    </button>`).join('') : '<div class="empty-state">まだ記録がありません<br>「新規」から始めましょう</div>';

  appEl().innerHTML = `
    <div class="topbar"><h1>Notes</h1><span></span></div>
    <button class="btn block" onclick="nav('#/new-session')">＋ 新規</button>
    <div class="spacer-top"></div>
    <h3>これまでの記録</h3>
    ${list}
  `;
}

// ---------- new session ----------
let newSessionMySlot = 4;

function renderNewSession() {
  newSessionMySlot = 4;
  appEl().innerHTML = `
    <div class="topbar"><button class="back" onclick="nav('#/')">← 戻る</button><h1>新規</h1><span></span></div>
    <div class="card">
      <label>タイトル</label>
      <input type="text" id="ns-title" placeholder="例: 9/20" value="${fmtDateTime(new Date().toISOString())}">
      <label>SB (BBを1とした比率)</label>
      <input type="number" id="ns-sb" inputmode="decimal" placeholder="例: 0.5" step="0.01" value="0.5">
    </div>
    <div class="card">
      <label>自分の位置</label>
      <div id="ns-table" class="table-oval"></div>
    </div>
    <div class="notice">相手8席(A~H)は全員在席の状態で用意されます。空席にしたい席は次の画面で切り替えられます。</div>
    <button class="btn block" onclick="submitNewSession()">開始</button>
  `;
  renderNewSessionTable();
}

function renderNewSessionTable() {
  const el = document.getElementById('ns-table');
  const slots = SLOT_POSITIONS.map((pos, slot) => {
    const isMe = slot === newSessionMySlot;
    return `<button type="button" class="table-seat ${isMe ? 'self' : ''}" style="left:${pos.left}%;top:${pos.top}%"
      onclick="pickMySlot(${slot})">${isMe ? '自分' : ''}</button>`;
  }).join('');
  el.innerHTML = DEALER_SPOT_HTML + slots;
}

function pickMySlot(slot) {
  newSessionMySlot = slot;
  renderNewSessionTable();
}

async function submitNewSession() {
  const title = document.getElementById('ns-title').value.trim() || fmtDateTime(new Date().toISOString());
  const sb = document.getElementById('ns-sb').value;
  // BB is always the unit (=1); SB is entered as a ratio of it.
  const { session } = await api('POST', '/api/sessions', {
    title, small_blind: sb ? Number(sb) : 0.5, big_blind: 1, my_slot: newSessionMySlot,
  });
  nav(`#/session/${session.id}`);
}

// ---------- session screen: idle (seat management) or live (embedded hand) ----------
async function renderSessionDetail(sessionId, keepScroll) {
  const scrollY = keepScroll ? window.scrollY : 0;
  if (!keepScroll) appEl().innerHTML = `<div class="topbar"><h1>読み込み中...</h1></div>`;
  const detail = await api('GET', `/api/sessions/${sessionId}`);
  if (detail.open_hand_id) {
    if (!keepScroll) handUiState = { tab: null, amountPromptKey: null, showFallback: false, showLog: false };
    handViewCtx = { backHash: '#/', sessionId };
    await renderHandBody(detail.open_hand_id, keepScroll);
  } else {
    renderIdleSession(sessionId, detail);
  }
  if (keepScroll) window.scrollTo(0, scrollY);
}

function renderIdleSession(sessionId, detail) {
  const { session, seats, hands, sb_seat_no, bb_seat_no } = detail;

  const seatButton = (seat) => {
    const { left, top } = seatPosition(session.my_slot, seat.seat_no);
    const isDealer = seat.seat_no === session.dealer_seat;
    const marks = [];
    if (isDealer) marks.push('<span class="mark dealer">D</span>');
    if (seat.seat_no === sb_seat_no) marks.push(`<span class="mark">SB${fmtRatio(session.small_blind)}</span>`);
    if (seat.seat_no === bb_seat_no) marks.push('<span class="mark">BB1</span>');
    if (seat.seat_no === 0) {
      return `<div class="table-seat self" style="left:${left}%;top:${top}%">
        <span class="seat-name">自分</span><span class="seat-marks">${marks.join('')}</span>
      </div>`;
    }
    return `<button type="button" class="table-seat ${seat.status}" style="left:${left}%;top:${top}%"
      onclick='openSeatSheet(${session.id}, ${JSON.stringify(seat).replace(/'/g, "&#39;")})'>
      <span class="seat-name">${seat.label}</span><span class="seat-marks">${marks.join('')}</span>
    </button>`;
  };

  const seatGrid = `<div class="table-oval">${DEALER_SPOT_HTML}${seats.map(seatButton).join('')}</div>`;
  const activeCount = seats.filter((s) => s.status === 'active').length;

  const handsList = hands.length ? hands.slice().reverse().map((h) => `
    <button class="list-item" onclick="nav('#/hand/${h.id}')">
      <div><strong>#${h.hand_no}</strong></div>
      <div class="meta">${fmtDateTime(h.created_at)}${h.pot_size ? ` ・ 合計 ${fmtBB(h.pot_size)}` : ''}</div>
    </button>`).join('') : '<div class="empty-state">まだ記録がありません</div>';

  appEl().innerHTML = `
    <div class="topbar"><button class="back" onclick="nav('#/')">← 戻る</button><h1>${escapeHtml(session.title)}</h1><span></span></div>
    <div class="card">
      ${seatGrid}
      <div class="meta" style="color:var(--muted);margin:8px 0;">
        ${fmtDateTime(session.created_at)}
        ${session.big_blind ? ` ・ SB${fmtRatio(session.small_blind)} (BB=1)` : ''}
      </div>
      <div class="row">
        <button class="btn secondary block" onclick="advanceDealer(${session.id})">Next(位置を送る)</button>
      </div>
    </div>
    <button class="btn block" ${activeCount < 2 ? 'disabled' : ''} onclick="startHand(${session.id})">＋ ハンドを開始</button>
    <div class="spacer-top"></div>
    <div class="row between"><h3>記録一覧</h3>
      <button class="btn danger small" onclick="deleteSession(${session.id})">削除</button>
    </div>
    ${handsList}
  `;
}

async function advanceDealer(sessionId) {
  await api('POST', `/api/sessions/${sessionId}/dealer/next`);
  renderSessionDetail(sessionId, true);
}

async function startHand(sessionId) {
  try {
    await api('POST', `/api/sessions/${sessionId}/hands`, {});
    renderSessionDetail(sessionId);
  } catch (e) {
    alert(e.message);
  }
}

async function deleteSession(sessionId) {
  if (!confirm('この記録を全て削除します。よろしいですか？')) return;
  await api('DELETE', `/api/sessions/${sessionId}`);
  nav('#/');
}

// ---------- hand view (shared by the live embedded hand and history review) ----------
let handUiState = { tab: null, amountPromptKey: null, showFallback: false, showLog: false };

function currentStreetFor(hand) {
  if (!hand.board_flop) return 'preflop';
  if (!hand.board_turn) return 'flop';
  if (!hand.board_river) return 'turn';
  return 'river';
}

function boardFieldLabel(field) {
  if (field === 'board_flop') return 'フロップ(3枚)';
  if (field === 'board_turn') return 'ターン(1枚)';
  return 'リバー(1枚)';
}

// What should the screen be doing right now, for this hand?
function computeHandState(hand, participants, streets) {
  const remaining = participants.filter((p) => !p.folded);
  if (remaining.length <= 1) {
    return { phase: 'result', remaining, autoWinnerSeatId: remaining[0] ? remaining[0].seat_id : null };
  }
  const street = currentStreetFor(hand);
  const info = streets[street] || { current_actor_seat_id: null };
  if (info.current_actor_seat_id) return { phase: 'action', street };
  if (street === 'river') {
    const winners = determineShowdownWinners(participants, boardCodes(hand));
    return {
      phase: 'showdown',
      remaining,
      autoWinnerSeatId: winners && winners.length === 1 ? winners[0].seat_id : null,
      tiedWinners: winners && winners.length > 1 ? winners : null,
    };
  }
  const nextField = street === 'preflop' ? 'board_flop' : street === 'flop' ? 'board_turn' : 'board_river';
  const nextCount = street === 'preflop' ? 3 : 1;
  const nextLabel = boardFieldLabel(nextField);
  return { phase: 'board', nextField, nextCount, nextLabel };
}

// Amounts are in BB, so round to cents-of-a-BB rather than whole numbers.
function roundBB(n) { return Math.round(n * 100) / 100; }

// Quick sizing buttons: preflop's opening raise is sized off the BB; any
// later raise (postflop always, or a preflop 3bet+) is sized off the amount
// currently facing the player; a fresh bet (no one has wagered this street
// yet) is sized off the pot.
function computeQuickAmounts(actionType, street, potInfo) {
  if (actionType === 'raise') {
    const isOpeningRaise = street === 'preflop' && potInfo.facing_bet === potInfo.bb_amount;
    if (isOpeningRaise && potInfo.bb_amount) {
      return [2.3, 2.5, 3, 4].map((x) => ({ label: `${x}x BB`, amount: roundBB(potInfo.bb_amount * x) }));
    }
    if (potInfo.facing_bet) {
      return [2, 2.5, 3].map((x) => ({ label: `${x}x`, amount: roundBB(potInfo.facing_bet * x) }));
    }
    return [];
  }
  if (actionType === 'bet' && potInfo.pot) {
    return [0.33, 0.5, 0.75, 1].map((x) => ({ label: `${Math.round(x * 100)}%`, amount: roundBB(potInfo.pot * x) }));
  }
  return [];
}

function renderActionPanel(hand, p, street, potInfo, compact) {
  const key = `${street}:${p.seat_id}`;
  const toCall = Math.max((potInfo.facing_bet || 0) - (potInfo.street_contrib[p.seat_no] || 0), 0);
  if (handUiState.amountPromptKey && handUiState.amountPromptKey.key === key) {
    const at = handUiState.amountPromptKey.actionType;
    const quick = computeQuickAmounts(at, street, potInfo);
    return `<div class="action-panel${compact ? ' compact' : ''}">
      <div class="name-row"><strong>${escapeHtml(p.label)}</strong><span>${ACTION_LABELS[at]}</span></div>
      ${quick.length ? `<div class="row">${quick.map((q) => `<button type="button" class="btn secondary small" onclick="submitQuickAmount(${hand.id}, ${p.seat_id}, '${street}', '${at}', ${q.amount})">${q.label}(${fmtBB(q.amount)})</button>`).join('')}</div>` : ''}
      <input type="number" inputmode="decimal" step="0.01" id="amount-input" placeholder="BB単位で直接入力(任意)" autofocus>
      <div class="row">
        <button class="btn secondary small" onclick="cancelAmountPrompt(${hand.id})">キャンセル</button>
        <button class="btn small" onclick="confirmAmountAction(${hand.id}, ${p.seat_id}, '${street}', '${at}')">記録する</button>
      </div>
    </div>`;
  }
  // gray out actions that don't make sense right now (e.g. UTG "check" preflop,
  // since the BB is already a live bet they'd have to call or raise instead)
  const hasBet = (potInfo.facing_bet || 0) > 0;
  const canCheck = !hasBet || toCall === 0;
  const canCall = toCall > 0;
  const canBet = !hasBet;
  const canRaise = hasBet;
  return `<div class="action-panel${compact ? ' compact' : ''}">
    <div class="name-row"><strong>${escapeHtml(p.label)}${p.is_me ? ' 👤' : ''}</strong></div>
    <div class="action-buttons">
      <button class="fold" onclick="submitAction(${hand.id}, ${p.seat_id}, '${street}', 'fold')">${ACTION_LABELS.fold}</button>
      <button class="check" ${canCheck ? '' : 'disabled'} onclick="submitAction(${hand.id}, ${p.seat_id}, '${street}', 'check')">${ACTION_LABELS.check}</button>
      <button class="call" ${canCall ? '' : 'disabled'} onclick="submitAction(${hand.id}, ${p.seat_id}, '${street}', 'call')">${ACTION_LABELS.call}${toCall ? `(${fmtBB(toCall)})` : ''}</button>
      <button class="bet" ${canBet ? '' : 'disabled'} onclick="promptAmount(${hand.id}, '${key}', 'bet')">${ACTION_LABELS.bet}</button>
      <button class="raise" ${canRaise ? '' : 'disabled'} onclick="promptAmount(${hand.id}, '${key}', 'raise')">${ACTION_LABELS.raise}</button>
      <button class="allin" onclick="promptAmount(${hand.id}, '${key}', 'allin')">${ACTION_LABELS.allin}</button>
    </div>
  </div>`;
}

async function submitQuickAmount(handId, seatId, street, actionType, amount) {
  handUiState.amountPromptKey = null;
  await api('POST', `/api/hands/${handId}/actions`, { seat_id: seatId, street, action_type: actionType, amount });
  renderHandBody(handId, true);
}

function toggleFallbackList(handId) {
  handUiState.showFallback = !handUiState.showFallback;
  renderHandBody(handId, true);
}

function toggleLog(handId) {
  handUiState.showLog = !handUiState.showLog;
  renderHandBody(handId, true);
}

// Where "戻る" and hand-history links should point, for whichever context
// (embedded live hand vs. standalone history review) is currently rendering.
let handViewCtx = { backHash: null, sessionId: null };

async function renderHandStandalone(handId) {
  appEl().innerHTML = `<div class="topbar"><h1>読み込み中...</h1></div>`;
  handUiState = { tab: null, amountPromptKey: null, showFallback: false, showLog: false };
  handViewCtx = { backHash: null, sessionId: null };
  await renderHandBody(handId, false);
}

async function renderHandBody(handId, keepScroll) {
  const scrollY = keepScroll ? window.scrollY : 0;
  const {
    hand, participants, actions, streets, pot_info: potInfo, my_slot: mySlot,
    non_participant_seats: nonParticipantSeats,
  } = await api('GET', `/api/hands/${handId}`);
  const sessionId = handViewCtx.sessionId || hand.session_id;
  const resolvedBackHash = handViewCtx.backHash || `#/session/${sessionId}`;

  if (!handUiState.tab) handUiState.tab = currentStreetFor(hand);

  const bySeatId = {};
  participants.forEach((p) => { bySeatId[p.seat_id] = p; });
  const state = computeHandState(hand, participants, streets);
  const allInSeatIds = new Set(actions.filter((a) => a.action_type === 'allin').map((a) => a.seat_id));

  // mini table: fixed physical seats, community cards + pot in the middle,
  // current actor highlighted so it's obvious at a glance whose turn this is
  const currentActor = state.phase === 'action' && streets[state.street].current_actor_seat_id
    ? bySeatId[streets[state.street].current_actor_seat_id] : null;
  const centerCards = boardCodes(hand);
  const miniTable = `<div class="table-oval mini">
    ${DEALER_SPOT_HTML}
    <div class="table-center">
      <div class="pot-badge">Pot ${fmtBB(potInfo.pot)}</div>
      ${centerCards.length ? `<div class="row" style="justify-content:center;">${centerCards.map(cardTile).join('')}</div>` : ''}
    </div>
    ${participants.map((p) => {
      const { left, top } = seatPosition(mySlot, p.seat_no);
      const isCurrent = currentActor && p.seat_id === currentActor.seat_id;
      const isDealer = p.seat_no === hand.dealer_seat_no;
      const marks = [];
      if (isDealer) marks.push('<span class="mark dealer">D</span>');
      if (p.seat_no === potInfo.sb_seat_no) marks.push(`<span class="mark">SB${fmtRatio(potInfo.sb_amount)}</span>`);
      if (p.seat_no === potInfo.bb_seat_no) marks.push('<span class="mark">BB1</span>');
      const isAllIn = allInSeatIds.has(p.seat_id);
      if (isAllIn) marks.push('<span class="mark allin">AI</span>');
      const contrib = potInfo.street_contrib[p.seat_no] || 0;
      const investedHtml = contrib > 0 ? `<span class="seat-invested">${fmtBB(contrib)}</span>` : '';
      const holeHtml = p.hole_cards ? `<span class="seat-hole">${cardsToTiles(p.hole_cards, 2)}</span>` : '';
      return `<button type="button" class="table-seat${p.folded ? ' folded' : ''}${isAllIn ? ' allin' : ''}${isCurrent ? ' current-turn' : ''}"
        style="left:${left}%;top:${top}%" onclick='openSeatSheet(${sessionId}, ${JSON.stringify(p).replace(/'/g, "&#39;")})'>
        <span class="seat-name">${escapeHtml(p.label)}</span>
        <span class="seat-marks">${marks.join('')}</span>
        ${investedHtml}
        ${holeHtml}
      </button>`;
    }).join('')}
    ${nonParticipantSeats.map((seat) => {
      const { left, top } = seatPosition(mySlot, seat.seat_no);
      return `<button type="button" class="table-seat ${seat.status}" style="left:${left}%;top:${top}%"
        onclick='openSeatSheet(${sessionId}, ${JSON.stringify(seat).replace(/'/g, "&#39;")})'>
        <span class="seat-name">${escapeHtml(seat.label)}</span>
      </button>`;
    }).join('')}
  </div>`;

  // the live panel: exactly one of action / board-reveal prompt / showdown / result
  let livePanel = '';
  if (state.phase === 'action') {
    const streetInfo = streets[state.street];
    const orderedInStreet = streetInfo.order.map((id) => bySeatId[id]).filter(Boolean);
    const others = orderedInStreet.filter((p) => !currentActor || p.seat_id !== currentActor.seat_id);
    livePanel = `
      ${currentActor
        ? `<div class="current-actor-wrap">
            <div class="current-actor-tag">アクション: ${escapeHtml(currentActor.label)}${currentActor.is_me ? ' 👤' : ''}</div>
            ${renderActionPanel(hand, currentActor, state.street, potInfo)}
          </div>`
        : '<div class="empty-state">行動が必要な相手はいません</div>'}
      ${others.length ? `
        <button type="button" class="btn secondary small spacer-top" onclick="toggleFallbackList(${hand.id})">${handUiState.showFallback ? '▲ 閉じる' : `▼ 他の人のアクションを記録(${others.length})`}</button>
        ${handUiState.showFallback ? others.map((p) => renderActionPanel(hand, p, state.street, potInfo, true)).join('') : ''}
      ` : ''}
    `;
  } else if (state.phase === 'board') {
    livePanel = `
      <div class="notice">ベットが揃いました。${escapeHtml(state.nextLabel)}を選択してください。</div>
      <button type="button" class="btn secondary block" onclick="revealBoard(${hand.id}, '${state.nextField}', ${state.nextCount})">${escapeHtml(state.nextLabel)}を選び直す</button>
    `;
    // move straight to the card picker instead of waiting for a tap, once
    // everyone's action for the street is settled
    if (!pickerState) revealBoard(hand.id, state.nextField, state.nextCount);
  } else if (state.phase === 'showdown') {
    const autoNote = state.autoWinnerSeatId
      ? `<div class="notice">自動判定: ${escapeHtml(bySeatId[state.autoWinnerSeatId].label)} の勝ち（下の「獲得」に反映済み。違う場合は選び直してください）</div>`
      : state.tiedWinners
        ? `<div class="notice">引き分け(チョップ): ${state.tiedWinners.map((p) => escapeHtml(p.label)).join(', ')} ・ 「獲得」は手動で選んでください</div>`
        : '';
    livePanel = `
      <div class="notice">ショーダウンです。残っている相手の手札を記録してください（不明なら「マック」）。</div>
      ${autoNote}
      ${state.remaining.map((p) => `
        <div class="action-panel compact">
          <div class="name-row"><strong>${escapeHtml(p.label)}${p.is_me ? ' 👤' : ''}</strong><span>${p.hole_cards ? cardsToTiles(p.hole_cards, 2) : '未記録'}</span></div>
          <div class="row">
            <button type="button" class="btn secondary small" onclick="openHoleCardPicker(${hand.id}, ${p.seat_id})">手札を記録</button>
            <button type="button" class="btn secondary small" onclick="quickMuck(${hand.id}, ${p.seat_id})">マック</button>
          </div>
        </div>`).join('')}
      ${renderResultForm(hand, participants, state, potInfo)}
    `;
  } else {
    livePanel = renderResultForm(hand, participants, state, potInfo);
  }

  // read-only history of any street, independent of the live panel above.
  // Collapsed by default so every player's actions piling up doesn't push
  // the live action panel off-screen.
  const tabs = STREET_ORDER.map((s) => `
    <button class="btn small ${handUiState.tab === s ? '' : 'secondary'}" onclick="switchTab('${s}', ${hand.id})">${STAGE_LABELS[s]}</button>
  `).join('');
  const tabActions = actions.filter((a) => a.street === handUiState.tab).slice().reverse();
  const logFeed = tabActions.map((a) => {
    const p = bySeatId[a.seat_id];
    return `<div class="log-entry">
      <span>${escapeHtml(p ? p.label : '?')} - ${ACTION_LABELS[a.action_type]}${a.amount ? ` (${fmtBB(a.amount)})` : ''}</span>
      <button class="undo" onclick="deleteAction(${a.id}, ${hand.id})">取り消し</button>
    </div>`;
  }).join('') || '<div class="empty-state">記録なし</div>';

  const boardEditRow = ['board_flop', 'board_turn', 'board_river'].map((f, i) => {
    if (!hand[f]) return '';
    const count = i === 0 ? 3 : 1;
    const streetName = f === 'board_flop' ? 'フロップ' : f === 'board_turn' ? 'ターン' : 'リバー';
    return `<button type="button" class="btn secondary small" onclick="editBoard(${hand.id}, '${f}', ${count})">${streetName}を編集</button>`;
  }).filter(Boolean).join(' ');

  appEl().innerHTML = `
    <div class="topbar">
      <button class="back" onclick="nav('${resolvedBackHash}')">← 戻る</button>
      <h1>#${hand.hand_no}</h1>
      <button class="back" onclick="deleteHand(${hand.id}, ${sessionId})">削除</button>
    </div>
    ${miniTable}
    <div class="card">
      ${livePanel}
    </div>
    <div class="card">
      <button type="button" class="btn secondary block" onclick="toggleLog(${hand.id})">${handUiState.showLog ? '▲ ログを閉じる' : '▽ ログを見る'}</button>
      ${handUiState.showLog ? `
        <div class="spacer-top row between">${boardEditRow}</div>
        <div class="row" style="margin:10px 0;">${tabs}</div>
        <div class="log-feed">${logFeed}</div>
      ` : ''}
    </div>
  `;
  if (keepScroll) window.scrollTo(0, scrollY);
}

function renderResultForm(hand, participants, state, potInfo) {
  const preselectWinner = hand.winner_seat_id || state.autoWinnerSeatId || '';
  const winnerOptions = participants.map((p) => `<option value="${p.seat_id}" ${String(preselectWinner) === String(p.seat_id) ? 'selected' : ''}>${escapeHtml(p.label)}</option>`).join('');
  const nextHandBtn = !hand.finished
    ? `<button class="btn block" onclick="saveAndNextHand(${hand.session_id}, ${hand.id})">保存して次のハンドへ</button>`
    : `<button class="btn block" onclick="saveHandSummary(${hand.id})">保存</button>`;
  const potDefault = hand.pot_size || potInfo.pot || '';
  return `
    <label>合計 (BB)</label>
    <input type="number" inputmode="decimal" step="0.01" id="hand-pot" value="${potDefault}">
    <label>獲得</label>
    <select id="hand-winner" style="width:100%;padding:12px;font-size:16px;border-radius:8px;border:1px solid var(--border);background:var(--field-bg);color:var(--text);margin-bottom:12px;">
      <option value="">未設定</option>
      ${winnerOptions}
    </select>
    <label>メモ</label>
    <textarea id="hand-memo" placeholder="気づいたことを自由に記録">${escapeHtml(hand.memo || '')}</textarea>
    ${preselectWinner ? `<button type="button" class="btn secondary block" onclick="runAiAnalysis(${hand.id})">AI分析</button>` : ''}
    ${nextHandBtn}
  `;
}

function switchTab(street, handId) {
  handUiState.tab = street;
  handUiState.amountPromptKey = null;
  renderHandBody(handId, true);
}

function promptAmount(handId, key, actionType) {
  handUiState.amountPromptKey = { key, actionType };
  renderHandBody(handId, true);
}

function cancelAmountPrompt(handId) {
  handUiState.amountPromptKey = null;
  renderHandBody(handId, true);
}

async function submitAction(handId, seatId, street, actionType) {
  await api('POST', `/api/hands/${handId}/actions`, { seat_id: seatId, street, action_type: actionType });
  renderHandBody(handId, true);
}

async function confirmAmountAction(handId, seatId, street, actionType) {
  const raw = document.getElementById('amount-input').value;
  const amount = raw ? Number(raw) : null;
  handUiState.amountPromptKey = null;
  await api('POST', `/api/hands/${handId}/actions`, { seat_id: seatId, street, action_type: actionType, amount });
  renderHandBody(handId, true);
}

async function deleteAction(actionId, handId) {
  await api('DELETE', `/api/actions/${actionId}`);
  renderHandBody(handId, true);
}

async function revealBoard(handId, field, count) {
  const { hand, participants } = await api('GET', `/api/hands/${handId}`);
  const excluded = collectKnownCards(hand, participants, field);
  openCardPicker({
    title: boardFieldLabel(field),
    min: count, max: count, excluded,
    onConfirm: async (cards) => {
      await api('PATCH', `/api/hands/${handId}`, { [field]: cards });
      renderHandBody(handId, true);
    },
  });
}

function editBoard(handId, field, count) {
  const label = boardFieldLabel(field);
  api('GET', `/api/hands/${handId}`).then(({ hand, participants }) => {
    const excluded = collectKnownCards(hand, participants, field);
    const initial = (hand[field] || '').split(' ').filter(Boolean);
    openCardPicker({
      title: label, min: count, max: count, excluded, initial,
      onConfirm: async (cards) => {
        await api('PATCH', `/api/hands/${handId}`, { [field]: cards });
        renderHandBody(handId, true);
      },
    });
  });
}

function openHoleCardPicker(handId, seatId) {
  api('GET', `/api/hands/${handId}`).then(({ hand, participants }) => {
    const p = participants.find((pp) => pp.seat_id === seatId);
    const excluded = collectKnownCards(hand, participants, `hole:${seatId}`);
    const initial = (p.hole_cards || '').split(' ').filter(Boolean);
    openCardPicker({
      title: `${p.label} の手札`, min: 0, max: 2, excluded, initial, allowSkip: true, skipLabel: 'マック(不明)',
      onConfirm: async (cards) => {
        await api('PATCH', `/api/hands/${handId}/seats/${seatId}`, { hole_cards: cards });
        renderHandBody(handId, true);
      },
    });
  });
}

async function quickMuck(handId, seatId) {
  await api('PATCH', `/api/hands/${handId}/seats/${seatId}`, { hole_cards: null });
  renderHandBody(handId, true);
}

async function saveHandSummary(handId) {
  const pot = document.getElementById('hand-pot').value;
  const winner = document.getElementById('hand-winner').value;
  const memo = document.getElementById('hand-memo').value;
  await api('PATCH', `/api/hands/${handId}`, {
    pot_size: pot ? Number(pot) : null,
    winner_seat_id: winner ? Number(winner) : null,
    memo: memo || null,
  });
  alert('保存しました');
}

async function saveAndNextHand(sessionId, handId) {
  const pot = document.getElementById('hand-pot').value;
  const winner = document.getElementById('hand-winner').value;
  const memo = document.getElementById('hand-memo').value;
  await api('PATCH', `/api/hands/${handId}`, {
    pot_size: pot ? Number(pot) : null,
    winner_seat_id: winner ? Number(winner) : null,
    memo: memo || null,
    finished: 1,
  });
  try {
    await api('POST', `/api/sessions/${sessionId}/dealer/next`);
    await api('POST', `/api/sessions/${sessionId}/hands`, {});
  } catch (e) {
    alert(e.message);
  }
  goToSession(sessionId);
}

async function deleteHand(handId, sessionId) {
  if (!confirm('この記録を削除します。よろしいですか？')) return;
  await api('DELETE', `/api/hands/${handId}`);
  goToSession(sessionId);
}
