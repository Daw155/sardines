/* No frontend framework or build step. The server owns every game decision. */
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
let clockOffset = 0, errorMessage = '', draft = '', stateEpoch = 0, homeName = storage.get('sardines-name', '');
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
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${credential || ''}` },
    body: data === undefined ? undefined : JSON.stringify(data),
    cache: 'no-store', signal: AbortSignal.timeout(15000),
  });
  let result;
  try { result = await response.json(); } catch { throw new Error('Could not connect to the room. Please try again.'); }
  if (!response.ok) { const error = new Error(result.error || 'Something went wrong. Try again.'); error.status = response.status; throw error; }
  return result;
}

function acceptRoom(value) {
  const previous = room;
  room = value; clockOffset = value.server_time - Date.now() / 1000; online = true; errorMessage = '';
  if (previous && (previous.round !== room.round || (previous.phase !== 'lobby' && room.phase === 'lobby'))) {
    draft = ''; storage.remove(`sardines-draft-${session.code}`);
  }
  if (previous?.phase === 'hiding' && room.phase === 'seeking') toast('Everyone is hidden. The search is on!');
  if (previous?.phase === 'seeking' && room.phase === 'ended') toast(room.end_reason === 'everyone_found' ? 'Everyone found their people. Round complete!' : 'The host ended the round.');
  renderRoom();
}

function home() {
  root.innerHTML = `<div class="home-layout"><section class="hero">
    <p class="eyebrow">The hide & seek with a twist</p>
    <h1>Find your<br>people.<br><em>Squeeze in.</em></h1>
    <p class="hero-copy">One hides. Everyone seeks. Find a sardine?<br>Hide with them. The more, the merrier.</p>
    <div class="tin-scene" aria-hidden="true"><span class="scribble">better together ↘</span><div class="tin"><i class="fish"></i><i class="fish"></i><i class="fish"></i></div><span class="scene-spark">✳</span><span class="scene-spark small">✦</span></div>
  </section><section class="entry-card" aria-labelledby="entry-title">
    <span class="card-tag">GOOD FRIENDS. GREAT HIDING SPOTS.</span><h2 id="entry-title">Let’s get everyone in.</h2><p class="muted">No sign-ups. Just your name and your people.</p>
    <form id="entry-form"><label class="field-label" for="player-name">What should we call you?</label>
    <input id="player-name" name="name" placeholder="Your name or nickname" maxlength="24" autocomplete="nickname" value="${esc(homeName)}" required>
    <p class="input-help">Pick a name your friends will recognize.</p>
    <button class="button create" type="submit" data-entry="create">Create a room <span class="arrow" aria-hidden="true">↗</span></button>
    <div class="divider">OR JOIN YOUR FRIENDS</div><label class="field-label" for="room-code">Have a room code?</label>
    <div class="join-row"><input id="room-code" name="code" placeholder="ABC123" maxlength="6" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="6-character room code" value="${esc(joinCode)}"><button class="button secondary" type="submit" data-entry="join">Join <span aria-hidden="true">→</span></button></div>
    <p class="card-footnote">A few friends. One room. A little adventure.</p></form>
  </section></div><section class="steps" aria-label="How it works">
    <div class="step"><span class="step-number">01</span><div><h3>Gather the crew</h3><p>Create a room and share the code.<br>Everyone’s invited.</p></div></div>
    <div class="step"><span class="step-number">02</span><div><h3>Hide. Seek. Squeeze.</h3><p>Sardines hide. Seekers find them<br>and quietly join the hiding spot.</p></div></div>
    <div class="step"><span class="step-number">03</span><div><h3>Leave a little clue</h3><p>A fresh hint every five minutes<br>helps bring everyone together.</p></div></div>
  </section>`;
  document.querySelector('#entry-form').addEventListener('submit', enter);
}

async function enter(event) {
  event.preventDefault(); if (busy) return;
  const mode = event.submitter?.dataset.entry || 'create';
  homeName = document.querySelector('#player-name').value.trim();
  joinCode = document.querySelector('#room-code').value.trim().toUpperCase();
  if (!homeName) return document.querySelector('#player-name').reportValidity();
  if (mode === 'join' && !/^[A-Z2-9]{6}$/.test(joinCode)) { toast('Enter the 6-character code your host shared.'); document.querySelector('#room-code').focus(); return; }
  busy = true; root.querySelectorAll('button').forEach(b => b.disabled = true);
  const credential = requestID();
  try {
    const value = await api(mode === 'create' ? '/rooms' : `/rooms/${joinCode}/join`, {name: homeName}, credential);
    session = {code: value.code, token: credential};
    storage.set('sardines-session', session); storage.set('sardines-name', homeName);
    history.replaceState(null, '', `/?room=${value.code}`);
    busy = false; acceptRoom(value);
  } catch (error) { toast(error.message); }
  finally { busy = false; if (!room) root.querySelectorAll('button').forEach(b => b.disabled = false); }
}

function playersPanel() {
  const players = room.players.map(p => {
    let status = p.role === 'sardine' ? 'Sardine' : 'Seeker', done = false;
    if (room.phase === 'hiding' && p.role === 'sardine') { status = p.hidden ? '✓ Hidden' : 'Finding a spot'; done = p.hidden; }
    if (['seeking','ended'].includes(room.phase)) { status = p.role === 'sardine' ? 'Hiding' : p.found ? '✓ Found them' : 'Seeking'; done = p.found || p.role === 'sardine'; }
    return `<li class="player-row"><span class="avatar ${p.role}">${esc(Array.from(p.name)[0].toUpperCase())}</span><div><div class="player-name">${esc(p.name)}${p.id === room.me_id ? ' <span class="muted">(you)</span>' : ''}</div><div class="player-meta">${p.id === room.host_id ? 'Room host' : 'Part of the crew'}</div></div><span class="player-status ${done ? 'done' : ''}">${status}</span></li>`;
  }).join('');
  return `<section class="panel players-panel"><div class="section-heading"><h2>The crew</h2><span class="count-badge">${room.players.length} ${room.players.length === 1 ? 'player' : 'players'}</span></div><ul class="player-list">${players}</ul>${room.phase === 'lobby' ? '<p class="notice">Share the room code with your friends. New arrivals start as seekers.</p>' : ''}</section>`;
}

function hostPanel() {
  if (!isHost()) return room.phase === 'lobby' ? '<section class="panel"><div class="section-heading"><h2>Make yourself at home.</h2></div><p class="muted">Your host will shuffle the roles and start the round when everyone’s here.</p></section>' : '';
  if (room.phase === 'lobby') {
    const ready = room.players.filter(p => p.role === 'sardine').length === room.sardine_count;
    return `<section class="panel host-panel"><div class="section-heading"><h2>Set up the round</h2><span class="count-badge">HOST</span></div><div class="settings-row"><div><strong>Number of sardines</strong><p class="muted">Leave at least one person to seek.</p></div><div class="stepper"><button data-action="count-down" aria-label="Fewer sardines" ${room.sardine_count <= 1 ? 'disabled' : ''}>−</button><output>${room.sardine_count}</output><button data-action="count-up" aria-label="More sardines" ${room.sardine_count >= room.players.length - 1 ? 'disabled' : ''}>+</button></div></div><div class="host-actions"><button class="button secondary" data-action="randomize" ${room.players.length < 2 ? 'disabled' : ''}>↻ &nbsp; Shuffle roles</button><button class="button" data-action="start" ${!ready || room.players.length < 2 ? 'disabled' : ''}>Start the round <span aria-hidden="true">→</span></button></div><p class="notice">${room.players.length < 2 ? 'It takes two to sardine. Invite a friend to get started.' : ready ? 'Roles are set. Everyone, including you, is in the game.' : 'Shuffle the roles to randomly pick your sardines.'}</p></section>`;
  }
  if (room.phase === 'ended') return '<section class="panel host-panel"><div class="section-heading"><h2>Same crew, new hiding spots?</h2></div><button class="button" data-action="reset">Back to the lobby <span aria-hidden="true">→</span></button></section>';
  return '<section class="panel host-panel"><div class="section-heading"><h2>Host controls</h2><span class="count-badge">HOST</span></div><button class="button secondary" data-action="end-confirm">End this round</button></section>';
}

function rolePanel() {
  const p = me();
  if (room.phase === 'ended') return `<section class="panel round-summary"><span class="celebration" aria-hidden="true">✳</span><h2>${room.end_reason === 'everyone_found' ? 'All packed in.' : 'That’s a wrap.'}</h2><p>${room.end_reason === 'everyone_found' ? 'Everyone found a sardine. A little closer together.' : 'Your host ended the round. Good hiding, everyone.'}</p><div class="stopwatch" data-stopwatch>${timeLabel(elapsed())}</div><p>${room.started_at ? 'Time spent seeking' : 'The search hadn’t started yet'}</p></section>`;
  if (room.phase === 'lobby') return `<section class="panel role-card ${p.role === 'seeker' ? 'waiting' : ''}"><p class="eyebrow">Your role</p><h2>${p.role === 'sardine' ? 'You’re a sardine.' : 'You’re a seeker.'}</h2><p>${p.role === 'sardine' ? 'Find a good hiding spot when the round starts. Your friends will come to you.' : 'When the search begins, find a sardine and quietly squeeze in beside them.'}</p></section>`;
  const hidden = room.players.filter(p => p.role === 'sardine' && p.hidden).length;
  if (room.phase === 'hiding') return `<section class="panel role-card"><p class="eyebrow">${p.role === 'sardine' ? 'Time to disappear' : 'Give them a head start'}</p><h2>${p.role === 'sardine' ? p.hidden ? 'Nicely tucked away.' : 'Find your hiding spot.' : 'No peeking.'}</h2><p>${p.role === 'sardine' ? 'Settle in somewhere good. The search starts when every sardine is hidden.' : 'The sardines are finding their spots. Stay here until everyone is ready.'}</p>${p.role === 'sardine' ? `<button class="button" data-action="hidden" ${p.hidden ? 'disabled' : ''}>${p.hidden ? '✓ You’re hidden' : 'I’m hidden!'}</button>` : ''}<p class="timer-sub">${hidden} of ${room.sardine_count} sardines hidden</p></section>`;
  return `<section class="panel role-card"><p class="eyebrow">${p.role === 'sardine' ? 'Stay tucked in' : p.found ? 'Welcome to the tin' : 'The search is on'}</p><h2>${p.role === 'sardine' ? 'Keep a little mystery.' : p.found ? 'Room for one more.' : 'Find your people.'}</h2><p>${p.role === 'sardine' ? 'Stay quiet, get cozy, and leave a little clue every five minutes.' : p.found ? 'Stay hidden with your sardine. The round ends when everyone has found a spot.' : 'Find a sardine, then quietly hide with them. Tap below once you’ve squeezed in.'}</p>${p.role === 'seeker' ? `<button class="button" data-action="found" data-found="${!p.found}">${p.found ? '✓ Hiding with a sardine' : 'I found them!'}</button>${p.found ? '<button class="quiet-button" data-action="undo-found">Tapped too soon? I’m still seeking</button>' : '<p class="timer-sub">You can undo this while the round is running.</p>'}` : ''}</section>`;
}

function timerPanel() {
  if (room.phase !== 'seeking') return '';
  const seekers = room.players.filter(p => p.role === 'seeker'), found = seekers.filter(p => p.found).length;
  return `<section class="panel timer-panel"><p class="timer-label">Time on the hunt</p><div class="stopwatch" data-stopwatch>${timeLabel(elapsed())}</div><p class="timer-sub">${found} of ${seekers.length} seekers found their people</p><div class="progress-track"><progress value="${found}" max="${seekers.length}" aria-label="Seekers who found a sardine"></progress></div></section>`;
}

function hintsPanel() {
  if (room.phase === 'lobby') return '';
  const p = me(), scheduled = room.scheduled_hint;
  const hints = [...room.hints].reverse().map(h => `<article class="hint-item"><p>${esc(h.text)}</p><footer><span>${esc(h.author)}${h.scheduled ? ' · Scheduled' : ''}</span><span>${timeLabel(h.sent_at - room.started_at)} into the search</span></footer></article>`).join('');
  return `<section class="panel hints-panel"><div class="section-heading"><h2>A little birdie said…</h2>${room.phase === 'seeking' ? '<span class="hint-countdown">Next hint mark <b data-countdown></b></span>' : '<span class="count-badge">HINTS</span>'}</div><div class="hint-list" aria-label="Hints for everyone">${hints || '<div class="hint-empty"><span class="hint-symbol" aria-hidden="true">“ ”</span><p>No clues just yet.<br>A little mystery is part of the fun.</p></div>'}</div>${p.role === 'sardine' && room.phase !== 'ended' ? `<form class="hint-composer" id="hint-form"><label for="hint-text" class="field-label">Give everyone a little nudge</label><textarea id="hint-text" maxlength="280" placeholder="Something you can see, hear, or feel…">${esc(draft)}</textarea><div class="composer-footer"><span>${room.phase === 'hiding' ? 'Write a draft while you wait.' : 'Your hint goes to the whole room.'}</span><span><b id="char-count">${draft.length}</b>/280</span></div><div class="hint-buttons"><button type="submit" class="button secondary" data-hint="hint" ${room.phase !== 'seeking' ? 'disabled' : ''}>Send now ↗</button><button type="submit" class="button" data-hint="schedule" ${room.phase !== 'seeking' ? 'disabled' : ''}>${scheduled ? 'Replace' : 'Schedule'} for <span data-nextmark></span></button></div></form>${scheduled ? `<div class="scheduled"><strong>✓ Queued for ${timeLabel(scheduled.due_at - room.started_at)}</strong><p>${esc(scheduled.text)}</p><button data-action="cancel_hint">Cancel scheduled hint</button></div>` : ''}` : ''}<p class="notice">${room.phase === 'ended' ? 'The clues from this round. A new round starts with a clean slate.' : 'Hint marks are every 5 minutes. Sardines can schedule a clue for the next mark or send one anytime.'}</p></section>`;
}

function renderRoom(force = false) {
  const key = JSON.stringify({...room, server_time: 0, online, errorMessage, busy});
  if (!force && signature === key) { updateTimers(); return; }
  signature = key;
  const focused = document.activeElement, focusID = focused?.id;
  const selection = focusID === 'hint-text' ? [focused.selectionStart, focused.selectionEnd] : null;
  const phaseTitle = {lobby:'The gathering spot.',hiding:'Ready, set, hide.',seeking:'Out of sight.<br>All together.',ended:'One for the books.'}[room.phase];
  root.innerHTML = `<div class="room-top">${['lobby','ended'].includes(room.phase) ? '<button class="back-button" data-action="leave-confirm">← Leave room</button>' : `<span class="muted">Round ${room.round}</span>`}<span class="connection ${online ? '' : 'offline'}" role="status">${online ? 'You’re connected' : 'Reconnecting…'}</span></div>${errorMessage ? `<div class="error-banner">${esc(errorMessage)}<button data-action="forget">Back to home</button></div>` : ''}<div class="room-layout"><div class="stack"><section class="panel"><div class="room-heading"><div><span class="phase-pill">${room.phase === 'lobby' ? 'Waiting room' : room.phase === 'hiding' ? 'Sardines are hiding' : room.phase === 'seeking' ? 'Round in progress' : 'Round complete'}</span><h1>${phaseTitle}</h1><p class="muted">${room.phase === 'lobby' ? 'Good times start with good company.' : room.phase === 'ended' ? 'Take a breath. Swap a story.' : 'A little adventure with your favorite people.'}</p></div><button class="room-code" data-action="copy" aria-label="Copy room code ${room.code}"><small>ROOM CODE</small><strong>${room.code}</strong><span>Tap to copy ↗</span></button></div></section>${timerPanel()}${rolePanel()}${hostPanel()}</div><div class="stack">${playersPanel()}${hintsPanel()}</div></div>`;
  root.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', onAction));
  root.querySelector('#hint-text')?.addEventListener('input', event => {
    draft = event.target.value; storage.set(`sardines-draft-${session.code}`, draft);
    document.querySelector('#char-count').textContent = draft.length;
  });
  root.querySelector('#hint-form')?.addEventListener('submit', event => {
    event.preventDefault(); if (!draft.trim()) return toast('Write a little clue first.');
    action(event.submitter?.dataset.hint || 'hint', {text: draft});
  });
  if (busy) root.querySelectorAll('button').forEach(button => button.disabled = true);
  if (focusID) { const next = document.getElementById(focusID); next?.focus({preventScroll:true}); if (selection && next) next.setSelectionRange(...selection); }
  updateTimers();
}

function updateTimers() {
  if (!room) return;
  root.querySelectorAll('[data-stopwatch]').forEach(el => el.textContent = timeLabel(elapsed()));
  const nextMark = (Math.floor(elapsed() / 300) + 1) * 300;
  root.querySelectorAll('[data-countdown]').forEach(el => el.textContent = timeLabel(Math.ceil(nextMark - elapsed())));
  root.querySelectorAll('[data-nextmark]').forEach(el => el.textContent = timeLabel(nextMark));
}

async function action(name, extra = {}) {
  if (busy || !room) return;
  stateEpoch++;
  busy = true; renderRoom(true);
  try {
    const result = await api(`/rooms/${session.code}/actions/${name}`, {...extra, round:room.round, request_id:requestID()});
    if (name === 'leave') { forget(); return; }
    if (name === 'hint' || name === 'schedule') { draft = ''; storage.remove(`sardines-draft-${session.code}`); toast(name === 'hint' ? 'Hint sent to everyone.' : 'Hint scheduled. We’ll take it from here.'); }
    busy = false; acceptRoom(result);
  } catch (error) { toast(error.message); }
  finally { busy = false; if (room) renderRoom(true); }
}

function confirmAction(title, content, buttonText, callback) {
  document.querySelector('#dialog-content').innerHTML = `<h2 id="dialog-title">${title}</h2><p>${content}</p><button class="button danger" id="dialog-confirm">${buttonText}</button>`;
  document.querySelector('#dialog-close').textContent = 'Keep playing';
  document.querySelector('#dialog-confirm').addEventListener('click', () => { dialog.close(); callback(); });
  dialog.showModal();
  document.querySelector('#dialog-close').focus();
}

function onAction(event) {
  const name = event.currentTarget.dataset.action;
  if (name === 'copy') {
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(room.code).then(() => toast('Room code copied. Send it to the crew!')).catch(() => toast(`Your room code is ${room.code}`));
    else toast(`Your room code is ${room.code}`);
  } else if (name === 'end-confirm') confirmAction('Call it a round?', 'This ends the round for everyone and cancels any scheduled hints.', 'End round', () => action('end'));
  else if (name === 'leave-confirm') confirmAction('Heading out?', isHost() ? 'If others are here, the next player becomes the host.' : 'You can join again between rounds.', 'Leave room', () => action('leave'));
  else if (name === 'forget') forget();
  else if (name.startsWith('count-')) action('configure', {count: room.sardine_count + (name === 'count-up' ? 1 : -1)});
  else if (name === 'found' || name === 'undo-found') action('found', {found: name === 'found' ? !me().found : false});
  else action(name);
}

function forget() {
  if (session) storage.remove(`sardines-draft-${session.code}`);
  storage.remove('sardines-session'); session = null; room = null; draft = ''; signature = ''; errorMessage = ''; busy = false;
  history.replaceState(null, '', '/'); home();
}

async function poll() {
  if (!session || busy || polling) return;
  polling = true;
  const credential = session.token;
  const epoch = stateEpoch;
  try {
    const result = await api(`/rooms/${session.code}`);
    if (session?.token === credential && !busy && epoch === stateEpoch) acceptRoom(result);
  } catch (error) {
    if (session?.token !== credential) return;
    online = false;
    if ([401,404].includes(error.status)) errorMessage = error.message;
    if (room) renderRoom(true);
    else {
      root.innerHTML = `<div class="loading">${[401,404].includes(error.status) ? 'Your room is no longer available.' : 'Let’s get you reconnected.'}<span>${esc(error.message)}</span><button class="quiet-button" id="retry">Try again</button><button class="quiet-button" id="go-home">Back to home</button></div>`;
      document.querySelector('#retry').onclick = poll; document.querySelector('#go-home').onclick = forget;
    }
  } finally { polling = false; }
}

document.querySelector('#how-button').addEventListener('click', () => {
  document.querySelector('#dialog-content').innerHTML = '<h2 id="dialog-title">Hide & seek. In reverse.</h2><ol><li><strong>Get together.</strong> Enter your name, create or join a room, and agree on your play area.</li><li><strong>Pick the sardines.</strong> The host chooses how many people hide, shuffles the roles, and starts the round.</li><li><strong>Hide first. Seek second.</strong> Every sardine taps “I’m hidden!” before the search and stopwatch begin.</li><li><strong>Find them? Join them.</strong> Quietly hide with a sardine and tap “I found them!” You can undo it while the round is running.</li><li><strong>Leave a little clue.</strong> Sardines can send hints anytime or queue one for the next 5-minute mark. When everyone’s found them, the round ends.</li></ol><p>Keep your hiding spots safe and agree on boundaries before you start.</p>';
  document.querySelector('#dialog-close').textContent = 'Let’s play'; dialog.showModal();
});
document.querySelector('#dialog-close').addEventListener('click', () => dialog.close());
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
window.addEventListener('online', poll);
setInterval(updateTimers, 250);
setInterval(() => { if (!document.hidden) poll(); }, 2500);
if (session) {
  draft = storage.get(`sardines-draft-${session.code}`, '');
  root.innerHTML = '<div class="loading">Getting the crew back together…<span>Rejoining your room.</span></div>'; poll();
} else home();
