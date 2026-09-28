from __future__ import annotations

import os
import threading

import urllib3
from flask import Flask
from flask_cors import CORS

import cache
from envs import registry
from routes.build import build_bp
from routes.testing import testing_bp
from routes.objects import objects_bp
from routes.promote import promote_bp
from routes.settings import settings_bp

# Container hosts commonly run self-signed certs; `insecure: true` per host
# (sml-wizard convention) disables verification, so silence the per-call noise.
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)


def create_app() -> Flask:
    app = Flask(__name__)
    CORS(app)
    app.register_blueprint(settings_bp, url_prefix="/api")
    app.register_blueprint(objects_bp, url_prefix="/api")
    app.register_blueprint(promote_bp, url_prefix="/api")
    app.register_blueprint(build_bp, url_prefix="/api")
    app.register_blueprint(testing_bp, url_prefix="/api")

    @app.get("/api/health")
    def health():
        return {"status": "ok", "fake": registry.FAKE, "cacheTtl": cache.TTL}

    return app


if __name__ == "__main__":
    # With the debug reloader the app runs in a child process; warm only there.
    if os.environ.get("WERKZEUG_RUN_MAIN") == "true":
        threading.Thread(target=registry.warm_cache, daemon=True).start()
    create_app().run(debug=True, port=int(os.environ.get("API_PORT", "5000")), threaded=True)
