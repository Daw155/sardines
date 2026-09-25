import os
import re
import secrets
import time
from functools import lru_cache

from flask import Flask, jsonify, request, send_from_directory
from werkzeug.exceptions import HTTPException

from game import GameError, act, authenticate, join, new_room, player, publish_due, require, view
from storage import StoreUnavailable, make_store

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = 8192


@lru_cache(maxsize=1)
def store():
    return make_store()


def body():
    data = request.get_json(silent=True)
    require(isinstance(data, dict), "Send a JSON object.")
    return data


def token():
    header = request.headers.get("Authorization", "")
    value = header.removeprefix("Bearer ") if header.startswith("Bearer ") else ""
    require(32 <= len(value) <= 128, "Your session is missing. Please join the room again.", 401)
    return value


def room_code(code):
    code = code.strip().upper()
    require(re.fullmatch(r"[A-Z2-9]{6}", code), "Enter the 6-character room code.")
    return code


@app.after_request
def headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["Content-Security-Policy"] = "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
    if request.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.errorhandler(GameError)
def game_error(exc):
    return jsonify(error=exc.message), exc.status


@app.errorhandler(StoreUnavailable)
def storage_error(exc):
    app.logger.error("Storage unavailable: %s", exc)
    return jsonify(error="Room storage is unavailable. Please try again shortly."), 503


@app.errorhandler(HTTPException)
def http_error(exc):
    return jsonify(error=exc.description), exc.code


@app.get("/")
def home():
    return send_from_directory("public", "index.html")


@app.get("/assets/<path:filename>")
def assets(filename):
    return send_from_directory("public/assets", filename)


@app.post("/api/rooms")
def create_room():
    data, credential = body(), token()
    host = player(data.get("name"), credential)
    now = time.time()
    for _ in range(10):
        code = "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(6))
        room = new_room(code, host, now)
        if store().create(code, room):
            return jsonify(view(room, host, now)), 201
    raise StoreUnavailable("Could not allocate a room code")


@app.post("/api/rooms/<code>/join")
def join_room(code):
    code, data, credential = room_code(code), body(), token()
    newcomer = player(data.get("name"), credential)

    def update(room):
        me = join(room, newcomer)
        # An empty room may be reused until it expires.
        if len(room["players"]) == 1:
            room["host_id"] = me["id"]
        return view(room, me, time.time())
    return jsonify(store().update(code, update))


@app.get("/api/rooms/<code>")
def get_room(code):
    code, credential = room_code(code), token()

    def update(room):
        me = authenticate(room, credential)
        now = time.time()
        publish_due(room, now)
        return view(room, me, now)
    return jsonify(store().update(code, update))


@app.post("/api/rooms/<code>/actions/<action>")
def action_room(code, action):
    code, data, credential = room_code(code), body(), token()

    def update(room):
        me = authenticate(room, credential)
        now = time.time()
        publish_due(room, now)
        act(room, me, action, data, now)
        return {"left": True} if action == "leave" else view(room, me, now)
    return jsonify(store().update(code, update))


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "8000")), debug=False)
