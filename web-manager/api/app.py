from __future__ import annotations

import math
import os
import threading
from typing import Any

import urllib3
from flask import Flask, g, jsonify, request
from flask.json.provider import DefaultJSONProvider
from flask_cors import CORS

import cache
from envs import registry
from routes.build import build_bp
from routes.analyze import analyze_bp
from routes.discovery import discovery_bp
from routes.testing import testing_bp
from routes.monitor import monitor_bp
from routes.objects import objects_bp
from routes.promote import promote_bp
from routes.pipeline import pipeline_bp
from routes.settings import settings_bp
from routes.importer import importer_bp

# Container hosts commonly run self-signed certs; `insecure: true` per host
# (sml-wizard convention) disables verification, so silence the per-call noise.
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)


def _finite(o: Any) -> Any:
    if isinstance(o, float):
        return o if math.isfinite(o) else None
    if isinstance(o, dict):
        return {k: _finite(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_finite(v) for v in o]
    return o


class _StrictJSON(DefaultJSONProvider):
    """NaN / Infinity aren't JSON - Python writes them anyway and the browser's
    JSON.parse then rejects the whole response (a blank Test compare page).
    Non-finite floats go out as null."""

    def dumps(self, obj: Any, **kwargs: Any) -> str:
        return super().dumps(_finite(obj), **kwargs)


_LOOPBACK = ("127.0.0.1", "::1")


def _client_ip() -> str | None:
    """Who is calling. Behind a proxy on this machine (Vite's, or a reverse
    proxy) every request arrives from loopback, so the last X-Forwarded-For hop
    - the address that proxy saw - decides. A header is only believed from a
    local proxy: a remote caller can't claim loopback by sending its own."""
    addr = request.remote_addr
    fwd = request.headers.get("X-Forwarded-For")
    if addr in _LOOPBACK and fwd:
        return fwd.split(",")[-1].strip()
    return addr


def create_app() -> Flask:
    app = Flask(__name__)
    app.json = _StrictJSON(app)
    CORS(app)
    @app.before_request
    def bind_business_unit():
        """Every call works inside one business unit: the `X-BU` header (or
        `?bu=` for plain links), else the first BU. See envs/registry.py."""
        bu = request.headers.get("X-BU") or request.args.get("bu")
        try:
            registry.set_bu(bu)
        except registry.UnknownBu as e:
            if request.method == "GET" and request.path == "/api/bus":
                # The BU list is how the UI recovers from a removed BU: never refuse it.
                registry.set_bu(None)
                return None
            return jsonify({"error": f"Unknown business unit '{e.args[0]}'", "unknownBu": True}), 400

    @app.before_request
    def pipeline_auth():
        """/api/pipeline/*: a bearer API token (pipeline/config.py) binds the
        call to the token's business unit and scopes. Without one, only
        loopback callers - the local UI through Vite's proxy - get in, per
        ENV_MANAGER_PIPELINE_OPEN: loopback (default) | all | none. The CLI
        file itself is public."""
        if not request.path.startswith("/api/pipeline/") or request.method == "OPTIONS":
            return None
        from pipeline import config as pconfig

        auth = request.headers.get("Authorization") or ""
        if auth.lower().startswith("bearer "):
            found = pconfig.authenticate(auth[7:].strip())
            if not found:
                return jsonify({"error": "Invalid or revoked API token"}), 401
            registry.set_bu(found[0])
            g.pipeline_token = found[1]
            return None
        if request.path == "/api/pipeline/cli":
            return None
        mode = os.environ.get("ENV_MANAGER_PIPELINE_OPEN", "loopback")
        if mode == "all" or (mode == "loopback" and _client_ip() in _LOOPBACK):
            return None
        return jsonify({"error": "An API token is required (Authorization: Bearer emt_...)"}), 401

    app.register_blueprint(settings_bp, url_prefix="/api")
    app.register_blueprint(objects_bp, url_prefix="/api")
    app.register_blueprint(promote_bp, url_prefix="/api")
    app.register_blueprint(pipeline_bp, url_prefix="/api")
    app.register_blueprint(build_bp, url_prefix="/api")
    app.register_blueprint(importer_bp, url_prefix="/api")
    app.register_blueprint(discovery_bp, url_prefix="/api")
    app.register_blueprint(testing_bp, url_prefix="/api")
    app.register_blueprint(monitor_bp, url_prefix="/api")
    app.register_blueprint(analyze_bp, url_prefix="/api")

    @app.get("/api/health")
    def health():
        return {"status": "ok", "fake": registry.FAKE, "cacheTtl": cache.TTL}

    return app


if __name__ == "__main__":
    # With the debug reloader the app runs in a child process; warm only there.
    if os.environ.get("WERKZEUG_RUN_MAIN") == "true":
        threading.Thread(target=registry.warm_cache, daemon=True).start()
    create_app().run(debug=True, port=int(os.environ.get("API_PORT", "5000")), threaded=True)
