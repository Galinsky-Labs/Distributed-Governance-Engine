#!/usr/bin/env python3
"""Install exact upstream CLI binaries after pinned-archive verification (Linux x86_64)."""
import hashlib
import io
import os
from pathlib import Path
import platform
import sys
import tarfile
import urllib.request

TOOLS = [
    ('wasm-bindgen', '0.2.130',
     'https://github.com/wasm-bindgen/wasm-bindgen/releases/download/0.2.130/wasm-bindgen-0.2.130-x86_64-unknown-linux-musl.tar.gz',
     '9687f3bb551b9f66f37ed32a40d7913a00f7962db653054e56857bc306c3227f'),
    ('cargo-audit', '0.22.2',
     'https://github.com/rustsec/rustsec/releases/download/cargo-audit/v0.22.2/cargo-audit-x86_64-unknown-linux-musl-v0.22.2.tgz',
     '7fb9497f8594b389e5fce5ef9b92db08432996895b2e0c5a0167a69ed445c428'),
]


def install(destination):
    if platform.system() != 'Linux' or platform.machine() != 'x86_64':
        raise RuntimeError('Pinned CLI archives require Linux x86_64; use the documented locked Cargo installation elsewhere')
    destination.mkdir(mode=0o700, parents=True, exist_ok=False)
    for name, version, url, checksum in TOOLS:
        with urllib.request.urlopen(url, timeout=60) as response:
            data = response.read(64_000_001)
        if len(data) > 64_000_000 or hashlib.sha256(data).hexdigest() != checksum:
            raise RuntimeError('Pinned upstream CLI archive verification failed')
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
            candidates = [member for member in archive.getmembers() if member.isfile() and member.name.rsplit('/', 1)[-1] == name]
            if len(candidates) != 1 or candidates[0].size > 100_000_000:
                raise RuntimeError('Unexpected CLI archive layout')
            contents = archive.extractfile(candidates[0]).read()
        descriptor = os.open(destination / name, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o755)
        with os.fdopen(descriptor, 'wb') as handle:
            handle.write(contents)
        print('Verified upstream CLI: ' + name + ' ' + version, flush=True)


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise RuntimeError('Supply a new user-owned tool directory')
        install(Path(sys.argv[1]))
    except Exception:
        # A failed redirect can carry a signed download URL; never echo it.
        print('Pinned MLS tool installation failed; no archive checksum or TLS check was bypassed.', file=sys.stderr)
        raise SystemExit(1)
