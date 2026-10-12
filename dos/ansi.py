#!/usr/bin/env python3
"""ansi.py — minimal VT100/ANSI parser + screen model for D0S.

GUI-free (no tkinter): fully unit-testable. d0s.py renders a Screen onto
a Tkinter Text widget.

Supported:
  printable text, CR LF BS TAB BEL, SGR attributes (16/256/truecolor),
  cursor motion (CUU/CUD/CUF/CUB/CNL/CPL/CHA/CUP/VPA), erase (ED/EL),
  insert/delete lines, save/restore cursor, show/hide cursor,
  alternate screen (?1049), window title (OSC 0/2).
Unknown sequences are parsed and ignored so stray bytes never corrupt
the screen.

This is a pragmatic subset, not xterm: it covers interactive shells and
common CLI tools. Full-screen TUIs get a best-effort alternate screen.
"""

# Classic 16-color DOS/VGA palette.
PALETTE_16 = [
    "#000000", "#aa0000", "#00aa00", "#aa5500",
    "#0000aa", "#aa00aa", "#00aaaa", "#aaaaaa",
    "#555555", "#ff5555", "#55ff55", "#ffff55",
    "#5555ff", "#ff55ff", "#55ffff", "#ffffff",
]

DEFAULT_FG = "#aaaaaa"  # DOS light gray
DEFAULT_BG = "#000000"


def _color_256(n):
    if n < 16:
        return PALETTE_16[n]
    if n < 232:
        n -= 16
        r, g, b = (n // 36), ((n // 6) % 6), (n % 6)
        conv = lambda v: 0 if v == 0 else 55 + 40 * v
        return "#%02x%02x%02x" % (conv(r), conv(g), conv(b))
    v = 8 + 10 * (n - 232)
    return "#%02x%02x%02x" % (v, v, v)


def resolve_color(spec, is_bg):
    """Turn a color spec into a Tk hex string. spec: None (default),
    int 0-255, or (r, g, b) tuple."""
    if spec is None:
        return DEFAULT_BG if is_bg else DEFAULT_FG
    if isinstance(spec, tuple):
        return "#%02x%02x%02x" % spec
    return _color_256(spec)


class Cell(object):
    __slots__ = ("ch", "fg", "bg", "bold", "underline", "reverse")

    def __init__(self):
        self.clear()

    def clear(self):
        self.ch = " "
        self.fg = None
        self.bg = None
        self.bold = False
        self.underline = False
        self.reverse = False

    def copy_attrs_from(self, screen):
        self.fg = screen.cur_fg
        self.bg = screen.cur_bg
        self.bold = screen.cur_bold
        self.underline = screen.cur_underline
        self.reverse = screen.cur_reverse


class Screen(object):
    def __init__(self, rows=25, cols=80):
        self.rows = rows
        self.cols = cols
        self.grid = [[Cell() for _ in range(cols)] for _ in range(rows)]
        self.cx = 0
        self.cy = 0
        self.cur_fg = None
        self.cur_bg = None
        self.cur_bold = False
        self.cur_underline = False
        self.cur_reverse = False
        self.cursor_visible = True
        self.window_title = None
        self.title_dirty = False
        self.bell_count = 0
        self.dirty = set(range(rows))
        self._alt_stack = []
        self._saved = None

    # -- text ------------------------------------------------------
    def put(self, ch):
        if self.cx >= self.cols:
            self.cx = 0
            self._linefeed()
        cell = self.grid[self.cy][self.cx]
        cell.ch = ch
        cell.copy_attrs_from(self)
        self.cx += 1
        self.dirty.add(self.cy)

    def carriage_return(self):
        self.cx = 0

    def newline(self):
        # LF only moves down; the PTY's ONLCR turns it into CR+LF.
        # If a wrap is pending (cursor past the last column), consume it
        # first so we don't get a double linefeed.
        if self.cx >= self.cols:
            self.cx = 0
        self._linefeed()

    def _linefeed(self):
        self.cy += 1
        if self.cy >= self.rows:
            self.cy = self.rows - 1
            self._scroll_up(1)

    def backspace(self):
        if self.cx > 0:
            self.cx -= 1

    def tab(self):
        self.cx = min(self.cols - 1, ((self.cx // 8) + 1) * 8)

    def bell(self):
        self.bell_count += 1

    def _scroll_up(self, n):
        for _ in range(n):
            self.grid.pop(0)
            self.grid.append([Cell() for _ in range(self.cols)])
        self.dirty = set(range(self.rows))

    # -- cursor ----------------------------------------------------
    def _clamp(self):
        self.cx = max(0, min(self.cols - 1, self.cx))
        self.cy = max(0, min(self.rows - 1, self.cy))

    def cursor_up(self, n=1):
        self.cy -= n
        self._clamp()

    def cursor_down(self, n=1):
        self.cy += n
        self._clamp()

    def cursor_forward(self, n=1):
        self.cx += n
        self._clamp()

    def cursor_back(self, n=1):
        self.cx -= n
        self._clamp()

    def cursor_next_line(self, n=1):
        self.cy += n
        self.cx = 0
        self._clamp()

    def cursor_prev_line(self, n=1):
        self.cy -= n
        self.cx = 0
        self._clamp()

    def cursor_to(self, row, col):
        # 1-based from the wire; clamp into range.
        self.cy = row - 1
        self.cx = col - 1
        self._clamp()

    def cursor_col(self, col):
        self.cx = col - 1
        self._clamp()

    def cursor_row(self, row):
        self.cy = row - 1
        self._clamp()

    def reverse_index(self):
        # ESC M: move up, scrolling down at the top.
        if self.cy == 0:
            self.grid.insert(0, [Cell() for _ in range(self.cols)])
            self.grid.pop()
            self.dirty = set(range(self.rows))
        else:
            self.cy -= 1

    def save_cursor(self):
        self._saved = (self.cx, self.cy, self.cur_fg, self.cur_bg,
                       self.cur_bold, self.cur_underline, self.cur_reverse)

    def restore_cursor(self):
        if self._saved:
            (self.cx, self.cy, self.cur_fg, self.cur_bg,
             self.cur_bold, self.cur_underline,
             self.cur_reverse) = self._saved
            self._clamp()

    # -- erase -----------------------------------------------------
    def erase_display(self, mode=0):
        if mode == 2:
            for r in range(self.rows):
                for c in self.grid[r]:
                    c.clear()
            self.dirty = set(range(self.rows))
        elif mode == 1:
            for r in range(self.cy + 1):
                end = self.cx + 1 if r == self.cy else self.cols
                for c in self.grid[r][:end]:
                    c.clear()
                self.dirty.add(r)
        else:  # 0: from cursor to end
            for r in range(self.cy, self.rows):
                start = self.cx if r == self.cy else 0
                for c in self.grid[r][start:]:
                    c.clear()
                self.dirty.add(r)

    def erase_line(self, mode=0):
        row = self.grid[self.cy]
        if mode == 2:
            for c in row:
                c.clear()
        elif mode == 1:
            for c in row[:self.cx + 1]:
                c.clear()
        else:
            for c in row[self.cx:]:
                c.clear()
        self.dirty.add(self.cy)

    def insert_lines(self, n=1):
        for _ in range(n):
            self.grid.insert(self.cy, [Cell() for _ in range(self.cols)])
            self.grid.pop()
        self.dirty = set(range(self.cy, self.rows))

    def delete_lines(self, n=1):
        for _ in range(n):
            self.grid.pop(self.cy)
            self.grid.append([Cell() for _ in range(self.cols)])
        self.dirty = set(range(self.cy, self.rows))

    # -- attributes ------------------------------------------------
    def sgr_reset(self):
        self.cur_fg = None
        self.cur_bg = None
        self.cur_bold = False
        self.cur_underline = False
        self.cur_reverse = False

    def apply_sgr(self, nums):
        i = 0
        while i < len(nums):
            n = nums[i]
            if n == 0:
                self.sgr_reset()
                i += 1
            elif n == 1:
                self.cur_bold = True
                i += 1
            elif n == 4:
                self.cur_underline = True
                i += 1
            elif n == 7:
                self.cur_reverse = True
                i += 1
            elif n == 22:
                self.cur_bold = False
                i += 1
            elif n == 24:
                self.cur_underline = False
                i += 1
            elif n == 27:
                self.cur_reverse = False
                i += 1
            elif 30 <= n <= 37:
                self.cur_fg = n - 30
                i += 1
            elif 90 <= n <= 97:
                self.cur_fg = n - 90 + 8
                i += 1
            elif n == 39:
                self.cur_fg = None
                i += 1
            elif 40 <= n <= 47:
                self.cur_bg = n - 40
                i += 1
            elif 100 <= n <= 107:
                self.cur_bg = n - 100 + 8
                i += 1
            elif n == 49:
                self.cur_bg = None
                i += 1
            elif n in (38, 48):
                # extended color: 38;5;n / 38;2;r;g;b
                is_fg = (n == 38)
                if i + 2 < len(nums) and nums[i + 1] == 5:
                    val = nums[i + 2]
                    if is_fg:
                        self.cur_fg = val
                    else:
                        self.cur_bg = val
                    i += 3
                elif (i + 4 < len(nums) and nums[i + 1] == 2
                        and all(0 <= v <= 255 for v in nums[i + 2:i + 5])):
                    val = tuple(nums[i + 2:i + 5])
                    if is_fg:
                        self.cur_fg = val
                    else:
                        self.cur_bg = val
                    i += 5
                else:
                    i += 1
            else:
                i += 1  # unknown SGR: ignore

    # -- alternate screen ------------------------------------------
    def alt_screen_on(self):
        self._alt_stack.append(
            (self.grid, self.cx, self.cy))
        self.grid = [[Cell() for _ in range(self.cols)]
                     for _ in range(self.rows)]
        self.cx, self.cy = 0, 0
        self.dirty = set(range(self.rows))

    def alt_screen_off(self):
        if self._alt_stack:
            self.grid, self.cx, self.cy = self._alt_stack.pop()
            self.dirty = set(range(self.rows))

    # -- misc ------------------------------------------------------
    def reset(self):
        fresh = Screen(self.rows, self.cols)
        self.__dict__.update(fresh.__dict__)

    def set_title(self, title):
        self.window_title = title
        self.title_dirty = True

    def resize(self, rows, cols):
        rows = max(1, rows)
        cols = max(1, cols)
        if rows == self.rows and cols == self.cols:
            return
        new_grid = [[Cell() for _ in range(cols)] for _ in range(rows)]
        for r in range(min(rows, self.rows)):
            for c in range(min(cols, self.cols)):
                src, dst = self.grid[r][c], new_grid[r][c]
                dst.ch, dst.fg, dst.bg = src.ch, src.fg, src.bg
                dst.bold, dst.underline = src.bold, src.underline
                dst.reverse = src.reverse
        self.grid = new_grid
        self.rows, self.cols = rows, cols
        self._clamp()
        self.dirty = set(range(rows))

    def take_dirty(self):
        d = self.dirty
        self.dirty = set()
        return d

    def row_text(self, r):
        return "".join(c.ch for c in self.grid[r]).rstrip()


class AnsiParser(object):
    def __init__(self, screen):
        self.s = screen
        self.state = "ground"
        self._csi = ""
        self._osc = ""

    def feed(self, data):
        for ch in data:
            self._step(ch)

    # -- state machine ---------------------------------------------
    def _step(self, ch):
        if self.state == "ground":
            self._ground(ch)
        elif self.state == "esc":
            self._esc(ch)
        elif self.state == "esc_skip":
            self.state = "ground"
        elif self.state == "csi":
            self._csi_step(ch)
        elif self.state == "osc":
            self._osc_step(ch)
        elif self.state == "osc_esc":
            if ch == "\\":
                self._dispatch_osc(self._osc)
            self.state = "ground"

    def _ground(self, ch):
        if ch == "\x1b":
            self.state = "esc"
        elif ch == "\x07":
            self.s.bell()
        elif ch == "\r":
            self.s.carriage_return()
        elif ch in ("\n", "\x0b", "\x0c"):
            self.s.newline()
        elif ch == "\b":
            self.s.backspace()
        elif ch == "\t":
            self.s.tab()
        elif ch < " ":
            pass  # other C0 controls: ignore
        elif ch == "\x7f":
            pass  # DEL: ignore
        else:
            self.s.put(ch)

    def _esc(self, ch):
        if ch == "[":
            self.state = "csi"
            self._csi = ""
        elif ch == "]":
            self.state = "osc"
            self._osc = ""
        elif ch in "()#":
            self.state = "esc_skip"  # charset selection: skip one byte
        elif ch == "M":
            self.s.reverse_index()
            self.state = "ground"
        elif ch == "c":
            self.s.reset()
            self.state = "ground"
        elif ch == "7":
            self.s.save_cursor()
            self.state = "ground"
        elif ch == "8":
            self.s.restore_cursor()
            self.state = "ground"
        elif ch in "=>":
            self.state = "ground"  # keypad mode: ignore
        else:
            self.state = "ground"  # unknown: drop

    def _csi_step(self, ch):
        if ch.isdigit() or ch in ";: " or ch in "?'\"$!":
            # parameter / private-marker bytes
            self._csi += ch
        elif "@" <= ch <= "~":
            self._dispatch_csi(ch, self._csi)
            self.state = "ground"
        else:
            self.state = "ground"  # malformed: drop

    def _osc_step(self, ch):
        if ch == "\x07":
            self._dispatch_osc(self._osc)
            self.state = "ground"
        elif ch == "\x1b":
            self.state = "osc_esc"
        else:
            self._osc += ch

    # -- dispatch --------------------------------------------------
    @staticmethod
    def _nums(param_str, count=None):
        body = param_str.lstrip("?")
        parts = body.split(";") if body else []
        nums = []
        for p in parts:
            p = p.strip()
            nums.append(int(p) if p.isdigit() else 0)
        return nums

    @staticmethod
    def _pn(nums, i, default):
        return nums[i] if i < len(nums) and nums[i] != 0 else default

    def _dispatch_csi(self, final, params):
        private = params.startswith("?")
        nums = self._nums(params)

        if final == "m":
            self.s.apply_sgr(nums or [0])
        elif final == "A":
            self.s.cursor_up(self._pn(nums, 0, 1))
        elif final == "B":
            self.s.cursor_down(self._pn(nums, 0, 1))
        elif final == "C":
            self.s.cursor_forward(self._pn(nums, 0, 1))
        elif final == "D":
            self.s.cursor_back(self._pn(nums, 0, 1))
        elif final == "E":
            self.s.cursor_next_line(self._pn(nums, 0, 1))
        elif final == "F":
            self.s.cursor_prev_line(self._pn(nums, 0, 1))
        elif final == "G":
            self.s.cursor_col(self._pn(nums, 0, 1))
        elif final in ("H", "f"):
            r = self._pn(nums, 0, 1)
            c = self._pn(nums, 1, 1)
            self.s.cursor_to(r, c)
        elif final == "d":
            self.s.cursor_row(self._pn(nums, 0, 1))
        elif final == "J":
            self.s.erase_display(self._pn(nums, 0, 0))
        elif final == "K":
            self.s.erase_line(self._pn(nums, 0, 0))
        elif final == "L":
            self.s.insert_lines(self._pn(nums, 0, 1))
        elif final == "M":
            self.s.delete_lines(self._pn(nums, 0, 1))
        elif final == "s":
            self.s.save_cursor()
        elif final == "u":
            self.s.restore_cursor()
        elif final in ("h", "l") and private:
            self._dispatch_private(final == "h", nums)
        # everything else: parsed and ignored (incl. non-private h/l)

    def _dispatch_private(self, set_mode, nums):
        for n in nums:
            if n == 25:
                self.s.cursor_visible = set_mode
            elif n == 1049:
                if set_mode:
                    self.s.alt_screen_on()
                else:
                    self.s.alt_screen_off()
            # 2004 (bracketed paste) and friends: ignored

    def _dispatch_osc(self, buf):
        # OSC <n> ; <text>  — we only care about 0/2 (window title).
        if ";" in buf:
            num, _, text = buf.partition(";")
            if num.strip() in ("0", "2"):
                self.s.set_title(text)
