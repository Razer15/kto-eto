import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore, doc, setDoc, getDoc, updateDoc, onSnapshot, arrayUnion, serverTimestamp, FieldPath, runTransaction }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

// ---------- init firebase ----------
let db = null, configOK = false;
try {
  if (firebaseConfig.apiKey && !firebaseConfig.apiKey.includes("ВСТАВЬ")) {
    const app = initializeApp(firebaseConfig);
    db = getFirestore(app);
    configOK = true;
  }
} catch (e) { console.error(e); }

// ---------- state ----------
let me = "";
let roomCode = "";
let unsub = null;
let room = null;
let factCount = 3;
let revealSent = -1;   // guard: reveal write already sent for this step index

const $ = id => document.getElementById(id);
const roomRef = () => doc(db, 'rooms', roomCode);

// ---------- session persistence (survive refresh AND full tab close mid-game) ----------
// localStorage (not sessionStorage) so a closed/reopened tab still restores.
// The freshness window stops us resurrecting an old room the next day: rooms are
// never deleted, so a stale saved code could otherwise drop you into a dead game.
const SKEY = 'ktoeto:v1';
const RESTORE_WINDOW_MS = 12 * 60 * 60 * 1000; // one party evening
function saveSession() { try { localStorage.setItem(SKEY, JSON.stringify({ me, roomCode, savedAt: Date.now() })); } catch (e) {} }
function clearSession() { try { localStorage.removeItem(SKEY); } catch (e) {} }

function go(id) {
  ['setupWarn','home','create','join','write','lobby','playScreen','results']
    .forEach(s => $(s).classList.add('hidden'));
  $(id).classList.remove('hidden');
  window.scrollTo(0, 0);
}

let toastTimer;
function toast(m) {
  const t = $('toast');
  t.textContent = m; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1900);
}

// ---------- initial screen ----------
if (!configOK) {
  go('setupWarn');
} else {
  go('home');
  tryRestore();
}

// Reconnect after a refresh / accidental navigation, using the saved session.
async function tryRestore() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(SKEY) || 'null'); } catch (e) {}
  if (!saved || !saved.me || !saved.roomCode) return;
  if (!saved.savedAt || Date.now() - saved.savedAt > RESTORE_WINDOW_MS) { clearSession(); return; }
  try {
    const snap = await getDoc(doc(db, 'rooms', saved.roomCode));
    if (!snap.exists()) { clearSession(); return; }
    const data = snap.data();
    me = saved.me; roomCode = saved.roomCode; factCount = data.factCount || 3;
    saveSession();   // reopening is activity — refresh savedAt so the window doesn't expire mid-game
    listenRoom();
    routeInitial(data);
  } catch (e) { console.error(e); clearSession(); }
}

// Put the reconnecting player on the right screen for the current phase.
function routeInitial(data) {
  ['wCode','lCode','pCode','rCode'].forEach(id => $(id).textContent = roomCode);
  $('wName').textContent = me;
  if (data.phase === 'playing') { go('playScreen'); return; }
  if (data.phase === 'results') return;  // the snapshot listener will call showResults()
  // lobby: if we already submitted facts → lobby, else back to the write screen
  const meP = (data.players || []).find(p => p.name.toLowerCase() === me.toLowerCase());
  if (meP && meP.ready) go('lobby'); else openWriteScreen();
}

// ---------- room code ----------
const WORDS = ['КОШКА','ЛУНА','МОРЕ','ВИШНЯ','ЛИСА','ЗВЕЗДА','МЯТА','ГРОЗА','ПЕРО','ВОЛНА','ИСКРА','РОЗА','ТУЧА','ЁЖИК','КЛЁН'];
function genCode() { return WORDS[Math.floor(Math.random()*WORDS.length)] + Math.floor(10 + Math.random()*89); }
function shuffle(arr) { const a = [...arr]; for (let i = a.length-1; i > 0; i--) { const j = Math.floor(Math.random()*(i+1)); [a[i],a[j]] = [a[j],a[i]]; } return a; }

// ---------- fact count selector ----------
function setCount(n) {
  factCount = n;
  document.querySelectorAll('.countbtn').forEach(b => {
    const on = (+b.dataset.n === n);
    b.classList.toggle('picked', on);
    b.style.background = on ? 'var(--plum)' : 'transparent';
    b.style.color = on ? '#fff' : 'var(--plum)';
  });
}

// ---------- create room ----------
// Pick a room code that isn't already taken. Rooms in the shared Firebase
// project are never deleted, so codes accumulate; setDoc would silently
// overwrite an existing (possibly live) room on a collision.
async function freshCode() {
  for (let i = 0; i < 8; i++) {
    const c = genCode();
    try { if (!(await getDoc(doc(db, 'rooms', c))).exists()) return c; }
    catch (e) { return c; }  // read failed (e.g. rules) — fall back to using it
  }
  return genCode() + Math.floor(Math.random() * 9);  // last resort: extra entropy
}

async function createRoom() {
  const name = $('cName').value.trim();
  if (!name) { toast('Впиши имя'); return; }
  me = name; roomCode = await freshCode();
  try {
    await setDoc(roomRef(), {
      code: roomCode, factCount, phase: 'lobby', creator: me,
      players: [{ name: me, ready: false }],
      facts: [], guesses: {}, order: [], stepIndex: 0, stepRevealed: false,
      createdAt: serverTimestamp()
    });
    saveSession();
    listenRoom();
    openWriteScreen();
  } catch (e) { console.error(e); toast('Не удалось создать. Проверь правила Firestore.'); }
}

// ---------- join room ----------
async function joinRoom() {
  const code = $('jCode').value.trim().toUpperCase();
  const name = $('jName').value.trim();
  if (!code) { toast('Введи код'); return; }
  if (!name) { toast('Впиши имя'); return; }
  try {
    const snap = await getDoc(doc(db, 'rooms', code));
    if (!snap.exists()) { toast('Комната не найдена'); return; }
    const data = snap.data();
    const existing = data.players.some(p => p.name.toLowerCase() === name.toLowerCase());
    if (data.phase !== 'lobby') {
      // Game already started: only an existing player may reconnect (e.g. after a refresh).
      if (!existing) { toast('Игра уже началась'); return; }
      me = name; roomCode = code; factCount = data.factCount;
      saveSession();
      listenRoom();
      routeInitial(data);
      return;
    }
    // Lobby: a matching name means someone with that name is already in — pick another.
    if (existing) { toast('Это имя уже занято — выбери другое'); return; }
    me = name; roomCode = code; factCount = data.factCount;
    await updateDoc(doc(db, 'rooms', code), { players: arrayUnion({ name: me, ready: false }) });
    saveSession();
    listenRoom();
    openWriteScreen();
  } catch (e) { console.error(e); toast('Ошибка входа'); }
}

// ---------- write facts ----------
function openWriteScreen() {
  ['wCode','lCode','pCode','rCode'].forEach(id => $(id).textContent = roomCode);
  $('wName').textContent = me;
  const box = $('factInputs'); box.innerHTML = '';
  const ex = ['В детстве съела мыло на спор','Знаю все столицы Африки','Боюсь голубей','Была на концерте до 10 лет','Умею шевелить ушами'];
  for (let i = 0; i < factCount; i++) {
    const row = document.createElement('div');
    row.style.marginBottom = '12px';
    row.innerHTML = `<label>Факт ${i+1}</label><textarea class="factField" placeholder="${ex[i % ex.length]}"></textarea>`;
    box.appendChild(row);
  }
  go('write');
}

async function submitFacts() {
  const facts = [...document.querySelectorAll('.factField')].map(f => f.value.trim());
  if (facts.some(f => !f)) { toast('Заполни все факты'); return; }
  const ref = roomRef();
  const newFacts = facts.map((t, i) => ({ id: me + '__' + i, text: t, owner: me }));
  try {
    // Transaction: submitFacts rewrites the whole facts+players arrays, so two
    // people finishing at once would otherwise last-write-wins and drop one's
    // facts. runTransaction re-reads and retries on conflict.
    await runTransaction(db, async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error('room gone');
      const data = snap.data();
      const players = (data.players || []).map(p => p.name.toLowerCase() === me.toLowerCase() ? { ...p, ready: true } : p);
      const others = (data.facts || []).filter(f => f.owner.toLowerCase() !== me.toLowerCase());
      tx.update(ref, { facts: [...others, ...newFacts], players });
    });
    go('lobby');
  } catch (e) { console.error(e); toast('Не удалось сохранить'); }
}

// ---------- live listener ----------
function listenRoom() {
  if (unsub) unsub();
  unsub = onSnapshot(roomRef(), snap => {
    if (!snap.exists()) return;
    room = snap.data();
    render();
  });
}

function render() {
  if (!room) return;
  if (room.phase === 'results') { showResults(); return; }
  if (room.phase === 'playing') {
    if ($('playScreen').classList.contains('hidden')) go('playScreen');
    renderPlay();
    return;
  }
  if (!$('lobby').classList.contains('hidden')) renderLobby();
}

// ---------- lobby ----------
function renderLobby() {
  const list = $('lobbyList'); list.innerHTML = '';
  room.players.forEach(p => {
    const chip = document.createElement('div');
    chip.className = 'lobby-chip' + (p.ready ? '' : ' waiting');
    chip.innerHTML = `<span class="dot"></span>${escapeHtml(p.name)} <span class="lobby-status">${p.ready ? 'готова' : 'пишет…'}</span>`;
    list.appendChild(chip);
  });
  const allReady = room.players.length >= 2 && room.players.every(p => p.ready);
  const readyCount = room.players.filter(p => p.ready).length;
  const isCreator = (room.creator || '').toLowerCase() === me.toLowerCase();

  $('lobbyHint').textContent = isCreator
    ? 'Скажи подругам код комнаты — он вверху. Когда все напишут факты, нажми «Начать».'
    : 'Когда все напишут факты, создательница начнёт игру.';

  $('lobbyStatus').innerHTML = allReady
    ? `<p class="center allready">Все готовы! 🎉</p>`
    : `<p class="field-note center">Готовы: ${readyCount} из ${room.players.length}${room.players.length < 2 ? ' · нужно минимум 2 участницы' : ''}</p>`;

  const startArea = $('startArea'), waitStart = $('waitStart');
  if (isCreator) {
    startArea.classList.toggle('hidden', !allReady);
    waitStart.classList.add('hidden');
  } else {
    startArea.classList.add('hidden');
    waitStart.classList.remove('hidden');
    $('waitStartText').textContent = allReady
      ? 'Все готовы — ждём, когда создательница начнёт.'
      : 'Ждём, пока все напишут факты…';
  }
}

// ---------- start game (creator) ----------
async function beginGame() {
  const order = shuffle((room.facts || []).map(f => f.id));
  try {
    await updateDoc(roomRef(), { phase: 'playing', order, stepIndex: 0, stepRevealed: false, guesses: {} });
  } catch (e) { console.error(e); toast('Ошибка старта'); }
}

// ---------- play: one fact at a time, in lockstep ----------
function renderPlay() {
  const order = room.order || [];
  const total = order.length;
  const idx = room.stepIndex || 0;
  const fid = order[idx];
  const fact = (room.facts || []).find(f => f.id === fid);
  const card = $('factCard');
  $('playProgress').textContent = total ? `Факт ${Math.min(idx + 1, total)} из ${total}` : '';
  if (!fact) { card.innerHTML = ''; return; }

  const owner = fact.owner;
  const iAmOwner = owner.toLowerCase() === me.toLowerCase();
  const isCreator = (room.creator || '').toLowerCase() === me.toLowerCase();
  const required = room.players.filter(p => p.name.toLowerCase() !== owner.toLowerCase());
  const guessesAll = room.guesses || {};
  const answered = required.filter(p => guessesAll[p.name] && guessesAll[p.name][fid] !== undefined);
  const allAnswered = required.length > 0 && answered.length === required.length;
  const revealed = !!room.stepRevealed;
  const myPick = guessesAll[me] ? guessesAll[me][fid] : undefined;

  // once everyone (except owner) has answered, flip to reveal for all
  if (allAnswered && !revealed) triggerReveal(idx);

  let html = `<div class="fact-item">
    <div class="fact-num">${iAmOwner ? 'Твой факт' : 'Факт'}</div>
    <div class="fact-text">«${escapeHtml(fact.text)}»</div>`;

  if (iAmOwner) {
    html += revealed
      ? `<div class="reveal-line hit">Это твой факт — все увидели ответ 🙈</div>`
      : `<p class="field-note">Остальные угадывают. Ответили ${answered.length} из ${required.length}</p>`;
  } else {
    const options = room.players.filter(p => p.name.toLowerCase() !== me.toLowerCase());
    let chips = '';
    options.forEach(p => {
      let cls = 'guess-chip', attrs = '';
      if (revealed) {
        if (p.name.toLowerCase() === owner.toLowerCase()) cls += ' correct';
        else if (myPick && myPick.toLowerCase() === p.name.toLowerCase()) cls += ' wrong';
        attrs = 'disabled';
      } else if (myPick) {
        if (myPick.toLowerCase() === p.name.toLowerCase()) cls += ' picked';
        attrs = 'disabled';
      }
      chips += `<button class="${cls}" data-fid="${escapeAttr(fid)}" data-name="${escapeAttr(p.name)}" ${attrs}>${escapeHtml(p.name)}</button>`;
    });
    html += `<div class="guess-grid">${chips}</div>`;
    if (revealed) {
      const hit = myPick && myPick.toLowerCase() === owner.toLowerCase();
      html += `<div class="reveal-line ${hit ? 'hit' : 'miss'}">${hit ? '✓ Верно! Это ' + escapeHtml(owner) : '✗ Это ' + escapeHtml(owner)}</div>`;
    } else if (myPick) {
      html += `<p class="field-note waitline">Ждём остальных: ${answered.length} из ${required.length}</p>`;
    }
  }

  if (revealed) {
    const last = idx >= total - 1;
    html += `<button class="full gold mt16" data-action="nextFact">${last ? 'Показать результаты →' : 'Дальше →'}</button>`;
  } else if (isCreator) {
    // Unstick a step when someone dropped out and never answers.
    html += `<button class="linklike skipbtn" data-action="skipStep">Кто-то завис? Показать ответ →</button>`;
  }
  html += `</div>`;
  card.innerHTML = html;
}

function triggerReveal(idx) {
  if (revealSent === idx) return;
  revealSent = idx;
  updateDoc(roomRef(), { stepRevealed: true }).catch(() => { revealSent = -1; });
}

async function pick(fid, name) {
  const g = { ...((room.guesses && room.guesses[me]) || {}) };
  g[fid] = name;
  // FieldPath keeps `me` a literal map key — a dotted string in updateDoc's
  // object form (`guesses.${me}`) would be parsed as a nested path and corrupt
  // the guesses map (breaking answer counting → step softlock, and results).
  try { await updateDoc(roomRef(), new FieldPath('guesses', me), g); }
  catch (e) { console.error(e); toast('Не удалось отправить ответ'); }
}

// Creator forces the current step to reveal (someone dropped out mid-step).
async function skipStep() {
  try { await updateDoc(roomRef(), { stepRevealed: true }); }
  catch (e) { console.error(e); toast('Не удалось пропустить'); }
}

async function nextFact() {
  const order = room.order || [];
  const next = (room.stepIndex || 0) + 1;
  try {
    if (next >= order.length) await updateDoc(roomRef(), { phase: 'results' });
    else await updateDoc(roomRef(), { stepIndex: next, stepRevealed: false });
  } catch (e) { console.error(e); }
}

// ---------- results ----------
function showResults() {
  const scores = {};
  room.players.forEach(p => scores[p.name] = 0);
  const factOwner = {};
  room.facts.forEach(f => factOwner[f.id] = f.owner);
  Object.entries(room.guesses || {}).forEach(([guesser, gmap]) => {
    Object.entries(gmap).forEach(([fid, answer]) => {
      if (factOwner[fid] && answer.toLowerCase() === factOwner[fid].toLowerCase()) {
        if (scores[guesser] !== undefined) scores[guesser]++;
      }
    });
  });
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const max = ranked.length ? ranked[0][1] : 0;
  const winners = ranked.filter(r => r[1] === max && max > 0).map(r => r[0]);
  $('winnerLine').textContent = winners.length === 0 ? 'Ничья — никто не угадал 😄'
    : winners.length === 1 ? `Побеждает ${winners[0]}!`
    : `Ничья: ${winners.join(' и ')}!`;

  const board = $('scoreboard'); board.innerHTML = '';
  ranked.forEach(([name, pts]) => {
    const row = document.createElement('div');
    row.className = 'score-row' + (pts === max && max > 0 ? ' lead' : '');
    row.innerHTML = `<span class="score-name">${escapeHtml(name)}</span><span class="score-pts">${pts}</span>`;
    board.appendChild(row);
  });

  const rev = $('reveal'); rev.innerHTML = '';
  const guesses = room.guesses || {};
  room.facts.forEach(f => {
    // who voted for whom on this fact (owner is excluded — she never guesses her own)
    const votes = room.players
      .map(p => ({ guesser: p.name, pick: guesses[p.name] ? guesses[p.name][f.id] : undefined }))
      .filter(v => v.pick !== undefined && v.guesser.toLowerCase() !== f.owner.toLowerCase());
    const correct = votes.filter(v => v.pick.toLowerCase() === f.owner.toLowerCase());

    let votesHtml;
    if (votes.length) {
      const chips = votes
        .slice().sort((a, b) => (b.pick.toLowerCase() === f.owner.toLowerCase()) - (a.pick.toLowerCase() === f.owner.toLowerCase()))
        .map(v => {
          const hit = v.pick.toLowerCase() === f.owner.toLowerCase();
          return `<span class="vote-chip ${hit ? 'ok' : 'no'}">${escapeHtml(v.guesser)} → ${escapeHtml(v.pick)}</span>`;
        }).join('');
      votesHtml = `<div class="vote-list">${chips}</div>`;
    } else {
      votesHtml = `<div class="vote-empty">никто не проголосовал</div>`;
    }

    const countHtml = votes.length ? `<span class="vote-count">угадали ${correct.length} из ${votes.length}</span>` : '';
    const div = document.createElement('div');
    div.className = 'fact-item';
    div.innerHTML = `<div class="fact-text revtext">«${escapeHtml(f.text)}»</div>`
      + `<div class="reveal-line hit">— ${escapeHtml(f.owner)}${countHtml}</div>`
      + votesHtml;
    rev.appendChild(div);
  });
  go('results');
}

// ---------- helpers ----------
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function escapeAttr(s) { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;'); }

// ---------- event delegation ----------
document.addEventListener('click', e => {
  const actionEl = e.target.closest('[data-action]');
  if (actionEl) {
    const a = actionEl.dataset.action;
    if (a === 'showCreate') { go('create'); setCount(3); }
    else if (a === 'showJoin') go('join');
    else if (a === 'home') go('home');
    else if (a === 'createRoom') createRoom();
    else if (a === 'joinRoom') joinRoom();
    else if (a === 'submitFacts') submitFacts();
    else if (a === 'beginGame') beginGame();
    else if (a === 'nextFact') nextFact();
    else if (a === 'skipStep') skipStep();
    else if (a === 'reload') { clearSession(); location.reload(); }
    return;
  }
  const countEl = e.target.closest('.countbtn');
  if (countEl) { setCount(+countEl.dataset.n); return; }
  const guessEl = e.target.closest('.guess-chip');
  if (guessEl && guessEl.dataset.fid && !guessEl.disabled) { pick(guessEl.dataset.fid, guessEl.dataset.name); return; }
});
