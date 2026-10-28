# python3 scripts/minidump-info.py <dump.dmp>...
# Read-only summary of BoardClip's Crashpad minidumps (Windows: %APPDATA%/BoardClip/Crashpad/reports,
# macOS: ~/Library/Application Support/BoardClip/Crashpad/pending): which process crashed (ptype),
# the exception, and the module + offset it happened in. Standard library only, so it runs on a
# Mac's system python too. Symbolize the offset with the release's breakpad symbols
# (electron-v<ver>-<platform>-<arch>-symbols.zip): the FUNC record covering it.
import struct, sys, re, os, datetime
MAC_EXC = {1: 'EXC_BAD_ACCESS', 2: 'EXC_BAD_INSTRUCTION', 3: 'EXC_ARITHMETIC', 5: 'EXC_SOFTWARE', 6: 'EXC_BREAKPOINT', 10: 'EXC_CRASH', 11: 'EXC_RESOURCE', 12: 'EXC_GUARD'}


def u32(b, o): return struct.unpack_from('<I', b, o)[0]
def u64(b, o): return struct.unpack_from('<Q', b, o)[0]


def name_at(b, rva):
    n = u32(b, rva)
    return b[rva + 4:rva + 4 + n].decode('utf-16-le', 'replace')


def summary(path):
    b = open(path, 'rb').read()
    if b[:4] != b'MDMP':
        return 'not a minidump'
    count, dir_rva = u32(b, 8), u32(b, 12)
    streams = {}
    for i in range(count):
        t, size, rva = struct.unpack_from('<III', b, dir_rva + i * 12)
        streams[t] = (size, rva)
    out = []
    # Annotations Crashpad keeps as plain strings: process type, product, version.
    text = re.findall(rb'[\x20-\x7e]{3,}', b[:4 * 1024 * 1024]) if len(b) < 8 * 1024 * 1024 else re.findall(rb'[\x20-\x7e]{3,}', b)
    keys = {}
    for i, s in enumerate(text[:-1]):
        k = s.decode()
        if k in ('ptype', 'prod', 'ver', 'plat', 'osarch', 'pid', '_productName', 'electron.v8-fatal.message', 'electron.v8-fatal.location', 'chromium-crash-message') and k not in keys:
            keys[k] = text[i + 1].decode()[:200]
    out.append('annotations ' + ' '.join(f'{k}={v}' for k, v in keys.items()))
    for s in text:
        t = s.decode()
        if re.search(r'Ineffective mark-compacts|heap limit|Check failed|NOTREACHED|out of memory|OOM', t):
            out.append('message ' + t[:200])
            break
    modules = []
    if 4 in streams:
        _, rva = streams[4]
        n = u32(b, rva)
        for i in range(n):
            m = rva + 4 + i * 108
            base, size = u64(b, m), u32(b, m + 8)
            modules.append((base, size, os.path.basename(name_at(b, u32(b, m + 20)))))
    if 6 in streams:
        _, rva = streams[6]
        tid = u32(b, rva)
        code, flags = u32(b, rva + 8), u32(b, rva + 12)
        addr = u64(b, rva + 24)
        nparams = u32(b, rva + 32)
        params = [u64(b, rva + 40 + 8 * k) for k in range(min(nparams, 4))]
        mod = next((f'{nm}+0x{addr - base:x}' for base, size, nm in modules if base <= addr < base + size), 'no module')
        label = MAC_EXC.get(code, f'0x{code:08x}')
        sig = f' signal={(flags >> 24) & 0xff}' if code == 10 else ''
        if code == 11 and len(params) > 1:  # EXC_RESOURCE: type in the top bits of code[0]
            sig = ' resource=' + {1: 'CPU', 2: 'WAKEUPS', 3: 'MEMORY', 4: 'IO', 5: 'THREADS'}.get((params[1] >> 61) & 7, '?')
        out.append(f'exception {label} code0=0x{flags:x}{sig} params={[hex(p) for p in params]} thread={tid} at 0x{addr:x} in {mod}')
    else:
        out.append('no exception stream')
    out.append(f'modules {len(modules)}: ' + ', '.join(nm for _, _, nm in modules[:6]))
    return '\n  '.join(out)


for p in sys.argv[1:]:
    st = os.stat(p)
    print(f'{os.path.basename(p)}  {st.st_size} bytes  {datetime.datetime.fromtimestamp(st.st_mtime):%Y-%m-%d %H:%M:%S}')
    try:
        print('  ' + summary(p))
    except Exception as e:
        print('  error', e)
