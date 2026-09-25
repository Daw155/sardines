"""Game rules are server-authoritative; all times are Unix seconds."""
import hashlib
import math
import secrets
import unicodedata

HINT_INTERVAL = 300
MAX_PLAYERS = 40


class GameError(Exception):
    def __init__(self, message, status=400):
        self.message, self.status = message, status


def require(condition, message, status=400):
    if not condition:
        raise GameError(message, status)


def clean_text(value, maximum, label):
    require(isinstance(value, str), f"Enter {label}.")
    value = unicodedata.normalize("NFKC", value).strip()
    require(0 < len(value) <= maximum, f"{label.capitalize()} must be 1–{maximum} characters.")
    require(not any(unicodedata.category(c).startswith("C") and c not in "\n\t" for c in value),
            f"{label.capitalize()} contains unsupported characters.")
    return value


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def player(name, token):
    return {"id": secrets.token_hex(8), "name": clean_text(name, 24, "your name"),
            "token_hash": token_hash(token), "role": "seeker", "hidden": False, "found": False}


def new_room(code, host, now):
    return {"code": code, "host_id": host["id"], "players": [host], "phase": "lobby",
            "sardine_count": 1, "round": 0, "started_at": None, "ended_at": None,
            "end_reason": None, "hints": [], "scheduled": {}, "actions": [], "created_at": now}


def authenticate(room, token):
    require(room is not None, "That room doesn't exist or has expired.", 404)
    digest = token_hash(token)
    me = next((p for p in room["players"] if secrets.compare_digest(p["token_hash"], digest)), None)
    require(me is not None, "You're no longer in this room. The host may have removed you.", 401)
    return me


def publish_due(room, now):
    if room["phase"] != "seeking":
        return
    due = sorted([(pid, hint) for pid, hint in room["scheduled"].items() if hint["due_at"] <= now],
                 key=lambda item: item[1]["due_at"])
    for pid, hint in due:
        author = next(p for p in room["players"] if p["id"] == pid)
        room["hints"].append({"id": secrets.token_hex(8), "text": hint["text"],
                              "author": author["name"], "sent_at": hint["due_at"], "scheduled": True})
        del room["scheduled"][pid]
    room["hints"] = room["hints"][-200:]


def finish(room, now, reason):
    room.update(phase="ended", ended_at=now, end_reason=reason, scheduled={})


def join(room, newcomer):
    require(room is not None, "That room doesn't exist or has expired.", 404)
    # Retrying a join with the same private token is safe, including after start.
    existing = next((p for p in room["players"] if p["token_hash"] == newcomer["token_hash"]), None)
    if existing:
        return existing
    require(room["phase"] in ("lobby", "ended"), "This round is in progress. Join when it ends.", 409)
    require(len(room["players"]) < MAX_PLAYERS, "This room is full (40 players).", 409)
    require(all(p["name"].casefold() != newcomer["name"].casefold() for p in room["players"]),
            "That name is already in this room. Try a nickname.", 409)
    room["players"].append(newcomer)
    return newcomer


def act(room, me, action, data, now):
    require(data.get("round") == room["round"], "The round changed. Please try again.", 409)
    request_id = data.get("request_id")
    require(isinstance(request_id, str) and 8 <= len(request_id) <= 80, "A request ID is required.")
    action_key = me["id"] + ":" + request_id
    if action_key in room["actions"]:
        return
    host = me["id"] == room["host_id"]
    if action in ("configure", "randomize", "start", "end", "reset", "kick"):
        require(host, "Only the host can do that.", 403)
    if action in ("configure", "randomize", "start"):
        require(room["phase"] == "lobby", "Return to the lobby before starting another round.", 409)
    if action == "rename":
        name = clean_text(data.get("name"), 24, "your name")
        require(all(p["id"] == me["id"] or p["name"].casefold() != name.casefold()
                    for p in room["players"]), "That name is already in this room. Try a nickname.", 409)
        me["name"] = name
    elif action == "kick":
        target = next((p for p in room["players"] if p["id"] == data.get("player_id")), None)
        require(target is not None, "That player has already left.", 404)
        require(target["id"] != me["id"], "Use Leave room to leave yourself.")
        room["players"].remove(target)
        room["scheduled"].pop(target["id"], None)
        if room["phase"] in ("hiding", "seeking"):
            sardines = [p for p in room["players"] if p["role"] == "sardine"]
            seekers = [p for p in room["players"] if p["role"] == "seeker"]
            room["sardine_count"] = len(sardines)
            if not sardines or not seekers:
                finish(room, now, "not_enough_players")
            elif room["phase"] == "hiding" and all(p["hidden"] for p in sardines):
                room.update(phase="seeking", started_at=now)
            elif room["phase"] == "seeking" and all(p["found"] for p in seekers):
                finish(room, now, "everyone_found")
        if room["phase"] in ("lobby", "ended"):
            room["sardine_count"] = max(1, min(room["sardine_count"], len(room["players"]) - 1))
            if room["phase"] == "lobby":
                # Removing a player changes the pool; require a fresh shuffle.
                for p in room["players"]:
                    p["role"] = "seeker"
    elif action == "configure":
        count = data.get("count")
        require(type(count) is int and 1 <= count < max(2, len(room["players"])),
                "Keep at least one sardine and one seeker.")
        room["sardine_count"] = count
        for p in room["players"]:
            p["role"] = "seeker"
    elif action == "randomize":
        require(len(room["players"]) > room["sardine_count"], "You need at least one seeker. Invite more friends.")
        chosen = secrets.SystemRandom().sample(room["players"], room["sardine_count"])
        ids = {p["id"] for p in chosen}
        for p in room["players"]:
            p["role"] = "sardine" if p["id"] in ids else "seeker"
    elif action == "start":
        require(len(room["players"]) >= 2, "Invite at least one friend first.")
        require(sum(p["role"] == "sardine" for p in room["players"]) == room["sardine_count"],
                "Randomize roles before starting.")
        require(any(p["role"] == "seeker" for p in room["players"]), "You need at least one seeker.")
        room.update(phase="hiding", round=room["round"] + 1, hints=[], scheduled={},
                    started_at=None, ended_at=None, end_reason=None)
        for p in room["players"]:
            p.update(hidden=False, found=False)
    elif action == "hidden":
        require(room["phase"] == "hiding" and me["role"] == "sardine", "Only hiding sardines can check in.", 409)
        me["hidden"] = True
        if all(p["hidden"] for p in room["players"] if p["role"] == "sardine"):
            room.update(phase="seeking", started_at=now)
    elif action == "found":
        require(room["phase"] == "seeking" and me["role"] == "seeker", "You can check in once seeking starts.", 409)
        require(type(data.get("found")) is bool, "Choose a found status.")
        me["found"] = data["found"]
        if all(p["found"] for p in room["players"] if p["role"] == "seeker"):
            finish(room, now, "everyone_found")
    elif action in ("hint", "schedule", "cancel_hint"):
        require(me["role"] == "sardine" and room["phase"] in ("hiding", "seeking"),
                "Only sardines can send hints during a round.", 403)
        if action == "cancel_hint":
            room["scheduled"].pop(me["id"], None)
        else:
            text = clean_text(data.get("text"), 280, "hint")
            if action == "schedule":
                require(room["phase"] == "seeking", "You can schedule this draft once the search begins.", 409)
                due = room["started_at"] + (math.floor((now - room["started_at"]) / HINT_INTERVAL) + 1) * HINT_INTERVAL
                room["scheduled"][me["id"]] = {"text": text, "due_at": due}
            else:
                require(room["phase"] == "seeking", "Wait for the search to begin before sending hints.", 409)
                room["hints"].append({"id": secrets.token_hex(8), "text": text, "author": me["name"],
                                      "sent_at": now, "scheduled": False})
                room["hints"] = room["hints"][-200:]
    elif action == "end":
        require(room["phase"] in ("hiding", "seeking"), "This round has already ended.", 409)
        finish(room, now, "host_ended")
    elif action == "reset":
        require(room["phase"] == "ended", "Finish this round first.", 409)
        room.update(phase="lobby", started_at=None, ended_at=None, end_reason=None, hints=[], scheduled={})
        for p in room["players"]:
            p.update(role="seeker", hidden=False, found=False)
    elif action == "leave":
        require(room["phase"] in ("lobby", "ended"), "Wait for the round to end before leaving.", 409)
        room["players"].remove(me)
        if room["players"]:
            if host:
                room["host_id"] = room["players"][0]["id"]
            room["sardine_count"] = min(room["sardine_count"], max(1, len(room["players"]) - 1))
        else:
            finish(room, now, "empty")
    else:
        raise GameError("Unknown action.", 404)
    room["actions"] = (room["actions"] + [action_key])[-100:]


def view(room, me, now):
    return {k: room[k] for k in ("code", "host_id", "phase", "sardine_count", "round", "started_at", "ended_at", "end_reason", "hints")} | {
        "players": [{k: p[k] for k in ("id", "name", "role", "hidden", "found")} for p in room["players"]],
        "me_id": me["id"], "scheduled_hint": room["scheduled"].get(me["id"]),
        "server_time": now, "hint_interval": HINT_INTERVAL}
