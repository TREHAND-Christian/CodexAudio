from __future__ import annotations

import asyncio
import json
import re
import sys
import threading
import time
import html
import textwrap
import os
import ctypes
from ctypes import wintypes
from pathlib import Path
from urllib.parse import quote as _url_quote, unquote as _url_unquote
from dataclasses import dataclass
from queue import Queue, Empty
from typing import Any, Optional


def _force_utf8_stdio() -> None:
    try:
        if hasattr(sys.stdin, "reconfigure"):
            sys.stdin.reconfigure(encoding="utf-8", errors="replace")
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        if hasattr(sys.stderr, "reconfigure"):
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


_force_utf8_stdio()

try:
    from langdetect import detect as _detect_lang
except Exception:  # pragma: no cover
    _detect_lang = None

try:
    from googletrans import Translator
except Exception:  # pragma: no cover
    Translator = None

try:
    import markdown as md
except Exception:  # pragma: no cover
    md = None

try:
    from pygments import highlight
    from pygments.lexers import get_lexer_by_name, TextLexer, guess_lexer
    from pygments.formatters import HtmlFormatter
except Exception:  # pragma: no cover
    highlight = None
    get_lexer_by_name = None
    TextLexer = None
    guess_lexer = None
    HtmlFormatter = None

try:
    from PySide6.QtCore import Qt, QTimer, QEvent
    from PySide6.QtGui import QDesktopServices
    from PySide6.QtGui import QColor, QPainter, QPainterPath, QIcon
    from PySide6.QtWidgets import (
        QApplication,
        QWidget,
        QHBoxLayout,
        QPushButton,
        QTextBrowser,
        QVBoxLayout,
        QAbstractButton,
    )
except Exception:  # pragma: no cover
    Qt = None
    QTimer = None
    QEvent = None
    QDesktopServices = None
    QColor = None
    QPainter = None
    QPainterPath = None
    QIcon = None
    QApplication = None
    QWidget = None
    QHBoxLayout = None
    QPushButton = None
    QTextBrowser = None
    QVBoxLayout = None
    QAbstractButton = None

# WinRT (Windows OneCore voices)
try:
    from winsdk.windows.media.speechsynthesis import SpeechSynthesizer
    import winsdk.windows.media.core as media_core
    import winsdk.windows.media.playback as media_playback
except Exception:  # pragma: no cover
    SpeechSynthesizer = None
    media_core = None
    media_playback = None

try:
    from PySide6.QtWebEngineWidgets import QWebEngineView
except Exception:  # pragma: no cover
    QWebEngineView = None

try:
    from PySide6.QtWebEngineCore import QWebEnginePage
except Exception:  # pragma: no cover
    QWebEnginePage = None


def _write(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _event(evt: dict) -> None:
    _write({"type": "event", "event": evt})


def _response(req_id: str, ok: bool, result: Any = None, error: str = "") -> None:
    if ok:
        _write({"id": req_id, "ok": True, "result": result})
    else:
        _write({"id": req_id, "ok": False, "error": error})


def _clamp(n: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, n))

def _slider_to_speaking_rate(slider: float) -> float:
    """
    Aligne la conversion avec l'app:
    - slider 0.0..1.0 => speaking_rate 0.5..1.0
    - slider 1.0..2.0 => speaking_rate 1.0..2.0
    """
    r = _clamp(float(slider), 0.0, 2.0)
    if r <= 1.0:
        return 0.5 + 0.5 * r
    return 1.0 + (r - 1.0) * 1.0


def _detect(text: str) -> str:
    if not text.strip() or _detect_lang is None:
        return "?"
    try:
        return str(_detect_lang(text[:1000]) or "?")
    except Exception:
        return "?"


def _target_label(code: str) -> str:
    c = (code or "").lower().split("-")[0]
    return {
        "fr": "Français",
        "en": "English",
        "de": "Deutsch",
        "es": "Español",
        "it": "Italiano",
        "pt": "Português",
        "nl": "Nederlands",
        "ru": "Русский",
        "ja": "日本語",
        "zh": "中文",
        "ar": "العربية",
    }.get(c, c or "?")


def _normalize_tts_text(text: str) -> str:
    if not text:
        return ""
    s = text
    s = re.sub(r"```.*?```", " ", s, flags=re.S)
    s = re.sub(r"`([^`\n]+)`", r"\1", s)
    s = re.sub(r"<[^>]+>", " ", s)
    # Strip Markdown emphasis markers for TTS only.
    s = re.sub(r"\*\*(.+?)\*\*", r"\1", s)
    s = re.sub(r"__(.+?)__", r"\1", s)
    s = re.sub(r"(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)", r"\1", s)
    s = re.sub(r"(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)", r"\1", s)
    # Replace file paths with basename so spoken text aligns with UI (file links show only filenames).
    try:
        path_re = re.compile(
            r"([A-Za-z]:\\[^\s<>\"']+\.[A-Za-z0-9]+|\\{2}[^\\\s<>\"']+\\[^\s<>\"']+\.[A-Za-z0-9]+|(?:\./|\.\./)[^\s<>\"']+\.[A-Za-z0-9]+|[^\s<>\"']+[\\/][^\s<>\"']+\.[A-Za-z0-9]+)"
        )

        def repl(m: re.Match) -> str:
            raw = m.group(1) or ""
            try:
                return Path(raw).name or raw
            except Exception:
                return raw

        s = path_re.sub(repl, s)
    except Exception:
        pass
    s = re.sub(r"\s{2,}", " ", s)
    return s.strip()


def _split_sentences(text: str) -> list[str]:
    if not text:
        return []
    s = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    out: list[str] = []
    buf: list[str] = []
    n = len(s)
    i = 0

    def flush():
        seg = "".join(buf).strip()
        buf.clear()
        if seg:
            out.append(seg)

    while i < n:
        ch = s[i]

        if ch == "\n":
            flush()
            while i < n and s[i] == "\n":
                i += 1
            continue

        if ch in ".!?":
            prev = s[i - 1] if i > 0 else ""
            nxt = s[i + 1] if i + 1 < n else ""
            if ch == "." and prev.isdigit() and nxt.isdigit():
                buf.append(ch)
                i += 1
                continue
            if nxt and (not nxt.isspace()) and nxt != "\n":
                buf.append(ch)
                i += 1
                continue

            j = i
            while j + 1 < n and s[j + 1] in ".!?":
                j += 1
            buf.extend(s[i : j + 1])
            i = j + 1
            flush()
            while i < n and s[i].isspace() and s[i] != "\n":
                i += 1
            continue

        buf.append(ch)
        i += 1

    flush()
    return out


def _escape_html(text: str) -> str:
    return (
        (text or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def _safe_log(msg: str) -> None:
    try:
        _event({"type": "log", "message": msg})
    except Exception:
        pass


def _state_path() -> Path:
    appdata = os.environ.get("APPDATA")
    if appdata:
        base = Path(appdata)
    else:
        base = Path.home() / "AppData" / "Roaming"
    return base / "CodexAudio" / "state.json"


def _read_state() -> dict:
    try:
        path = _state_path()
        if not path.exists():
            return {}
        return json.loads(path.read_text(encoding="utf-8")) or {}
    except Exception:
        return {}


def _write_state(data: dict) -> None:
    try:
        path = _state_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


def _update_window_state(key: str, values: dict) -> None:
    data = _read_state()
    windows = data.get("windows") if isinstance(data.get("windows"), dict) else {}
    cur = windows.get(key) if isinstance(windows.get(key), dict) else {}
    cur.update(values)
    windows[key] = cur
    data["windows"] = windows
    _write_state(data)


def _escape_ssml(text: str) -> str:
    return (
        (text or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


def _is_rdp_foreground() -> bool:
    if sys.platform != "win32":
        return False
    try:
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    except Exception:
        return False

    try:
        hwnd = user32.GetForegroundWindow()
        if not hwnd:
            return False

        class_buf = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, class_buf, 256)
        class_name = class_buf.value or ""
        if "TscShellContainerClass" in class_name:
            return True

        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if not pid.value:
            return False

        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        hproc = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
        if not hproc:
            return False
        try:
            buf_len = wintypes.DWORD(512)
            buf = ctypes.create_unicode_buffer(512)
            if kernel32.QueryFullProcessImageNameW(hproc, 0, buf, ctypes.byref(buf_len)):
                name = os.path.basename(buf.value).lower()
                if name in {"mstsc.exe", "msrdc.exe", "remotedesktop.exe"}:
                    return True
        finally:
            kernel32.CloseHandle(hproc)
    except Exception:
        return False

    return False


class TTSEngine:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._stop_flag = False
        self._pause_flag = False
        self._resume_pending = False
        self._restart_pending = False
        self._player: Optional[object] = None
        self._stream: Optional[object] = None
        self._queue: list[str] = []
        self._queue_index = 0
        self._cfg: dict[str, Any] = {}
        self._next_queue: list[str] = []
        self._next_cfg: dict[str, Any] = {}
        self._on_sentence = None
        self._on_started = None
        self._on_finished = None

    def set_callbacks(self, on_sentence=None, on_started=None, on_finished=None) -> None:
        self._on_sentence = on_sentence
        self._on_started = on_started
        self._on_finished = on_finished

    def list_voices(self) -> list[dict[str, Any]]:
        voices: list[dict[str, Any]] = []
        if SpeechSynthesizer is None:
            return voices
        try:
            for v in SpeechSynthesizer.all_voices:
                display = getattr(v, "display_name", "") or ""
                lang = getattr(v, "language", "") or ""
                if display:
                    name = display
                    if name.lower().startswith("microsoft "):
                        name = name[len("Microsoft ") :]
                    voices.append(
                        {
                            "engine": "winrt",
                            "id": f"winrt:{display}",
                            "name": name,
                            "languages": [lang.lower()] if lang else [],
                        }
                    )
        except Exception:
            pass
        return voices

    def list_available_languages(self) -> list[str]:
        if SpeechSynthesizer is None:
            return []
        langs: list[str] = []
        try:
            for v in SpeechSynthesizer.all_voices:
                lang = getattr(v, "language", "") or ""
                if lang:
                    langs.append(lang.lower())
        except Exception:
            pass
        return sorted(set(langs))

    def pick_voice_for_lang(self, lang: str) -> str:
        code = (lang or "").lower()
        voices = self.list_voices()
        voices.sort(key=lambda x: x.get("name", ""))
        for v in voices:
            for l in (v.get("languages") or []):
                if isinstance(l, str) and l.lower().startswith(code):
                    return str(v.get("id") or "")
        return str(voices[0]["id"]) if voices else ""

    def voice_matches_lang(self, voice_id: str, lang: str) -> bool:
        vid = str(voice_id or "").strip()
        code = str(lang or "").strip().lower()
        if not vid or not code:
            return False
        for v in self.list_voices():
            if str(v.get("id") or "") != vid:
                continue
            for l in (v.get("languages") or []):
                if isinstance(l, str) and l.lower().startswith(code):
                    return True
            return False
        return False

    def stop(self) -> None:
        with self._lock:
            self._stop_flag = True
            self._pause_flag = False
            self._resume_pending = False
            self._restart_pending = False
            self._next_queue = []
            self._next_cfg = {}
            t = self._thread
            if t is not None and t.is_alive():
                return
            self._queue = []
            self._queue_index = 0

    def pause(self) -> None:
        with self._lock:
            self._pause_flag = True
            self._stop_flag = True
            self._restart_pending = False
            self._next_queue = []
            self._next_cfg = {}

    def resume(self) -> None:
        t = self._thread
        if t is not None and t.is_alive():
            with self._lock:
                self._resume_pending = True
            return
        with self._lock:
            if not self._pause_flag:
                return
            self._pause_flag = False
        if self._queue:
            self._start_queue(self._cfg)

    def speak_queue(self, queue: list[str], cfg: dict[str, Any]) -> None:
        if not queue:
            return
        with self._lock:
            self._pause_flag = False
            t = self._thread
            if t is not None and t.is_alive():
                self._stop_flag = True
                self._restart_pending = True
                self._next_queue = list(queue)
                self._next_cfg = dict(cfg or {})
                _event({"type": "log", "message": "tts_restart_pending"})
                return
            self._queue = list(queue)
            self._queue_index = 0
            self._cfg = dict(cfg or {})
            self._stop_flag = False
            self._restart_pending = False
            self._next_queue = []
            self._next_cfg = {}
        self._start_queue(self._cfg)

    def _start_queue(self, cfg: dict[str, Any]) -> None:
        if SpeechSynthesizer is None or media_core is None or media_playback is None:
            _event({"type": "error", "message": "WinRT indisponible sur ce poste."})
            return
        t = self._thread
        if t is not None and t.is_alive():
            return

        voice_id = str(cfg.get("voice_id") or "")
        voice_display = voice_id[len("winrt:") :] if voice_id.startswith("winrt:") else ""

        async def run_sequence() -> bool:
            completed = True
            for i in range(self._queue_index, len(self._queue)):
                with self._lock:
                    if self._stop_flag or self._pause_flag:
                        completed = False
                        break
                    self._queue_index = i
                _safe_log(f"[tts] sentence event idx={i} len={len(self._queue[i] or '')}")
                try:
                    await self._winrt_speak_async(self._queue[i], voice_display, cfg)
                except Exception as e:
                    _event({"type": "error", "message": str(e)})
                with self._lock:
                    if self._stop_flag or self._pause_flag:
                        completed = False
                        break
            return completed

        def run() -> None:
            try:
                if self._on_started:
                    try:
                        self._on_started()
                    except Exception:
                        pass
                _event({"type": "started"})
                completed = asyncio.run(run_sequence())
            except Exception as e:
                _event({"type": "error", "message": str(e)})
                completed = False
            finally:
                resume = False
                restart = False
                with self._lock:
                    self._player = None
                    self._stream = None
                    self._thread = None
                    if self._pause_flag:
                        self._stop_flag = False
                    elif self._restart_pending and bool(self._next_queue):
                        self._restart_pending = False
                        self._stop_flag = False
                        self._pause_flag = False
                        self._queue = self._next_queue
                        self._queue_index = 0
                        self._cfg = self._next_cfg
                        self._next_queue = []
                        self._next_cfg = {}
                        restart = True
                    elif self._stop_flag:
                        self._stop_flag = False
                        self._queue = []
                        self._queue_index = 0
                        self._next_queue = []
                        self._next_cfg = {}
                    elif completed:
                        self._queue = []
                        self._queue_index = 0
                        self._next_queue = []
                        self._next_cfg = {}

                    resume = self._resume_pending and bool(self._queue)
                    if resume:
                        self._resume_pending = False
                        self._pause_flag = False
                if self._on_finished:
                    try:
                        self._on_finished()
                    except Exception:
                        pass
                _event({"type": "finished"})
                if resume or restart:
                    self._start_queue(self._cfg)

        self._thread = threading.Thread(target=run, daemon=True)
        self._thread.start()

    async def _winrt_speak_async(self, text: str, voice_display: str, cfg: dict[str, Any]) -> None:
        text = (text or "").strip()
        if not text:
            return

        rate = float(cfg.get("rate") or 1.0)
        rate = _clamp(rate, 0.5, 2.0)
        volume = float(cfg.get("volume") or 80.0)
        volume = _clamp(volume, 0.0, 100.0)

        synth = SpeechSynthesizer()
        voice_lang = "fr-FR"
        if voice_display:
            try:
                for v in SpeechSynthesizer.all_voices:
                    if (getattr(v, "display_name", "") or "") == voice_display:
                        synth.voice = v
                        voice_lang = getattr(v, "language", "") or voice_lang
                        break
            except Exception:
                pass

        try:
            if hasattr(synth, "options") and hasattr(synth.options, "speaking_rate"):
                synth.options.speaking_rate = _slider_to_speaking_rate(rate)
        except Exception:
            pass

        ssml = (
            f'<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" '
            f'xml:lang="{voice_lang}">'
            f"{_escape_ssml(text)}"
            "</speak>"
        )

        stream = await synth.synthesize_ssml_to_stream_async(ssml)

        player = media_playback.MediaPlayer()
        player.source = media_core.MediaSource.create_from_stream(stream, stream.content_type)
        player.volume = volume / 100.0
        with self._lock:
            self._player = player
            self._stream = stream

        try:
            player.play()
        except Exception:
            return

        State = media_playback.MediaPlaybackState
        ST_PLAYING = getattr(State, "PLAYING", None) or getattr(State, "Playing", None)
        ST_PAUSED = getattr(State, "PAUSED", None) or getattr(State, "Paused", None)
        ST_STOPPED = getattr(State, "STOPPED", None) or getattr(State, "Stopped", None)
        ST_NONE = getattr(State, "NONE", None) or getattr(State, "None", None)

        started = False
        t0 = time.time()
        max_sec = 15 + (len(text) * 0.08)
        max_sec = min(max_sec, 180.0)

        while True:
            with self._lock:
                if self._stop_flag or self._pause_flag:
                    break

            if (time.time() - t0) > max_sec:
                break

            try:
                st = player.playback_session.playback_state
            except Exception:
                break

            if ST_PLAYING is not None and st == ST_PLAYING:
                started = True

            if started:
                if ST_STOPPED is not None and st == ST_STOPPED:
                    break
                if ST_PAUSED is not None and st == ST_PAUSED:
                    break
                if ST_NONE is not None and st == ST_NONE:
                    break

            await asyncio.sleep(0.05)

        try:
            player.pause()
        except Exception:
            pass
        try:
            player.source = None
        except Exception:
            pass


@dataclass
class ProcessResult:
    display_text: str
    detected_lang: str
    effective_lang: str
    voice_id: str
    label: str
    queue: list[str]


class Processor:
    def __init__(self, tts: TTSEngine) -> None:
        self.tts = tts
        self.translator = Translator() if Translator is not None else None

    def process(self, text: str, target_lang: str, translate_enabled: bool, voice_id: str, tts_lang: str = "") -> ProcessResult:
        raw = (text or "").strip()
        detected = _detect(raw)
        if translate_enabled and self.translator is not None:
            display = self._translate(raw, target_lang)
            effective = (target_lang or "fr").lower()
        else:
            display = raw
            effective = detected if detected and detected != "?" else (target_lang or "fr").lower()

        display_norm = display.strip()
        spoken = _normalize_tts_text(display_norm)

        tts_base = (tts_lang or "").lower().split("-")[0]
        if not tts_base:
            tts_base = effective.split("-")[0]

        chosen = voice_id or ""
        if not chosen or not self.tts.voice_matches_lang(chosen, tts_base):
            chosen = self.tts.pick_voice_for_lang(tts_base)
        label = _target_label((target_lang or effective).lower())
        queue = _split_sentences(spoken)
        if not queue and spoken:
            queue = [spoken]
        return ProcessResult(
            display_text=display_norm,
            detected_lang=detected,
            effective_lang=effective,
            voice_id=chosen,
            label=label,
            queue=queue,
        )

    def _translate(self, text: str, target_lang: str) -> str:
        if not text.strip() or self.translator is None:
            return text
        dest = (target_lang or "fr").lower()
        try:
            masked, mapping = self._mask_code(text)
            tr = self.translator.translate(masked, dest=dest)
            out = tr.text or masked
            return self._unmask_code(out, mapping)
        except Exception:
            return text

    def _mask_code(self, text: str) -> tuple[str, list[tuple[str, str]]]:
        mapping: list[tuple[str, str]] = []

        def mask(pattern: str, src: str, prefix: str) -> str:
            idx = 0

            def repl(m):
                nonlocal idx
                token = f"<<<{prefix}{idx}>>>"
                mapping.append((token, m.group(0)))
                idx += 1
                return token

            return re.sub(pattern, repl, src, flags=re.S)

        masked = mask(r"```.*?```", text, "CODEBLOCK")
        masked = mask(r"`[^`\n]+`", masked, "INLINE")
        return masked, mapping

    def _unmask_code(self, text: str, mapping: list[tuple[str, str]]) -> str:
        out = text
        for token, original in mapping:
            out = out.replace(token, original)
        return out


class _ChatWebPage(QWebEnginePage if QWebEnginePage is not None else object):
    def __init__(self, on_open_file, parent=None) -> None:
        if QWebEnginePage is not None:
            super().__init__(parent)
        self._on_open_file = on_open_file

    # PySide signature: acceptNavigationRequest(self, url: QUrl, type: NavigationType, isMainFrame: bool) -> bool
    def acceptNavigationRequest(self, url, nav_type, is_main_frame):  # type: ignore[override]
        try:
            s = url.toString()
        except Exception:
            return True
        if s.startswith("codexaudio://open-file?path="):
            try:
                raw = s.split("codexaudio://open-file?path=", 1)[1]
                path = _url_unquote(raw)
            except Exception:
                path = ""
            if path and self._on_open_file:
                try:
                    self._on_open_file(path)
                except Exception:
                    pass
            return False
        return True


class TranslationWindow(QWidget):
    def __init__(self, on_ui_cmd=None, on_focus=None):
        super().__init__()
        self.setWindowTitle("Fenêtre texte")
        self.setWindowFlag(Qt.Window, True)
        self.setWindowFlag(Qt.WindowMinMaxButtonsHint, True)
        self.setWindowFlag(Qt.WindowCloseButtonHint, True)
        self.setAttribute(Qt.WA_QuitOnClose, False)
        self.setMinimumSize(260, 260)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)

        self._chat_css = self._load_chat_css()
        self._last_text = ""
        self._last_label = ""
        self._queue: list[str] = []
        self._web_ready = False
        self._on_ui_cmd = on_ui_cmd
        self._on_focus = on_focus

        if QWebEngineView is not None:
            self.browser = QWebEngineView()
            if QWebEnginePage is not None:
                try:
                    self.browser.setPage(
                        _ChatWebPage(
                            on_open_file=lambda p: self._emit_open_file(p),
                            parent=self.browser,
                        )
                    )
                except Exception:
                    pass
            try:
                self.browser.loadFinished.connect(self._on_web_load_finished)
            except Exception:
                pass
        else:
            self.browser = QTextBrowser()
            self.browser.setOpenExternalLinks(False)
            self.browser.setStyleSheet("background-color:#1e1e1e;color:#d4d4d4;border:none;")
            try:
                self.browser.anchorClicked.connect(self._on_textbrowser_anchor_clicked)
            except Exception:
                pass

        layout.addWidget(self.browser)
        self._restore_window_state()

    def ensure_on_top(self, activate: bool = False) -> None:
        try:
            self.show()
            self.raise_()
            if activate:
                self.activateWindow()
        except Exception:
            pass

    def _notify_focus(self) -> None:
        if not self._on_focus:
            return
        try:
            self._on_focus()
        except Exception:
            pass

    def set_focus_callback(self, on_focus) -> None:
        self._on_focus = on_focus

    def focusInEvent(self, event) -> None:  # type: ignore[override]
        self._notify_focus()
        super().focusInEvent(event)

    def changeEvent(self, event) -> None:  # type: ignore[override]
        if QEvent is not None and event.type() == QEvent.ActivationChange:
            try:
                if self.isActiveWindow():
                    self._notify_focus()
            except Exception:
                pass
        super().changeEvent(event)

    def _on_textbrowser_anchor_clicked(self, url) -> None:
        try:
            s = url.toString()
        except Exception:
            return
        if s.startswith("codexaudio://open-file?path="):
            try:
                raw = s.split("codexaudio://open-file?path=", 1)[1]
                path = _url_unquote(raw)
            except Exception:
                path = ""
            if path:
                self._emit_open_file(path)
            return
        if QDesktopServices is not None:
            try:
                QDesktopServices.openUrl(url)
            except Exception:
                pass

    def _emit_open_file(self, path: str) -> None:
        if not self._on_ui_cmd:
            return
        try:
            self._on_ui_cmd("openFile", path=path)
        except Exception:
            pass

    def set_translation(self, text: str, label: str, queue: list[str]) -> None:
        self._last_text = text or ""
        self._last_label = label or ""
        self._queue = list(queue or [])
        title = f"Fenêtre texte - {label}" if label else "Fenêtre texte"
        self.setWindowTitle(title)
        self._render()

    def moveEvent(self, event) -> None:  # type: ignore[override]
        try:
            _update_window_state(
                "translation",
                {
                    "x": int(self.x()),
                    "y": int(self.y()),
                    "w": int(self.width()),
                    "h": int(self.height()),
                    "visible": bool(self.isVisible()),
                },
            )
        except Exception:
            pass
        super().moveEvent(event)

    def resizeEvent(self, event) -> None:  # type: ignore[override]
        try:
            _update_window_state(
                "translation",
                {
                    "x": int(self.x()),
                    "y": int(self.y()),
                    "w": int(self.width()),
                    "h": int(self.height()),
                    "visible": bool(self.isVisible()),
                },
            )
        except Exception:
            pass
        super().resizeEvent(event)

    def showEvent(self, event) -> None:  # type: ignore[override]
        # Keep on top without stealing focus.
        self.ensure_on_top(activate=False)
        try:
            _update_window_state("translation", {"visible": True})
        except Exception:
            pass
        super().showEvent(event)

    def hideEvent(self, event) -> None:  # type: ignore[override]
        try:
            _update_window_state("translation", {"visible": False})
        except Exception:
            pass
        super().hideEvent(event)

    def _restore_window_state(self) -> None:
        data = _read_state()
        windows = data.get("windows") if isinstance(data.get("windows"), dict) else {}
        st = windows.get("translation") if isinstance(windows.get("translation"), dict) else {}
        try:
            x = int(st.get("x")) if st.get("x") is not None else None
            y = int(st.get("y")) if st.get("y") is not None else None
            w = int(st.get("w")) if st.get("w") is not None else None
            h = int(st.get("h")) if st.get("h") is not None else None
            if w and h:
                self.resize(max(self.minimumWidth(), w), max(self.minimumHeight(), h))
            if x is not None and y is not None:
                self.move(x, y)
        except Exception:
            pass
    def _on_web_load_finished(self, ok: bool) -> None:
        self._web_ready = bool(ok)

    def _load_chat_css(self) -> str:
        try:
            path = Path(__file__).with_name("translation_chat.css")
            return path.read_text(encoding="utf-8")
        except Exception:
            return ""

    def _wrap_html(self, html_fragment: str) -> str:
        css = self._chat_css or ""
        script = (
            "<script>"
            "function copyCode(btn){"
            "var host=btn.closest('.chat-code-block');"
            "if(!host){return;}"
            "var code=host.querySelector('.chat-code-body code');"
            "if(!code){return;}"
            "var text=code.innerText||code.textContent||'';"
            "if(navigator&&navigator.clipboard&&navigator.clipboard.writeText){"
            "navigator.clipboard.writeText(text);"
            "}else{"
            "var ta=document.createElement('textarea');"
            "ta.value=text;document.body.appendChild(ta);"
            "ta.select();document.execCommand('copy');"
            "document.body.removeChild(ta);"
            "}"
            "btn.classList.add('copied');"
            "setTimeout(function(){btn.classList.remove('copied');},1200);"
            "}"
            "</script>"
        )
        return (
            "<!doctype html>"
            "<html><head><meta charset=\"utf-8\">"
            f"<style>{css}</style>{script}"
            "</head><body class=\"chat-body\">"
            "<div class=\"chat-root\">"
            "<div class=\"chat-message\">"
            f"{html_fragment}"
            "</div></div></body></html>"
        )

    def _to_html(self, text: str) -> str:
        if not text:
            return ""
        if md is None:
            return self._simple_markdown_to_html(text)
        try:
            return md.markdown(
                text,
                extensions=["fenced_code", "tables", "sane_lists", "nl2br"],
                output_format="html5",
            )
        except Exception:
            return self._simple_markdown_to_html(text)

    def _simple_markdown_to_html(self, text: str) -> str:
        lines = (text or "").splitlines()
        html_lines: list[str] = []
        in_code = False
        in_ul = False
        in_ol = False

        def close_lists() -> None:
            nonlocal in_ul, in_ol
            if in_ul:
                html_lines.append("</ul>")
                in_ul = False
            if in_ol:
                html_lines.append("</ol>")
                in_ol = False

        for raw in lines:
            line = raw.rstrip("\r\n")
            if line.strip().startswith("```"):
                close_lists()
                if in_code:
                    html_lines.append("</code></pre>")
                    in_code = False
                else:
                    html_lines.append("<pre><code>")
                    in_code = True
                continue

            if in_code:
                html_lines.append(html.escape(line) + "\n")
                continue

            if not line.strip():
                close_lists()
                continue

            m_ul = re.match(r"^\s*([-*•]|[–—])\s+(.*)$", line)
            m_ol = re.match(r"^\s*\d+\.\s+(.*)$", line)
            if m_ul:
                if in_ol:
                    html_lines.append("</ol>")
                    in_ol = False
                if not in_ul:
                    html_lines.append("<ul>")
                    in_ul = True
                html_lines.append(f"<li>{self._inline_code(m_ul.group(2))}</li>")
                continue
            if m_ol:
                if in_ul:
                    html_lines.append("</ul>")
                    in_ul = False
                if not in_ol:
                    html_lines.append("<ol>")
                    in_ol = True
                html_lines.append(f"<li>{self._inline_code(m_ol.group(1))}</li>")
                continue

            close_lists()
            html_lines.append(f"<p>{self._inline_code(line)}</p>")

        if in_code:
            html_lines.append("</code></pre>")
        close_lists()
        return "\n".join(html_lines)

    def _inline_code(self, text: str) -> str:
        def repl(m):
            return f"<code>{html.escape(m.group(1))}</code>"

        escaped = html.escape(text or "")
        return re.sub(r"`([^`]+)`", repl, escaped)

    def _wrap_code_blocks(self, html_text: str) -> str:
        if not html_text:
            return ""

        def repl(m):
            class_attr = m.group(1) or ""
            code_html = m.group(2) or ""

            lang = None
            if class_attr:
                m_lang = re.search(r"(language|lang)-([a-z0-9_+-]+)", class_attr, re.I)
                if m_lang:
                    lang = m_lang.group(2).lower()

            raw_code = html.unescape(code_html).replace("\r\n", "\n")
            raw_code = textwrap.dedent(raw_code).strip("\n")
            detected_label = lang or "auto"
            rendered = html.escape(raw_code)

            if highlight is not None and HtmlFormatter is not None:
                lexer = None
                if lang and get_lexer_by_name is not None:
                    try:
                        lexer = get_lexer_by_name(lang, stripall=False)
                    except Exception:
                        lexer = None
                if lexer is None:
                    try:
                        if guess_lexer is not None:
                            lexer = guess_lexer(raw_code)
                            detected_label = (
                                lexer.aliases[0] if getattr(lexer, "aliases", None) else lexer.name
                            )
                    except Exception:
                        lexer = None
                if lexer is None and TextLexer is not None:
                    lexer = TextLexer(stripall=False)
                    detected_label = "text"
                try:
                    formatter = HtmlFormatter(nowrap=True, noclasses=True, style="monokai")
                    rendered = highlight(raw_code, lexer, formatter) if lexer is not None else html.escape(raw_code)
                except Exception:
                    rendered = html.escape(raw_code)

            safe_lang = html.escape(detected_label)
            return (
                '<div class="chat-code-block">'
                '<div class="chat-code-header">'
                f'<div class="chat-code-lang">{safe_lang}</div>'
                '<button class="chat-code-copy" onclick="copyCode(this)" title="Copier" aria-label="Copier"></button>'
                "</div>"
                '<div class="chat-code-body" dir="ltr">'
                f"<code>{rendered}</code>"
                "</div></div>"
            )

        return re.sub(r"(?s)<pre><code(?: class=\"([^\"]+)\")?>(.*?)</code></pre>", repl, html_text)

    def _normalize_bullets(self, html_text: str) -> str:
        if not html_text:
            return ""

        pre_blocks: dict[str, str] = {}

        def stash_pre(m):
            key = f"__PRE_BLOCK_{len(pre_blocks)}__"
            pre_blocks[key] = m.group(0)
            return key

        tmp = re.sub(r"(?s)<pre>.*?</pre>", stash_pre, html_text)
        tmp = re.sub(r"(?s)<code class=\"whitespace-pre!\">.*?</code>", stash_pre, tmp)

        out_lines: list[str] = []
        para_re = re.compile(r"(?s)<p>(.*?)</p>")
        last = 0
        for m in para_re.finditer(tmp):
            out_lines.append(tmp[last : m.start()])
            out_lines.append(self._normalize_paragraph_bullets(m.group(1)))
            last = m.end()
        out_lines.append(tmp[last:])

        result = "".join(out_lines)
        for key, block in pre_blocks.items():
            result = result.replace(key, block)
        return result

    def _normalize_paragraph_bullets(self, paragraph_html: str) -> str:
        parts = re.split(r"<br\s*/?>", paragraph_html or "")
        out: list[str] = []
        in_ul = False
        bullet_re = re.compile(r"^\s*([-*•–—])\s+(.*)$")

        def close_ul() -> None:
            nonlocal in_ul
            if in_ul:
                out.append("</ul>")
                in_ul = False

        for part in parts:
            content = (part or "").strip()
            if not content:
                close_ul()
                continue
            m = bullet_re.match(content)
            if m:
                if not in_ul:
                    out.append('<ul class="chat-ul">')
                    in_ul = True
                out.append(f"<li>{m.group(2)}</li>")
            else:
                close_ul()
                out.append(f"<p>{content}</p>")

        close_ul()
        return "".join(out)

    def _decorate_links(self, html_text: str) -> str:
        if not html_text:
            return ""

        blocks: dict[str, str] = {}

        def stash_block(m):
            key = f"__BLOCK_{len(blocks)}__"
            blocks[key] = m.group(0)
            return key

        tmp = re.sub(r"(?s)<pre>.*?</pre>", stash_block, html_text)
        tmp = re.sub(r"(?s)<code>.*?</code>", stash_block, tmp)

        parts = re.split(r"(<[^>]+>)", tmp)
        out: list[str] = []
        in_anchor = False

        url_re = re.compile(r"(https?://[^\\s<]+)", re.I)
        email_re = re.compile(r"([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,})")

        def repl_url(m):
            url = m.group(1)
            return f'<a class="chat-link" href="{url}">{url}</a>'

        def repl_email(m):
            email = m.group(1)
            return f'<a class="chat-link" href="mailto:{email}">{email}</a>'

        for part in parts:
            if not part:
                continue
            if part.startswith("<"):
                tag = part.lower()
                if tag.startswith("<a "):
                    in_anchor = True
                elif tag.startswith("</a"):
                    in_anchor = False
                out.append(part)
                continue

            if in_anchor:
                out.append(part)
                continue

            text = part
            text = url_re.sub(repl_url, text)
            text = email_re.sub(repl_email, text)
            out.append(text)

        result = "".join(out)
        for key, block in blocks.items():
            result = result.replace(key, block)
        return result

    def _decorate_file_links(self, html_text: str) -> str:
        if not html_text:
            return ""

        pre_blocks: dict[str, str] = {}

        def stash_pre(m):
            key = f"__PRE_BLOCK_{len(pre_blocks)}__"
            pre_blocks[key] = m.group(0)
            return key

        tmp = re.sub(r"(?s)<pre>.*?</pre>", stash_pre, html_text)
        tmp = re.sub(r"(?s)<code class=\"whitespace-pre!\">.*?</code>", stash_pre, tmp)

        def looks_like_path(s: str) -> bool:
            if not s:
                return False
            if "<" in s or ">" in s:
                return False
            if s.lower().startswith("file://"):
                return False
            if "\\" in s or "/" in s:
                return True
            m = re.search(r"\.([A-Za-z0-9]+)$", s)
            if not m:
                return False
            ext = m.group(1).lower()
            return ext in {"py", "txt", "md", "json", "yaml", "yml", "ini", "toml", "css", "js", "ts", "tsx", "jsx"}

        def to_abs_path(content: str) -> str:
            abs_path = content
            try:
                cand = Path(content)
                if not cand.is_absolute():
                    ext_dir = Path(__file__).resolve().parent
                    cand2 = (ext_dir / cand).resolve()
                    if cand2.exists():
                        cand = cand2
                    else:
                        cand = (Path.cwd() / cand).resolve()
                abs_path = str(cand)
            except Exception:
                abs_path = content
            return abs_path

        def make_file_anchor(content: str) -> str:
            try:
                display = Path(content).name or content
            except Exception:
                display = content
            abs_path = to_abs_path(content)
            safe_display = html.escape(display)
            href = "codexaudio://open-file?path=" + _url_quote(abs_path)
            safe_href = html.escape(href, quote=True)
            return f'<a class="chat-file-link" href="{safe_href}"><span class="chat-file-name">{safe_display}</span></a>'

        def replace_inline_code(m):
            content = html.unescape(m.group(1) or "")
            if looks_like_path(content):
                return make_file_anchor(content)
            return f"<code>{m.group(1)}</code>"

        tmp = re.sub(r"<code>([^<]+)</code>", replace_inline_code, tmp)

        # Also decorate bare paths in text nodes (not only inline code).
        parts = re.split(r"(<[^>]+>)", tmp)
        out: list[str] = []
        in_anchor = False
        # Heuristic: drive paths, ./../, or slash paths with extension.
        bare_re = re.compile(
            r"([A-Za-z]:\\\\[^\\s<]+\\.[A-Za-z0-9]+|\\.{1,2}/[^\\s<]+\\.[A-Za-z0-9]+|[^\\s<]+[\\\\/][^\\s<]+\\.[A-Za-z0-9]+)"
        )

        for part in parts:
            if not part:
                continue
            if part.startswith("<"):
                tag = part.lower()
                if tag.startswith("<a "):
                    in_anchor = True
                elif tag.startswith("</a"):
                    in_anchor = False
                out.append(part)
                continue
            if in_anchor:
                out.append(part)
                continue

            def repl_bare(m):
                content = m.group(1)
                if looks_like_path(content):
                    return make_file_anchor(content)
                return content

            out.append(bare_re.sub(repl_bare, part))

        tmp = "".join(out)

        for key, block in pre_blocks.items():
            tmp = tmp.replace(key, block)
        return tmp

    def _render(self) -> None:
        text = self._last_text or ""
        html_body = self._to_html(text)
        html_body = self._wrap_code_blocks(html_body)
        html_body = self._normalize_bullets(html_body)
        html_body = self._decorate_file_links(html_body)
        html_body = self._decorate_links(html_body)

        html_doc = self._wrap_html(html_body)

        if QWebEngineView is not None and isinstance(self.browser, QWebEngineView):
            self._web_ready = False
            self.browser.setHtml(html_doc)
        else:
            # QTextBrowser fallback: still render full HTML so lists become real bullets.
            self.browser.setHtml(html_doc)


class MiniBar(QWidget):
    def __init__(self, on_ui_cmd):
        super().__init__()
        self._on_ui_cmd = on_ui_cmd
        self._app_paused = False
        self._muted = False
        self._playing = False
        self._drag_enabled = True
        self._drag_active = False
        self._drag_offset = None
        self._drag_start_pos = None
        self._drag_pressed_button = None
        self._drag_moved = False

        self.setWindowTitle("CodexAudio")
        self.setWindowFlag(Qt.FramelessWindowHint, True)
        self.setWindowFlag(Qt.Tool, True)
        self.setWindowFlag(Qt.WindowStaysOnTopHint, True)
        self.setAttribute(Qt.WA_TranslucentBackground, True)
        self.setFixedHeight(36)

        self.btn_play = QPushButton("⏯")
        self.btn_stop = QPushButton("⏹")
        self.btn_mute = QPushButton("🔇")
        self.btn_opts = QPushButton("⚙")
        self.btn_text = QPushButton("🪟")

        for b in [self.btn_play, self.btn_stop, self.btn_mute, self.btn_opts, self.btn_text]:
            b.setFixedSize(34, 28)
            b.setFlat(True)
            b.installEventFilter(self)

        layout = QHBoxLayout(self)
        layout.setContentsMargins(6, 4, 6, 4)
        layout.setSpacing(6)
        layout.addWidget(self.btn_play)
        layout.addWidget(self.btn_stop)
        layout.addWidget(self.btn_mute)
        layout.addWidget(self.btn_text)
        layout.addWidget(self.btn_opts)

        self.btn_play.clicked.connect(lambda: self._on_ui_cmd("playPause"))
        self.btn_stop.clicked.connect(lambda: self._on_ui_cmd("stop"))
        self.btn_mute.clicked.connect(lambda: self._on_ui_cmd("toggleMute"))
        self.btn_opts.clicked.connect(lambda: self._on_ui_cmd("openOptions"))
        self.btn_text.clicked.connect(lambda: self._on_ui_cmd("openTranslation"))
        self._restore_window_state()

    def ensure_on_top(self, activate: bool = False) -> None:
        try:
            self.setWindowFlag(Qt.WindowStaysOnTopHint, True)
            self.show()
            self.raise_()
            if activate:
                self.activateWindow()
        except Exception:
            pass

    def set_draggable(self, enabled: bool) -> None:
        self._drag_enabled = bool(enabled)

    def eventFilter(self, obj, event):
        if not self._drag_enabled or QEvent is None or QAbstractButton is None or not isinstance(obj, QAbstractButton):
            return super().eventFilter(obj, event)

        if event.type() == QEvent.MouseButtonPress and event.button() == Qt.LeftButton:
            self._drag_active = True
            self._drag_offset = event.globalPosition().toPoint() - self.frameGeometry().topLeft()
            self._drag_start_pos = event.globalPosition().toPoint()
            self._drag_pressed_button = obj
            self._drag_moved = False
            event.accept()
            return True

        if event.type() == QEvent.MouseMove and self._drag_active and self._drag_pressed_button is obj:
            if self._drag_offset is not None:
                current_pos = event.globalPosition().toPoint()
                if self._drag_start_pos and (current_pos - self._drag_start_pos).manhattanLength() > 3:
                    self._drag_moved = True
                if self._drag_moved:
                    self.move(current_pos - self._drag_offset)
            event.accept()
            return True

        if (
            event.type() == QEvent.MouseButtonRelease
            and self._drag_active
            and self._drag_pressed_button is obj
            and event.button() == Qt.LeftButton
        ):
            if not self._drag_moved:
                obj.click()
            self._drag_active = False
            self._drag_offset = None
            self._drag_start_pos = None
            self._drag_pressed_button = None
            try:
                self._save_window_state()
            except Exception:
                pass
            event.accept()
            return True

        return super().eventFilter(obj, event)

    def mousePressEvent(self, event):
        if self._drag_enabled and event.button() == Qt.LeftButton:
            child = self.childAt(event.position().toPoint())
            if QAbstractButton is not None and isinstance(child, QAbstractButton):
                super().mousePressEvent(event)
                return
            self._drag_active = True
            self._drag_offset = event.globalPosition().toPoint() - self.frameGeometry().topLeft()
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event):
        if self._drag_enabled and self._drag_active and self._drag_offset is not None:
            pos = event.globalPosition().toPoint() - self._drag_offset
            self.move(pos)
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event):
        if self._drag_enabled and event.button() == Qt.LeftButton:
            self._drag_active = False
            self._drag_offset = None
            try:
                self._save_window_state()
            except Exception:
                pass
            event.accept()
            return
        super().mouseReleaseEvent(event)

    def showEvent(self, event) -> None:  # type: ignore[override]
        self.ensure_on_top()
        try:
            self._save_window_state()
        except Exception:
            pass
        super().showEvent(event)

    def hideEvent(self, event) -> None:  # type: ignore[override]
        try:
            self._save_window_state()
        except Exception:
            pass
        super().hideEvent(event)

    def _save_window_state(self) -> None:
        _update_window_state(
            "minibar",
            {
                "x": int(self.x()),
                "y": int(self.y()),
                "w": int(self.width()),
                "h": int(self.height()),
                "visible": bool(self.isVisible()),
            },
        )

    def _restore_window_state(self) -> None:
        data = _read_state()
        windows = data.get("windows") if isinstance(data.get("windows"), dict) else {}
        st = windows.get("minibar") if isinstance(windows.get("minibar"), dict) else {}
        try:
            x = int(st.get("x")) if st.get("x") is not None else None
            y = int(st.get("y")) if st.get("y") is not None else None
            if x is not None and y is not None:
                self.move(x, y)
        except Exception:
            pass

    def set_state(self, app_paused: bool, muted: bool, playing: bool) -> None:
        self._app_paused = bool(app_paused)
        self._muted = bool(muted)
        self._playing = bool(playing)
        self.update()

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing, True)
        border_color = QColor(196, 58, 58) if self._app_paused else QColor(47, 191, 58)
        bg_color = QColor(230, 230, 230)
        border_width = 3
        radius = 8
        rect = self.rect().adjusted(
            border_width // 2,
            border_width // 2,
            -border_width // 2,
            -border_width // 2,
        )
        path = QPainterPath()
        path.addRoundedRect(rect, radius, radius)
        painter.fillPath(path, bg_color)
        painter.setPen(border_color)
        painter.setBrush(Qt.NoBrush)
        painter.drawPath(path)


def main() -> int:
    if QApplication is None or Qt is None:
        _event({"type": "error", "message": "PySide6 indisponible (UI flottante non disponible)."})
        return 1

    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)
    _event({"type": "log", "message": "backend_ready"})

    def on_ui_cmd(cmd: str) -> None:
        _event({"type": "ui_cmd", "cmd": cmd})

    def on_ui_cmd2(cmd: str, **payload) -> None:
        evt = {"type": "ui_cmd", "cmd": cmd}
        evt.update(payload or {})
        _event(evt)

    tts = TTSEngine()
    proc = Processor(tts)

    minibar = MiniBar(on_ui_cmd)
    # Start hidden to avoid a brief "flash" on launch before VS Code sends the desired visibility state.
    minibar.hide()

    translation = TranslationWindow(
        on_ui_cmd=on_ui_cmd2,
        # Keep minibar on top without stealing focus when translation gains focus.
        on_focus=lambda: minibar.ensure_on_top(activate=False) if minibar.isVisible() else None,
    )
    translation.hide()

    want_minibar_visible = False
    want_translation_visible = False

    def apply_visibility() -> None:
        if _is_rdp_foreground():
            if minibar.isVisible():
                minibar.hide()
            if translation.isVisible():
                translation.hide()
            return

        if want_minibar_visible:
            if not minibar.isVisible():
                minibar.show()
            minibar.ensure_on_top(activate=False)
        else:
            if minibar.isVisible():
                minibar.hide()

        if want_translation_visible:
            if not translation.isVisible():
                translation.show()
            translation.ensure_on_top(activate=False)
        else:
            if translation.isVisible():
                translation.hide()

    # Cache state sent by the extension to keep the minibar coherent.
    app_paused_state = False
    muted_state = False
    playing_state = False

    # No UI callbacks (highlighting removed).

    inbox: "Queue[dict]" = Queue()

    def reader():
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except Exception:
                continue
            if isinstance(msg, dict):
                inbox.put(msg)

    th = threading.Thread(target=reader, daemon=True)
    th.start()

    def handle(msg: dict) -> None:
        nonlocal want_minibar_visible, want_translation_visible
        req_id = str(msg.get("id") or "")
        method = str(msg.get("method") or "")
        params = msg.get("params") or {}
        try:
            if method == "list_voices":
                _response(req_id, True, tts.list_voices())
            elif method == "list_available_languages":
                _response(req_id, True, tts.list_available_languages())
            elif method == "capabilities":
                _response(
                    req_id,
                    True,
                    {
                        "translate_available": bool(Translator is not None),
                    },
                )
            elif method == "process":
                if not isinstance(params, dict):
                    params = {}
                text = str(params.get("text") or "")
                target_lang = str(params.get("target_lang") or "fr")
                translate_enabled = bool(params.get("translate_enabled") is True)
                voice_id = str(params.get("voice_id") or "")
                tts_lang = str(params.get("tts_lang") or "")
                result = proc.process(text, target_lang, translate_enabled, voice_id, tts_lang)
                _response(
                    req_id,
                    True,
                    {
                        "display_text": result.display_text,
                        "detected_lang": result.detected_lang,
                        "effective_lang": result.effective_lang,
                        "voice_id": result.voice_id,
                        "label": result.label,
                        "queue": result.queue,
                    },
                )
            elif method == "speak_queue":
                if not isinstance(params, dict):
                    params = {}
                queue = params.get("queue")
                if not isinstance(queue, list):
                    queue = []
                queue = [str(x) for x in queue if str(x).strip()]
                _safe_log(f"[tts] speak_queue received n={len(queue)}")
                cfg = {
                    "voice_id": str(params.get("voice_id") or ""),
                    "rate": float(params.get("rate") or 1.0),
                    "volume": float(params.get("volume") or 80.0),
                }
                tts.speak_queue(queue, cfg)
                app_paused_state = bool(params.get("app_paused") is True)
                muted_state = bool(params.get("muted") is True)
                playing_state = True
                minibar.set_state(
                    app_paused=app_paused_state,
                    muted=muted_state,
                    playing=playing_state,
                )
                _response(req_id, True, {"ok": True})
            elif method == "stop":
                tts.stop()
                playing_state = False
                minibar.set_state(app_paused=app_paused_state, muted=muted_state, playing=playing_state)
                _response(req_id, True, {"ok": True})
            elif method == "pause":
                tts.pause()
                playing_state = False
                minibar.set_state(app_paused=app_paused_state, muted=muted_state, playing=playing_state)
                _response(req_id, True, {"ok": True})
            elif method == "resume":
                tts.resume()
                playing_state = True
                minibar.set_state(app_paused=app_paused_state, muted=muted_state, playing=playing_state)
                _response(req_id, True, {"ok": True})
            elif method == "set_translation":
                if not isinstance(params, dict):
                    params = {}
                label = str(params.get("label") or "")
                text = str(params.get("text") or "")
                queue = params.get("queue")
                if not isinstance(queue, list):
                    queue = []
                queue = [str(x) for x in queue]
                translation.set_translation(text=text, label=label, queue=queue)
                _response(req_id, True, {"ok": True})
            elif method == "show_translation":
                if not isinstance(params, dict):
                    params = {}
                show = bool(params.get("show") is True)
                want_translation_visible = show
                apply_visibility()
                _response(req_id, True, {"ok": True})
            elif method == "show_minibar":
                if not isinstance(params, dict):
                    params = {}
                show = bool(params.get("show") is True)
                want_minibar_visible = show
                apply_visibility()
                _response(req_id, True, {"ok": True})
            elif method == "update_state":
                if not isinstance(params, dict):
                    params = {}
                app_paused_state = bool(params.get("app_paused") is True)
                muted_state = bool(params.get("muted") is True)
                playing_state = bool(params.get("playing") is True)
                minibar.set_state(app_paused=app_paused_state, muted=muted_state, playing=playing_state)
                _response(req_id, True, {"ok": True})
            else:
                _response(req_id, False, error=f"Unknown method: {method}")
        except Exception as e:
            _response(req_id, False, error=str(e))

    def drain_inbox() -> None:
        # Run in Qt main thread.
        while True:
            try:
                msg = inbox.get_nowait()
            except Empty:
                break
            if isinstance(msg, dict):
                handle(msg)

    timer = QTimer()
    timer.setInterval(50)
    timer.timeout.connect(drain_inbox)
    timer.start()

    rdp_timer = QTimer()
    rdp_timer.setInterval(500)
    rdp_timer.timeout.connect(apply_visibility)
    rdp_timer.start()

    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
