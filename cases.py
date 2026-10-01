"""The edge-case tester behind POST /cases.

It finds the functions in your code that take a linked list (struct ListNode * or struct ListNode **),
writes a test main for each case (build the list, call your function, print the list it left, free what is
still in it), compiles it with gcc -g -fsanitize=address and runs it for at most 2 seconds. Then it turns
AddressSanitizer's report into plain words.

Requests (JSON):
  {"code": ..., "list": true}                                   -> {"functions": [...]}
  {"code": ..., "func": ..., "args": {...}, "cases": [...]}     -> {"results": [...]} or {"error": gcc's message}
  {"code": ..., "func": ..., "args": {...}, "trace": [1, 1, 2]} -> {"program": ..., "shown": ...}
     program: the same test without -fsanitize, to send to /run; shown: the part of it the viewer shows
"""
import json, os, re, resource, shutil, subprocess, tempfile
from concurrent.futures import ThreadPoolExecutor

TIMEOUT = 2                 # seconds per case
OUT_MAX = 1 << 20           # a case that prints more than 1 MB is stopped
ASAN_OPTIONS = "detect_leaks=1:halt_on_error=1:hard_rss_limit_mb=512:allocator_may_return_null=1:print_summary=0"
SCALAR = re.compile(r"(unsigned |signed )?(int|char|short|long|long long|long int|unsigned)")


# ---------- reading your code ----------
def blank(code):
    """comments and string/char literals replaced by spaces, so their braces and words don't count"""
    def sp(m): return re.sub(r"[^\n]", " ", m.group(0))
    return re.sub(r'//[^\n]*|/\*.*?\*/|"(?:\\.|[^"\\\n])*"|\'(?:\\.|[^\'\\\n])*\'', sp, code, flags=re.S)

def norm(t):
    """'struct  ListNode*' -> 'struct ListNode *'"""
    t = re.sub(r"\b(static|inline|extern|const|register|volatile)\b", " ", t)
    t = re.sub(r"\s*(\*+)\s*", lambda m: " " + m.group(1), t)
    return re.sub(r"\s+", " ", t).strip()

def structs(src):
    """struct name -> its value field (the first int) and its next field (the first pointer to the same struct)"""
    out = {}
    for m in re.finditer(r"\bstruct\s+(\w+)\s*\{([^{}]*)\}\s*;", src):
        name, val, nxt = m.group(1), None, None
        for f in m.group(2).split(";"):
            f = norm(f)
            v = re.fullmatch(r"int (\w+)", f)
            n = re.fullmatch(r"struct %s \*(\w+)" % name, f)
            if v and not val: val = v.group(1)
            if n and not nxt: nxt = n.group(1)
        if val and nxt: out[name] = {"val": val, "next": nxt}
    return out

def functions(code):
    """every function that takes exactly one linked list, plus maybe some ints"""
    src = blank(code)
    depth, depths = 0, []
    for c in src:                                       # brace depth before each character
        depths.append(depth)
        depth += c == "{"
        depth -= c == "}"
    lists, out = structs(src), []
    for m in re.finditer(r"([A-Za-z_][\w \t\*]*?[\s\*])([A-Za-z_]\w*)\s*\(([^()]*)\)\s*\{", src):
        if depths[m.start()] or m.group(2) == "main" or m.group(2) in ("if", "while", "for", "switch"): continue
        ret, params, lst = norm(m.group(1)), [], None
        if re.search(r"\b(typedef|struct\s+\w+\s*\{)", ret) or ret in ("return", "else"): continue
        raw = m.group(3).strip()
        ok = True
        for p in ([] if raw in ("", "void") else raw.split(",")):
            pm = re.fullmatch(r"(.*?)([A-Za-z_]\w*)\s*(\[\s*\])?", p.strip(), re.S)
            if not pm: ok = False; break
            t = norm(pm.group(1)) + (" *" if pm.group(3) else "")
            t = t.replace("* *", "**")
            lm = re.fullmatch(r"struct (\w+) (\*{1,2})", t)
            if lm and lm.group(1) in lists and lst is None:
                lst = len(params)
                params.append({"name": pm.group(2), "type": t, "list": True, "stars": len(lm.group(2)), "struct": lm.group(1)})
            elif SCALAR.fullmatch(t):
                params.append({"name": pm.group(2), "type": t, "list": False})
            else: ok = False; break
        if not ok or lst is None: continue
        p = params[lst]
        out.append({"name": m.group(2), "ret": ret, "params": params, "struct": p["struct"],
                    "val": lists[p["struct"]]["val"], "next": lists[p["struct"]]["next"],
                    "line": code.count("\n", 0, m.start(2)) + 1,
                    "sig": "%s%s%s(%s)" % (ret, "" if ret.endswith("*") else " ", m.group(2),
                                           ", ".join(q["type"] + ("" if q["type"].endswith("*") else " ") + q["name"] for q in params))})
    return out


# ---------- the test program ----------
def test_main(f, vals, args, label):
    """the tester's code, added after yours: build the list, call your function, print and free what's left"""
    S, V, N = "struct " + f["struct"], f["val"], f["next"]
    lst = next(p for p in f["params"] if p["list"])
    call = ", ".join(("&head" if p["stars"] == 2 else "head") if p["list"] else str(int(args.get(p["name"], 1)))
                     for p in f["params"])
    ret = f["ret"]
    if ret == S + " *":
        run = ["  result = %s(%s);" % (f["name"], call)]
    elif SCALAR.fullmatch(ret):
        run = ["  returned = %s(%s);" % (f["name"], call), '  printf("[test] returned: %d\\n", returned);', "  result = head;"]
    else:
        run = ["  %s(%s);" % (f["name"], call), "  result = head;"]
    decl = "  int vals[] = {%s};" % ", ".join(str(int(v)) for v in vals) if vals else "  int vals[1] = {0};   /* the empty list: n is 0 */"
    lines = [
        "",
        "#undef main",
        "/* ---------- added by the edge-case tester: case %s ---------- */" % label,
        "",
        "%s *tc_build_list(int *vals, int n) {" % S,
        "  %s *head = NULL;" % S,
        "  %s *tail = NULL;" % S,
        "  int i;",
        "",
        "  for (i = 0; i < n; i++) {",
        "    %s *node = calloc(1, sizeof(%s));" % (S, S),
        "    node->%s = vals[i];" % V,
        "    if (tail == NULL) {",
        "      head = node;",
        "    } else {",
        "      tail->%s = node;" % N,
        "    }",
        "    tail = node;",
        "  }",
        "  return head;",
        "}",
        "",
        "/* how many nodes, or -1 if following %s loops back (a cycle) */" % N,
        "int tc_length(%s *head) {" % S,
        "  %s *slow = head;" % S,
        "  %s *fast = head;" % S,
        "  int n = 0;",
        "",
        "  while (fast != NULL) {",
        "    n++;",
        "    fast = fast->%s;" % N,
        "    if (fast == NULL) {",
        "      break;",
        "    }",
        "    n++;",
        "    fast = fast->%s;" % N,
        "    slow = slow->%s;" % N,
        "    if (slow == fast) {",
        "      return -1;",
        "    }",
        "  }",
        "  return n;",
        "}",
        "",
        "void tc_print_list(char *label, %s *head) {" % S,
        '  printf("[test] %s: ", label);',
        "  if (tc_length(head) < 0) {",
        '    printf("cycle\\n");',
        "    return;",
        "  }",
        "  while (head != NULL) {",
        '    printf("%%d -> ", head->%s);' % V,
        "    head = head->%s;" % N,
        "  }",
        '  printf("NULL\\n");',
        "}",
        "",
        "/* frees what is still in the list, so a leak is a node your function lost */",
        "void tc_free_list(%s *head) {" % S,
        "  %s *next = NULL;" % S,
        "",
        "  if (tc_length(head) < 0) {",
        "    return;",
        "  }",
        "  while (head != NULL) {",
        "    next = head->%s;" % N,
        "    free(head);",
        "    head = next;",
        "  }",
        "}",
        "",
        "int main() {",
        decl,
        "  %s *head = tc_build_list(vals, %d);" % (S, len(vals)),
        "  %s *result = NULL;" % S,
    ] + (["  int returned = 0;"] if SCALAR.fullmatch(ret) else []) + [
        "",
        "  setvbuf(stdout, NULL, _IONBF, 0);",
        '  tc_print_list("before", head);',
    ] + run + [
        '  tc_print_list("after", result);',
        "  tc_free_list(result);",
        "  return 0;",
        "}",
        "",
    ]
    return "\n".join(lines)

PREFIX = "#include <stdio.h>\n#include <stdlib.h>\n#define main user_main\n#line 1\n"

def program(code, f, vals, args, label):
    """(the whole file, the part shown in the viewer): your code keeps its line numbers"""
    shown = code.rstrip("\n") + "\n" + test_main(f, vals, args, label)
    return PREFIX + shown, shown


# ---------- running one case ----------
FRAME = re.compile(r"#\d+ 0x[0-9a-f]+ in (\S+) (\S+?):(\d+)")

def frames(block):
    """the stack frames of a report that are in the test file: [(function, line)]"""
    return [(m.group(1), int(m.group(3))) for m in FRAME.finditer(block) if m.group(2).endswith("prog.c")]

def where(fr, user_lines):
    """'line 12 in remove_duplicates()', or the tester's own code"""
    if not fr: return "somewhere outside your code"
    fn, line = fr
    if line > user_lines: return "the tester's %s()" % fn
    return "line %d in %s()" % (line, fn)

def mine(fr, user_lines): return bool(fr) and fr[1] <= user_lines

def explain(err, user_lines):
    """AddressSanitizer's report -> a list of {kind, text, line}"""
    reasons = []
    head = re.search(r"ERROR: (AddressSanitizer|LeakSanitizer): ([\w-]+)", err)
    if head and head.group(1) == "AddressSanitizer":
        kind = head.group(2)
        parts = re.split(r"\n(?=freed by thread|previously allocated by thread)", err)
        fr = frames(parts[0])
        first = next((x for x in fr), None)
        acc = re.search(r"(READ|WRITE) of size (\d+)", err)
        verb = "writes" if acc and acc.group(1) == "WRITE" else "reads"
        freed = next((frames(p) for p in parts if p.startswith("freed by")), [])
        fwhere = "on " + where(freed[0], user_lines) if freed else "earlier"
        line = first[1] if mine(first, user_lines) else None
        if kind == "heap-use-after-free":
            if mine(first, user_lines):
                text = "use-after-free on %s: it %s a node that was freed %s" % (where(first, user_lines), verb, fwhere)
            else:
                text = "use-after-free: the list your function left still links to a node it freed %s" % fwhere
                line = freed[0][1] if freed and mine(freed[0], user_lines) else None
            reasons.append({"kind": "use-after-free", "text": text, "line": line})
        elif kind == "attempting":                                  # attempting double-free
            fr2 = [x for x in fr if x[0] != "free"]
            second = fr2[0] if fr2 else None
            if mine(second, user_lines):
                text = "double free on %s: that node was already freed %s" % (where(second, user_lines), fwhere)
                line = second[1]
            else:
                text = "double free: your function freed a node %s but left it in the list, so the tester's cleanup freed it again" % fwhere
                line = freed[0][1] if freed and mine(freed[0], user_lines) else None
            reasons.append({"kind": "double free", "text": text, "line": line})
        elif kind == "SEGV":
            addr = re.search(r"unknown address (0x[0-9a-f]+)", err)
            a = int(addr.group(1), 16) if addr else 0
            if a < 4096 or "zero page" in err:
                text = "NULL dereference on %s: it %s through a NULL pointer (address 0x%x)" % (where(first, user_lines), verb if acc else ("writes" if "WRITE memory access" in err else "reads"), a)
                reasons.append({"kind": "NULL dereference", "text": text, "line": line})
            else:
                reasons.append({"kind": "crash", "text": "crash on %s: it touched memory it doesn't own (address 0x%x)" % (where(first, user_lines), a), "line": line})
        elif kind == "stack-overflow":
            reasons.append({"kind": "crash", "text": "crash on %s: the stack overflowed. Does the recursion ever stop?" % where(first, user_lines), "line": line})
        elif kind in ("heap-buffer-overflow", "stack-buffer-overflow", "global-buffer-overflow"):
            reasons.append({"kind": "crash", "text": "out of bounds on %s: it %s past the end of a block or array" % (where(first, user_lines), verb), "line": line})
        elif kind == "FPE":
            reasons.append({"kind": "crash", "text": "crash on %s: division by zero" % where(first, user_lines), "line": line})
        elif "rss" in err.lower() and "limit" in err.lower():
            reasons.append({"kind": "endless loop", "text": "used more than 512 MB of memory: an endless loop that keeps calling malloc?", "line": None})
        else:
            reasons.append({"kind": "crash", "text": "crash on %s: AddressSanitizer says %s" % (where(first, user_lines), kind), "line": line})
    elif re.search(r"exceeded|rss_limit|RSS limit", err):
        reasons.append({"kind": "endless loop", "text": "used more than 512 MB of memory: an endless loop that keeps calling malloc?", "line": None})
    leaks = re.findall(r"(Direct|Indirect) leak of (\d+) byte\(s\) in (\d+) object\(s\) allocated from:\n((?:\s+#\d+[^\n]*\n?)+)", err)
    if leaks:
        total = sum(int(b) for _, b, _, _ in leaks)
        count = sum(int(n) for _, _, n, _ in leaks)
        sites = []
        for _, _, _, st in leaks:
            fr = next(iter(frames(st)), None)
            s = "made by the tester's list builder" if fr and fr[0] == "tc_build_list" else "allocated on " + where(fr, user_lines)
            if s not in sites: sites.append(s)
        own = [f for _, _, _, st in leaks for f in frames(st)[:1] if mine(f, user_lines)]
        text = "leak: %d bytes in %d block%s never freed (%s)" % (total, count, "" if count == 1 else "s", "; ".join(sites))
        if sites == ["made by the tester's list builder"]:
            text += ": your function took them out of the list without free()"
        reasons.append({"kind": "leak", "text": text, "line": own[0][1] if own else None})
    return reasons

def limit():                                     # in the child: stop it if it prints too much
    resource.setrlimit(resource.RLIMIT_FSIZE, (OUT_MAX, OUT_MAX))

def run_case(tmp, k, code, f, case, args, user_lines):
    vals = [int(v) for v in case.get("vals", [])]
    expect = case.get("expect")
    label = "[%s]" % ", ".join(map(str, vals))
    src, _ = program(code, f, vals, args, label)
    d = os.path.join(tmp, "c%d" % k); os.mkdir(d)
    with open(os.path.join(d, "prog.c"), "w") as fh: fh.write(src)
    res = {"vals": vals, "expect": expect, "before": vals, "after": None, "cycle": False, "returned": None, "output": "", "reasons": []}
    cc = subprocess.run(["gcc", "-g", "-O0", "-w", "-fsanitize=address", "-fno-omit-frame-pointer", "prog.c", "-o", "test"],
                        cwd=d, capture_output=True, text=True)
    if cc.returncode:
        res["reasons"].append({"kind": "compile", "text": "gcc: " + (cc.stderr.strip().splitlines() or ["failed"])[0], "line": None})
        res["pass"] = False
        return res
    env = dict(os.environ, ASAN_OPTIONS=ASAN_OPTIONS)
    out_p, err_p = os.path.join(d, "out.txt"), os.path.join(d, "err.txt")
    with open(out_p, "w") as out, open(err_p, "w") as err:
        p = subprocess.Popen(["./test"], cwd=d, stdout=out, stderr=err, stdin=subprocess.DEVNULL, env=env, preexec_fn=limit)
        try: p.wait(timeout=TIMEOUT); timed_out = False
        except subprocess.TimeoutExpired: p.kill(); p.wait(); timed_out = True
    with open(out_p, errors="replace") as fh: stdout = fh.read(OUT_MAX)
    with open(err_p, errors="replace") as fh: stderr = fh.read(OUT_MAX)
    for m in re.finditer(r"\[test\] (before|after|returned): ([^\n]*)", stdout):
        what, txt = m.group(1), m.group(2).strip()
        if what == "returned": res["returned"] = int(txt)
        elif what == "after" and txt == "cycle": res["cycle"] = True
        elif what == "after" and txt.endswith("NULL"): res["after"] = [int(x) for x in txt.split(" -> ")[:-1]]   # not if it crashed halfway
    res["output"] = re.sub(r"\[test\] [^\n]*\n?", "", stdout)[:2000]
    if timed_out:
        res["reasons"].append({"kind": "endless loop", "text": "endless loop: still running after %d seconds" % TIMEOUT, "line": None})
    elif p.returncode == -25:                                   # SIGXFSZ: printed too much
        res["reasons"].append({"kind": "endless loop", "text": "printed more than 1 MB: an endless loop that keeps printing?", "line": None})
    else:
        res["reasons"] += [r for r in explain(stderr, user_lines) if not (res["cycle"] and r["kind"] == "leak")]
        if p.returncode < 0 and not res["reasons"]:
            res["reasons"].append({"kind": "crash", "text": "crash: the program was stopped by signal %d" % -p.returncode, "line": None})
    if res["cycle"]:
        res["reasons"].append({"kind": "cycle", "text": "the list it left loops back on itself (a cycle): following %s never reaches NULL" % f["next"], "line": None})
    if expect is not None and not res["reasons"] and res["after"] is not None and res["after"] != [int(x) for x in expect]:
        show = lambda l: " -> ".join(map(str, l)) + (" -> NULL" if l else "NULL")
        res["reasons"].append({"kind": "wrong result", "text": "wrong result: expected %s, got %s" % (show(expect), show(res["after"])), "line": None})
    res["pass"] = not res["reasons"]
    return res


# ---------- the route ----------
def handle(body):
    try: req = json.loads(body)
    except ValueError: return False, json.dumps({"error": "the request isn't JSON"})
    code = req.get("code", "")
    funcs = functions(code)
    if req.get("list"):
        return True, json.dumps({"functions": funcs})
    f = next((x for x in funcs if x["name"] == req.get("func")), None)
    if not f:
        return False, json.dumps({"error": "%s() isn't in the code, or doesn't take a linked list" % req.get("func")})
    args = req.get("args") or {}
    if "trace" in req:
        vals = [int(v) for v in req["trace"]]
        prog, shown = program(code, f, vals, args, "[%s]" % ", ".join(map(str, vals)))
        return True, json.dumps({"program": prog, "shown": shown})
    user_lines = code.rstrip("\n").count("\n") + 1
    tmp = tempfile.mkdtemp(prefix="mvcases-")
    try:
        cc = subprocess.run(["gcc", "-fsyntax-only", "-w", "-x", "c", "-"], input=program(code, f, [1], args, "check")[0],
                            capture_output=True, text=True)
        if cc.returncode:
            return False, json.dumps({"error": cc.stderr.replace("<stdin>", "prog.c")})
        cases = req.get("cases", [])
        with ThreadPoolExecutor(max_workers=max(2, os.cpu_count() or 2)) as pool:
            results = list(pool.map(lambda kc: run_case(tmp, kc[0], code, f, kc[1], args, user_lines), enumerate(cases)))
        for c, r in zip(cases, results): r["name"] = c.get("name", "")
        return True, json.dumps({"results": results, "func": f})
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
