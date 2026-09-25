/* Plain JavaScript; game decisions and identity stay on the server. */
const root = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
const storage = {
  get(key, fallback = null) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
  remove(key) { try { localStorage.removeItem(key); } catch {} },
};
let session = storage.get('sardines-session');
if (!session || typeof session.code !== 'string' || typeof session.token !== 'string') session = null;
let room = null, busy = false, polling = false, online = true, signature = '', toastTimeout;
let clockOffset = 0, draft = '', stateEpoch = 0, playersOpen = false;
let homeName = storage.get('sardines-name', '');
let joinCode = new URLSearchParams(location.search).get('room')?.slice(0, 6).toUpperCase() || '';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const now = () => Date.now() / 1000 + clockOffset;
const elapsed = () => room?.started_at ? Math.max(0, (room.ended_at ?? now()) - room.started_at) : 0;
const timeLabel = seconds => {
  const s = Math.max(0, Math.floor(seconds));
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}` : `${String(Math.floor(s / 60)).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
};
const me = () => room?.players.find(p => p.id === room.me_id);
const isHost = () => room?.host_id === room?.me_id;
const requestID = () => [...crypto.getRandomValues(new Uint8Array(24))].map(n => n.toString(16).padStart(2, '0')).join('');

function toast(message) {
  const el = document.querySelector('#toast');
  el.textContent = message; el.hidden = false;
  clearTimeout(toastTimeout); toastTimeout = setTimeout(() => el.hidden = true, 5000);
}

async function api(path, data, credential = session?.token) {
  const response = await fetch(`/api${path}`, {
    method: data === undefined ? 'GET' : 'POST',
    headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${credential || ''}`},
    body: data === undefined ? undefined : JSON.stringify(data),
    cache: 'no-store', signal: AbortSignal.timeout(15000),
  });
  let result;
  try { result = await response.json(); } catch { throw new Error('Could not connect. Please try again.'); }
  if (!response.ok) { const error = new Error(result.error || 'Something went wrong. Try again.'); error.status = response.status; throw error; }
  return result;
}

function acceptRoom(value) {
  const previous = room;
  room = value; clockOffset = value.server_time - Date.now() / 1000; online = true;
  if (previous && (previous.round !== room.round || (previous.phase !== 'lobby' && room.phase === 'lobby'))) {
    draft = ''; storage.remove(`sardines-draft-${session.code}`);
  }
  if (!previous || previous.phase !== room.phase) playersOpen = room.phase === 'lobby';
  homeName = me().name; storage.set('sardines-name', homeName);
  if (previous?.phase === 'hiding' && room.phase === 'seeking') toast('Everyone is hidden. Start seeking!');
  if (previous && previous.phase !== 'ended' && room.phase === 'ended') toast(endMessage());
  renderRoom();
}

function home() {
  root.innerHTML = `<form id="entry-form" class="entry" aria-label="Create or join a room">
    <label for="player-name">Your name</label>
    <input id="player-name" name="name" placeholder="Name or nickname" maxlength="24" autocomplete="nickname" value="${esc(homeName)}" required>
    <button class="button" type="submit" data-entry="create">Create room</button>
    <div class="divider">or</div>
    <label for="room-code">Room code</label>
    <div class="join-row"><input id="room-code" name="code" placeholder="ABC234" maxlength="6" autocomplete="off" autocapitalize="characters" spellcheck="false" value="${esc(joinCode)}"><button class="button secondary" type="submit" data-entry="join">Join</button></div>
  </form>`;
  document.querySelector('#entry-form').addEventListener('submit', enter);
  document.querySelector('#room-code').addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); document.querySelector('#entry-form').requestSubmit(document.querySelector('[data-entry="join"]')); }
  });
}

async function enter(event) {
  event.preventDefault(); if (busy) return;
  const mode = event.submitter?.dataset.entry || 'create';
  homeName = document.querySelector('#player-name').value.trim();
  joinCode = document.querySelector('#room-code').value.trim().toUpperCase();
  if (!homeName) { toast('Enter your name.'); document.querySelector('#player-name').focus(); return; }
  if (mode === 'join' && !/^[A-Z2-9]{6}$/.test(joinCode)) { toast('Enter a 6-character room code.'); document.querySelector('#room-code').focus(); return; }
  busy = true; root.querySelectorAll('button').forEach(b => b.disabled = true);
  const credential = requestID();
  try {
    const value = await api(mode === 'create' ? '/rooms' : `/rooms/${joinCode}/join`, {name: homeName}, credential);
    session = {code: value.code, token: credential};
    storage.set('sardines-session', session);
    history.replaceState(null, '', `/?room=${value.code}`);
    busy = false; acceptRoom(value);
  } catch (error) { toast(error.message); }
  finally { busy = false; if (!room) root.querySelectorAll('button').forEach(b => b.disabled = false); }
}

function endMessage() {
  return {everyone_found: 'Everyone found a sardine!', host_ended: 'The host ended the round.', not_enough_players: 'Round ended: not enough sardines or seekers.'}[room.end_reason] || 'Round ended.';
}

function gamePanel() {
  const p = me(), sardine = p.role === 'sardine';
  if (room.phase === 'lobby') {
    const assigned = room.players.some(p => p.role === 'sardine');
    const ready = room.players.filter(p => p.role === 'sardine').length === room.sardine_count && room.players.length > room.sardine_count;
    return `<section class="game"><h1>Waiting for players</h1><p class="muted">${assigned ? `You’re a ${p.role}.` : 'Share the code to invite friends.'}</p>${isHost() ? `
      <div class="settings-row"><label id="sardines-label">Sardines</label><div class="stepper" role="group" aria-labelledby="sardines-label"><button data-action="count-down" aria-label="Fewer sardines" ${room.sardine_count <= 1 ? 'disabled' : ''}>−</button><output>${room.sardine_count}</output><button data-action="count-up" aria-label="More sardines" ${room.sardine_count >= room.players.length - 1 ? 'disabled' : ''}>+</button></div></div>
      <div class="button-row"><button class="button secondary" data-action="randomize" ${room.players.length < 2 ? 'disabled' : ''}>Shuffle roles</button><button class="button" data-action="start" ${ready ? '' : 'disabled'}>Start round</button></div>
      <p class="small muted">${room.players.length < 2 ? 'Invite at least one more player.' : ready ? 'Everyone’s ready to play.' : 'Shuffle roles before starting.'}</p>` : '<p class="small muted">The host will start the round.</p>'}</section>`;
  }
  if (room.phase === 'ended') return `<section class="game"><h1>Round complete</h1><p class="muted">${endMessage()}</p>${room.started_at ? `<div class="stopwatch" data-stopwatch>${timeLabel(elapsed())}</div><p class="small muted">Time spent seeking</p>` : ''}${isHost() ? '<button class="button" data-action="reset">Back to lobby</button>' : '<p class="small muted">Waiting for the host to start a new round.</p>'}</section>`;
  if (room.phase === 'hiding') {
    const hidden = room.players.filter(p => p.role === 'sardine' && p.hidden).length;
    return `<section class="game"><span class="role">${sardine ? 'Sardine' : 'Seeker'}</span><h1>${sardine ? p.hidden ? 'You’re hidden' : 'Go hide' : 'Wait here'}</h1><p class="muted">${hidden} of ${room.sardine_count} sardines hidden.</p>${sardine ? `<button class="button" data-action="hidden" ${p.hidden ? 'disabled' : ''}>${p.hidden ? 'Waiting for the others…' : 'I’m hidden!'}</button>` : '<p class="small muted">The search starts when everyone is hidden.</p>'}</section>`;
  }
  const seekers = room.players.filter(p => p.role === 'seeker'), found = seekers.filter(p => p.found).length;
  return `<section class="game"><span class="role">${sardine ? 'Sardine' : 'Seeker'}</span><h1>${sardine ? 'Stay hidden' : p.found ? 'You found them' : 'Start seeking'}</h1><div class="stopwatch" data-stopwatch>${timeLabel(elapsed())}</div><p class="muted">${found} of ${seekers.length} seekers found a sardine.</p>${sardine ? '' : `<button class="button ${p.found ? 'secondary' : ''}" data-action="found">${p.found ? 'Undo · I’m still seeking' : 'I found them!'}</button>`}</section>`;
}

function playersPanel() {
  const players = room.players.map(p => {
    let status = p.role === 'sardine' ? 'Sardine' : 'Seeker';
    if (room.phase === 'hiding' && p.role === 'sardine') status = p.hidden ? 'Hidden' : 'Hiding…';
    if (['seeking', 'ended'].includes(room.phase) && p.role === 'seeker') status = p.found ? 'Found them' : 'Seeking';
    return `<li class="player"><div class="player-info"><span class="player-name">${esc(p.name)}${p.id === room.me_id ? ' <small>(you)</small>' : ''}${p.id === room.host_id ? ' <small>· host</small>' : ''}</span><span class="player-status">${status}</span></div>${isHost() && p.id !== room.me_id ? `<button class="text-button danger-text" data-action="kick-confirm" data-player="${p.id}" aria-label="Kick ${esc(p.name)}">Kick</button>` : ''}</li>`;
  }).join('');
  return `<details class="players" id="players" ${playersOpen ? 'open' : ''}><summary>Players <span class="muted">${room.players.length}</span></summary><ul>${players}</ul></details>`;
}

function hintsPanel() {
  if (room.phase === 'lobby') return '';
  const scheduled = room.scheduled_hint, canWrite = me().role === 'sardine' && room.phase !== 'ended';
  const hints = [...room.hints].reverse().map(h => `<article class="hint"><p>${esc(h.text)}</p><footer>${esc(h.author)} · ${timeLabel(h.sent_at - room.started_at)}</footer></article>`).join('');
  return `<section class="hints"><div class="section-heading"><h2>Hints</h2>${room.phase === 'seeking' ? '<span class="small muted">Next mark in <b data-countdown></b></span>' : ''}</div>
    ${canWrite ? `<form id="hint-form"><label class="sr-only" for="hint-text">Hint for all players</label><textarea id="hint-text" maxlength="280" rows="2" placeholder="Write a hint…">${esc(draft)}</textarea><div class="button-row"><button type="submit" class="button secondary" data-hint="hint" ${room.phase !== 'seeking' ? 'disabled' : ''}>Send now</button><button type="submit" class="button" data-hint="schedule" ${room.phase !== 'seeking' ? 'disabled' : ''}>${scheduled ? 'Replace' : 'Queue'} for <span data-nextmark></span></button></div>${room.phase === 'hiding' ? '<p class="small muted">Draft now. Send when seeking starts.</p>' : ''}</form>${scheduled ? `<div class="scheduled"><div class="section-heading"><strong>Queued for ${timeLabel(scheduled.due_at - room.started_at)}</strong><button class="text-button" data-action="cancel_hint">Cancel</button></div><p>${esc(scheduled.text)}</p></div>` : ''}` : ''}
    <div class="hint-list" aria-label="Hints for everyone">${hints || '<p class="small muted">No hints yet.</p>'}</div></section>`;
}

function renderRoom(force = false) {
  const key = JSON.stringify({...room, server_time: 0, online, busy});
  if (!force && signature === key) { updateTimers(); return; }
  signature = key;
  const focused = document.activeElement, focusID = focused?.id;
  const selection = focusID === 'hint-text' ? [focused.selectionStart, focused.selectionEnd] : null;
  root.innerHTML = `<div class="room-bar"><button class="room-code" data-action="copy" aria-label="Copy room code ${room.code}"><small>ROOM</small> ${room.code} <small>Copy</small></button><button class="text-button" data-action="rename">Edit name</button></div>
    ${online ? '' : '<p class="connection" role="status">Reconnecting…</p>'}
    ${gamePanel()}${hintsPanel()}${playersPanel()}
    <div class="room-footer">${['lobby','ended'].includes(room.phase) ? '<button class="text-button" data-action="leave-confirm">Leave room</button>' : isHost() ? '<button class="text-button danger-text" data-action="end-confirm">End round</button>' : ''}</div>`;
  root.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', onAction));
  root.querySelector('#players')?.addEventListener('toggle', event => { playersOpen = event.target.open; });
  root.querySelector('#hint-text')?.addEventListener('input', event => {
    draft = event.target.value; storage.set(`sardines-draft-${session.code}`, draft);
  });
  root.querySelector('#hint-form')?.addEventListener('submit', event => {
    event.preventDefault(); if (!draft.trim()) return toast('Write a hint first.');
    action(event.submitter?.dataset.hint || 'hint', {text: draft});
  });
  if (busy) root.querySelectorAll('button').forEach(button => button.disabled = true);
  if (focusID) { const next = document.getElementById(focusID); next?.focus({preventScroll:true}); if (selection && next) next.setSelectionRange(...selection); }
  updateTimers();
}

function updateTimers() {
  if (!room) return;
  root.querySelectorAll('[data-stopwatch]').forEach(el => el.textContent = timeLabel(elapsed()));
  const interval = room.hint_interval, nextMark = (Math.floor(elapsed() / interval) + 1) * interval;
  root.querySelectorAll('[data-countdown]').forEach(el => el.textContent = timeLabel(Math.ceil(nextMark - elapsed())));
  root.querySelectorAll('[data-nextmark]').forEach(el => el.textContent = timeLabel(nextMark));
}

async function action(name, extra = {}) {
  if (busy || !room) return false;
  stateEpoch++; busy = true; renderRoom(true);
  try {
    const result = await api(`/rooms/${session.code}/actions/${name}`, {...extra, round:room.round, request_id:requestID()});
    if (name === 'leave') { forget(); return true; }
    if (name === 'hint' || name === 'schedule') { draft = ''; storage.remove(`sardines-draft-${session.code}`); toast(name === 'hint' ? 'Hint sent.' : 'Hint queued.'); }
    if (name === 'rename') toast('Name updated.');
    if (name === 'kick') toast('Player removed.');
    busy = false; acceptRoom(result); return true;
  } catch (error) {
    if (error.status === 401) forget();
    toast(error.message); return false;
  } finally { busy = false; if (room) renderRoom(true); }
}

function confirmAction(title, content, buttonText, callback) {
  document.querySelector('#dialog-content').innerHTML = `<h2 id="dialog-title">${esc(title)}</h2><p class="muted">${esc(content)}</p><button class="button danger" id="dialog-confirm">${esc(buttonText)}</button>`;
  document.querySelector('#dialog-close').textContent = 'Cancel';
  document.querySelector('#dialog-confirm').addEventListener('click', () => { dialog.close(); callback(); });
  dialog.showModal(); document.querySelector('#dialog-close').focus();
}

function editName() {
  document.querySelector('#dialog-content').innerHTML = `<h2 id="dialog-title">Edit name</h2><form id="rename-form"><label for="new-name">Your name</label><input id="new-name" maxlength="24" autocomplete="nickname" value="${esc(me().name)}" required><button class="button" type="submit">Save</button></form>`;
  document.querySelector('#dialog-close').textContent = 'Cancel';
  document.querySelector('#rename-form').addEventListener('submit', async event => {
    event.preventDefault();
    const input = document.querySelector('#new-name'), button = event.currentTarget.querySelector('button');
    const name = input.value.trim();
    if (!name) { input.setCustomValidity('Enter your name.'); input.reportValidity(); return; }
    button.disabled = true;
    if (await action('rename', {name})) dialog.close();
    button.disabled = false;
  });
  document.querySelector('#new-name').addEventListener('input', event => event.target.setCustomValidity(''));
  dialog.showModal(); document.querySelector('#new-name').select();
}

function onAction(event) {
  const name = event.currentTarget.dataset.action;
  if (name === 'copy') {
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(room.code).then(() => toast('Room code copied.')).catch(() => toast(`Room code: ${room.code}`));
    else toast(`Room code: ${room.code}`);
  } else if (name === 'rename') editName();
  else if (name === 'kick-confirm') {
    const target = room.players.find(p => p.id === event.currentTarget.dataset.player);
    if (target) confirmAction(`Kick ${target.name}?`, 'They’ll be removed from the room. The round will adjust to the remaining players.', 'Kick player', () => action('kick', {player_id: target.id}));
  } else if (name === 'end-confirm') confirmAction('End round?', 'This ends the round for everyone and cancels queued hints.', 'End round', () => action('end'));
  else if (name === 'leave-confirm') confirmAction('Leave room?', isHost() ? 'The next player will become host.' : 'You can rejoin between rounds.', 'Leave room', () => action('leave'));
  else if (name.startsWith('count-')) action('configure', {count: room.sardine_count + (name === 'count-up' ? 1 : -1)});
  else if (name === 'found') action('found', {found: !me().found});
  else action(name);
}

function forget() {
  stateEpoch++;
  if (session) storage.remove(`sardines-draft-${session.code}`);
  storage.remove('sardines-session'); session = null; room = null; draft = ''; signature = ''; busy = false;
  if (dialog.open) dialog.close();
  joinCode = ''; history.replaceState(null, '', '/'); home();
}

async function poll() {
  if (!session || busy || polling) return;
  polling = true;
  const credential = session.token, epoch = stateEpoch;
  try {
    const result = await api(`/rooms/${session.code}`);
    if (session?.token === credential && !busy && epoch === stateEpoch) acceptRoom(result);
  } catch (error) {
    if (session?.token !== credential || epoch !== stateEpoch) return;
    if ([401,404].includes(error.status)) { forget(); toast(error.message); return; }
    online = false;
    if (room) renderRoom(true);
    else {
      root.innerHTML = `<section class="entry"><p class="muted">${esc(error.message)}</p><button class="button" id="retry">Try again</button><button class="text-button" id="go-home">Back</button></section>`;
      document.querySelector('#retry').onclick = poll; document.querySelector('#go-home').onclick = forget;
    }
  } finally { polling = false; }
}

document.querySelector('#how-button').addEventListener('click', () => {
  document.querySelector('#dialog-content').innerHTML = '<h2 id="dialog-title">How to play</h2><ol><li>The host picks how many sardines hide, shuffles roles, and starts.</li><li>Sardines hide and tap “I’m hidden!” Everyone else waits.</li><li>Once all sardines are hidden, seekers go find them and hide alongside them.</li><li>Seekers tap “I found them!” You can undo while the round is running.</li><li>Sardines can send hints or queue them for each 5-minute mark. The round ends when everyone is found.</li></ol>';
  document.querySelector('#dialog-close').textContent = 'Close'; dialog.showModal();
});
document.querySelector('#dialog-close').addEventListener('click', () => dialog.close());
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
window.addEventListener('online', poll);
setInterval(updateTimers, 250);
setInterval(() => { if (!document.hidden) poll(); }, 2500);
if (session) {
  draft = storage.get(`sardines-draft-${session.code}`, '');
  root.innerHTML = '<p class="loading muted">Rejoining room…</p>'; poll();
} else home();
