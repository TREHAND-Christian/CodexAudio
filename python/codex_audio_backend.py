from __future__ import annotations

import asyncio
import base64
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


def _configure_qt_runtime() -> None:
    # Prefer software rendering for Qt WebEngine on Windows to avoid GPU/overlay crashes.
    chromium_flags = os.environ.get("QTWEBENGINE_CHROMIUM_FLAGS", "").strip()
    extra_flags = [
        "--disable-gpu",
        "--disable-gpu-compositing",
    ]
    for flag in extra_flags:
        if flag not in chromium_flags:
            chromium_flags = f"{chromium_flags} {flag}".strip()
    os.environ["QTWEBENGINE_CHROMIUM_FLAGS"] = chromium_flags
    os.environ.setdefault("QT_OPENGL", "software")
    os.environ.setdefault("QSG_RHI_BACKEND", "software")


_configure_qt_runtime()


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

from translation_window import TranslationWindow, _WindowStateFns


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
        self._after_queue: list[str] = []
        self._after_cfg: dict[str, Any] = {}
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
            self._after_queue = []
            self._after_cfg = {}
            t = self._thread
            if t is not None and t.is_alive():
                return
            self._queue = []
            self._queue_index = 0

    def pause(self) -> None:
        with self._lock:
            # Pause at the next sentence boundary instead of cutting the current spoken sentence.
            self._pause_flag = True
            self._stop_flag = False
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

    def speak_after(self, queue: list[str], cfg: dict[str, Any]) -> None:
        if not queue:
            return
        with self._lock:
            t = self._thread
            if t is not None and t.is_alive():
                # Queue after current playback without interrupting.
                if self._after_queue:
                    self._after_queue.extend(list(queue))
                else:
                    self._after_queue = list(queue)
                    self._after_cfg = dict(cfg or {})
                _event({"type": "log", "message": "tts_after_queued"})
                return
        self.speak_queue(queue, cfg)

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
                    if not self._stop_flag:
                        self._queue_index = i + 1
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
                        if self._after_queue:
                            self._queue = self._after_queue
                            self._queue_index = 0
                            self._cfg = self._after_cfg
                            self._after_queue = []
                            self._after_cfg = {}
                            restart = True

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
                if self._stop_flag:
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




class MiniBar(QWidget):
    def __init__(self, on_ui_cmd):
        super().__init__()
        self._on_ui_cmd = on_ui_cmd
        self._app_paused = False
        self._muted = False
        self._playing = False
        self._theme = "dark"
        self._ui_lang = "fr"
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
        self.setFixedHeight(42)

        self.btn_play = QPushButton("▶")
        self.btn_stop = QPushButton("■")
        self.btn_mute = QPushButton("🔈")
        self.btn_opts = QPushButton("⚙")
        self.btn_text = QPushButton("▣")

        for b in [self.btn_play, self.btn_stop, self.btn_mute, self.btn_opts, self.btn_text]:
            b.setFixedSize(40, 32)
            b.setFlat(True)
            b.installEventFilter(self)

        layout = QHBoxLayout(self)
        layout.setContentsMargins(7, 5, 7, 5)
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
        self._apply_button_style()
        self._update_labels()
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

    def set_state(self, app_paused: bool, muted: bool, playing: bool, theme: str = "", ui_lang: str = "") -> None:
        self._app_paused = bool(app_paused)
        self._muted = bool(muted)
        self._playing = bool(playing)
        if theme:
            self._theme = "light" if str(theme).lower() == "light" else "dark"
        if ui_lang:
            self._ui_lang = str(ui_lang).lower().split("-")[0] or "fr"
        self._apply_button_style()
        self._update_labels()
        self.update()

    def _tooltip(self, key: str) -> str:
        labels = {
            "fr": {
                "play": "Lire / pause",
                "stop": "Stop",
                "mute": "Muet",
                "unmute": "Son",
                "text": "Texte",
                "options": "Options",
            },
            "en": {
                "play": "Play / pause",
                "stop": "Stop",
                "mute": "Mute",
                "unmute": "Sound",
                "text": "Text",
                "options": "Options",
            },
            "de": {"play": "Start / Pause", "stop": "Stopp", "mute": "Stumm", "unmute": "Ton", "text": "Text", "options": "Optionen"},
            "es": {"play": "Reproducir / pausa", "stop": "Parar", "mute": "Silencio", "unmute": "Sonido", "text": "Texto", "options": "Opciones"},
            "it": {"play": "Play / pausa", "stop": "Stop", "mute": "Muto", "unmute": "Audio", "text": "Testo", "options": "Opzioni"},
            "pt": {"play": "Reproduzir / pausa", "stop": "Parar", "mute": "Mudo", "unmute": "Som", "text": "Texto", "options": "Opcoes"},
            "nl": {"play": "Afspelen / pauze", "stop": "Stop", "mute": "Dempen", "unmute": "Geluid", "text": "Tekst", "options": "Opties"},
            "ru": {"play": "Пуск / пауза", "stop": "Стоп", "mute": "Без звука", "unmute": "Звук", "text": "Текст", "options": "Параметры"},
            "ja": {"play": "再生 / 一時停止", "stop": "停止", "mute": "ミュート", "unmute": "音声", "text": "テキスト", "options": "設定"},
            "zh": {"play": "播放 / 暂停", "stop": "停止", "mute": "静音", "unmute": "声音", "text": "文本", "options": "选项"},
            "ar": {"play": "تشغيل / إيقاف", "stop": "إيقاف", "mute": "كتم", "unmute": "صوت", "text": "نص", "options": "خيارات"},
        }
        lang = self._ui_lang if self._ui_lang in labels else "fr"
        return labels[lang].get(key, key)

    def _update_labels(self) -> None:
        self.btn_play.setText("▮▮" if self._playing else "▶")
        self.btn_mute.setText("🔇" if self._muted else "🔈")
        self.btn_text.setText("▣")
        self.btn_play.setToolTip(self._tooltip("play"))
        self.btn_stop.setToolTip(self._tooltip("stop"))
        self.btn_mute.setToolTip(self._tooltip("unmute" if self._muted else "mute"))
        self.btn_text.setToolTip(self._tooltip("text"))
        self.btn_opts.setToolTip(self._tooltip("options"))

    def _apply_button_style(self) -> None:
        if self._theme == "light":
            bg = "#f6f8fa"
            fg = "#1f2328"
            hover = "#eaeef2"
            border = "#d0d7de"
        else:
            bg = "#252526"
            fg = "#f2f2f2"
            hover = "#333333"
            border = "#4a4a4a"
        self.setStyleSheet(
            "QPushButton {"
            f"background:{bg}; color:{fg}; border:1px solid {border};"
            "border-radius:7px; font-size:18px; font-weight:700; padding:0;"
            "}"
            f"QPushButton:hover {{ background:{hover}; }}"
            "QToolTip { padding:4px 7px; border-radius:4px; }"
        )

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing, True)
        border_color = QColor(196, 58, 58) if self._app_paused else QColor(47, 191, 58)
        bg_color = QColor(246, 248, 250) if self._theme == "light" else QColor(37, 37, 38)
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
    try:
        if hasattr(QApplication, "setAttribute") and hasattr(Qt, "AA_UseSoftwareOpenGL"):
            QApplication.setAttribute(Qt.AA_UseSoftwareOpenGL, True)
    except Exception:
        pass
    expected = os.environ.get("CODEXAUDIO_EXPECTED_PYTHON", "").strip()
    if expected:
        try:
            cur = os.path.normcase(os.path.abspath(sys.executable))
            exp = os.path.normcase(os.path.abspath(expected))
            if cur != exp:
                _event({"type": "error", "message": f"Python inattendu: {cur} (attendu: {exp})"})
                return 1
        except Exception:
            # If comparison fails, continue.
            pass

    if os.name == "nt":
        try:
            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("trehand.CodexAudio")
        except Exception:
            pass

    app = QApplication(sys.argv)
    try:
        app.setApplicationName("CodexAudio")
    except Exception:
        pass
    try:
        if hasattr(app, "setApplicationDisplayName"):
            app.setApplicationDisplayName("CodexAudio")
    except Exception:
        pass
    try:
        if hasattr(app, "setDesktopFileName"):
            app.setDesktopFileName("CodexAudio")
    except Exception:
        pass
    try:
        icon_path = Path(__file__).resolve().parent.parent / "assets" / "CAC-logo.ico"
        if QIcon is not None and icon_path.exists():
            app.setWindowIcon(QIcon(str(icon_path)))
    except Exception:
        pass
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
        window_state_fns=_WindowStateFns(read_state=_read_state, update_state=_update_window_state),
    )
    translation.hide()

    want_minibar_visible = False
    want_translation_visible = False
    last_minibar_visible = None
    last_translation_visible = None

    def apply_visibility() -> None:
        nonlocal last_minibar_visible, last_translation_visible
        if _is_rdp_foreground():
            if minibar.isVisible():
                minibar.hide()
            if translation.isVisible():
                translation.hide()
            return

        if want_minibar_visible:
            if not minibar.isVisible():
                minibar.show()
        else:
            if minibar.isVisible():
                minibar.hide()

        if want_translation_visible:
            if not translation.isVisible():
                translation.show()
        else:
            if translation.isVisible():
                translation.hide()

        minibar_vis = minibar.isVisible()
        translation_vis = translation.isVisible()

        if last_translation_visible is None or translation_vis != last_translation_visible:
            if translation_vis:
                translation.ensure_on_top(activate=False)
            last_translation_visible = translation_vis

        if last_minibar_visible is None or minibar_vis != last_minibar_visible:
            if minibar_vis:
                minibar.ensure_on_top(activate=False)
            last_minibar_visible = minibar_vis

        if translation_vis and minibar_vis:
            # Keep the minibar above the translation window without spamming raise/show.
            minibar.ensure_on_top(activate=False)

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
        nonlocal app_paused_state, muted_state, playing_state
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
                minibar.set_state(app_paused=app_paused_state, muted=muted_state, playing=playing_state)
                _response(req_id, True, {"ok": True})
            elif method == "speak_after":
                if not isinstance(params, dict):
                    params = {}
                queue = params.get("queue")
                if not isinstance(queue, list):
                    queue = []
                queue = [str(x) for x in queue if str(x).strip()]
                _safe_log(f"[tts] speak_after received n={len(queue)}")
                cfg = {
                    "voice_id": str(params.get("voice_id") or ""),
                    "rate": float(params.get("rate") or 1.0),
                    "volume": float(params.get("volume") or 80.0),
                }
                tts.speak_after(queue, cfg)
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
                is_initial = bool(params.get("is_initial") is True)
                if not isinstance(queue, list):
                    queue = []
                queue = [str(x) for x in queue]
                translation.set_translation(text=text, label=label, queue=queue, is_initial=is_initial)
                _response(req_id, True, {"ok": True})
            elif method == "append_session_event":
                if not isinstance(params, dict):
                    params = {}
                action = str(params.get("action") or "")
                session_id = str(params.get("id") or "")
                name = str(params.get("name") or "")
                translation.append_session_event(action=action, session_id=session_id, name=name)
                _response(req_id, True, {"ok": True})
            elif method == "show_translation":
                if not isinstance(params, dict):
                    params = {}
                show = bool(params.get("show") is True)
                want_translation_visible = show
                apply_visibility()
                translation.set_visible(show)
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
                theme = str(params.get("theme") or "")
                ui_lang = str(params.get("ui_lang") or "")
                minibar.set_state(
                    app_paused=app_paused_state,
                    muted=muted_state,
                    playing=playing_state,
                    theme=theme,
                    ui_lang=ui_lang,
                )
                if theme:
                    translation.set_theme(theme)
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
