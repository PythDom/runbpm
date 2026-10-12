"""Tests du serveur de base partagée : python -m unittest discover -s server"""

import io
import json
import os
import tempfile
import unittest

from runbpm_server import Store, create_app


def song(sid, bpm, **extra):
    return {"id": sid, "title": f"T{sid}", "artist": "A", "duration": 200, "bpm": bpm, "bpmSource": "analyse", "confidence": 0.6, **extra}


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "sub", "db.sqlite")
        self.app = create_app(self.path)
        self.alice = self.app.store.add_user("alice")
        self.bob = self.app.store.add_user("bob")

    def tearDown(self):
        self.tmp.cleanup()

    def call(self, method, path, key=None, body=None):
        raw = json.dumps(body).encode() if body is not None else b""
        path, _, query = path.partition("?")
        environ = {
            "REQUEST_METHOD": method,
            "PATH_INFO": path,
            "QUERY_STRING": query,
            "CONTENT_LENGTH": str(len(raw)),
            "wsgi.input": io.BytesIO(raw),
        }
        if key:
            environ["HTTP_X_RUNBPM_KEY"] = key
        out = {}

        def start_response(status, headers):
            out["status"] = int(status.split()[0])
            out["headers"] = dict(headers)

        data = b"".join(self.app(environ, start_response))
        return out["status"], (json.loads(data) if data else None), out["headers"]

    def test_health_and_cors(self):
        status, body, headers = self.call("GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(body["songs"], 0)
        self.assertEqual(headers["Access-Control-Allow-Origin"], "*")
        status, body, headers = self.call("OPTIONS", "/api/songs")
        self.assertEqual(status, 204)
        self.assertIn("X-RunBPM-Key", headers["Access-Control-Allow-Headers"])

    def test_auth(self):
        self.assertEqual(self.call("GET", "/api/songs")[0], 401)
        self.assertEqual(self.call("GET", "/api/songs", "alice:faux")[0], 401)
        self.assertEqual(self.call("GET", "/api/songs", "inconnu:x")[0], 401)
        self.assertEqual(self.call("GET", "/api/whoami", self.alice)[1], {"user": "alice"})
        self.app.store.revoke("alice")
        self.assertEqual(self.call("GET", "/api/songs", self.alice)[0], 401)
        # Le code n'est conservé que sous forme d'empreinte.
        with open(self.path, "rb") as f:
            self.assertNotIn(self.bob.split(":")[1].encode(), f.read())

    def test_upsert_manual_priority(self):
        s, r, _ = self.call("POST", "/api/songs", self.alice, {"songs": [song("1", 170), song("2", 88), {"id": "x", "bpm": 999}]})
        self.assertEqual((r["added"], r["total"]), (2, 2))
        s, r, _ = self.call("PATCH", "/api/songs/1", self.bob, {"bpm": 85})
        self.assertEqual((r["song"]["bpm"], r["song"]["bpmSource"], r["song"]["updatedBy"]), (85, "manuel", "bob"))
        s, r, _ = self.call("POST", "/api/songs", self.alice, {"songs": [song("1", 171, title="Nouveau"), song("2", 89), song("3", 175)]})
        self.assertEqual((r["added"], r["updated"], r["kept"]), (1, 1, 1))
        s, r, _ = self.call("POST", "/api/songs", self.alice, {"songs": [song("2", 89)]})
        self.assertEqual(r["unchanged"], 1)
        songs = {x["id"]: x for x in self.call("GET", "/api/songs", self.bob)[1]["songs"]}
        self.assertEqual((songs["1"]["bpm"], songs["1"]["title"]), (85, "Nouveau"))
        self.assertEqual(songs["2"]["bpm"], 89)
        self.assertEqual(self.call("PATCH", "/api/songs/1", self.alice, {"bpm": 20})[0], 400)
        self.assertEqual(self.call("PATCH", "/api/songs/zz", self.alice, {"bpm": 170})[0], 404)
        self.assertEqual(self.call("POST", "/api/songs", self.alice, None)[0], 200)
        # Morceaux modifiés depuis une date
        later = self.call("GET", "/api/songs?since=2999-01-01T00:00:00Z", self.alice)[1]["songs"]
        self.assertEqual(later, [])

    def test_selection_per_user(self):
        self.call("PUT", "/api/selection", self.alice, {"selected": ["1", "2", "2", 3]})
        self.call("PUT", "/api/selection", self.bob, {"selected": ["9"]})
        self.assertEqual(self.call("GET", "/api/selection", self.alice)[1], {"user": "alice", "selected": ["1", "2"]})
        self.assertEqual(self.call("GET", "/api/selection", self.bob)[1]["selected"], ["9"])

    def test_export_import_and_persistence(self):
        self.call("POST", "/api/songs", self.alice, {"songs": [song("42", 176)]})
        self.call("PUT", "/api/selection", self.alice, {"selected": ["42"]})
        data = self.app.store.export()
        other = Store(os.path.join(self.tmp.name, "copy.sqlite"))
        other.import_data(json.loads(json.dumps(data)))
        self.assertEqual(other.songs()[0]["bpm"], 176)
        self.assertEqual(other.selection("alice"), ["42"])
        # Relecture du même fichier par une nouvelle application
        self.assertEqual(create_app(self.path).store.count(), 1)

    def test_bad_requests(self):
        status, body, _ = self.call("POST", "/api/songs", self.alice, None)
        self.assertEqual(status, 200)
        environ_body = b"{pas du json"
        environ = {"REQUEST_METHOD": "POST", "PATH_INFO": "/api/songs", "CONTENT_LENGTH": str(len(environ_body)),
                   "wsgi.input": io.BytesIO(environ_body), "HTTP_X_RUNBPM_KEY": self.alice}
        res = {}
        self.app(environ, lambda s, h: res.update(status=s))
        self.assertTrue(res["status"].startswith("400"))
        self.assertEqual(self.call("GET", "/autre", self.alice)[0], 404)


if __name__ == "__main__":
    unittest.main()
