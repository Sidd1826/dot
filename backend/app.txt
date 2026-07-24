import os
from dotenv import load_dotenv
from flask import Flask, send_from_directory
from flask_cors import CORS
from routes import routes

load_dotenv()


def create_app():
    app = Flask(__name__, static_folder="frontend", static_url_path="")

    # Enable Cross-Origin Resource Sharing (CORS)
    CORS(app)

    # Register blueprints
    app.register_blueprint(routes, url_prefix="/api")

    @app.route("/")
    def root():
        return send_from_directory(app.static_folder, "index.html")

    return app


app = create_app()

if __name__ == "__main__":
    app.run(
        host="0.0.0.0",
        port=int(os.getenv("PORT", 5000)),
        debug=True,
    )