#!/usr/bin/env python3
"""Display an image via Kitty graphics protocol (tmux-aware)."""

import base64
import os
import sys

CHUNK_SIZE = 4096

def send_kitty_sequence(seq: str) -> None:
    """Send a Kitty graphics sequence, wrapping for tmux if needed."""
    if os.environ.get("TMUX"):
        # DCS passthrough: double all ESC chars, wrap in \ePtmux;...\e\\
        doubled = seq.replace("\x1b", "\x1b\x1b")
        sys.stdout.write(f"\x1bPtmux;{doubled}\x1b\\")
    else:
        sys.stdout.write(seq)

def display_image(path: str) -> None:
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")

    offset = 0
    first = True
    while offset < len(b64):
        chunk = b64[offset:offset + CHUNK_SIZE]
        offset += CHUNK_SIZE
        more = 1 if offset < len(b64) else 0

        if first:
            send_kitty_sequence(f"\x1b_Ga=T,f=100,i=1,q=2,m={more};{chunk}\x1b\\")
            first = False
        else:
            send_kitty_sequence(f"\x1b_Gi=1,q=2,m={more};{chunk}\x1b\\")

    sys.stdout.write("\n")
    sys.stdout.flush()

if __name__ == "__main__":
    image = sys.argv[1] if len(sys.argv) > 1 else "/tmp/resume-placeholder.png"
    if not os.path.isfile(image):
        print(f"File not found: {image}", file=sys.stderr)
        sys.exit(1)
    display_image(image)
