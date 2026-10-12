#!/usr/bin/env python3
"""Unit tests for the D0S ANSI parser + screen (no GUI, no PTY)."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from ansi import AnsiParser, Screen, resolve_color


def run(text, rows=25, cols=80):
    s = Screen(rows, cols)
    AnsiParser(s).feed(text)
    return s


class TextTests(unittest.TestCase):
    def test_plain_text(self):
        s = run("hello")
        self.assertEqual(s.row_text(0), "hello")
        self.assertEqual((s.cx, s.cy), (5, 0))

    def test_crlf(self):
        s = run("a\r\nb")
        self.assertEqual(s.row_text(0), "a")
        self.assertEqual(s.row_text(1), "b")

    def test_lf_only_keeps_column(self):
        # LF moves down; the PTY's ONLCR supplies the CR in real use.
        s = run("ab\ncd")
        self.assertEqual(s.grid[1].ch if False else s.row_text(1)[2:], "cd")

    def test_backspace(self):
        s = run("ab\bc")
        self.assertEqual(s.row_text(0), "ac")

    def test_tab(self):
        s = run("a\tb")
        self.assertEqual(s.grid[0][0].ch, "a")
        self.assertEqual(s.grid[0][8].ch, "b")

    def test_wrap(self):
        s = run("x" * 85, rows=25, cols=80)
        self.assertEqual(s.row_text(0), "x" * 80)
        self.assertEqual(s.row_text(1), "xxxxx")

    def test_scroll(self):
        s = Screen(3, 10)
        AnsiParser(s).feed("l1\r\nl2\r\nl3\r\nl4")
        self.assertEqual(s.row_text(0), "l2")
        self.assertEqual(s.row_text(1), "l3")
        self.assertEqual(s.row_text(2), "l4")

    def test_bell_counts(self):
        s = run("a\x07b\x07")
        self.assertEqual(s.bell_count, 2)
        self.assertEqual(s.row_text(0), "ab")


class SgrTests(unittest.TestCase):
    def test_basic_fg(self):
        s = run("\x1b[31mR")
        self.assertEqual(s.grid[0][0].fg, 1)
        self.assertEqual(resolve_color(1, False), "#aa0000")

    def test_bright_fg(self):
        s = run("\x1b[91mR")
        self.assertEqual(s.grid[0][0].fg, 9)

    def test_bg(self):
        s = run("\x1b[44mB")
        self.assertEqual(s.grid[0][0].bg, 4)

    def test_bold_underline(self):
        s = run("\x1b[1;4mX")
        c = s.grid[0][0]
        self.assertTrue(c.bold)
        self.assertTrue(c.underline)

    def test_reset(self):
        s = run("\x1b[1;31mA\x1b[0mB")
        a, b = s.grid[0][0], s.grid[0][1]
        self.assertTrue(a.bold)
        self.assertEqual(a.fg, 1)
        self.assertFalse(b.bold)
        self.assertIsNone(b.fg)

    def test_256color(self):
        s = run("\x1b[38;5;200mX")
        self.assertEqual(s.grid[0][0].fg, 200)
        self.assertEqual(resolve_color(200, False), "#ff00d7")

    def test_truecolor(self):
        s = run("\x1b[38;2;10;20;30mX")
        self.assertEqual(s.grid[0][0].fg, (10, 20, 30))
        self.assertEqual(resolve_color((10, 20, 30), False), "#0a141e")

    def test_default_colors(self):
        self.assertEqual(resolve_color(None, False), "#aaaaaa")
        self.assertEqual(resolve_color(None, True), "#000000")

    def test_unknown_sgr_ignored(self):
        s = run("\x1b[999mX")  # must not raise, must print X
        self.assertEqual(s.row_text(0), "X")


class CursorTests(unittest.TestCase):
    def test_cup(self):
        s = run("\x1b[5;10HX")
        self.assertEqual(s.grid[4][9].ch, "X")

    def test_moves(self):
        s = run("\x1b[3;3H\x1b[2A\x1b[4C\x1b[1B\x1b[2DX")
        # start (2,2) -> up2 (0,2) -> fwd4 (0,6) -> down1 (1,6) -> back2 (1,4)
        self.assertEqual(s.grid[1][4].ch, "X")

    def test_home(self):
        s = run("hello\x1b[HX")
        self.assertEqual(s.row_text(0), "Xello")

    def test_cha(self):
        s = run("abcdef\x1b[3GX")
        self.assertEqual(s.row_text(0), "abXdef")

    def test_clamp(self):
        s = run("\x1b[999;999HX")
        self.assertEqual(s.grid[24][79].ch, "X")

    def test_save_restore(self):
        s = run("ab\x1b[sXY\x1b[uZ")
        # ab, save at (2,0), write XY -> (4,0), restore to (2,0), write Z
        self.assertEqual(s.row_text(0), "abZY")


class EraseTests(unittest.TestCase):
    def test_el_all(self):
        s = run("hello\x1b[2K")
        self.assertEqual(s.row_text(0), "")

    def test_el_right(self):
        s = run("hello\x1b[1;3H\x1b[K")
        self.assertEqual(s.row_text(0), "he")

    def test_ed_all(self):
        s = run("a\r\nb\r\nc\x1b[2J")
        self.assertEqual(s.row_text(0), "")
        self.assertEqual(s.row_text(1), "")
        self.assertEqual(s.row_text(2), "")

    def test_ed_below(self):
        # ED 0 from (0,1): rows 0 stays, rows 1..end cleared.
        s = run("a\r\nb\r\nc\x1b[2;1H\x1b[J")
        self.assertEqual(s.row_text(0), "a")
        self.assertEqual(s.row_text(1), "")
        self.assertEqual(s.row_text(2), "")


class LineEditTests(unittest.TestCase):
    def test_insert_lines(self):
        s = run("a\r\nb\x1b[1;1H\x1b[2L")
        self.assertEqual(s.row_text(0), "")
        self.assertEqual(s.row_text(2), "a")

    def test_delete_lines(self):
        s = run("a\r\nb\r\nc\x1b[1;1H\x1b[1M")
        self.assertEqual(s.row_text(0), "b")
        self.assertEqual(s.row_text(1), "c")


class AltScreenTests(unittest.TestCase):
    def test_alt_screen_roundtrip(self):
        s = run("main\x1b[?1049h" + "alt" + "\x1b[?1049l")
        self.assertEqual(s.row_text(0), "main")

    def test_alt_screen_isolated(self):
        s = run("main\x1b[?1049h")
        self.assertEqual(s.row_text(0), "")


class OscTests(unittest.TestCase):
    def test_title_bel(self):
        s = run("\x1b]0;My Title\x07")
        self.assertEqual(s.window_title, "My Title")
        self.assertTrue(s.title_dirty)

    def test_title_st(self):
        s = run("\x1b]2;Other\x1b\\")
        self.assertEqual(s.window_title, "Other")


class RobustnessTests(unittest.TestCase):
    def test_unknown_csi_ignored(self):
        s = run("a\x1b[?2004h\x1b[?2004lb")
        self.assertEqual(s.row_text(0), "ab")

    def test_unknown_esc_ignored(self):
        s = run("a\x1bZb")
        self.assertEqual(s.row_text(0), "ab")

    def test_split_feeds(self):
        # escape sequences split across feed() calls still parse
        s = Screen()
        p = AnsiParser(s)
        p.feed("\x1b[3")
        p.feed("1mR")
        self.assertEqual(s.grid[0][0].fg, 1)
        self.assertEqual(s.grid[0][0].ch, "R")

    def test_resize_keeps_text(self):
        s = run("hello")
        s.resize(30, 100)
        self.assertEqual(s.row_text(0), "hello")
        self.assertEqual((s.rows, s.cols), (30, 100))

    def test_reset(self):
        s = run("\x1b[31mhello\x1bc")
        self.assertEqual(s.row_text(0), "")
        self.assertIsNone(s.cur_fg)


if __name__ == "__main__":
    unittest.main()
