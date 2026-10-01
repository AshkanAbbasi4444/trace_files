# StackFrameDraw.py
#
# Draw every function's stack frame as a single self-contained HTML page.
# For each function it stacks the locals, the saved frame pointer and the
# return address as boxes (highest address on top), shows how many bytes
# separate each buffer from the return address, and flags functions that
# call a dangerous libc routine (gets, scanf, strcpy, ...).
#
# Works in BOTH Ghidra Python runtimes:
#   - old Ghidra: Jython (Python 2.7)
#   - new Ghidra: PyGhidra (Python 3)
# So: no f-strings, no type hints, only % / .format(), and guarded imports.
#
# Run it from the Script Manager (GUI) or headless; see ghidra/README.md.
#
# @category Analysis.StackFrame
# @menupath Tools.Stack Frame Draw

import os

# Ghidra type used to tell an array (a buffer) apart from a scalar. Guarded so
# that a class rename in some Ghidra version can't stop the whole script.
try:
    from ghidra.program.model.data import Array
except:
    Array = None

# Library functions that make stack buffer overflows easy. A function that
# calls any of these gets a red badge.
DANGEROUS = ["gets", "scanf", "strcpy", "strcat", "sprintf", "memcpy"]


# ---------------------------------------------------------------------------
# 1. Names: clean up a called symbol so fortified / versioned variants match.
#    __isoc99_scanf -> scanf,  __strcpy_chk -> strcpy,  memcpy@GLIBC -> memcpy
# ---------------------------------------------------------------------------
def clean_name(name):
    n = name
    at = n.find("@")                      # drop version: strcpy@GLIBC_2.2.5
    if at >= 0:
        n = n[:at]
    ns = n.rfind("::")                    # drop namespace: EXTERNAL::strcpy
    if ns >= 0:
        n = n[ns + 2:]
    if n.startswith("__isoc99_"):         # __isoc99_scanf -> scanf
        n = n[len("__isoc99_"):]
    while n.startswith("_"):              # __strcpy_chk -> strcpy_chk
        n = n[1:]
    if n.endswith("_chk"):                # strcpy_chk -> strcpy (fortified)
        n = n[:-4]
    return n


def called_function_names(func, monitor):
    """Every function name this function calls (resolving thunks/PLT)."""
    names = set()
    got = False
    try:
        # Preferred API: resolves thunks and external PLT stubs for us.
        for c in func.getCalledFunctions(monitor):
            names.add(c.getName())
        got = True
    except:
        got = False
    if not got:
        # Fallback for very old Ghidra: scan call references in the body.
        try:
            prog = func.getProgram()
            fm = prog.getFunctionManager()
            insts = prog.getListing().getInstructions(func.getBody(), True)
            for ins in insts:
                for ref in ins.getReferencesFrom():
                    if ref.getReferenceType().isCall():
                        tgt = fm.getFunctionAt(ref.getToAddress())
                        if tgt is not None:
                            names.add(tgt.getName())
        except:
            pass
    return names


def dangerous_hits(names):
    """Which dangerous functions this function calls, sorted."""
    hits = []
    for nm in names:
        c = clean_name(nm)
        if c in DANGEROUS and c not in hits:
            hits.append(c)
    hits.sort()
    return hits


def has_canary(names):
    """True if the compiler added a stack protector (calls __stack_chk_fail)."""
    for nm in names:
        if "stack_chk" in nm:
            return True
    return False


# ---------------------------------------------------------------------------
# 2. Rows: stack variables + synthesized saved-fp / return-address / canary.
#    Ghidra's stack offsets: return address at getReturnAddressOffset()
#    (0 on x86), the saved frame pointer one pointer below it, locals more
#    negative (lower addresses). Positive offsets are the caller's stack args.
# ---------------------------------------------------------------------------
def is_array(dt):
    if Array is not None:
        try:
            if isinstance(dt, Array):
                return True
        except:
            pass
    try:                                   # fallback: type name like "char[64]"
        return "[" in dt.getName()
    except:
        return False


def collect_rows(func, ptr, is_x86, canary):
    """Return (rows, ret_off, rbp_off). rows are dicts, highest address last."""
    frame = func.getStackFrame()
    ret_off = frame.getReturnAddressOffset()
    rbp_off = ret_off - ptr                # where the saved frame pointer sits
    canary_off = rbp_off - ptr             # GCC's canary slot, just below it
    rows = []
    occupied = set()

    # 2a. real stack variables Ghidra recovered
    for var in frame.getStackVariables():
        try:
            off = var.getStackOffset()
            size = var.getLength()
            dt = var.getDataType()
            rows.append({"name": var.getName(), "off": off, "size": size,
                         "type": dt.getDisplayName(),
                         "kind": "buffer" if is_array(dt) else "var"})
            for b in range(off, off + size):
                occupied.add(b)
        except:
            pass

    # 2b. label an existing pointer-sized slot right below saved rbp as canary
    if canary and is_x86:
        for r in rows:
            if r["off"] == canary_off and r["size"] == ptr:
                r["kind"] = "canary"

    # 2c. synthesize the canary if the compiler used one but Ghidra named none
    if canary and is_x86 and canary_off not in occupied:
        rows.append({"name": "stack canary", "off": canary_off, "size": ptr,
                     "type": "canary (inferred)", "kind": "canary"})

    # 2d. synthesize saved frame pointer (x86 only) and the return address
    if is_x86 and rbp_off not in occupied:
        rows.append({"name": "saved rbp" if ptr == 8 else "saved ebp",
                     "off": rbp_off, "size": ptr, "type": "saved frame pointer",
                     "kind": "savedfp"})
    if ret_off not in occupied:
        rows.append({"name": "return address", "off": ret_off, "size": ptr,
                     "type": "return address", "kind": "ret"})

    # 2e. highest address on top
    rows.sort(key=lambda r: r["off"], reverse=True)
    return rows, ret_off, rbp_off


# ---------------------------------------------------------------------------
# 3. HTML helpers
# ---------------------------------------------------------------------------
def esc(s):
    s = str(s)
    s = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return s.replace('"', "&quot;")


def rel(off, rbp_off, ptr):
    """Offset shown relative to the frame pointer, e.g. rbp-0x40."""
    base = "rbp" if ptr == 8 else "ebp"
    d = off - rbp_off
    if d == 0:
        return base
    if d > 0:
        return base + "+0x%x" % d
    return base + "-0x%x" % (-d)


def box_height(size):
    """Box height proportional to size, with a floor and a ceiling."""
    h = size * 3
    if h < 30:
        h = 30
    if h > 160:
        h = 160
    return h


def render_card(func, rows, ret_off, rbp_off, ptr, hits):
    out = []
    out.append('<section class="card">')
    out.append('<div class="fname">%s <span class="addr">@ %s</span></div>'
               % (esc(func.getName()), esc(func.getEntryPoint())))
    if hits:
        out.append('<div class="badge">&#9888; calls %s</div>'
                   % esc(", ".join(hits)))
    out.append('<div class="frame">')
    if not rows:
        out.append('<div class="empty">no stack frame recovered</div>')
    for r in rows:
        off_txt = rel(r["off"], rbp_off, ptr)
        meta = "%s &middot; %d B &middot; %s" % (esc(off_txt), r["size"],
                                                 esc(r["type"]))
        dist = ""
        if r["kind"] == "buffer":
            # bytes from the buffer's start up to the return address: the
            # overflow distance an attacker must cover.
            d = ret_off - r["off"]
            dist = ('<span class="dist">&uarr; %d bytes to return address</span>'
                    % d)
        out.append('<div class="box %s" style="height:%dpx">'
                   '<span class="bx-name">%s</span>'
                   '<span class="bx-meta">%s</span>%s</div>'
                   % (r["kind"], box_height(r["size"]), esc(r["name"]),
                      meta, dist))
    out.append('</div></section>')
    return "".join(out)


# All colours are light backgrounds with dark text (light mode only).
CSS = """
:root{color-scheme:light}
*{box-sizing:border-box}
html,body{margin:0;background:#ffffff;color:#1b2733;
  font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
header{padding:16px 22px;border-bottom:1px solid #d8dee6;background:#f6f8fa}
h1{margin:0 0 4px;font-size:18px;color:#1b2733}
.sub{color:#5b6b7b;font-size:13px}
.legend{display:flex;flex-wrap:wrap;gap:14px;margin:12px 0 0;font-size:12px}
.legend span{display:inline-flex;align-items:center;gap:6px;color:#3a4a5a}
.sw{width:14px;height:14px;border-radius:3px;border:1px solid #9aa7b4;display:inline-block}
.grid{display:flex;flex-wrap:wrap;gap:18px;padding:22px;align-items:flex-start}
.card{border:1px solid #d8dee6;border-radius:10px;background:#fcfdff;
  width:320px;padding:12px 12px 14px;box-shadow:0 1px 2px rgba(20,33,61,.05)}
.fname{font:600 14px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color:#14213d;word-break:break-all}
.addr{color:#8a97a5;font-weight:400;font-size:12px}
.badge{display:inline-block;margin:8px 0 2px;padding:2px 9px;border-radius:999px;
  background:#fdECEC;border:1px solid #e8a9a3;color:#922b21;font-size:12px;
  font-weight:600}
.frame{margin-top:10px;border:1px dashed #c4ccd6;border-radius:8px;padding:6px;
  background:#ffffff}
.box{position:relative;margin:5px 0;padding:6px 10px;border-radius:6px;
  border:1px solid #aeb6bf;border-left-width:5px;background:#f4f6f9;
  color:#2c3e50;overflow:hidden;display:flex;flex-direction:column;
  justify-content:center}
.bx-name{font:600 13px ui-monospace,Menlo,Consolas,monospace}
.bx-meta{font:11px ui-monospace,Menlo,Consolas,monospace;color:#5b6b7b}
.dist{position:absolute;right:8px;top:6px;font-size:11px;font-weight:600;
  color:#7D6608;background:#fdf6e3;border:1px solid #e3d08a;border-radius:4px;
  padding:1px 6px}
.box.buffer{background:#fdf6e3;border-color:#d4ac0d;color:#7D6608}
.box.canary{background:#f4ecf7;border-color:#8e44ad;color:#5b2c6f}
.box.savedfp{background:#e7f0ff;border-color:#2e6da4;color:#1f4e79}
.box.ret{background:#fdecec;border-color:#c0392b;color:#922b21}
.empty{color:#8a97a5;font-size:12px;padding:6px}
"""


def build_html(prog_name, cards, n_funcs, n_flagged):
    sw = ('<span><i class="sw" style="background:#fdf6e3;border-color:#d4ac0d">'
          '</i>buffer (array)</span>'
          '<span><i class="sw" style="background:#f4ecf7;border-color:#8e44ad">'
          '</i>stack canary</span>'
          '<span><i class="sw" style="background:#e7f0ff;border-color:#2e6da4">'
          '</i>saved rbp</span>'
          '<span><i class="sw" style="background:#fdecec;border-color:#c0392b">'
          '</i>return address</span>'
          '<span><i class="sw" style="background:#f4f6f9">'
          '</i>local variable</span>')
    parts = []
    parts.append("<!doctype html><html lang=\"en\"><head>")
    parts.append('<meta charset="utf-8">')
    parts.append('<meta name="viewport" content="width=device-width,'
                 'initial-scale=1">')
    parts.append('<meta name="color-scheme" content="light">')
    parts.append("<title>Stack frames: %s</title>" % esc(prog_name))
    parts.append("<style>%s</style></head><body>" % CSS)
    parts.append("<header><h1>Stack frames &mdash; %s</h1>" % esc(prog_name))
    parts.append('<div class="sub">%d function%s, %d calling a dangerous '
                 'routine. Highest address on top; each box is sized by its '
                 'byte count.</div>'
                 % (n_funcs, "" if n_funcs == 1 else "s", n_flagged))
    parts.append('<div class="legend">%s</div></header>' % sw)
    parts.append('<div class="grid">')
    parts.append("".join(cards))
    parts.append("</div></body></html>")
    return "".join(parts)


# ---------------------------------------------------------------------------
# 4. Where to write the file: ask, else drop it next to the binary.
# ---------------------------------------------------------------------------
def choose_path(prog):
    path = None
    try:
        sel = askFile("Save stack-frame HTML", "Save")   # GUI prompt
        if sel is not None:
            path = sel.getAbsolutePath()
    except:
        path = None                        # headless / cancelled: fall through
    if path:
        return path
    exe = None
    try:
        exe = prog.getExecutablePath()
    except:
        exe = None
    folder = os.path.dirname(exe) if exe else os.getcwd()
    if not folder:
        folder = os.getcwd()
    return os.path.join(folder, prog.getName() + "_stackframes.html")


# ---------------------------------------------------------------------------
# 5. Main: loop over functions, build cards, write the page.
# ---------------------------------------------------------------------------
def run(prog, monitor):
    ptr = prog.getDefaultPointerSize()
    proc = ""
    try:
        proc = prog.getLanguage().getProcessor().toString().lower()
    except:
        try:
            proc = str(prog.getLanguage().getLanguageDescription()
                       .getProcessor()).lower()
        except:
            proc = ""
    is_x86 = "x86" in proc                  # saved rbp/ebp applies to x86

    cards = []
    n_funcs = 0
    n_flagged = 0
    for func in prog.getFunctionManager().getFunctions(True):
        # 1. skip imports and PLT/thunk stubs
        if func.isExternal() or func.isThunk():
            continue
        n_funcs += 1
        names = called_function_names(func, monitor)
        hits = dangerous_hits(names)
        if hits:
            n_flagged += 1
        rows, ret_off, rbp_off = collect_rows(func, ptr, is_x86,
                                              has_canary(names))
        cards.append(render_card(func, rows, ret_off, rbp_off, ptr, hits))

    html = build_html(prog.getName(), cards, n_funcs, n_flagged)
    out_path = choose_path(prog)
    fh = open(out_path, "w")
    try:
        fh.write(html)
    finally:
        fh.close()
    return out_path, n_funcs, n_flagged


# Ghidra injects currentProgram, monitor, askFile and println into the script's
# globals. Run and report; wrap so a failure prints clearly.
try:
    _out, _nf, _flag = run(currentProgram, monitor)
    println("StackFrameDraw: wrote %s (%d functions, %d flagged)"
            % (_out, _nf, _flag))
except Exception as _e:
    try:
        println("StackFrameDraw failed: %s" % _e)
    except:
        print("StackFrameDraw failed: %s" % _e)
    raise
