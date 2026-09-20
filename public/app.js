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

const STREET_LABELS = { preflop: 'プリフロップ', flop: 'フロップ', turn: 'ターン', river: 'リバー' };
const ACTION_LABELS = { fold: 'フォールド', check: 'チェック', call: 'コール', bet: 'ベット', raise: 'レイズ', allin: 'オールイン' };
const ACTIONS_NEEDING_AMOUNT = ['bet', 'raise', 'allin'];

// ---------- card helpers ----------
const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
const SUITS = [
  { code: 's', symbol: '♠', color: 'black' },
  { code: 'h', symbol: '♥', color: 'red' },
  { code: 'd', symbol: '♦', color: 'red' },
  { code: 'c', symbol: '♣', color: 'black' },
];

function cardTile(code) {
  if (!code) return '<span class="card-tile empty">?</span>';
  const rank = code[0];
  const suit = SUITS.find((s) => s.code === code[1]);
  const cls = suit && suit.color === 'red' ? 'card-tile red' : 'card-tile';
  return `<span class="${cls}">${rank}${suit ? suit.symbol : ''}</span>`;
}

function cardsToTiles(str, slots) {
  const codes = (str || '').split(' ').filter(Boolean);
  const out = [];
  for (let i = 0; i < slots; i += 1) out.push(cardTile(codes[i]));
  return out.join('');
}

function collectKnownCards(hand, participants, excludeField) {
  const set = new Set();
  ['board_flop', 'board_turn', 'board_river'].forEach((f) => {
    if (f === excludeField) return;
    (hand[f] || '').split(' ').filter(Boolean).forEach((c) => set.add(c));
  });
  participants.forEach((p) => {
    if (excludeField === `hole:${p.player_id}`) return;
    (p.hole_cards || '').split(' ').filter(Boolean).forEach((c) => set.add(c));
  });
  return set;
}

// ---------- card picker modal ----------
let pickerState = null;

function openCardPicker({ title, min, max, excluded, initial, allowSkip, onConfirm }) {
  pickerState = {
    title, min, max, excluded: excluded || new Set(),
    selected: (initial || []).slice(),
    allowSkip: !!allowSkip,
    onConfirm,
  };
  renderPicker();
}

function closeCardPicker() {
  pickerState = null;
  const el = document.getElementById('picker-root');
  if (el) el.innerHTML = '';
}

function renderPicker() {
  const root = document.getElementById('picker-root');
  if (!pickerState) { root.innerHTML = ''; return; }
  const { title, min, max, excluded, selected } = pickerState;
  const rows = SUITS.map((suit) => {
    const cells = RANKS.map((rank) => {
      const code = rank + suit.code;
      const isSel = selected.includes(code);
      const isExcluded = excluded.has(code) && !isSel;
      return `<button type="button" class="${suit.color === 'red' ? 'red' : ''}${isSel ? ' selected' : ''}"
        ${isExcluded ? 'disabled' : ''} onclick="pickerToggle('${code}')">${rank}${suit.symbol}</button>`;
    }).join('');
    return `<div class="picker-suit-row">
      <div class="picker-suit-label ${suit.color}">${suit.symbol}</div>
      <div class="picker-grid">${cells}</div>
    </div>`;
  }).join('');

  const canConfirm = selected.length >= min;
  root.innerHTML = `
    <div class="modal-overlay" onclick="if(event.target===this) pickerCancel()">
      <div class="modal-sheet">
        <h2>${escapeHtml(title)}</h2>
        <div style="color:var(--muted);font-size:13px;margin-bottom:10px;">${selected.length}/${max} 選択中${min < max ? `(最低${min}枚)` : ''}</div>
        ${rows}
        <div class="row spacer-top">
          <button type="button" class="btn secondary" onclick="pickerCancel()">キャンセル</button>
          ${selected.length ? '<button type="button" class="btn secondary" onclick="pickerClear()">クリア</button>' : ''}
          ${pickerState.allowSkip ? '<button type="button" class="btn secondary" onclick="pickerSkip()">不明/スキップ</button>' : ''}
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
  if (parts[0] === 'session' && parts[2] === 'new-hand') return renderNewHand(parts[1]);
  if (parts[0] === 'session') return renderSessionDetail(parts[1]);
  if (parts[0] === 'hand') return renderHandPage(parts[1]);
  return renderHome();
}

function nav(hash) { window.location.hash = hash; }

// ---------- home ----------
async function renderHome() {
  appEl().innerHTML = `<div class="topbar"><h1>Poker Memo</h1><span></span></div><div class="empty-state">読み込み中...</div>`;
  const sessions = await api('GET', '/api/sessions');
  const list = sessions.length ? sessions.map((s) => `
    <button class="list-item" onclick="nav('#/session/${s.id}')">
      <div><strong>${escapeHtml(s.title)}</strong></div>
      <div class="meta">${fmtDateTime(s.created_at)} ・ ${s.hand_count}ハンド
        ${s.small_blind || s.big_blind ? ` ・ SB${fmtNum(s.small_blind)}/BB${fmtNum(s.big_blind)}` : ''}</div>
    </button>`).join('') : '<div class="empty-state">まだセッションがありません<br>「新規セッション」から始めましょう</div>';

  appEl().innerHTML = `
    <div class="topbar"><h1>Poker Memo</h1><span></span></div>
    <button class="btn block" onclick="nav('#/new-session')">＋ 新規セッション</button>
    <div class="spacer-top"></div>
    <h3>過去のセッション</h3>
    ${list}
  `;
}

// ---------- new session ----------
let newSessionRowCount = 0;

function renderNewSession() {
  newSessionRowCount = 0;
  appEl().innerHTML = `
    <div class="topbar"><button class="back" onclick="nav('#/')">← 戻る</button><h1>新規セッション</h1><span></span></div>
    <div class="card">
      <label>セッション名</label>
      <input type="text" id="ns-title" placeholder="例: 9/20 ホームゲーム" value="${fmtDateTime(new Date().toISOString())}">
      <div class="row">
        <div style="flex:1">
          <label>SB</label>
          <input type="number" id="ns-sb" inputmode="decimal" placeholder="任意">
        </div>
        <div style="flex:1">
          <label>BB</label>
          <input type="number" id="ns-bb" inputmode="decimal" placeholder="任意">
        </div>
      </div>
    </div>
    <div class="card">
      <label>参加プレイヤー</label>
      <div id="player-rows"></div>
      <button type="button" class="btn secondary small" onclick="addPlayerRow()">＋ プレイヤーを追加</button>
    </div>
    <button class="btn block" onclick="submitNewSession()">セッションを開始</button>
  `;
  addPlayerRow('自分', true);
  addPlayerRow();
  addPlayerRow();
}

function addPlayerRow(name = '', isMe = false) {
  newSessionRowCount += 1;
  const id = newSessionRowCount;
  const row = document.createElement('div');
  row.className = 'player-row';
  row.dataset.rowId = id;
  row.innerHTML = `
    <input type="text" placeholder="名前" value="${escapeHtml(name)}">
    <button type="button" class="me-toggle${isMe ? ' active' : ''}" onclick="toggleMeRow(this)">自分</button>
    <button type="button" class="btn secondary small" onclick="this.closest('.player-row').remove()">×</button>
  `;
  document.getElementById('player-rows').appendChild(row);
}

function toggleMeRow(btn) {
  document.querySelectorAll('#player-rows .me-toggle').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
}

async function submitNewSession() {
  const title = document.getElementById('ns-title').value.trim() || fmtDateTime(new Date().toISOString());
  const sb = document.getElementById('ns-sb').value;
  const bb = document.getElementById('ns-bb').value;
  const rows = Array.from(document.querySelectorAll('#player-rows .player-row'));
  const players = rows.map((r) => ({
    name: r.querySelector('input[type="text"]').value.trim(),
    is_me: r.querySelector('.me-toggle').classList.contains('active'),
  })).filter((p) => p.name);
  if (players.length === 0) {
    alert('プレイヤーを1人以上入力してください');
    return;
  }
  const { session } = await api('POST', '/api/sessions', {
    title, small_blind: sb ? Number(sb) : null, big_blind: bb ? Number(bb) : null, players,
  });
  nav(`#/session/${session.id}`);
}

// ---------- session detail ----------
async function renderSessionDetail(sessionId) {
  appEl().innerHTML = `<div class="topbar"><button class="back" onclick="nav('#/')">← 戻る</button><h1>読み込み中...</h1></div>`;
  const { session, players, hands } = await api('GET', `/api/sessions/${sessionId}`);

  const handsList = hands.length ? hands.slice().reverse().map((h) => {
    const winner = h.winner_player_id ? players.find((p) => p.id === h.winner_player_id) : null;
    return `<button class="list-item" onclick="nav('#/hand/${h.id}')">
      <div><strong>ハンド #${h.hand_no}</strong> ${winner ? `・ 勝者: ${escapeHtml(winner.name)}` : ''}</div>
      <div class="meta">${fmtDateTime(h.created_at)}${h.pot_size ? ` ・ Pot ${fmtNum(h.pot_size)}` : ''}</div>
    </button>`;
  }).join('') : '<div class="empty-state">まだハンドが記録されていません</div>';

  const playerChips = players.map((p) => `<span class="chip${p.is_me ? ' me' : ''}">${escapeHtml(p.name)}</span>`).join(' ');

  appEl().innerHTML = `
    <div class="topbar"><button class="back" onclick="nav('#/')">← 戻る</button><h1>${escapeHtml(session.title)}</h1><span></span></div>
    <div class="card">
      <div class="meta" style="color:var(--muted);margin-bottom:8px;">
        ${fmtDateTime(session.created_at)}
        ${session.small_blind || session.big_blind ? ` ・ SB${fmtNum(session.small_blind)}/BB${fmtNum(session.big_blind)}` : ''}
      </div>
      <div>${playerChips}</div>
      <div class="row spacer-top">
        <input type="text" id="add-player-name" placeholder="新しいプレイヤー名" style="flex:1;margin-bottom:0;">
        <button class="btn secondary small" onclick="addSessionPlayer(${session.id})">追加</button>
      </div>
    </div>
    <button class="btn block" onclick="nav('#/session/${session.id}/new-hand')">＋ ハンドを記録</button>
    <div class="spacer-top"></div>
    <div class="row between"><h3>ハンド一覧</h3>
      <button class="btn danger small" onclick="deleteSession(${session.id})">セッション削除</button>
    </div>
    ${handsList}
  `;
}

async function addSessionPlayer(sessionId) {
  const input = document.getElementById('add-player-name');
  const name = input.value.trim();
  if (!name) return;
  await api('POST', `/api/sessions/${sessionId}/players`, { name });
  renderSessionDetail(sessionId);
}

async function deleteSession(sessionId) {
  if (!confirm('このセッションと記録した全ハンドを削除します。よろしいですか？')) return;
  await api('DELETE', `/api/sessions/${sessionId}`);
  nav('#/');
}

// ---------- new hand setup ----------
async function renderNewHand(sessionId) {
  appEl().innerHTML = `<div class="topbar"><button class="back" onclick="nav('#/session/${sessionId}')">← 戻る</button><h1>読み込み中...</h1></div>`;
  const { session, players } = await api('GET', `/api/sessions/${sessionId}`);

  const rows = players.map((p) => `
    <label style="display:flex;align-items:center;gap:8px;font-size:15px;color:var(--text);margin-bottom:8px;">
      <input type="checkbox" value="${p.id}" checked class="nh-participant" style="width:auto;">
      ${escapeHtml(p.name)}${p.is_me ? ' <span class="chip me" style="margin-left:4px;">自分</span>' : ''}
    </label>`).join('');

  const dealerOptions = players.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');

  appEl().innerHTML = `
    <div class="topbar"><button class="back" onclick="nav('#/session/${sessionId}')">← 戻る</button><h1>新しいハンド</h1><span></span></div>
    <div class="card">
      <label>参加プレイヤー</label>
      ${rows}
    </div>
    <div class="card">
      <label>ディーラー(任意)</label>
      <select id="nh-dealer" style="width:100%;padding:12px;font-size:16px;border-radius:8px;border:1px solid var(--border);background:#0f2a20;color:var(--text);">
        <option value="">未設定</option>
        ${dealerOptions}
      </select>
    </div>
    <button class="btn block" onclick="submitNewHand(${session.id})">ハンド開始</button>
  `;
}

async function submitNewHand(sessionId) {
  const ids = Array.from(document.querySelectorAll('.nh-participant:checked')).map((c) => Number(c.value));
  if (ids.length === 0) {
    alert('参加プレイヤーを1人以上選んでください');
    return;
  }
  const dealer = document.getElementById('nh-dealer').value;
  const hand = await api('POST', `/api/sessions/${sessionId}/hands`, {
    participant_player_ids: ids,
    dealer_player_id: dealer ? Number(dealer) : null,
  });
  nav(`#/hand/${hand.hand.id}`);
}

// ---------- hand page ----------
let handUiState = { tab: 'preflop', amountPromptKey: null };

function currentStreetFor(hand) {
  if (!hand.board_flop) return 'preflop';
  if (!hand.board_turn) return 'flop';
  if (!hand.board_river) return 'turn';
  return 'river';
}

async function renderHandPage(handId, keepScroll) {
  const scrollY = keepScroll ? window.scrollY : 0;
  if (!keepScroll) {
    appEl().innerHTML = `<div class="topbar"><h1>読み込み中...</h1></div>`;
    handUiState = { tab: 'preflop', amountPromptKey: null };
  }
  const { hand, participants, actions } = await api('GET', `/api/hands/${handId}`);

  if (!keepScroll) handUiState.tab = currentStreetFor(hand);

  const activeStreet = handUiState.tab;
  const nonFolded = participants.filter((p) => !p.folded);

  // participant chips
  const chips = participants.map((p) => {
    const dealerMark = hand.dealer_player_id === p.player_id ? ' (D)' : '';
    return `<span class="chip${p.is_me ? ' me' : ''}${p.folded ? ' folded' : ''}" style="cursor:pointer" onclick="openHoleCardPicker(${hand.id}, ${p.player_id})">
      ${escapeHtml(p.name)}${dealerMark}${p.hole_cards ? ' ' + cardsToTiles(p.hole_cards, 2) : ' 🂠'}
    </span>`;
  }).join(' ');

  // board section
  const boardSection = `
    <div class="card">
      <h3>ボード</h3>
      <div class="row between">
        <div>フロップ ${cardsToTiles(hand.board_flop, 3)}</div>
        <button class="btn secondary small" onclick="editBoard(${hand.id}, 'board_flop', 3)">${hand.board_flop ? '編集' : '設定'}</button>
      </div>
      <div class="row between spacer-top">
        <div>ターン ${cardsToTiles(hand.board_turn, 1)}</div>
        <button class="btn secondary small" onclick="editBoard(${hand.id}, 'board_turn', 1)">${hand.board_turn ? '編集' : '設定'}</button>
      </div>
      <div class="row between spacer-top">
        <div>リバー ${cardsToTiles(hand.board_river, 1)}</div>
        <button class="btn secondary small" onclick="editBoard(${hand.id}, 'board_river', 1)">${hand.board_river ? '編集' : '設定'}</button>
      </div>
    </div>`;

  // street tabs
  const tabs = ['preflop', 'flop', 'turn', 'river'].map((s) => `
    <button class="btn small ${activeStreet === s ? '' : 'secondary'}" onclick="switchTab('${s}', ${hand.id})">${STREET_LABELS[s]}</button>
  `).join('');

  // action panels for players eligible in this street (not folded before/at this street)
  const streetOrder = ['preflop', 'flop', 'turn', 'river'];
  const streetIdx = streetOrder.indexOf(activeStreet);
  const eligible = participants.filter((p) => {
    const foldedBefore = actions.some((a) => a.player_id === p.player_id && a.action_type === 'fold' && streetOrder.indexOf(a.street) <= streetIdx);
    return !foldedBefore;
  });

  const actionPanels = eligible.map((p) => {
    const key = `${activeStreet}:${p.player_id}`;
    if (handUiState.amountPromptKey && handUiState.amountPromptKey.key === key) {
      const at = handUiState.amountPromptKey.actionType;
      return `<div class="action-panel">
        <div class="name-row"><strong>${escapeHtml(p.name)}</strong><span>${ACTION_LABELS[at]}</span></div>
        <input type="number" inputmode="decimal" id="amount-input" placeholder="金額(任意)" autofocus>
        <div class="row">
          <button class="btn secondary small" onclick="cancelAmountPrompt(${hand.id})">キャンセル</button>
          <button class="btn small" onclick="confirmAmountAction(${hand.id}, ${p.player_id}, '${activeStreet}', '${at}')">記録する</button>
        </div>
      </div>`;
    }
    return `<div class="action-panel">
      <div class="name-row"><strong>${escapeHtml(p.name)}${p.is_me ? ' 👤' : ''}</strong></div>
      <div class="action-buttons">
        <button class="fold" onclick="submitAction(${hand.id}, ${p.player_id}, '${activeStreet}', 'fold')">フォールド</button>
        <button class="check" onclick="submitAction(${hand.id}, ${p.player_id}, '${activeStreet}', 'check')">チェック</button>
        <button class="call" onclick="submitAction(${hand.id}, ${p.player_id}, '${activeStreet}', 'call')">コール</button>
        <button class="bet" onclick="promptAmount('${key}', 'bet')">ベット</button>
        <button class="raise" onclick="promptAmount('${key}', 'raise')">レイズ</button>
        <button class="allin" onclick="promptAmount('${key}', 'allin')">オールイン</button>
      </div>
    </div>`;
  }).join('') || '<div class="empty-state">このストリートで行動できるプレイヤーがいません</div>';

  const streetActions = actions.filter((a) => a.street === activeStreet).slice().reverse();
  const logFeed = streetActions.map((a) => {
    const p = participants.find((pp) => pp.player_id === a.player_id);
    return `<div class="log-entry">
      <span>${escapeHtml(p ? p.name : '?')} - ${ACTION_LABELS[a.action_type]}${a.amount ? ` (${fmtNum(a.amount)})` : ''}</span>
      <button class="undo" onclick="deleteAction(${a.id}, ${hand.id})">取り消し</button>
    </div>`;
  }).join('');

  const winnerOptions = participants.map((p) => `<option value="${p.player_id}" ${hand.winner_player_id === p.player_id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('');

  appEl().innerHTML = `
    <div class="topbar">
      <button class="back" onclick="nav('#/session/${hand.session_id}')">← 戻る</button>
      <h1>ハンド #${hand.hand_no}</h1>
      <button class="back" onclick="deleteHand(${hand.id}, ${hand.session_id})">削除</button>
    </div>
    <div class="card">${chips}</div>
    ${boardSection}
    <div class="card">
      <h3>アクション記録</h3>
      <div class="row spacer-top" style="margin-bottom:10px;">${tabs}</div>
      <span class="street-badge">${STREET_LABELS[activeStreet]}</span>
      ${actionPanels}
      <div class="log-feed">${logFeed}</div>
    </div>
    <div class="card">
      <h3>ハンド終了時の記録(任意)</h3>
      <label>ポットサイズ</label>
      <input type="number" inputmode="decimal" id="hand-pot" value="${hand.pot_size || ''}">
      <label>勝者</label>
      <select id="hand-winner" style="width:100%;padding:12px;font-size:16px;border-radius:8px;border:1px solid var(--border);background:#0f2a20;color:var(--text);margin-bottom:12px;">
        <option value="">未設定</option>
        ${winnerOptions}
      </select>
      <label>メモ</label>
      <textarea id="hand-memo" placeholder="気づいたことを自由に記録">${escapeHtml(hand.memo || '')}</textarea>
      <button class="btn block" onclick="saveHandSummary(${hand.id})">保存</button>
    </div>
  `;
  if (keepScroll) window.scrollTo(0, scrollY);
}

function switchTab(street, handId) {
  handUiState.tab = street;
  handUiState.amountPromptKey = null;
  renderHandPage(handId, true);
}

function promptAmount(key, actionType) {
  handUiState.amountPromptKey = { key, actionType };
  const [, handId] = [null, window.location.hash.match(/#\/hand\/(\d+)/)[1]];
  renderHandPage(handId, true);
}

function cancelAmountPrompt(handId) {
  handUiState.amountPromptKey = null;
  renderHandPage(handId, true);
}

async function submitAction(handId, playerId, street, actionType) {
  await api('POST', `/api/hands/${handId}/actions`, { player_id: playerId, street, action_type: actionType });
  renderHandPage(handId, true);
}

async function confirmAmountAction(handId, playerId, street, actionType) {
  const raw = document.getElementById('amount-input').value;
  const amount = raw ? Number(raw) : null;
  handUiState.amountPromptKey = null;
  await api('POST', `/api/hands/${handId}/actions`, { player_id: playerId, street, action_type: actionType, amount });
  renderHandPage(handId, true);
}

async function deleteAction(actionId, handId) {
  await api('DELETE', `/api/actions/${actionId}`);
  renderHandPage(handId, true);
}

function editBoard(handId, field, count) {
  const label = field === 'board_flop' ? 'フロップ (3枚)' : field === 'board_turn' ? 'ターン (1枚)' : 'リバー (1枚)';
  api('GET', `/api/hands/${handId}`).then(({ hand, participants }) => {
    const excluded = collectKnownCards(hand, participants, field);
    const initial = (hand[field] || '').split(' ').filter(Boolean);
    openCardPicker({
      title: label, min: count, max: count, excluded, initial,
      onConfirm: async (cards) => {
        await api('PATCH', `/api/hands/${handId}`, { [field]: cards });
        renderHandPage(handId, true);
      },
    });
  });
}

function openHoleCardPicker(handId, playerId) {
  api('GET', `/api/hands/${handId}`).then(({ hand, participants }) => {
    const p = participants.find((pp) => pp.player_id === playerId);
    const excluded = collectKnownCards(hand, participants, `hole:${playerId}`);
    const initial = (p.hole_cards || '').split(' ').filter(Boolean);
    openCardPicker({
      title: `${p.name} のハンド`, min: 0, max: 2, excluded, initial, allowSkip: true,
      onConfirm: async (cards) => {
        await api('PATCH', `/api/hands/${handId}/players/${playerId}`, { hole_cards: cards });
        renderHandPage(handId, true);
      },
    });
  });
}

async function saveHandSummary(handId) {
  const pot = document.getElementById('hand-pot').value;
  const winner = document.getElementById('hand-winner').value;
  const memo = document.getElementById('hand-memo').value;
  await api('PATCH', `/api/hands/${handId}`, {
    pot_size: pot ? Number(pot) : null,
    winner_player_id: winner ? Number(winner) : null,
    memo: memo || null,
  });
  alert('保存しました');
}

async function deleteHand(handId, sessionId) {
  if (!confirm('このハンドの記録を削除します。よろしいですか？')) return;
  await api('DELETE', `/api/hands/${handId}`);
  nav(`#/session/${sessionId}`);
}
