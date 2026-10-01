from __future__ import annotations

import math
import os
import threading
from typing import Any

import urllib3
from flask import Flask, jsonify, request
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
from routes.settings import settings_bp

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

    app.register_blueprint(settings_bp, url_prefix="/api")
    app.register_blueprint(objects_bp, url_prefix="/api")
    app.register_blueprint(promote_bp, url_prefix="/api")
    app.register_blueprint(build_bp, url_prefix="/api")
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
