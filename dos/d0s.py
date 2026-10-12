#!/usr/bin/env python3
"""D0S — the DOS-style terminal for Aeon OS Berk.

A real terminal (PTY + shell), dressed like the good old days: black
screen, phosphor text, big readable characters. Replaces the stock
Terminal on Berk.

Standard library only: tkinter, pty, termios, etc. No third-party
packages.

Keys:
  Type normally. Ctrl+Shift+C copies, Ctrl+Shift+V pastes.
  Everything else goes straight to the program running inside.
"""

import codecs
import fcntl
import os as _os
import pty
import queue
import signal
import struct
import sys as _sys
import termios
import threading

_here = _os.path.dirname(_os.path.abspath(__file__))
_sys.path.insert(0, _here)
from ansi import AnsiParser, Screen, resolve_color  # noqa: E402

BG = "#000000"
FG = "#aaaaaa"
CURSOR_COLOR = "#ffb000"  # amber phosphor


def _pick_shell():
    shell = _os.environ.get("SHELL", "")
    if shell and _os.path.isfile(shell) and _os.access(shell, _os.X_OK):
        return shell
    return "/bin/bash"


class D0STerminal(object):
    def __init__(self, tk):
        self._tk = tk
        self.screen = Screen(25, 80)
        self.parser = AnsiParser(self.screen)
        self._queue = queue.Queue()
        self._need_render = False
        self._exited = False
        self._tag_cache = {}
        self._fonts = {}

        self.root = tk.Tk()
        self.root.title("D0S")
        self.root.configure(bg=BG)

        self.font = self._pick_font()
        self.bold_font = (self.font[0], self.font[1], "bold")

        self.text = tk.Text(
            self.root,
            bg=BG, fg=FG,
            font=self.font,
            insertbackground=CURSOR_COLOR,
            blockcursor=True,
            highlightthickness=0,
            borderwidth=0,
            padx=8, pady=8,
            wrap="none",
            undo=False,
            maxundo=0,
        )
        self.text.pack(fill="both", expand=True)
        # Start with a full grid of empty lines.
        self.text.insert("1.0", "\n" * (self.screen.rows - 1))
        self.text.mark_set("insert", "1.0")
        self.text.focus_set()

        self.text.bind("<Key>", self._on_key)
        self.text.bind("<Configure>", self._on_resize)
        # Keep the selection working for copy; clicks just focus.
        self.text.bind("<Button-1>", lambda e: self.text.focus_set())

        self._spawn_shell()
        self.root.after(30, self._pump)
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

    # -- setup -----------------------------------------------------
    def _pick_font(self):
        import tkinter.font as tkfont
        for name, size in (("DejaVu Sans Mono", 15),
                           ("Liberation Mono", 15),
                           ("Courier New", 14),
                           ("Courier", 14)):
            try:
                f = tkfont.Font(family=name, size=size)
                # Force load: measure something.
                f.measure("M")
                return (name, size)
            except Exception:
                continue
        return ("TkFixedFont", 14)

    def _spawn_shell(self):
        shell = _pick_shell()
        pid, fd = pty.fork()
        if pid == 0:
            # Child: become the shell.
            env = dict(_os.environ)
            env["TERM"] = "xterm-256color"
            try:
                _os.execvpe(shell, [shell], env)
            except Exception:
                _os._exit(1)
        self.child_pid = pid
        self.fd = fd
        self._exited = False
        self._update_winsize()
        threading.Thread(target=self._reader, daemon=True).start()

    # -- PTY plumbing ----------------------------------------------
    def _reader(self):
        dec = codecs.getincrementaldecoder("utf-8")(errors="replace")
        while True:
            try:
                data = _os.read(self.fd, 65536)
            except OSError:
                break
            if not data:
                break
            try:
                text = dec.decode(data)
            except Exception:
                continue
            if text:
                self.parser.feed(text)
                self._need_render = True
        self._queue.put(("exited",))

    def _write_pty(self, data):
        if self._exited:
            return
        try:
            _os.write(self.fd, data)
        except OSError:
            pass

    def _update_winsize(self):
        if getattr(self, "_exited", False):
            return
        try:
            rows, cols = self.screen.rows, self.screen.cols
            fcntl.ioctl(self.fd, termios.TIOCSWINSZ,
                        struct.pack("HHHH", rows, cols, 0, 0))
            _os.kill(self.child_pid, signal.SIGWINCH)
        except OSError:
            pass

    def _on_resize(self, event=None):
        try:
            import tkinter.font as tkfont
            f = tkfont.Font(font=self.text.cget("font"))
            cw = max(1, f.measure("M"))
            lh = max(1, f.metrics("linespace"))
            cols = max(20, (self.text.winfo_width() - 16) // cw)
            rows = max(5, (self.text.winfo_height() - 16) // lh)
        except Exception:
            return
        if (rows, cols) != (self.screen.rows, self.screen.cols):
            self.screen.resize(rows, cols)
            self._sync_text_rows()
            self._need_render = True
            self._update_winsize()

    def _sync_text_rows(self):
        # Make the Text widget hold exactly screen.rows lines.
        want = self.screen.rows
        have = int(self.text.index("end-1c").split(".")[0])
        if have < want:
            self.text.insert("end", "\n" * (want - have))
        elif have > want:
            self.text.delete("%d.0" % (want + 1), "end-1c")

    # -- main loop -------------------------------------------------
    def _pump(self):
        try:
            while True:
                msg = self._queue.get_nowait()
                if msg[0] == "exited":
                    self._on_child_exited()
        except queue.Empty:
            pass
        if self._need_render:
            self._need_render = False
            self._render()
        self.root.after(30, self._pump)

    def _on_child_exited(self):
        self._exited = True
        try:
            _os.close(self.fd)
        except OSError:
            pass
        self.parser.feed("\r\n[D0S: the shell exited. "
                         "Press any key for a new one.]\r\n")
        self._need_render = True

    def _respawn(self):
        self.screen.reset()
        self._tag_cache.clear()
        self._sync_text_rows()
        self._spawn_shell()
        self._need_render = True

    def _on_close(self):
        try:
            _os.kill(self.child_pid, signal.SIGHUP)
        except OSError:
            pass
        self.root.destroy()

    # -- rendering -------------------------------------------------
    def _tag_for(self, fg, bg, bold, underline, reverse):
        if reverse:
            fg, bg = bg, fg
        key = (fg if isinstance(fg, tuple) else fg,
               bg if isinstance(bg, tuple) else bg,
               bold, underline)
        tag = self._tag_cache.get(key)
        if tag is None:
            tag = "t%d" % len(self._tag_cache)
            opts = {
                "foreground": resolve_color(fg, False),
                "background": resolve_color(bg, True),
            }
            if bold:
                opts["font"] = self.bold_font
            if underline:
                opts["underline"] = True
            self.text.tag_config(tag, **opts)
            self._tag_cache[key] = tag
        return tag

    def _render_row(self, r):
        cells = self.screen.grid[r]
        # Trim trailing blank default cells (keeps copy clean + fast).
        end = self.screen.cols
        while end > 0:
            c = cells[end - 1]
            if (c.ch != " " or c.fg is not None or c.bg is not None
                    or c.bold or c.underline or c.reverse):
                break
            end -= 1
        self.text.delete("%d.0" % (r + 1), "%d.end" % (r + 1))
        if end == 0:
            return
        pos = 0
        while pos < end:
            cell = cells[pos]
            key = (cell.fg, cell.bg, cell.bold, cell.underline,
                   cell.reverse)
            nxt = pos + 1
            while nxt < end:
                c2 = cells[nxt]
                if (c2.fg, c2.bg, c2.bold, c2.underline,
                        c2.reverse) != key:
                    break
                nxt += 1
            chunk = "".join(cells[i].ch for i in range(pos, nxt))
            self.text.insert("%d.%d" % (r + 1, pos), chunk,
                             self._tag_for(*key))
            pos = nxt

    def _render(self):
        for r in sorted(self.screen.take_dirty()):
            if r < self.screen.rows:
                self._render_row(r)
        if self.screen.cursor_visible and not self._exited:
            self.text.config(blockcursor=True, insertwidth=2)
        else:
            self.text.config(blockcursor=False, insertwidth=0)
        self.text.mark_set(
            "insert", "%d.%d" % (self.screen.cy + 1, self.screen.cx))
        self.text.see("insert")
        if self.screen.title_dirty:
            self.screen.title_dirty = False
            self.root.title(self.screen.window_title or "D0S")
        if self.screen.bell_count:
            self.screen.bell_count = 0
            self._flash()

    def _flash(self):
        # Visual bell: brief amber wash.
        try:
            self.text.config(background="#2a1a00")
            self.root.after(120,
                            lambda: self.text.config(background=BG))
        except Exception:
            pass

    # -- input -----------------------------------------------------
    def _on_key(self, event):
        if self._exited:
            self._respawn()
            return "break"
        ks = event.keysym
        ctrl = bool(event.state & 0x4)
        shift = bool(event.state & 0x1)
        alt = bool(event.state & 0x8)  # Mod1
        # Copy / paste first: Ctrl+Shift+C / Ctrl+Shift+V.
        # (Plain Ctrl+C still sends interrupt, like a real terminal.)
        if ctrl and shift and ks.lower() == "c":
            self._copy()
            return "break"
        if ctrl and shift and ks.lower() == "v":
            self._paste()
            return "break"

        special = {
            "Return": b"\r", "KP_Enter": b"\r",
            "BackSpace": b"\x7f", "Delete": b"\x1b[3~",
            "Tab": b"\t", "Escape": b"\x1b",
            "Up": b"\x1b[A", "Down": b"\x1b[B",
            "Right": b"\x1b[C", "Left": b"\x1b[D",
            "Home": b"\x1b[H", "End": b"\x1b[F",
            "Prior": b"\x1b[5~", "Next": b"\x1b[6~",
            "Insert": b"\x1b[2~",
        }
        if ks in special and not ctrl and not alt:
            self._write_pty(special[ks])
            return "break"
        if ctrl and ks.lower() == "space":
            self._write_pty(b"\x00")  # Ctrl+Space = NUL
            return "break"
        if ctrl and len(ks) == 1 and ks.isalpha():
            self._write_pty(bytes([ord(ks.upper()) & 0x1f]))
            return "break"
        if event.char:
            data = event.char.encode("utf-8", "replace")
            if alt:
                data = b"\x1b" + data
            self._write_pty(data)
        # anything else: swallow so it never lands in the widget
        return "break"

    def _copy(self):
        try:
            sel = self.text.get("sel.first", "sel.last")
        except Exception:
            return
        self.root.clipboard_clear()
        self.root.clipboard_append(sel)

    def _paste(self):
        try:
            data = self.root.clipboard_get()
        except Exception:
            return
        # Bracketed paste is overkill; plain paste is fine.
        self._write_pty(data.replace("\r\n", "\r").replace("\n", "\r")
                        .encode("utf-8", "replace"))

    def run(self):
        self.root.mainloop()


def main():
    import tkinter
    try:
        app = D0STerminal(tkinter)
    except tkinter.TclError:
        print("D0S needs a desktop to show its window.", file=_sys.stderr)
        return 1
    app.run()
    return 0


if __name__ == "__main__":
    _sys.exit(main())
