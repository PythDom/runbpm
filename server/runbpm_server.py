#!/usr/bin/env python3
"""Base partagée RunBPM : morceaux Navidrome avec leur BPM, et sélection « course » de chaque utilisateur.

Un seul fichier, bibliothèque standard uniquement (Python 3.8+) : il s'installe tel quel sur
PythonAnywhere (application WSGI) et se lance sur un PC sans rien installer.

    python runbpm_server.py adduser alice      # crée un utilisateur, affiche son code d'accès
    python runbpm_server.py users              # liste les utilisateurs
    python runbpm_server.py revoke alice       # retire l'accès
    python runbpm_server.py serve --port 8000  # serveur local (essais)
    python runbpm_server.py export base.json   # sauvegarde lisible
    python runbpm_server.py import base.json   # restauration / fusion

La base est un fichier SQLite : variable RUNBPM_DB, sinon ~/runbpm-data/runbpm.sqlite.

Identité : chaque requête porte l'en-tête « X-RunBPM-Key: nom:secret ». Seule l'empreinte
SHA-256 du secret est conservée. Les données ne sont pas sensibles (titres et tempos), mais seuls les
utilisateurs invités peuvent les lire et les modifier.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import sys
from datetime import datetime, timezone
from urllib.parse import unquote

MAX_BODY = 8 * 1024 * 1024
BPM_SOURCES = {"tag", "analyse", "import", "manuel"}
NAME_RE = re.compile(r"^[A-Za-z0-9_.@-]{1,64}$")
SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  name TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS songs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  album TEXT,
  duration INTEGER NOT NULL,
  bpm REAL NOT NULL,
  bpm_source TEXT NOT NULL,
  confidence REAL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
CREATE TABLE IF NOT EXISTS selections (
  user TEXT NOT NULL,
  song_id TEXT NOT NULL,
  PRIMARY KEY (user, song_id)
);
"""


def default_db_path() -> str:
    return os.environ.get("RUNBPM_DB") or os.path.join(os.path.expanduser("~"), "runbpm-data", "runbpm.sqlite")


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def hash_key(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


class HttpError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class Store:
    """Accès à la base SQLite (une connexion par requête : sûr avec plusieurs processus)."""

    def __init__(self, path: str):
        self.path = path
        folder = os.path.dirname(os.path.abspath(path))
        os.makedirs(folder, exist_ok=True)
        with self.connect() as db:
            db.executescript(SCHEMA)

    def connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        return db

    # ---------- utilisateurs ----------

    def add_user(self, name: str) -> str:
        if not NAME_RE.match(name):
            raise ValueError("Nom invalide : lettres, chiffres, . _ - @ (64 caractères au plus).")
        secret = secrets.token_urlsafe(18)
        with self.connect() as db:
            db.execute(
                "INSERT INTO users (name, key_hash, created_at) VALUES (?, ?, ?) "
                "ON CONFLICT(name) DO UPDATE SET key_hash = excluded.key_hash",
                (name, hash_key(secret), now()),
            )
        return f"{name}:{secret}"

    def revoke(self, name: str) -> bool:
        with self.connect() as db:
            return db.execute("DELETE FROM users WHERE name = ?", (name,)).rowcount > 0

    def users(self) -> list[tuple[str, str]]:
        with self.connect() as db:
            return [(r["name"], r["created_at"]) for r in db.execute("SELECT name, created_at FROM users ORDER BY name")]

    def authenticate(self, code: str | None) -> str:
        if not code or ":" not in code:
            raise HttpError(401, "Code d’accès manquant.")
        name, secret = code.split(":", 1)
        with self.connect() as db:
            row = db.execute("SELECT key_hash FROM users WHERE name = ?", (name,)).fetchone()
        if not row or not hmac.compare_digest(row["key_hash"], hash_key(secret)):
            raise HttpError(401, "Code d’accès refusé.")
        return name

    # ---------- morceaux ----------

    @staticmethod
    def song_json(r: sqlite3.Row) -> dict:
        out = {
            "id": r["id"],
            "title": r["title"],
            "artist": r["artist"],
            "duration": r["duration"],
            "bpm": r["bpm"],
            "bpmSource": r["bpm_source"],
            "updatedAt": r["updated_at"],
        }
        if r["album"] is not None:
            out["album"] = r["album"]
        if r["confidence"] is not None:
            out["confidence"] = r["confidence"]
        if r["updated_by"] is not None:
            out["updatedBy"] = r["updated_by"]
        return out

    def count(self) -> int:
        with self.connect() as db:
            return db.execute("SELECT COUNT(*) FROM songs").fetchone()[0]

    def songs(self, since: str | None = None) -> list[dict]:
        with self.connect() as db:
            if since:
                rows = db.execute("SELECT * FROM songs WHERE updated_at > ? ORDER BY id", (since,))
            else:
                rows = db.execute("SELECT * FROM songs ORDER BY id")
            return [self.song_json(r) for r in rows]

    def upsert(self, songs: list, user: str) -> dict:
        stats = {"added": 0, "updated": 0, "kept": 0, "unchanged": 0}
        stamp = now()
        with self.connect() as db:
            for raw in songs:
                s = clean_song(raw)
                if not s:
                    continue
                old = db.execute("SELECT * FROM songs WHERE id = ?", (s["id"],)).fetchone()
                meta = (s["title"], s["artist"], s["album"], s["duration"], s["id"])
                if old is not None and (
                    (old["bpm_source"] == "manuel" and s["bpmSource"] != "manuel")
                    or (old["bpm"] == s["bpm"] and old["bpm_source"] == s["bpmSource"])
                ):
                    # Correction manuelle prioritaire sur une analyse, ou rien de neuf : métadonnées seulement.
                    db.execute("UPDATE songs SET title = ?, artist = ?, album = ?, duration = ? WHERE id = ?", meta)
                    stats["kept" if old["bpm_source"] == "manuel" and s["bpmSource"] != "manuel" else "unchanged"] += 1
                    continue
                db.execute(
                    "INSERT INTO songs (id, title, artist, album, duration, bpm, bpm_source, confidence, updated_at, updated_by) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET "
                    "title = excluded.title, artist = excluded.artist, album = excluded.album, duration = excluded.duration, "
                    "bpm = excluded.bpm, bpm_source = excluded.bpm_source, confidence = excluded.confidence, "
                    "updated_at = excluded.updated_at, updated_by = excluded.updated_by",
                    (s["id"], s["title"], s["artist"], s["album"], s["duration"], s["bpm"], s["bpmSource"], s["confidence"], stamp, user),
                )
                stats["updated" if old is not None else "added"] += 1
            stats["total"] = db.execute("SELECT COUNT(*) FROM songs").fetchone()[0]
        return stats

    def set_bpm(self, song_id: str, bpm, user: str) -> dict:
        try:
            value = float(bpm)
        except (TypeError, ValueError):
            value = float("nan")
        if not 40 <= value <= 260:
            raise HttpError(400, "BPM invalide (40 à 260).")
        with self.connect() as db:
            n = db.execute(
                "UPDATE songs SET bpm = ?, bpm_source = 'manuel', confidence = NULL, updated_at = ?, updated_by = ? WHERE id = ?",
                (round(value, 1), now(), user, song_id),
            ).rowcount
            if n == 0:
                raise HttpError(404, "Morceau inconnu de la base partagée.")
            return self.song_json(db.execute("SELECT * FROM songs WHERE id = ?", (song_id,)).fetchone())

    # ---------- sélections ----------

    def selection(self, user: str) -> list[str]:
        with self.connect() as db:
            return [r[0] for r in db.execute("SELECT song_id FROM selections WHERE user = ? ORDER BY song_id", (user,))]

    def set_selection(self, user: str, ids) -> list[str]:
        clean = list(dict.fromkeys(x[:200] for x in (ids if isinstance(ids, list) else []) if isinstance(x, str) and x))[:200000]
        with self.connect() as db:
            db.execute("DELETE FROM selections WHERE user = ?", (user,))
            db.executemany("INSERT INTO selections (user, song_id) VALUES (?, ?)", [(user, i) for i in clean])
        return clean

    # ---------- sauvegarde ----------

    def export(self) -> dict:
        with self.connect() as db:
            sel: dict[str, list[str]] = {}
            for r in db.execute("SELECT user, song_id FROM selections ORDER BY user, song_id"):
                sel.setdefault(r["user"], []).append(r["song_id"])
        return {"version": 1, "songs": {s["id"]: s for s in self.songs()}, "selections": sel}

    def import_data(self, data: dict, user: str = "import") -> dict:
        songs = data.get("songs", [])
        stats = self.upsert(list(songs.values()) if isinstance(songs, dict) else songs, user)
        for name, ids in (data.get("selections") or {}).items():
            if NAME_RE.match(name):
                self.set_selection(name, ids)
        return stats


def clean_song(s) -> dict | None:
    if not isinstance(s, dict):
        return None
    sid = s.get("id")
    if not isinstance(sid, str) or not sid:
        return None
    try:
        bpm = float(s.get("bpm"))
        duration = float(s.get("duration"))
    except (TypeError, ValueError):
        return None
    if not (40 <= bpm <= 260) or not duration > 0:
        return None

    def text(v, default=None, limit=300):
        return v[:limit] if isinstance(v, str) else default

    try:
        confidence = max(0.0, min(1.0, float(s["confidence"]))) if s.get("confidence") is not None else None
    except (TypeError, ValueError):
        confidence = None
    return {
        "id": sid[:200],
        "title": text(s.get("title"), "Sans titre"),
        "artist": text(s.get("artist"), "Artiste inconnu"),
        "album": text(s.get("album")),
        "duration": int(round(duration)),
        "bpm": round(bpm, 1),
        "bpmSource": s.get("bpmSource") if s.get("bpmSource") in BPM_SOURCES else "analyse",
        "confidence": confidence,
    }


# ---------- application WSGI ----------

CORS_HEADERS = [
    # Le navigateur ne transmet aucun cookie : l'identité passe par l'en-tête, on peut ouvrir à toute origine
    # (application Android, http://127.0.0.1 sur le PC, page publiée…).
    ("Access-Control-Allow-Origin", "*"),
    ("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, OPTIONS"),
    ("Access-Control-Allow-Headers", "Content-Type, X-RunBPM-Key"),
    ("Access-Control-Max-Age", "86400"),
]


def create_app(db_path: str | None = None):
    store = Store(db_path or default_db_path())

    def read_json(environ) -> dict:
        try:
            length = int(environ.get("CONTENT_LENGTH") or 0)
        except ValueError:
            length = 0
        if length > MAX_BODY:
            raise HttpError(413, "Requête trop volumineuse.")
        raw = environ["wsgi.input"].read(length) if length else b""
        try:
            data = json.loads(raw.decode("utf-8") or "{}")
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise HttpError(400, "JSON invalide.")
        if not isinstance(data, dict):
            raise HttpError(400, "JSON invalide.")
        return data

    def route(environ):
        method = environ.get("REQUEST_METHOD", "GET")
        path = environ.get("PATH_INFO", "/").rstrip("/") or "/"
        query = environ.get("QUERY_STRING", "")
        if method == "OPTIONS":
            return 204, None
        if path == "/api/health" and method == "GET":
            return 200, {"ok": True, "configured": True, "auth": "code", "songs": store.count()}
        if not path.startswith("/api/"):
            raise HttpError(404, "Introuvable.")
        user = store.authenticate(environ.get("HTTP_X_RUNBPM_KEY"))
        if path == "/api/whoami" and method == "GET":
            return 200, {"user": user}
        if path == "/api/songs" and method == "GET":
            since = next((unquote(p[6:]) for p in query.split("&") if p.startswith("since=")), None)
            return 200, {"songs": store.songs(since), "now": now()}
        if path == "/api/songs" and method == "POST":
            body = read_json(environ)
            return 200, store.upsert(body.get("songs") if isinstance(body.get("songs"), list) else [], user)
        if path.startswith("/api/songs/") and method == "PATCH":
            return 200, {"song": store.set_bpm(unquote(path[len("/api/songs/"):]), read_json(environ).get("bpm"), user)}
        if path == "/api/selection" and method == "GET":
            return 200, {"user": user, "selected": store.selection(user)}
        if path == "/api/selection" and method == "PUT":
            return 200, {"user": user, "selected": store.set_selection(user, read_json(environ).get("selected"))}
        raise HttpError(404, "Introuvable.")

    def application(environ, start_response):
        try:
            status, body = route(environ)
        except HttpError as e:
            status, body = e.status, {"error": e.message}
        except Exception as e:  # noqa: BLE001 — erreur inattendue : journalisée, message générique
            print(f"RunBPM : erreur interne : {e!r}", file=sys.stderr)
            status, body = 500, {"error": "Erreur interne du serveur RunBPM."}
        data = b"" if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        reason = {200: "OK", 204: "No Content", 400: "Bad Request", 401: "Unauthorized", 404: "Not Found", 413: "Payload Too Large"}
        headers = CORS_HEADERS + [("Cache-Control", "no-store"), ("Content-Length", str(len(data)))]
        if body is not None:
            headers.append(("Content-Type", "application/json; charset=utf-8"))
        start_response(f"{status} {reason.get(status, 'Error')}", headers)
        return [data]

    application.store = store  # type: ignore[attr-defined]
    return application


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Base partagée RunBPM")
    parser.add_argument("--db", default=None, help="fichier SQLite (défaut : $RUNBPM_DB ou ~/runbpm-data/runbpm.sqlite)")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("serve", help="serveur local")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    sub.add_parser("adduser", help="crée un utilisateur (ou renouvelle son code)").add_argument("name")
    sub.add_parser("revoke", help="retire l'accès d'un utilisateur").add_argument("name")
    sub.add_parser("users", help="liste les utilisateurs")
    sub.add_parser("export", help="exporte la base en JSON").add_argument("file")
    sub.add_parser("import", help="fusionne un export JSON dans la base").add_argument("file")
    args = parser.parse_args(argv)
    path = args.db or default_db_path()

    if args.cmd == "serve":
        from wsgiref.simple_server import make_server

        app = create_app(path)
        print(f"RunBPM : base {path} ({app.store.count()} morceaux) sur http://{args.host}:{args.port}/api/health")
        make_server(args.host, args.port, app).serve_forever()
        return 0
    store = Store(path)
    if args.cmd == "adduser":
        code = store.add_user(args.name)
        print(f"Code d’accès de {args.name} (à saisir dans RunBPM, il ne sera plus affiché) :\n\n  {code}\n")
    elif args.cmd == "revoke":
        print("Accès retiré." if store.revoke(args.name) else "Utilisateur inconnu.")
    elif args.cmd == "users":
        for name, created in store.users():
            print(f"{name}\t{created}")
    elif args.cmd == "export":
        with open(args.file, "w", encoding="utf-8") as f:
            json.dump(store.export(), f, ensure_ascii=False, indent=1)
        print(f"{store.count()} morceaux exportés dans {args.file}.")
    elif args.cmd == "import":
        with open(args.file, encoding="utf-8") as f:
            print(store.import_data(json.load(f)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
