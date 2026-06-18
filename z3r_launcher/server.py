from __future__ import annotations

import importlib
import json
import mimetypes
import os
import secrets
import sys
import threading
import time
import urllib.parse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable

from .backend import LauncherBackend, LauncherError, app_data_dir, static_dir


HEARTBEAT_TIMEOUT_SECONDS = 45
MAX_REQUEST_BYTES = 16 * 1024 * 1024
GTK_WEBVIEW_GUI = "gtk"
GTK_WEBVIEW_MODULE = "webview.platforms.gtk"
GIREPOSITORY_DIR = "girepository-1.0"


class ServerState:
    def __init__(self, token: str) -> None:
        self.token = token
        self.server: ThreadingHTTPServer | None = None
        self.last_seen = time.monotonic()
        self.active_commands = 0
        self.lock = threading.Lock()
        self.exiting = False
        self.exit_callbacks: list[Callable[[], None]] = []

    def touch(self) -> None:
        with self.lock:
            self.last_seen = time.monotonic()

    def begin_command(self) -> None:
        with self.lock:
            self.last_seen = time.monotonic()
            self.active_commands += 1

    def end_command(self) -> None:
        with self.lock:
            self.last_seen = time.monotonic()
            self.active_commands = max(0, self.active_commands - 1)

    def should_timeout(self) -> bool:
        with self.lock:
            return (
                not self.exiting
                and self.active_commands == 0
                and time.monotonic() - self.last_seen > HEARTBEAT_TIMEOUT_SECONDS
            )

    def add_exit_callback(self, callback: Callable[[], None]) -> None:
        with self.lock:
            self.exit_callbacks.append(callback)

    def schedule_exit(self, delay: float = 1.2) -> None:
        with self.lock:
            if self.exiting:
                return
            self.exiting = True
            callbacks = list(self.exit_callbacks)

        def close_server() -> None:
            time.sleep(delay)
            for callback in callbacks:
                try:
                    callback()
                except Exception as error:
                    print(f"Exit callback failed: {type(error).__name__}: {error}", file=sys.stderr)
            if self.server:
                self.server.shutdown()

        threading.Thread(target=close_server, daemon=True).start()


def make_handler(state: ServerState, backend: LauncherBackend) -> type[BaseHTTPRequestHandler]:
    class LauncherRequestHandler(BaseHTTPRequestHandler):
        server_version = "Z3RLauncherPython/1.0"

        def log_message(self, format: str, *args: Any) -> None:
            return

        def do_GET(self) -> None:
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path == "/api/ping":
                self.handle_ping()
                return
            self.serve_static(parsed)

        def do_POST(self) -> None:
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path == "/api/invoke":
                self.handle_invoke()
                return
            if parsed.path == "/api/ping":
                self.handle_ping()
                return
            if parsed.path == "/api/shutdown":
                self.handle_shutdown()
                return
            self.write_json({"error": "Not found."}, status=HTTPStatus.NOT_FOUND)

        def handle_ping(self) -> None:
            if not self.authorized():
                self.write_json({"error": "Unauthorized."}, status=HTTPStatus.FORBIDDEN)
                return
            state.touch()
            self.write_json({"ok": True})

        def handle_shutdown(self) -> None:
            if not self.authorized():
                self.write_json({"error": "Unauthorized."}, status=HTTPStatus.FORBIDDEN)
                return
            state.touch()
            state.schedule_exit(delay=0.2)
            self.write_json({"ok": True})

        def handle_invoke(self) -> None:
            if not self.authorized():
                self.write_json({"error": "Unauthorized."}, status=HTTPStatus.FORBIDDEN)
                return

            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                self.write_json({"error": "Invalid request length."}, status=HTTPStatus.BAD_REQUEST)
                return

            if length < 0 or length > MAX_REQUEST_BYTES:
                self.write_json({"error": "Request body is too large."}, status=HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
                return

            try:
                body = self.rfile.read(length)
                request = json.loads(body.decode("utf-8"))
                command = request["command"]
                payload = request.get("payload") or {}
                if not isinstance(command, str) or not isinstance(payload, dict):
                    raise ValueError("Invalid command payload.")
            except (KeyError, ValueError, json.JSONDecodeError, UnicodeDecodeError) as error:
                self.write_json({"error": f"Invalid invoke request: {error}"}, status=HTTPStatus.BAD_REQUEST)
                return

            state.begin_command()
            try:
                result = backend.invoke(command, payload)
            except LauncherError as error:
                self.write_json({"error": str(error)}, status=HTTPStatus.BAD_REQUEST)
            except Exception as error:
                self.write_json({"error": f"{type(error).__name__}: {error}"}, status=HTTPStatus.INTERNAL_SERVER_ERROR)
            else:
                self.write_json({"result": result})
            finally:
                state.end_command()

        def serve_static(self, parsed: urllib.parse.ParseResult) -> None:
            if parsed.path in ("", "/"):
                path = static_dir() / "index.html"
            else:
                relative = urllib.parse.unquote(parsed.path).lstrip("/")
                path = static_dir() / relative

            try:
                root = static_dir().resolve()
                resolved = path.resolve()
                resolved.relative_to(root)
            except (OSError, ValueError):
                self.send_error(HTTPStatus.NOT_FOUND)
                return

            if not resolved.is_file():
                self.send_error(HTTPStatus.NOT_FOUND)
                return

            state.touch()
            content_type = mimetypes.guess_type(str(resolved))[0] or "application/octet-stream"
            try:
                data = resolved.read_bytes()
            except OSError:
                self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR)
                return

            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def authorized(self) -> bool:
            return self.headers.get("X-Z3R-Launcher-Token") == state.token

        def write_json(self, value: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
            data = json.dumps(value).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

    return LauncherRequestHandler


def start_timeout_monitor(state: ServerState) -> None:
    def monitor() -> None:
        while True:
            time.sleep(5)
            if state.should_timeout():
                state.schedule_exit(delay=0)
                return

    threading.Thread(target=monitor, daemon=True).start()


def truthy_env(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


def should_require_webview() -> bool:
    # Frozen PyInstaller builds are release packages, so they must stay in the standalone app window path.
    return bool(getattr(sys, "frozen", False)) or truthy_env("Z3R_LAUNCHER_REQUIRE_WEBVIEW")


def should_use_webview() -> bool:
    if should_require_webview():
        return True
    return not truthy_env("Z3R_LAUNCHER_NO_WEBVIEW")


def selected_webview_gui() -> str:
    # Prefer the launcher-specific variable because wrappers use it to document intentional backend selection.
    gui = os.environ.get("Z3R_LAUNCHER_WEBVIEW_GUI", "").strip().lower()
    if gui:
        return gui
    return os.environ.get("PYWEBVIEW_GUI", "").strip().lower()


def should_require_linux_gtk_webview() -> bool:
    # Linux release packages rely on GTK/WebKitGTK so they avoid QtWebEngine graphics initialization failures.
    return should_require_webview() and sys.platform.startswith("linux")


def prepend_existing_env_paths(name: str, candidates: list[Path]) -> None:
    """Prepend existing directories to a path-like environment variable without duplicating entries."""
    existing = [value for value in os.environ.get(name, "").split(os.pathsep) if value]
    additions: list[str] = []
    for candidate in candidates:
        if candidate.is_dir():
            value = str(candidate)
            if value not in existing and value not in additions:
                additions.append(value)
    if additions:
        os.environ[name] = os.pathsep.join(additions + existing)


def linux_girepository_candidates() -> list[Path]:
    """Return AppImage and PyInstaller locations that can contain bundled GObject typelibs."""
    candidates: list[Path] = []
    meipass = getattr(sys, "_MEIPASS", "")
    if meipass:
        base = Path(meipass)
        candidates.append(base / GIREPOSITORY_DIR)
        candidates.append(base / "usr" / "lib" / GIREPOSITORY_DIR)
        candidates.extend((base / "usr" / "lib").glob(f"*/{GIREPOSITORY_DIR}"))

    appdir = os.environ.get("APPDIR", "")
    if appdir:
        base = Path(appdir)
        candidates.append(base / "usr" / "lib" / GIREPOSITORY_DIR)
        candidates.extend((base / "usr" / "lib").glob(f"*/{GIREPOSITORY_DIR}"))

    return candidates


def prepare_linux_gtk_typelib_paths() -> None:
    """Expose bundled Linux GTK/WebKitGTK typelibs before pywebview imports its GTK backend."""
    if should_require_linux_gtk_webview():
        prepend_existing_env_paths("GI_TYPELIB_PATH", linux_girepository_candidates())


def require_linux_gtk_backend() -> None:
    if not should_require_linux_gtk_webview():
        return

    gui = selected_webview_gui() or GTK_WEBVIEW_GUI
    if gui != GTK_WEBVIEW_GUI:
        raise LauncherError("Packaged Linux releases require the GTK pywebview backend; Qt is disabled.")

    prepare_linux_gtk_typelib_paths()
    try:
        importlib.import_module(GTK_WEBVIEW_MODULE)
    except Exception as error:
        message = (
            "Packaged Linux releases require bundled PyGObject, GTK, and WebKitGTK. "
            f"The GTK pywebview backend could not be imported: {type(error).__name__}: {error}"
        )
        raise LauncherError(message) from error


def serve_until_shutdown(server: ThreadingHTTPServer) -> None:
    try:
        server.serve_forever()
    finally:
        server.server_close()


def start_server_thread(server: ThreadingHTTPServer) -> threading.Thread:
    thread = threading.Thread(target=serve_until_shutdown, args=(server,), daemon=False)
    thread.start()
    return thread


def import_webview() -> Any:
    prepare_linux_gtk_typelib_paths()
    try:
        import webview
    except ImportError as error:
        if should_require_webview():
            raise LauncherError("pywebview is required for packaged Z3R Launcher releases.") from error
        message = "pywebview is not installed. Install pywebview to use the standalone launcher window."
        raise LauncherError(message) from error
    return webview


def webview_start_options() -> dict[str, Any]:
    options: dict[str, Any] = {"debug": truthy_env("Z3R_LAUNCHER_WEBVIEW_DEBUG")}
    gui = selected_webview_gui()
    if should_require_linux_gtk_webview() and not gui:
        gui = GTK_WEBVIEW_GUI
    if gui:
        options["gui"] = gui
    return options


def open_webview_window(url: str, state: ServerState) -> None:
    webview = import_webview()
    require_linux_gtk_backend()
    storage = app_data_dir() / "webview"
    storage.mkdir(parents=True, exist_ok=True)
    window = webview.create_window(
        "Z3R Launcher",
        url,
        width=1280,
        height=820,
        min_size=(960, 640),
    )
    state.add_exit_callback(window.destroy)
    webview.start(storage_path=str(storage), private_mode=False, **webview_start_options())


def report_browser_disabled(url: str) -> None:
    print("Z3R Launcher requires the standalone pywebview app window.", file=sys.stderr)
    print("Opening the launcher in the user's browser is disabled.", file=sys.stderr)
    print(f"The internal server was prepared at {url} but was not opened externally.", file=sys.stderr)


def main() -> None:
    token = secrets.token_urlsafe(32)
    state = ServerState(token)
    backend = LauncherBackend(schedule_exit=state.schedule_exit)
    handler = make_handler(state, backend)
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    state.server = server
    start_timeout_monitor(state)
    host, port = server.server_address
    url = f"http://{host}:{port}/?token={urllib.parse.quote(token)}"

    if not should_use_webview():
        report_browser_disabled(url)
        server.server_close()
        return

    server_thread = start_server_thread(server)
    try:
        open_webview_window(url, state)
    except Exception as error:
        print(f"Could not open native app window: {type(error).__name__}: {error}", file=sys.stderr)
        report_browser_disabled(url)
        state.schedule_exit(delay=0)
        server_thread.join()
        return
    state.schedule_exit(delay=0)
    server_thread.join()


if __name__ == "__main__":
    main()
