import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore, doc, setDoc, getDoc, updateDoc, onSnapshot, arrayUnion, serverTimestamp }
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
let myGuesses = {};
let started = false;
let orderedFacts = [];

const $ = id => document.getElementById(id);

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
go(configOK ? 'home' : 'setupWarn');

// ---------- room code ----------
const WORDS = ['КОШКА','ЛУНА','МОРЕ','ВИШНЯ','ЛИСА','ЗВЕЗДА','МЯТА','ГРОЗА','ПЕРО','ВОЛНА','ИСКРА','РОЗА','ТУЧА','ЁЖИК','КЛЁН'];
function genCode() { return WORDS[Math.floor(Math.random()*WORDS.length)] + Math.floor(10 + Math.random()*89); }

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
async function createRoom() {
  const name = $('cName').value.trim();
  if (!name) { toast('Впиши имя'); return; }
  me = name; roomCode = genCode();
  try {
    await setDoc(doc(db, 'rooms', roomCode), {
      code: roomCode, factCount, phase: 'lobby',
      players: [{ name: me, ready: false }],
      facts: [], guesses: {}, done: [], createdAt: serverTimestamp()
    });
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
    if (data.phase !== 'lobby') { toast('Игра уже началась'); return; }
    me = name; roomCode = code; factCount = data.factCount;
    if (!data.players.some(p => p.name.toLowerCase() === me.toLowerCase())) {
      await updateDoc(doc(db, 'rooms', code), { players: arrayUnion({ name: me, ready: false }) });
    }
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
  try {
    const snap = await getDoc(doc(db, 'rooms', roomCode));
    const data = snap.data();
    const newFacts = facts.map((t, i) => ({ id: me + '__' + i, text: t, owner: me }));
    const players = data.players.map(p => p.name.toLowerCase() === me.toLowerCase() ? { ...p, ready: true } : p);
    const others = (data.facts || []).filter(f => f.owner.toLowerCase() !== me.toLowerCase());
    await updateDoc(doc(db, 'rooms', roomCode), { facts: [...others, ...newFacts], players });
    go('lobby');
  } catch (e) { console.error(e); toast('Не удалось сохранить'); }
}

// ---------- live listener ----------
function listenRoom() {
  if (unsub) unsub();
  unsub = onSnapshot(doc(db, 'rooms', roomCode), snap => {
    if (!snap.exists()) return;
    room = snap.data();
    render();
  });
}

function render() {
  if (!room) return;
  if (room.phase === 'playing' && !started) { started = true; buildPlayScreen(); }
  if (room.phase === 'results') { showResults(); return; }
  if (!$('lobby').classList.contains('hidden')) renderLobby();
  if (!$('playScreen').classList.contains('hidden')) { renderWaiting(); checkAllDone(); }
}

// ---------- lobby ----------
function renderLobby() {
  const list = $('lobbyList'); list.innerHTML = '';
  room.players.forEach(p => {
    const chip = document.createElement('div');
    chip.className = 'lobby-chip' + (p.ready ? '' : ' waiting');
    chip.innerHTML = `<span class="dot"></span>${escapeHtml(p.name)}${p.ready ? '' : ' <span style="font-weight:400;color:#9a8a7d">пишет…</span>'}`;
    list.appendChild(chip);
  });
  const allReady = room.players.length >= 2 && room.players.every(p => p.ready);
  const readyCount = room.players.filter(p => p.ready).length;
  $('lobbyStatus').innerHTML = allReady
    ? `<p class="center" style="color:var(--sage);font-weight:700">Все готовы! 🎉</p>`
    : `<p class="field-note center">Готовы: ${readyCount} из ${room.players.length}${room.players.length < 2 ? ' · нужно минимум 2 участницы' : ''}</p>`;
  $('startArea').classList.toggle('hidden', !allReady);
}

async function beginGame() {
  try { await updateDoc(doc(db, 'rooms', roomCode), { phase: 'playing' }); }
  catch (e) { console.error(e); toast('Ошибка старта'); }
}

// ---------- play ----------
function buildPlayScreen() {
  orderedFacts = [...room.facts].sort((a, b) => hashStr(a.id + roomCode) - hashStr(b.id + roomCode));
  const list = $('factList'); list.innerHTML = '';
  orderedFacts.forEach(f => {
    if (f.owner.toLowerCase() === me.toLowerCase()) return;
    const div = document.createElement('div');
    div.className = 'fact-item'; div.dataset.fid = f.id;
    let chips = '';
    room.players.forEach(p => {
      if (p.name.toLowerCase() === me.toLowerCase()) return;
      chips += `<button class="guess-chip" data-fid="${escapeAttr(f.id)}" data-name="${escapeAttr(p.name)}">${escapeHtml(p.name)}</button>`;
    });
    div.innerHTML = `<div class="fact-num">Факт</div><div class="fact-text">«${escapeHtml(f.text)}»</div><div class="guess-grid">${chips}</div>`;
    list.appendChild(div);
  });
  updatePlayProgress();
  go('playScreen');
}

async function pick(fid, name, btn) {
  myGuesses[fid] = name;
  [...btn.parentElement.children].forEach(c => c.classList.remove('picked'));
  btn.classList.add('picked');
  updatePlayProgress();
  try { await updateDoc(doc(db, 'rooms', roomCode), { [`guesses.${me}`]: myGuesses }); }
  catch (e) { console.error(e); }
  checkMyCompletion();
}

function myFactsToGuess() {
  return orderedFacts.filter(f => f.owner.toLowerCase() !== me.toLowerCase());
}
function updatePlayProgress() {
  $('playProgress').textContent = `Отвечено ${Object.keys(myGuesses).length} из ${myFactsToGuess().length}`;
}

async function checkMyCompletion() {
  if (Object.keys(myGuesses).length >= myFactsToGuess().length) {
    try { await updateDoc(doc(db, 'rooms', roomCode), { done: arrayUnion(me) }); } catch (e) {}
    $('factList').classList.add('hidden');
    $('playProgress').classList.add('hidden');
    $('doneArea').classList.remove('hidden');
    renderWaiting();
  }
}

function renderWaiting() {
  if ($('doneArea').classList.contains('hidden')) return;
  const done = room.done || [];
  const waiting = room.players.map(p => p.name).filter(n => !done.includes(n));
  $('waitingOn').innerHTML = waiting.length
    ? `<p class="field-note center">Ещё отвечают: ${waiting.map(escapeHtml).join(', ')}</p>`
    : `<p class="center" style="color:var(--sage);font-weight:700">Все закончили!</p>`;
}

async function checkAllDone() {
  const done = room.done || [];
  if (done.length >= room.players.length && room.players.length >= 2 && room.phase === 'playing') {
    try { await updateDoc(doc(db, 'rooms', roomCode), { phase: 'results' }); } catch (e) {}
  }
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
  room.facts.forEach(f => {
    const div = document.createElement('div');
    div.className = 'fact-item';
    div.innerHTML = `<div class="fact-text" style="margin-bottom:8px">«${escapeHtml(f.text)}»</div><div class="reveal-line hit">— ${escapeHtml(f.owner)}</div>`;
    rev.appendChild(div);
  });
  go('results');
}

// ---------- helpers ----------
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; } return h; }
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
    else if (a === 'reload') location.reload();
    return;
  }
  const countEl = e.target.closest('.countbtn');
  if (countEl) { setCount(+countEl.dataset.n); return; }
  const guessEl = e.target.closest('.guess-chip');
  if (guessEl && guessEl.dataset.fid) { pick(guessEl.dataset.fid, guessEl.dataset.name, guessEl); return; }
});
