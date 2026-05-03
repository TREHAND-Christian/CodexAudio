from __future__ import annotations

import base64
import html
import re
import textwrap
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

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
    from PySide6.QtWidgets import (
        QApplication,
        QWidget,
        QTextBrowser,
        QVBoxLayout,
    )
except Exception:  # pragma: no cover
    Qt = None
    QTimer = None
    QEvent = None
    QDesktopServices = None
    QApplication = None
    QWidget = None
    QTextBrowser = None
    QVBoxLayout = None

try:
    from PySide6.QtWebEngineWidgets import QWebEngineView
except Exception:  # pragma: no cover
    QWebEngineView = None

try:
    from PySide6.QtWebEngineCore import QWebEnginePage
except Exception:  # pragma: no cover
    QWebEnginePage = None


@dataclass
class _WindowStateFns:
    read_state: Callable[[], dict]
    update_state: Callable[[str, dict], None]


class _ChatWebPage(QWebEnginePage if QWebEnginePage is not None else object):
    def __init__(self, on_open_file, parent=None) -> None:
        if QWebEnginePage is not None:
            super().__init__(parent)
        self._on_open_file = on_open_file

    def acceptNavigationRequest(self, url, nav_type, is_main_frame):  # type: ignore[override]
        try:
            s = url.toString()
        except Exception:
            return True
        if s.startswith("codexaudio://open-file?path="):
            try:
                raw = s.split("codexaudio://open-file?path=", 1)[1]
                from urllib.parse import unquote as _url_unquote

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
    def __init__(
        self,
        on_ui_cmd=None,
        on_focus=None,
        window_state_fns: Optional[_WindowStateFns] = None,
    ):
        super().__init__()
        self.setWindowTitle("Fenêtre texte")
        self.setWindowFlag(Qt.Window, True)
        self.setWindowFlag(Qt.WindowMinMaxButtonsHint, True)
        self.setWindowFlag(Qt.WindowCloseButtonHint, True)
        self.setWindowFlag(Qt.WindowStaysOnTopHint, True)
        self.setAttribute(Qt.WA_QuitOnClose, False)
        self.setMinimumSize(260, 260)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)

        self._chat_css = self._load_chat_css()
        self._last_text = ""
        self._last_label = ""
        self._queue: list[str] = []
        self._session_events: list[dict[str, str]] = []
        self._web_ready = False
        self._on_ui_cmd = on_ui_cmd
        self._on_focus = on_focus
        self._state_fns = window_state_fns
        self._logo_data_url = self._load_logo_data_url()

        self._visible = False
        self._pending_seq = 0
        self._rendered_seq = 0
        self._wait_for_fresh = False
        self._show_logo_on_next_show = True
        self._skip_first_render = False

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
            self._apply_native_theme()
            try:
                self.browser.anchorClicked.connect(self._on_textbrowser_anchor_clicked)
            except Exception:
                pass

        layout.addWidget(self.browser)
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

    def set_visible(self, show: bool, startup: bool = False) -> None:
        self._visible = bool(show)
        if self._visible:
            if self._show_logo_on_next_show:
                self._wait_for_fresh = True
                self._skip_first_render = True
                # Ignore any already-received text (initial sync) while logo is shown.
                self._rendered_seq = self._pending_seq
                self._render_logo()
                self._show_logo_on_next_show = False
            else:
                if self._pending_seq > self._rendered_seq and not self._wait_for_fresh:
                    self._render()
        else:
            if self.isVisible():
                self.hide()

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

    def _detect_theme(self) -> str:
        try:
            app = QApplication.instance() if QApplication is not None else None
            if app is None:
                return "dark"
            color = app.palette().color(app.palette().Window)
            return "light" if int(color.lightness()) >= 128 else "dark"
        except Exception:
            return "dark"

    def _apply_native_theme(self) -> None:
        if QTextBrowser is not None and isinstance(getattr(self, "browser", None), QTextBrowser):
            if self._detect_theme() == "light":
                self.browser.setStyleSheet("background-color:#ffffff;color:#1f2328;border:none;")
            else:
                self.browser.setStyleSheet("background-color:#1e1e1e;color:#d4d4d4;border:none;")

    def _on_textbrowser_anchor_clicked(self, url) -> None:
        try:
            s = url.toString()
        except Exception:
            return
        if s.startswith("codexaudio://open-file?path="):
            try:
                raw = s.split("codexaudio://open-file?path=", 1)[1]
                from urllib.parse import unquote as _url_unquote

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

    def set_translation(self, text: str, label: str, queue: list[str], is_initial: bool = False) -> None:
        self._last_text = text or ""
        self._last_label = label or ""
        self._queue = list(queue or [])
        self._pending_seq += 1
        title = f"Fenêtre texte - {label}" if label else "Fenêtre texte"
        self.setWindowTitle(title)
        if self._visible:
            if self._skip_first_render and is_initial:
                self._skip_first_render = False
                if self._pending_seq > self._rendered_seq:
                    self._wait_for_fresh = False
            if self._wait_for_fresh:
                if self._pending_seq > self._rendered_seq:
                    self._wait_for_fresh = False
            if not self._wait_for_fresh:
                self._render()

    def append_session_event(self, action: str, session_id: str, name: str = "") -> None:
        action = (action or "").strip()
        session_id = (session_id or "").strip()
        name = (name or "").strip()
        if not session_id or not action:
            return
        self._session_events.append(
            {
                "action": action,
                "id": session_id,
                "name": name,
            }
        )
        self._session_events = self._session_events[-30:]
        self._pending_seq += 1
        if not self._last_label:
            self.setWindowTitle("Fenêtre texte - Sessions Codex")
        if self._visible and not self._wait_for_fresh:
            self._render()

    def moveEvent(self, event) -> None:  # type: ignore[override]
        try:
            if self._state_fns:
                self._state_fns.update_state(
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
            if self._state_fns:
                self._state_fns.update_state(
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
        self.ensure_on_top(activate=False)
        try:
            if self._state_fns:
                self._state_fns.update_state("translation", {"visible": True})
        except Exception:
            pass
        super().showEvent(event)

    def hideEvent(self, event) -> None:  # type: ignore[override]
        try:
            if self._state_fns:
                self._state_fns.update_state("translation", {"visible": False})
        except Exception:
            pass
        super().hideEvent(event)

    def closeEvent(self, event) -> None:  # type: ignore[override]
        try:
            if self._on_ui_cmd:
                self._on_ui_cmd("translationClosed")
        except Exception:
            pass
        super().closeEvent(event)

    def _restore_window_state(self) -> None:
        data = self._state_fns.read_state() if self._state_fns else {}
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

    def _load_logo_data_url(self) -> str:
        try:
            logo_path = Path(__file__).resolve().parent.parent / "assets" / "CAC-logo.png"
            raw = logo_path.read_bytes()
            b64 = base64.b64encode(raw).decode("ascii")
            return f"data:image/png;base64,{b64}"
        except Exception:
            return ""

    def _wrap_html(self, html_fragment: str) -> str:
        css = self._chat_css or ""
        theme = self._detect_theme()
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
            f"</head><body class=\"chat-body theme-{theme}\">"
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
                extensions=[
                    "fenced_code",
                    "tables",
                    "sane_lists",
                    "nl2br",
                    "pymdownx.tilde",
                    "pymdownx.tasklist",
                ],
                extension_configs={
                    "pymdownx.tasklist": {"custom_checkbox": True},
                },
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
        if not text:
            return ""

        code_spans: list[str] = []

        def repl_code(m):
            code_spans.append(html.escape(m.group(1)))
            return f"%%CODESPAN{len(code_spans) - 1}%%"

        tmp = re.sub(r"`([^`]+)`", repl_code, text)
        escaped = html.escape(tmp)

        def repl_bold(m):
            return f"<strong>{m.group(1)}</strong>"

        def repl_em(m):
            return f"<em>{m.group(1)}</em>"

        escaped = re.sub(r"\*\*(.+?)\*\*", repl_bold, escaped)
        escaped = re.sub(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)", repl_em, escaped)
        escaped = re.sub(r"(?<!_)_(?!_)(.+?)(?<!_)_(?!_)", repl_em, escaped)

        def restore_code(m):
            idx = int(m.group(1))
            if 0 <= idx < len(code_spans):
                return f"<code>{code_spans[idx]}</code>"
            return ""

        return re.sub(r"%%CODESPAN(\d+)%%", restore_code, escaped)

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
            from urllib.parse import quote as _url_quote

            href = "codexaudio://open-file?path=" + _url_quote(abs_path)
            safe_href = html.escape(href, quote=True)
            return f'<a class="chat-file-link" href="{safe_href}"><span class="chat-file-name">{safe_display}</span></a>'

        def replace_inline_code(m):
            content = html.unescape(m.group(1) or "")
            if looks_like_path(content):
                return make_file_anchor(content)
            return f"<code>{m.group(1)}</code>"

        tmp = re.sub(r"<code>([^<]+)</code>", replace_inline_code, tmp)

        parts = re.split(r"(<[^>]+>)", tmp)
        out: list[str] = []
        in_anchor = False
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

    def _render_logo(self) -> None:
        if not self._logo_data_url:
            self._render()
            return
        html_body = (
            '<div style="display:flex;align-items:center;justify-content:center;height:60vh;">'
            f'<img src="{self._logo_data_url}" alt="CodexAudio" style="width:160px;height:160px;opacity:0.9;" />'
            "</div>"
        )
        html_body = self._wrap_code_blocks(html_body)
        html_body = self._normalize_bullets(html_body)
        html_body = self._decorate_file_links(html_body)
        html_body = self._decorate_links(html_body)
        html_doc = self._wrap_html(html_body)
        if QWebEngineView is not None and isinstance(self.browser, QWebEngineView):
            self._web_ready = False
            self.browser.setHtml(html_doc)
        else:
            self.browser.setHtml(html_doc)

    def _render(self) -> None:
        text = self._last_text or ""
        if self._session_events:
            event_lines = ["## Sessions Codex"]
            for event in self._session_events:
                title = event.get("name") or event.get("id") or ""
                sid = event.get("id") or ""
                action = event.get("action") or ""
                event_lines.append(f"- {title} ({sid}) > {action}")
            if text.strip():
                text = "\n".join(event_lines) + "\n\n---\n\n" + text
            else:
                text = "\n".join(event_lines)
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
            self.browser.setHtml(html_doc)
        self._rendered_seq = self._pending_seq
