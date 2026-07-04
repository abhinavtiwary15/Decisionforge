#!/usr/bin/env python3
"""
validators.py
=============
Structural validation for Indian GSTINs.

A GSTIN (Goods and Services Tax Identification Number) is a 15-character
alphanumeric identifier issued to every GST-registered entity in India.
Its structure is:

  Pos 1-2  : State code  -- 2 digits, valid range 01-37
  Pos 3-7  : PAN part 1  -- 5 uppercase letters
  Pos 8-11 : PAN part 2  -- 4 digits
  Pos 12   : PAN part 3  -- 1 uppercase letter  (10-char PAN = AAAAA9999A)
  Pos 13   : Entity code -- 1 character, 1-9 or A-Z  (not '0')
  Pos 14   : Fixed 'Z'   -- always the letter Z
  Pos 15   : Checksum    -- 1 alphanumeric character (0-9 or A-Z)
                           (structural check only; arithmetic not implemented)

Normalisation: input is uppercased and stripped before validation.  The GST
portal accepts GSTINs case-insensitively, so a lowercase input that is
structurally correct must pass.

Public API
----------
validate_gstin(gstin) -> (bool, str | None)
    Returns (True, None) on success.
    Returns (False, <specific_error>) on failure.
"""

from __future__ import annotations

import re
from typing import Optional

# ---------------------------------------------------------------------------
# Compiled regex for full structural match (applied AFTER uppercasing)
# ---------------------------------------------------------------------------
# Group names mirror the GSTIN field names for clarity in error reporting.
_GSTIN_RE = re.compile(
    r"^"
    r"(?P<state>[0-9]{2})"          # positions 1-2  : 2 digits (range checked separately)
    r"(?P<pan_alpha>[A-Z]{5})"      # positions 3-7  : 5 uppercase letters
    r"(?P<pan_digits>[0-9]{4})"     # positions 8-11 : 4 digits
    r"(?P<pan_last>[A-Z])"          # position  12   : 1 uppercase letter
    r"(?P<entity>[1-9A-Z])"         # position  13   : 1-9 or A-Z (not 0)
    r"(?P<z_char>Z)"                # position  14   : must be literal 'Z'
    r"(?P<checksum>[0-9A-Z])"       # position  15   : alphanumeric checksum
    r"$"
)

# Valid state codes as a frozenset of zero-padded 2-digit strings.
# Indian states/UTs currently assigned: 01-37.
_VALID_STATE_CODES: frozenset[str] = frozenset(f"{n:02d}" for n in range(1, 38))

GSTIN_LENGTH: int = 15


# ---------------------------------------------------------------------------
# Per-segment fallback patterns used to pinpoint the first bad segment
# ---------------------------------------------------------------------------
_SEG_CHECKS = [
    # (slice_start, slice_end, pattern, error_template)
    (0,  2,  re.compile(r"^[0-9]{2}$"),  "State code '{val}' must be exactly 2 digits; "
                                          "got non-numeric characters."),
    (2,  7,  re.compile(r"^[A-Z]{5}$"),  "PAN segment (positions 3-7) must be 5 uppercase "
                                          "letters; got '{val}'."),
    (7,  11, re.compile(r"^[0-9]{4}$"),  "PAN segment (positions 8-11) must be 4 digits; "
                                          "got '{val}'."),
    (11, 12, re.compile(r"^[A-Z]$"),     "PAN segment (position 12) must be 1 uppercase "
                                          "letter; got '{val}'."),
    (12, 13, re.compile(r"^[1-9A-Z]$"),  "Entity code (position 13) must be 1-9 or A-Z "
                                          "(digit '0' is not allowed); got '{val}'."),
    (13, 14, re.compile(r"^Z$"),          "Position 14 must be the fixed letter 'Z'; "
                                          "got '{val}'."),
    (14, 15, re.compile(r"^[0-9A-Z]$"),  "Checksum (position 15) must be alphanumeric "
                                          "(0-9 or A-Z); got '{val}'."),
]


def validate_gstin(gstin: str) -> tuple[bool, Optional[str]]:
    """
    Validate the structural format of an Indian GSTIN.

    Input is normalised (stripped, uppercased) before any check.  This means
    a lowercase GSTIN that is otherwise correctly formed will return
    (True, None) -- matching the GST portal's case-insensitive behaviour.

    The checksum digit at position 15 is verified to be alphanumeric but its
    arithmetic value is NOT computed (structural check only).

    Parameters
    ----------
    gstin : str
        Raw GSTIN string from any source.

    Returns
    -------
    (True, None)
        Structure is valid.
    (False, error_message)
        Structure is invalid; error_message describes the specific problem
        with the exact bad value and position.

    Examples
    --------
    >>> validate_gstin("27AABCU9603R1ZV")
    (True, None)
    >>> validate_gstin("27aabcu9603r1zv")   # lowercase -- normalised
    (True, None)
    >>> validate_gstin("99AABCU9603R1ZV")   # state code 99 out of range
    (False, "State code '99' is out of the valid range 01-37 ...")
    """
    # ------------------------------------------------------------------
    # Step 0: type / null guard
    # ------------------------------------------------------------------
    if not gstin or not isinstance(gstin, str):
        return False, "GSTIN must be a non-empty string."

    # ------------------------------------------------------------------
    # Step 1: normalise (strip whitespace, uppercase)
    # ------------------------------------------------------------------
    normalised = gstin.strip().upper()

    # ------------------------------------------------------------------
    # Step 2: length check (most common rejection reason)
    # ------------------------------------------------------------------
    if len(normalised) != GSTIN_LENGTH:
        return (
            False,
            f"GSTIN must be exactly {GSTIN_LENGTH} characters; "
            f"got {len(normalised)} ('{normalised}').",
        )

    # ------------------------------------------------------------------
    # Step 3: full regex match
    # ------------------------------------------------------------------
    m = _GSTIN_RE.match(normalised)
    if m:
        # Regex passed -- now verify state code is in valid numeric range.
        state_code = m.group("state")
        if state_code not in _VALID_STATE_CODES:
            return (
                False,
                f"State code '{state_code}' is out of the valid range 01-37 "
                f"(assigned Indian state/UT codes).",
            )
        return True, None

    # ------------------------------------------------------------------
    # Step 4: regex failed -- walk segments to produce a specific message
    # ------------------------------------------------------------------
    # First check the state code range (may pass digit check but fail range).
    state_raw = normalised[:2]
    if re.match(r"^[0-9]{2}$", state_raw) and state_raw not in _VALID_STATE_CODES:
        return (
            False,
            f"State code '{state_raw}' is out of the valid range 01-37 "
            f"(assigned Indian state/UT codes).",
        )

    # Walk each segment pattern to find the first mismatch.
    for start, end, pattern, template in _SEG_CHECKS:
        val = normalised[start:end]
        if not pattern.match(val):
            return False, template.format(val=val)

    # Fallback: should not be reachable given the segment checks above.
    return False, f"GSTIN '{normalised}' has an unrecognised structural problem."
