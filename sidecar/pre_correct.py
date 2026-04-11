"""
pre_correct.py
Rule-based pre-correction for historical English OCR output.
Applied BEFORE OCRonos-Vintage to fix systematic character
substitution errors that the neural model won't catch.

Rules are ordered: most specific first, then more general.
All rules use regex for precision — no blind string replacement.

PHILOSOPHY: When in doubt, leave it alone.
A rule that breaks valid English is worse than no rule at all.
Only add rules for errors that are (a) systematic, (b) unambiguous,
and (c) confirmed in your actual OCR output.
"""

import re
from typing import List, Tuple

# Each rule: (regex_pattern, replacement, description)
RULES: List[Tuple[str, str, str]] = [

    # ── Scan artifacts ─────────────────────────────────────────────
    (r'[ \t]*\\[ \t]*$',             '',      'trailing backslash'),
    (r'[ \t]*\|[ \t]*$',             '',      'trailing pipe at line end'),
    (r'[ \t]*~[ \t]*$',              '',      'trailing tilde'),

    # ── Specific digit/word confusions (safe — whole words only) ───
    # 0 in specific common words
    (r'\b0ne\b',                     'one',   '0ne -> one'),
    (r'\b0ld\b',                     'old',   '0ld -> old'),
    (r'\b0ut\b',                     'out',   '0ut -> out'),
    (r'\b0ur\b',                     'our',   '0ur -> our'),
    (r'\b0f\b',                      'of',    '0f -> of'),
    (r'\b0n\b',                      'on',    '0n -> on'),
    (r'\b0r\b',                      'or',    '0r -> or'),
    # 0 between letters (safe — no English word has digit between letters)
    (r'(?<=[a-zA-Z])0(?=[a-zA-Z])', 'o',     '0 between letters -> o'),

    # 1 in specific common words (safe — whole words)
    (r'\b1t\b',                      'it',    '1t -> it'),
    (r'\b1n\b',                      'in',    '1n -> in'),
    (r'\b1s\b',                      'is',    '1s -> is'),
    (r'\b1f\b',                      'if',    '1f -> if'),
    (r'\b1ll\b',                     'ill',   '1ll -> ill'),
    # Standalone 1 not adjacent to other digits -> I
    (r'(?<![0-9])\b1\b(?![0-9])',    'I',     'standalone 1 (not in number) -> I'),
    # 1 between lowercase letters -> l
    (r'(?<=[a-z])1(?=[a-z])',        'l',     '1 between lowercase letters -> l'),

    # 6 in specific patterns
    (r'\b6ll\b',                     'fill',  '6ll -> fill'),
    (r'\b6l\b',                      'fil',   '6l -> fil'),

    # ── Character substitutions (unambiguous in context) ───────────
    # { before letter -> f  (e.g. {ruffles -> fruffles)
    (r'\{(?=[a-zA-Z])',              'f',     '{ before letter -> f'),
    # } after word character -> )
    (r'(?<=[a-zA-Z0-9])\}',          ')',     '} after word -> )'),

    # ── Specific word fixes (confirmed OCR errors) ─────────────────
    (r'\bjt\b',                      'it',    'jt -> it'),
    (r'\bJt\b',                      'It',    'Jt -> It'),
    (r'\bLis\b',                     'his',   'Lis -> his'),
    (r'\btbe\b',                     'the',   'tbe -> the'),
    (r'\btlie\b',                    'the',   'tlie -> the'),
    (r'\btile\b',                    'the',   'tile -> the (OCR artifact)'),
    (r'\bthc\b',                     'the',   'thc -> the'),
    (r'\bbave\b',                    'have',  'bave -> have'),
    (r'\bbim\b',                     'him',   'bim -> him'),
    (r'\btbat\b',                    'that',  'tbat -> that'),
    (r'\bwhicb\b',                   'which', 'whicb -> which'),
    (r'\bwbich\b',                   'which', 'wbich -> which'),
    (r'\bwbo\b',                     'who',   'wbo -> who'),
    (r'\byonr\b',                    'your',  'yonr -> your'),
    (r'\byon\b',                     'you',   'yon -> you (OCR artifact)'),
    (r'\b1ou\b',                     'you',   '1ou -> you'),
    (r'\b1our\b',                    'your',  '1our -> your'),

    # ── Personal pronoun I / T confusion ───────────────────────────
    # Only fire on T in positions where it unambiguously = I.
    # Do NOT use a general \bT\b rule — it fires on initials.
    (r'(?<=—)T(?=\s)',               'I',     '—T[space] -> —I'),
    (r'(?:^|(?<=\n))T(?=\s)',        'I',     'line-initial T[space] -> I'),

    # ── Punctuation cleanup ─────────────────────────────────────────
    (r' ,',                          ',',     'space before comma'),
    (r' \.',                         '.',     'space before period'),
    (r' ;',                          ';',     'space before semicolon'),
    (r'--+',                         '—',     'multiple dashes -> em dash'),

    # ── Hyphenation (soft hyphen across line break) ─────────────────
    # Only join lowercase-to-lowercase to avoid joining proper nouns.
    (r'([a-z])-\s*\n\s*([a-z])',    r'\1\2', 'soft hyphen join (lowercase)'),
]


def apply(text: str) -> str:
    """Apply all pre-correction rules to OCR text."""
    for pattern, replacement, _ in RULES:
        text = re.sub(pattern, replacement, text, flags=re.MULTILINE)
    return text


def apply_with_log(text: str) -> Tuple[str, List[str]]:
    """Apply rules and return (corrected_text, list_of_applied_rules)."""
    applied = []
    for pattern, replacement, desc in RULES:
        new_text = re.sub(pattern, replacement, text, flags=re.MULTILINE)
        if new_text != text:
            applied.append(desc)
        text = new_text
    return text, applied