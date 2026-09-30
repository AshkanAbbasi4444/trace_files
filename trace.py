import gdb, json, os, re

START     = "main"
MAX_STEPS = 4000
NODE_MAX  = 64
CHUNK_MAX = 200
FRAME_MAX = 512                        # most bytes of one stack frame to record
STDOUT    = "prog_stdout.txt"
WATCH_MAX = 4                          # x86-64 CPUs have 4 hardware watchpoints, 8 bytes each

steps, KNOWN, FREED = [], {}, set()   # KNOWN: addr -> struct name
ALLOCED = set()                        # every address malloc/calloc/realloc handed to the program
FREE_ORDER = []                        # addresses in the order free() got them, newest last
LIBCALLS = []                          # library calls since the last snapshot, and what the watchpoints caught
WPS = []                               # the watchpoints armed right now
watch_ok = True                        # False once the CPU refuses a hardware watchpoint
our_file = None

def is_ptr(t):  return t.strip_typedefs().code == gdb.TYPE_CODE_PTR
def scalar(t):  return t.strip_typedefs().code in (gdb.TYPE_CODE_INT, gdb.TYPE_CODE_ENUM,
                                                   gdb.TYPE_CODE_CHAR, gdb.TYPE_CODE_BOOL)
def struct_of(t):
    t = t.strip_typedefs()
    if t.code != gdb.TYPE_CODE_PTR: return None
    tgt = t.target().strip_typedefs()
    return tgt if tgt.code == gdb.TYPE_CODE_STRUCT else None
def raw(addr, size):
    """size bytes at addr, as hex, lowest address first"""
    if not addr or size <= 0: return None
    try: return bytes(gdb.selected_inferior().read_memory(addr, size)).hex()
    except gdb.error: return None

# ---- watch the allocator, without stopping ----
class MallocRet(gdb.FinishBreakpoint):
    def __init__(self, frame): super().__init__(frame, internal=True)
    def stop(self):
        try:
            a = int(gdb.parse_and_eval("$rax"))                  # the address it just returned
            FREED.discard(a); ALLOCED.add(a)
        except Exception: pass
        return False
class Malloc(gdb.Breakpoint):                     # malloc, calloc and realloc all hand out blocks
    def __init__(self, fn="malloc"): super().__init__(fn, internal=True)
    def stop(self):
        try: MallocRet(gdb.newest_frame())
        except Exception: pass
        return False
class Free(gdb.Breakpoint):
    def __init__(self): super().__init__("free", internal=True)
    def stop(self):
        try:
            a = int(gdb.parse_and_eval("$rdi")); FREED.add(a); FREE_ORDER.append(a)
        except Exception: pass
        return False

# ---- real gdb watchpoints: catch what a library call (free, malloc, strcpy ...) writes into your memory ----
def ours(frame):
    try:
        s = frame.find_sal()
        return bool(s.symtab) and s.symtab.filename == our_file
    except gdb.error: return False

class Watch(gdb.Breakpoint):
    """a hardware watchpoint on one 8-byte word: the CPU stops the program the moment something writes it"""
    def __init__(self, addr, call):
        super().__init__("*(long *) %d" % addr, gdb.BP_WATCHPOINT, gdb.WP_WRITE, internal=True)
        self.addr, self.call, self.old = addr, call, raw(addr, 8)
    def stop(self):
        try:
            new, f = raw(self.addr, 8), gdb.newest_frame()
            if new != self.old and not ours(f):                  # only writes made inside the library
                self.call["writes"].append({"addr": self.addr, "size": 8, "old": self.old, "new": new, "in": f.name()})
            self.old = new
        except Exception: pass
        return False

def disarm():
    """delete every watchpoint, even one the CPU refused half-way"""
    del WPS[:]
    for b in gdb.breakpoints():
        try:
            if b.type in (gdb.BP_WATCHPOINT, gdb.BP_HARDWARE_WATCHPOINT): b.delete()
        except (gdb.error, RuntimeError): pass

def reg(r): return int(gdb.parse_and_eval("(unsigned long) $" + r))
def chunk_size(p):
    """the size malloc wrote in the header just above the block at p"""
    b = raw(p - 8, 8)
    return int.from_bytes(bytes.fromhex(b), "little") & ~7 if b else 0

def user_mem(p):
    """[start, end) of your variable or heap block that p points into, or None"""
    if not steps or p < 4096: return None
    s = steps[-1]
    for n in s["heap"]:
        if not n["freed"] and n["addr"] <= p < n["addr"] + n["size"]: return n["addr"], n["addr"] + n["size"]
    for fr in s["frames"]:
        for v in fr["vars"]:
            if v["addr"] and v["addr"] <= p < v["addr"] + v["size"]: return v["addr"], v["addr"] + v["size"]
    return None

def plan(func):
    """which 8-byte words this call is likely to write, most likely first"""
    a = [reg(r) for r in ("rdi", "rsi", "rdx", "rcx")]
    if func == "free":                                    # the block's first 2 words, and the next chunk's header
        if not a[0]: return []
        nxt = a[0] - 16 + chunk_size(a[0])
        return [a[0], a[0] + 8, nxt, nxt + 8]
    if func in ("malloc", "calloc", "realloc"):          # malloc hands back the newest freed block of the right size
        n = {"malloc": a[0], "calloc": a[0] * a[1], "realloc": a[1]}[func]
        want, seen, out = max(32, (n + 8 + 15) & ~15), set(), []
        if func == "realloc" and a[0]: out += [a[0], a[0] + 8]
        for p in reversed(FREE_ORDER):
            if p in FREED and p not in seen and chunk_size(p) == want: seen.add(p); out += [p, p + 8]
        return out
    out = []                                              # anything else: the memory its pointer arguments point into
    for p in a:
        m = user_mem(p)
        if m: out += list(range(p - p % 8, min(m[1], p + 8 * WATCH_MAX), 8))
    return out

ALLOCS = ("malloc", "calloc", "realloc", "free")

def arm(func, line):
    global watch_ok
    disarm()
    call = {"func": func, "line": line, "arg": reg("rdi"), "watched": [], "writes": []}
    for w in plan(func):
        if len(WPS) >= WATCH_MAX or not watch_ok: break
        if w in call["watched"] or not raw(w, 8): continue
        try: WPS.append(Watch(w, call)); call["watched"].append(w)
        except (gdb.error, RuntimeError):                 # the CPU has no room: go on without watchpoints
            watch_ok = False; disarm(); del call["watched"][:]
    if call["watched"]: LIBCALLS.append(call)

class LibCall(gdb.Breakpoint):
    """sits on a `call free@plt` in your code, and arms watchpoints just before the library runs"""
    def __init__(self, pc, func, line):
        super().__init__("*%d" % pc, internal=True)
        self.func, self.line = func, line
    def stop(self):
        try: arm(self.func, self.line)
        except Exception: pass
        return False

def lib_calls():
    """every call from your code into a library, as (address, function, line)"""
    blk = gdb.selected_frame().find_sal().symtab.static_block()
    for ins in gdb.selected_frame().architecture().disassemble(blk.start, blk.end - 1):
        m = re.search(r"\bcall\b.*<([\w.]+)@plt>", ins["asm"])
        if m: yield ins["addr"], re.sub(r"^__isoc99_", "", m.group(1)), gdb.find_pc_line(ins["addr"]).line

def read_block(addr, stname):
    t = gdb.lookup_type(stname)
    v = gdb.Value(addr).cast(t.pointer()).dereference()
    fields = []
    for f in t.fields():
        if f.name is None: continue
        fv = v[f.name]; ft = fv.type.strip_typedefs()
        if ft.code == gdb.TYPE_CODE_PTR:   kind, val = "ptr", int(fv)
        elif scalar(ft):                   kind, val = "int", int(fv)
        else:                              kind, val = "other", None
        fields.append({"name": f.name, "type": str(f.type), "kind": kind, "value": val,
                       "offset": f.bitpos // 8, "size": f.type.sizeof,
                       "target": str(ft.target()) if kind == "ptr" else None})
    return {"addr": addr, "type": stname, "fields": fields, "freed": False,
            "size": t.sizeof, "bytes": raw(addr, t.sizeof),
            "header": raw(addr - 16, 16)}          # malloc's chunk header

def frame_mem(frame, vars_):
    """the frame's own bytes, up to just past the return address (x86-64, -O0). A function that calls
       nothing may keep its locals below rsp (the red zone), so start at the lowest variable if that's lower."""
    try:
        rbp = int(frame.read_register("rbp")); rsp = int(frame.read_register("rsp"))
        if not (0 < rsp <= rbp): return {}
        lo = min([rsp] + [v["addr"] for v in vars_ if v.get("addr") and v["addr"] < rbp])
        lo -= lo % 8
        if rbp + 16 - lo > FRAME_MAX: return {}
        return {"rbp": rbp, "rsp": rsp, "lo": lo, "frame_bytes": raw(lo, rbp + 16 - lo)}
    except (gdb.error, ValueError): return {}

def collect_vars(frame):
    out, block = [], frame.block()
    while block and not block.is_static:
        for sym in block:
            if not (sym.is_variable or sym.is_argument): continue
            try:
                v = sym.value(frame); t = v.type; st = struct_of(t)
                a = int(v.address) if v.address else None
                out.append({"name": sym.name, "type": str(t), "addr": a,
                            "value": int(v) if (is_ptr(t) or scalar(t)) else None,
                            "kind": "ptr" if is_ptr(t) else ("int" if scalar(t) else "other"),
                            "struct": str(st) if st else None,
                            "size": t.sizeof, "bytes": raw(a, t.sizeof),
                            "arg": bool(sym.is_argument),      # parameters start with real values
                            "target": str(t.strip_typedefs().target()) if is_ptr(t) else None,   # one star down
                            "decl": sym.line})                 # the line it was declared on
            except gdb.error: pass
        if block.function: break
        block = block.superblock
    return out

def signature(frame):
    """the function's C signature, like: void remove_elements_ref(struct ListNode **head, int val)"""
    try:
        blk = frame.block()
        while blk and not blk.function: blk = blk.superblock
        join = lambda t, n: t + ("" if t.endswith("*") else " ") + n
        ps = [join(str(sym.type), sym.name) for sym in blk if sym.is_argument]
        return "%s(%s)" % (join(str(frame.function().type.target()), frame.name()), ", ".join(ps))
    except (gdb.error, AttributeError, RuntimeError): return None

def returned(name):
    """what function `name` just handed back: on x86-64 it's still in rax, so read it as the return type"""
    try:
        sym = gdb.lookup_global_symbol(name) or gdb.lookup_symbol(name)[0]
        rt = sym.type.target()
        if rt.code == gdb.TYPE_CODE_VOID: return None
        return {"func": name, "type": str(rt), "value": int(gdb.parse_and_eval("$rax").cast(rt))}
    except (gdb.error, AttributeError, TypeError, RuntimeError): return None

def discover(vars_, real=lambda a: True):
    """remember every block reachable from these variables, following all pointer fields;
       real(addr) says whether a real block starts there, so leftover pointers can't invent one"""
    queue = [(v["value"], v["struct"]) for v in vars_ if v["struct"] and v["value"]]
    while queue and len(KNOWN) < NODE_MAX:
        addr, stname = queue.pop(0)
        if not addr or addr in KNOWN or addr in FREED or not real(addr): continue
        try: b = read_block(addr, stname)
        except gdb.error: continue
        KNOWN[addr] = stname
        for f in b["fields"]:
            if f["kind"] == "ptr" and f["value"]: queue.append((f["value"], stname))

def heap_now():
    """every block we have ever seen — freed ones too, with their bytes as they are now"""
    out = []
    for addr, stname in KNOWN.items():
        try: b = read_block(addr, stname)
        except gdb.error: continue
        b["freed"] = addr in FREED
        out.append(b)
    return sorted(out, key=lambda b: b["addr"])

def heap_bounds():
    """start and end of the [heap] mapping, or None before the first malloc"""
    try:
        with open("/proc/%d/maps" % gdb.selected_inferior().pid) as fh:
            for line in fh:
                if line.rstrip().endswith("[heap]"):
                    lo, hi = line.split()[0].split("-")
                    return int(lo, 16), int(hi, 16)
    except (IOError, ValueError): pass
    return None

def buffer_of(stream):
    """where stdin's or stdout's buffer is: FILE._IO_buf_base, offset 0x38 on x86-64 glibc"""
    try: return int(gdb.parse_and_eval("*(long *)(*(char **) &%s + 0x38)" % stream))
    except gdb.error: return 0

def chunks_now():
    """walk the heap chunk by chunk, using each chunk's size field"""
    b = heap_bounds()
    if not b: return []
    lo, hi = b
    bufs = {buffer_of("stdout"): "stdout", buffer_of("stdin"): "stdin"}
    out, p = [], lo
    while p + 16 <= hi and len(out) < CHUNK_MAX:
        try: size = int.from_bytes(bytes(gdb.selected_inferior().read_memory(p + 8, 8)), "little") & ~7
        except gdb.error: break
        if size < 32 or p + size > hi: break                 # not a sane chunk: stop walking
        user = p + 16
        if p + size == hi: state = "top"                     # the rest of the heap: not allocated
        elif user in FREED: state = "freed"
        else: state = "used"
        what = "tcache" if p == lo and size in (0x250, 0x290) else bufs.get(user)
        if not what and state == "used" and user not in ALLOCED: what = "malloc"   # malloc's own, never handed to you
        out.append({"addr": user, "size": size, "state": state, "what": what})
        if state == "top": break
        p += size
    return out

def in_our_file():
    try: return ours(gdb.selected_frame())
    except gdb.error: return False

def console():
    try:
        with open(STDOUT) as fh: return fh.read()
    except IOError: return ""

def snapshot():
    frame = gdb.selected_frame(); sal = frame.find_sal()
    frames, f = [], frame
    while f:
        s = f.find_sal()
        if s.symtab and s.symtab.filename == our_file:
            fr = {"func": f.name(), "at": s.line, "sig": signature(f), "vars": collect_vars(f)}
            fr.update(frame_mem(f, fr["vars"]))                    # return address, saved rbp, unused slots
            frames.append(fr)
        f = f.older()
    chunks = chunks_now()
    starts = {c["addr"] for c in chunks if c["state"] == "used"}       # where real malloc'd blocks start
    locals_ = {v["addr"] for fr in frames for v in fr["vars"]            # structs living on the stack
               if v["kind"] == "other" and v["type"].startswith("struct ") and "[" not in v["type"]}
    real = (lambda a: a in starts or a in locals_) if chunks else (lambda a: True)
    for fr in frames: discover(fr["vars"], real)
    ret = None
    if steps and len(frames) < len(steps[-1]["frames"]):           # a function just returned
        ret = returned(steps[-1]["frames"][0]["func"])
    steps.append({"line": sal.line, "func": frame.name(), "frames": frames,
                  "heap": heap_now(), "chunks": chunks, "ret": ret, "out": console(),
                  "lib": [c for c in LIBCALLS if c["writes"] or c["func"] in ALLOCS]})   # what the watchpoints caught
    del LIBCALLS[:]

class NoWatch(Exception): pass
def run(cmd):
    try: t = gdb.execute(cmd, to_string=True)
    except gdb.error as e:
        if "Could not insert hardware" in str(e): raise NoWatch()
        raise
    if "Could not insert hardware" in t: raise NoWatch()    # gdb stopped half-way through the line

def advance():
    """run one line of your code; library code runs to the end without stopping"""
    run("step")
    while not in_our_file():
        run("finish")

gdb.execute("set pagination off"); gdb.execute("set confirm off")
gdb.execute("break " + START)
gdb.execute("run > " + STDOUT)
our_file = gdb.selected_frame().find_sal().symtab.filename
try:
    gdb.execute("call (int) setvbuf(*(void **) &stdout, (char *) 0, 2, (unsigned long) 0)", to_string=True)
except gdb.error:
    pass
for fn in ("malloc", "calloc", "realloc"):
    try: Malloc(fn)
    except (gdb.error, RuntimeError): pass
Free()
for pc, fn, line in lib_calls():
    try: LibCall(pc, fn, line)
    except (gdb.error, RuntimeError): pass

for _ in range(MAX_STEPS):
    try:
        snapshot()
        try: advance()
        except NoWatch:                                     # this CPU can't: finish the line without watchpoints
            disarm(); watch_ok = False; del LIBCALLS[:]
            advance()
    except gdb.error:
        break
    finally:
        disarm()

out = os.path.splitext(os.path.basename(gdb.current_progspace().filename))[0] + ".json"
with open(out, "w") as fh: json.dump({"file": our_file, "allocs_tracked": True, "watchpoints": watch_ok, "steps": steps}, fh)
print("wrote %s with %d steps" % (out, len(steps)))
