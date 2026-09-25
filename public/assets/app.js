/* Plain JavaScript; game decisions and identity stay on the server. */
const root = document.querySelector("#app");
const dialog = document.querySelector("#dialog");
const storage = {
    get(key, fallback = null) {
        try {
            return JSON.parse(localStorage.getItem(key)) ?? fallback;
        } catch {
            return fallback;
        }
    },
    set(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch {}
    },
    remove(key) {
        try {
            localStorage.removeItem(key);
        } catch {}
    },
};
let session = storage.get("sardines-session");
if (!session || typeof session.code !== "string" || typeof session.token !== "string") session = null;
let room = null,
    busy = false,
    polling = false,
    online = true,
    signature = "",
    toastTimeout;
let clockOffset = 0,
    draft = "",
    stateEpoch = 0;
let homeName = storage.get("sardines-name", "");
let joinCode = new URLSearchParams(location.search).get("room")?.slice(0, 6).toUpperCase() || "";
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[c]);
const now = () => Date.now() / 1000 + clockOffset;
const elapsed = () => (room?.started_at ? Math.max(0, (room.ended_at ?? now()) - room.started_at) : 0);
const timeLabel = (seconds) => {
    const s = Math.max(0, Math.floor(seconds));
    return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const me = () => room?.players.find((p) => p.id === room.me_id);
const isHost = () => room?.host_id === room?.me_id;
const requestID = () => [...crypto.getRandomValues(new Uint8Array(24))].map((n) => n.toString(16).padStart(2, "0")).join("");

function actionIcon(action) {
    const paths = action === "edit"
        ? '<path d="m16 3 5 5-12 12-6 1 1-6Z"/><path d="m13 6 5 5"/>'
        : '<circle cx="9" cy="7" r="4"/><path d="M2 21v-2a7 7 0 0 1 14 0v2M17 10h6"/>';
    return `<svg class="action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
}

function toast(message) {
    const el = document.querySelector("#toast");
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => (el.hidden = true), 5000);
}

async function api(path, data, credential = session?.token) {
    const response = await fetch(`/api${path}`, {
        method: data === undefined ? "GET" : "POST",
        headers: {"Content-Type": "application/json", Authorization: `Bearer ${credential || ""}`},
        body: data === undefined ? undefined : JSON.stringify(data),
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
    });
    let result;
    try {
        result = await response.json();
    } catch {
        throw new Error("Could not connect. Please try again.");
    }
    if (!response.ok) {
        const error = new Error(result.error || "Something went wrong. Try again.");
        error.status = response.status;
        throw error;
    }
    return result;
}

function acceptRoom(value) {
    const previous = room;
    room = value;
    clockOffset = value.server_time - Date.now() / 1000;
    online = true;
    if (previous && (previous.round !== room.round || (previous.phase !== "lobby" && room.phase === "lobby"))) {
        draft = "";
        storage.remove(`sardines-draft-${session.code}`);
    }
    homeName = me().name;
    storage.set("sardines-name", homeName);
    if (previous?.phase === "hiding" && room.phase === "seeking") toast("Everyone is hidden. Start seeking!");
    if (previous && previous.phase !== "ended" && room.phase === "ended") toast(endMessage());
    renderRoom();
}

function updateHeader() {
    const code = document.querySelector("#header-code");
    code.hidden = !room;
    code.textContent = room?.code || "";
    code.setAttribute("aria-label", room ? `Copy room code ${room.code}` : "Room code");
}

function home() {
    updateHeader();
    root.innerHTML = `<form id="entry-form" class="card entry" aria-label="Create or join a room">
    <label for="player-name">Your name</label>
    <input id="player-name" name="name" placeholder="Name or nickname" maxlength="24" autocomplete="nickname" value="${esc(homeName)}" required>
    <div class="entry-actions">
      <button class="button" type="submit" data-entry="create">Create</button>
      <div class="join-row"><label class="sr-only" for="room-code">Room code</label><input id="room-code" name="code" placeholder="Code" maxlength="6" autocomplete="off" autocapitalize="characters" spellcheck="false" value="${esc(joinCode)}"><button class="button" type="submit" data-entry="join">Join</button></div>
    </div>
  </form>`;
    document.querySelector("#entry-form").addEventListener("submit", enter);
    document.querySelector("#room-code").addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            document.querySelector("#entry-form").requestSubmit(document.querySelector('[data-entry="join"]'));
        }
    });
}

async function enter(event) {
    event.preventDefault();
    if (busy) return;
    const mode = event.submitter?.dataset.entry || "create";
    homeName = document.querySelector("#player-name").value.trim();
    joinCode = document.querySelector("#room-code").value.trim().toUpperCase();
    if (!homeName) {
        toast("Enter your name.");
        document.querySelector("#player-name").focus();
        return;
    }
    if (mode === "join" && !/^[A-Z2-9]{6}$/.test(joinCode)) {
        toast("Enter a 6-character room code.");
        document.querySelector("#room-code").focus();
        return;
    }
    busy = true;
    root.querySelectorAll("button").forEach((b) => (b.disabled = true));
    const credential = requestID();
    try {
        const value = await api(mode === "create" ? "/rooms" : `/rooms/${joinCode}/join`, {name: homeName}, credential);
        session = {code: value.code, token: credential};
        storage.set("sardines-session", session);
        history.replaceState(null, "", `/?room=${value.code}`);
        busy = false;
        acceptRoom(value);
    } catch (error) {
        toast(error.message);
    } finally {
        busy = false;
        if (!room) root.querySelectorAll("button").forEach((b) => (b.disabled = false));
    }
}

function endMessage() {
    return {everyone_found: "Everyone found a sardine!", host_ended: "The host ended the round.", not_enough_players: "Round ended: not enough sardines or seekers."}[room.end_reason] || "Round ended.";
}

function progressBar(value, total, label) {
    return `<progress class="round-progress" value="${value}" max="${total}" aria-label="${label}"></progress>`;
}

function gamePanel() {
    const p = me(),
        sardine = p.role === "sardine";
    const heading = `<div class="section-heading"><h2>Round progress</h2><span class="role ${sardine ? "sardine" : "seeker"}" aria-label="Your role: ${sardine ? "Sardine" : "Seeker"}">${sardine ? "Sardine" : "Seeker"}</span></div>`;
    if (room.phase === "lobby") {
        const assigned = room.players.some((p) => p.role === "sardine");
        return `<section class="card game">${heading}<h1>Waiting for players</h1><p class="muted">${assigned ? `You’re a ${p.role}.` : "Share the code to invite friends."}</p>${!isHost() ? '<p class="small muted">The host will start the round.</p>' : ""}</section>`;
    }
    if (room.phase === "ended")
        return `<section class="card game complete">${heading}<h1>Round complete</h1><p class="muted">${endMessage()}</p>${room.started_at ? `<div class="stopwatch" data-stopwatch>${timeLabel(elapsed())}</div><p class="small muted">Time spent seeking</p>` : ""}${!isHost() ? '<p class="small muted">Waiting for the host to start a new round.</p>' : ""}</section>`;
    if (room.phase === "hiding") {
        const hidden = room.players.filter((p) => p.role === "sardine" && p.hidden).length;
        return `<section class="card game">${heading}<h1>${sardine ? (p.hidden ? "You’re hidden" : "Go hide") : "Wait here"}</h1><p class="muted">${hidden} of ${room.sardine_count} sardines hidden.</p>${progressBar(hidden, room.sardine_count, "Sardines hidden")}${sardine ? `<button class="button" data-action="hidden" ${p.hidden ? "disabled" : ""}>${p.hidden ? "Waiting for the others…" : "I’m hidden!"}</button>` : '<p class="small muted">The search starts when everyone is hidden.</p>'}</section>`;
    }
    const seekers = room.players.filter((p) => p.role === "seeker"),
        found = seekers.filter((p) => p.found).length;
    return `<section class="card game">${heading}<h1>${sardine ? "Stay hidden" : p.found ? "You found them" : "Start seeking"}</h1><div class="stopwatch" data-stopwatch>${timeLabel(elapsed())}</div><p class="muted">${found} of ${seekers.length} seekers found a sardine.</p>${progressBar(found, seekers.length, "Seekers who found a sardine")}${sardine ? "" : `<button class="button ${p.found ? "secondary" : ""}" data-action="found">${p.found ? "Undo · I’m still seeking" : "I found them!"}</button>`}</section>`;
}

function hostPanel() {
    if (!isHost()) return "";
    let controls;
    if (room.phase === "lobby") {
        const ready = room.players.filter((p) => p.role === "sardine").length === room.sardine_count && room.players.length > room.sardine_count;
        controls = `<div class="settings-row"><span id="sardines-label">Sardines</span><div class="stepper" role="group" aria-labelledby="sardines-label"><button data-action="count-down" aria-label="Fewer sardines" ${room.sardine_count <= 1 ? "disabled" : ""}>−</button><output>${room.sardine_count}</output><button data-action="count-up" aria-label="More sardines" ${room.sardine_count >= room.players.length - 1 ? "disabled" : ""}>+</button></div></div><div class="button-row"><button class="button secondary" data-action="randomize" ${room.players.length < 2 ? "disabled" : ""}>Shuffle roles</button><button class="button" data-action="start" ${ready ? "" : "disabled"}>Start round</button></div><p class="small muted">${room.players.length < 2 ? "Invite at least one more player." : ready ? "Ready to start." : "Shuffle roles before starting."}</p>`;
    } else if (room.phase === "ended") {
        controls = '<button class="button" data-action="reset">Back to lobby</button>';
    } else {
        controls = '<button class="button secondary" data-action="end-confirm">End round</button>';
    }
    return `<section class="card host-controls"><div class="section-heading"><h2>Host controls</h2></div>${controls}</section>`;
}

function playersPanel() {
    const players = room.players
        .map((p) => {
            const role = p.role === "sardine" ? "Sardine" : "Seeker";
            let status = "";
            if (room.phase === "hiding" && p.role === "sardine") status = p.hidden ? "Hidden" : "Hiding…";
            if (["seeking", "ended"].includes(room.phase) && p.role === "seeker") status = p.found ? "Found them" : "Seeking";
            return `<li class="player"><div class="player-info"><span class="player-name">${esc(p.name)}${p.id === room.me_id ? " <small>(you)</small>" : ""}${p.id === room.host_id ? " <small>· host</small>" : ""}</span><div class="player-details"><span class="role role-small ${p.role}">${role}</span>${status ? `<span class="player-status">${status}</span>` : ""}</div></div>${p.id === room.me_id ? `<button class="text-button player-action edit-name" data-action="rename" aria-label="Edit your name">${actionIcon("edit")}<span>Edit</span></button>` : isHost() ? `<button class="text-button player-action danger-text" data-action="kick-confirm" data-player="${p.id}" aria-label="Kick ${esc(p.name)}">${actionIcon("kick")}<span>Kick</span></button>` : ""}</li>`;
        })
        .join("");
    return `<section class="card players"><div class="section-heading"><h2>Players</h2><span class="count">${room.players.length}</span></div><ul>${players}</ul></section>`;
}

function hintsPanel() {
    if (room.phase === "lobby") return '<section class="card hints"><h2>Round hints</h2><p class="small muted">Hints will appear here once the round starts.</p></section>';
    const scheduled = room.scheduled_hint,
        canWrite = me().role === "sardine" && room.phase !== "ended";
    const hints = [...room.hints]
        .reverse()
        .map((h) => `<article class="hint"><p>${esc(h.text)}</p><footer>${esc(h.author)} · ${timeLabel(h.sent_at - room.started_at)}</footer></article>`)
        .join("");
    return `<section class="card hints"><div class="section-heading"><h2>Round hints</h2>${room.phase === "seeking" ? '<span class="small muted">Next mark in <b data-countdown></b></span>' : ""}</div>
    ${canWrite ? `<form id="hint-form"><label class="sr-only" for="hint-text">Hint for all players</label><textarea id="hint-text" maxlength="280" rows="2" placeholder="Write a hint…">${esc(draft)}</textarea><div class="button-row"><button type="submit" class="button secondary" data-hint="hint" ${room.phase !== "seeking" ? "disabled" : ""}>Send now</button><button type="submit" class="button" data-hint="schedule" ${room.phase !== "seeking" ? "disabled" : ""}>${scheduled ? "Replace" : "Queue"} for <span data-nextmark></span></button></div>${room.phase === "hiding" ? '<p class="small muted">Draft now. Send when seeking starts.</p>' : ""}</form>${scheduled ? `<div class="scheduled"><div class="section-heading"><strong>Queued for ${timeLabel(scheduled.due_at - room.started_at)}</strong><button class="text-button" data-action="cancel_hint">Cancel</button></div><p>${esc(scheduled.text)}</p></div>` : ""}` : ""}
    <div class="hint-list" aria-label="Hints for everyone">${hints || '<p class="small muted">No hints yet.</p>'}</div></section>`;
}

function renderRoom(force = false) {
    const key = JSON.stringify({...room, server_time: 0, online, busy});
    if (!force && signature === key) {
        updateTimers();
        return;
    }
    signature = key;
    const focused = document.activeElement,
        focusID = focused?.id;
    const selection = focusID === "hint-text" ? [focused.selectionStart, focused.selectionEnd] : null;
    updateHeader();
    document.querySelector("#header-code").disabled = busy;
    const canLeave = ["lobby", "ended"].includes(room.phase);
    root.innerHTML = `${online ? "" : '<p class="card connection" role="status">Reconnecting…</p>'}
    ${gamePanel()}${hintsPanel()}${playersPanel()}${hostPanel()}
    <section class="card leave-card" aria-label="Leave room"><button class="button danger" data-action="leave-confirm" ${canLeave ? "" : 'disabled aria-describedby="leave-note"'}>Leave room</button>${canLeave ? "" : '<p class="small muted" id="leave-note">You can leave when the round ends.</p>'}</section>`;
    root.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", onAction));
    root.querySelector("#hint-text")?.addEventListener("input", (event) => {
        draft = event.target.value;
        storage.set(`sardines-draft-${session.code}`, draft);
    });
    root.querySelector("#hint-form")?.addEventListener("submit", (event) => {
        event.preventDefault();
        if (!draft.trim()) return toast("Write a hint first.");
        action(event.submitter?.dataset.hint || "hint", {text: draft});
    });
    if (busy) root.querySelectorAll("button").forEach((button) => (button.disabled = true));
    if (focusID) {
        const next = document.getElementById(focusID);
        next?.focus({preventScroll: true});
        if (selection && next) next.setSelectionRange(...selection);
    }
    updateTimers();
}

function updateTimers() {
    if (!room) return;
    root.querySelectorAll("[data-stopwatch]").forEach((el) => (el.textContent = timeLabel(elapsed())));
    const interval = room.hint_interval,
        nextMark = (Math.floor(elapsed() / interval) + 1) * interval;
    root.querySelectorAll("[data-countdown]").forEach((el) => (el.textContent = timeLabel(Math.ceil(nextMark - elapsed()))));
    root.querySelectorAll("[data-nextmark]").forEach((el) => (el.textContent = timeLabel(nextMark)));
}

async function action(name, extra = {}) {
    if (busy || !room) return false;
    stateEpoch++;
    busy = true;
    renderRoom(true);
    try {
        const result = await api(`/rooms/${session.code}/actions/${name}`, {...extra, round: room.round, request_id: requestID()});
        if (name === "leave") {
            forget();
            return true;
        }
        if (name === "hint" || name === "schedule") {
            draft = "";
            storage.remove(`sardines-draft-${session.code}`);
            toast(name === "hint" ? "Hint sent." : "Hint queued.");
        }
        if (name === "rename") toast("Name updated.");
        if (name === "kick") toast("Player removed.");
        busy = false;
        acceptRoom(result);
        return true;
    } catch (error) {
        if (error.status === 401) forget();
        toast(error.message);
        return false;
    } finally {
        busy = false;
        if (room) renderRoom(true);
    }
}

function confirmAction(title, content, buttonText, callback) {
    document.querySelector("#dialog-content").innerHTML = `<h2 id="dialog-title">${esc(title)}</h2><p class="muted">${esc(content)}</p><button class="button danger" id="dialog-confirm">${esc(buttonText)}</button>`;
    document.querySelector("#dialog-close").textContent = "Cancel";
    document.querySelector("#dialog-confirm").addEventListener("click", () => {
        dialog.close();
        callback();
    });
    dialog.showModal();
    document.querySelector("#dialog-close").focus();
}

function editName() {
    document.querySelector("#dialog-content").innerHTML =
        `<h2 id="dialog-title">Edit name</h2><form id="rename-form"><label for="new-name">Your name</label><input id="new-name" maxlength="24" autocomplete="nickname" value="${esc(me().name)}" required><button class="button" type="submit">Save</button></form>`;
    document.querySelector("#dialog-close").textContent = "Cancel";
    document.querySelector("#rename-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const input = document.querySelector("#new-name"),
            button = event.currentTarget.querySelector("button");
        const name = input.value.trim();
        if (!name) {
            input.setCustomValidity("Enter your name.");
            input.reportValidity();
            return;
        }
        button.disabled = true;
        if (await action("rename", {name})) dialog.close();
        button.disabled = false;
    });
    document.querySelector("#new-name").addEventListener("input", (event) => event.target.setCustomValidity(""));
    dialog.showModal();
    document.querySelector("#new-name").select();
}

function onAction(event) {
    const name = event.currentTarget.dataset.action;
    if (name === "copy") {
        if (navigator.clipboard?.writeText)
            navigator.clipboard
                .writeText(room.code)
                .then(() => toast("Room code copied."))
                .catch(() => toast(`Room code: ${room.code}`));
        else toast(`Room code: ${room.code}`);
    } else if (name === "rename") editName();
    else if (name === "kick-confirm") {
        const target = room.players.find((p) => p.id === event.currentTarget.dataset.player);
        if (target) confirmAction(`Kick ${target.name}?`, "They’ll be removed from the room. The round will adjust to the remaining players.", "Kick player", () => action("kick", {player_id: target.id}));
    } else if (name === "end-confirm") confirmAction("End round?", "This ends the round for everyone and cancels queued hints.", "End round", () => action("end"));
    else if (name === "leave-confirm") confirmAction("Leave room?", isHost() ? "The next player will become host." : "You can rejoin between rounds.", "Leave room", () => action("leave"));
    else if (name.startsWith("count-")) action("configure", {count: room.sardine_count + (name === "count-up" ? 1 : -1)});
    else if (name === "found") action("found", {found: !me().found});
    else action(name);
}

function forget() {
    stateEpoch++;
    if (session) storage.remove(`sardines-draft-${session.code}`);
    storage.remove("sardines-session");
    session = null;
    room = null;
    draft = "";
    signature = "";
    busy = false;
    if (dialog.open) dialog.close();
    joinCode = "";
    history.replaceState(null, "", "/");
    home();
}

async function poll() {
    if (!session || busy || polling) return;
    polling = true;
    const credential = session.token,
        epoch = stateEpoch;
    try {
        const result = await api(`/rooms/${session.code}`);
        if (session?.token === credential && !busy && epoch === stateEpoch) acceptRoom(result);
    } catch (error) {
        if (session?.token !== credential || epoch !== stateEpoch) return;
        if ([401, 404].includes(error.status)) {
            forget();
            toast(error.message);
            return;
        }
        online = false;
        if (room) renderRoom(true);
        else {
            root.innerHTML = `<section class="card entry"><p class="muted">${esc(error.message)}</p><button class="button" id="retry">Try again</button><button class="text-button" id="go-home">Back</button></section>`;
            document.querySelector("#retry").onclick = poll;
            document.querySelector("#go-home").onclick = forget;
        }
    } finally {
        polling = false;
    }
}

document.querySelector("#header-code").addEventListener("click", onAction);
document.querySelector("#how-button").addEventListener("click", () => {
    document.querySelector("#dialog-content").innerHTML =
        '<h2 id="dialog-title">How to play</h2><ol><li>The host picks how many sardines hide, shuffles roles, and starts.</li><li>Sardines hide and tap “I’m hidden!” Everyone else waits.</li><li>Once all sardines are hidden, seekers go find them and hide alongside them.</li><li>Seekers tap “I found them!” You can undo while the round is running.</li><li>Sardines can send hints or queue them for each 5-minute mark. The round ends when everyone is found.</li></ol>';
    document.querySelector("#dialog-close").textContent = "Close";
    dialog.showModal();
});
document.querySelector("#dialog-close").addEventListener("click", () => dialog.close());
document.addEventListener("visibilitychange", () => {
    if (!document.hidden) poll();
});
window.addEventListener("online", poll);
setInterval(updateTimers, 250);
setInterval(() => {
    if (!document.hidden) poll();
}, 2500);
if (session) {
    draft = storage.get(`sardines-draft-${session.code}`, "");
    root.innerHTML = '<p class="card loading muted">Rejoining room…</p>';
    poll();
} else home();
