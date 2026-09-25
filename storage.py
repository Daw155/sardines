"""Small atomic room store: SQLite locally, Upstash REST on Vercel."""
import json
import os
import sqlite3
import time
from urllib.request import Request, urlopen

TTL = 24 * 60 * 60


class StoreUnavailable(Exception):
    pass


class SQLiteStore:
    def __init__(self, path):
        self.path = path
        with self.connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, data TEXT, expires REAL)")

    def connect(self):
        return sqlite3.connect(self.path, timeout=10)

    def create(self, code, room):
        with self.connect() as db:
            db.execute("DELETE FROM rooms WHERE expires < ?", (time.time(),))
            cursor = db.execute("INSERT OR IGNORE INTO rooms VALUES (?, ?, ?)",
                                (code, json.dumps(room), time.time() + TTL))
            return cursor.rowcount == 1

    def update(self, code, fn):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT data FROM rooms WHERE code = ? AND expires > ?",
                             (code, time.time())).fetchone()
            room = json.loads(row[0]) if row else None
            result = fn(room)
            if room is not None:
                db.execute("UPDATE rooms SET data = ?, expires = ? WHERE code = ?",
                           (json.dumps(room), time.time() + TTL, code))
            return result


class RedisStore:
    # Compare-and-set the entire tiny room in one atomic Redis operation. A racing
    # request retries against fresh state, so no joins or hidden votes get lost.
    CAS = """
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3]); return 1
    end
    return 0
    """

    def __init__(self, url, token):
        self.url, self.token = url.rstrip('/'), token

    def command(self, *args):
        req = Request(self.url, json.dumps(args).encode(),
                      {"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"})
        try:
            with urlopen(req, timeout=8) as response:
                body = json.load(response)
            if "error" in body:
                raise StoreUnavailable("Redis command failed")
            return body["result"]
        except (OSError, ValueError, KeyError) as exc:
            raise StoreUnavailable("Room storage is temporarily unavailable") from exc

    def create(self, code, room):
        return self.command("SET", f"sardines:{code}", json.dumps(room), "EX", TTL, "NX") == "OK"

    def update(self, code, fn):
        key = f"sardines:{code}"
        for _ in range(10):
            raw = self.command("GET", key)
            room = json.loads(raw) if raw else None
            result = fn(room)
            if room is None:
                return result
            updated = json.dumps(room)
            if raw == updated:
                # Avoid rewriting unchanged polling responses; keep active rooms alive.
                self.command("EXPIRE", key, TTL)
                return result
            if self.command("EVAL", self.CAS, 1, key, raw, updated, TTL):
                return result
        raise StoreUnavailable("The room is busy. Please try again.")


def make_store():
    url = os.getenv("UPSTASH_REDIS_REST_URL") or os.getenv("KV_REST_API_URL")
    token = os.getenv("UPSTASH_REDIS_REST_TOKEN") or os.getenv("KV_REST_API_TOKEN")
    if url and token:
        return RedisStore(url, token)
    if os.getenv("VERCEL"):
        raise StoreUnavailable("Connect Upstash Redis and set its REST URL and token in Vercel.")
    return SQLiteStore(os.getenv("SARDINES_DB", ".sardines.sqlite3"))
