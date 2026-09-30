/* preview.js: a small C interpreter for the live preview.
   It runs the C typed so far and writes steps in the same JSON shape as trace.py, so node_cards_viewer.html
   draws them with its usual code. Memory copies what gcc -g -O0 on x86-64 and glibc's malloc do:
   int 4 bytes, pointers 8, struct padding, gcc's stack frame layout, malloc's chunks and tcache.
   Steps copy how trace.py steps through gdb, quirks included (a line that calls malloc stops twice).

   CPreview.run(code, {caret}) -> {trace, error, bug, note, highlight, blueprints, partial}
   Works in the browser (window.CPreview) and in node (require("./preview.js")). */
(function (root) {
"use strict";

const MAX_STEPS = 4000, MAX_DEPTH = 400, NODE_MAX = 64, CHUNK_MAX = 200, FRAME_MAX = 512, MAX_OPS = 5e6;
const STACK_TOP = 0x7ffffffff000, STACK_SIZE = 0x40000;       /* 256 KB of stack */
const MAIN_RBP = 0x7fffffffca40;                              /* where gdb usually starts main's frame */
const MAIN_SAVED_RBP = 0x7fffffffcae0, LIBC_RET = 0x7ffff7c2a1ca;
const HEAP_LO = 0x555555559000, HEAP_GROW = 0x21000;          /* glibc's first heap: 132 KB */
const RODATA = 0x555555556004;                                /* string literals, like _IO_stdin_used+4 */
const CODE = 0x555555555189;                                  /* made-up return addresses point in here */
const TCACHE_KEY = [0x4c, 0x4e, 0xd3, 0x4f, 0xfe, 0x79, 0xdd, 0x34];
const CANARY = [0x00, 0xb6, 0x84, 0x44, 0x49, 0x8e, 0x79, 0x85];   /* the first byte is always 0 */
const ZERO8 = "0000000000000000";

/* ---------- errors ---------- */
class CErr extends Error { constructor(line, msg) { super(msg); this.line = line; } }   /* the preview can't run this */
class Crash { constructor(kind, addr, msg) { this.kind = kind; this.addr = addr; this.msg = msg; } }   /* the program would die here */
class Halt { constructor(why) { this.why = why; } }                                                    /* stop running, no error */
class Ret { constructor(v) { this.v = v; } }
const BRK = { brk: 1 }, CONT = { cont: 1 };

/* ---------- types ---------- */
const INT = { k: "int" }, CHAR = { k: "char" }, VOID = { k: "void" };
const ptr = to => ({ k: "ptr", to }), arr = (of, n) => ({ k: "arr", of, n }), st = name => ({ k: "struct", name });
const VOIDP = ptr(VOID), CHARP = ptr(CHAR);
const isPtr = t => t.k === "ptr", isInt = t => t.k === "int" || t.k === "char", isScalar = t => isPtr(t) || isInt(t);
const roundUp = (x, a) => Math.ceil(x / a) * a;

function typeStr(t) {
  switch (t.k) {
    case "int": case "char": case "void": return t.k;
    case "struct": return "struct " + t.name;
    case "arr": { const b = typeStr(t.of); return `${b}${b.endsWith("*") ? "" : " "}[${t.n}]`; }   /* int [4], struct Pair *[9] */
    case "ptr": { if (t.to.k === "arr") return `${typeStr(t.to.of)} (*)[${t.to.n}]`;
      const b = typeStr(t.to); return b.endsWith("*") ? b + "*" : b + " *"; }
  }
  return "?";
}
const joinTN = (t, n) => t + (t.endsWith("*") ? "" : " ") + n;       /* like trace.py's signature() */

/* ---------- lexer ---------- */
const OPS = ["<<=", ">>=", "->", "++", "--", "<<", ">>", "<=", ">=", "==", "!=", "&&", "||", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=",
  "+", "-", "*", "/", "%", "=", "<", ">", "!", "&", "|", "^", "~", "?", ":", ";", ",", ".", "(", ")", "[", "]", "{", "}"];
const ESC = { n: 10, t: 9, r: 13, "0": 0, "\\": 92, "'": 39, '"': 34, a: 7, b: 8, f: 12, v: 11 };

/* partial: the text stops where you're typing, so an unfinished string, char or comment just ends the tokens */
function lex(src, partial, line0) {
  const toks = []; let i = 0, line = line0 || 1; const n = src.length;
  const tok = (k, v, l) => toks.push({ k, v, line: l || line });
  const esc = (j, l) => { const c = src[j + 1]; if (c === undefined) return null;
    if (!(c in ESC)) throw new CErr(l, `the escape \\${c} isn't supported in the preview`); return ESC[c]; };
  while (i < n) {
    const c = src[i];
    if (c === "\n") { line++; i++; continue; }
    if (c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\v") { i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      if (e < 0) { if (partial) break; throw new CErr(line, "a /* comment is never closed"); }
      for (let k = i; k < e; k++) if (src[k] === "\n") line++;
      i = e + 2; continue;
    }
    if (c === "#") {                                                      /* only #include is allowed */
      let e = src.indexOf("\n", i); if (e < 0) e = n;
      const w = (/^#\s*(\w*)/.exec(src.slice(i, e)) || [])[1] || "";
      if (w !== "include" && !(partial && e === n && "include".startsWith(w)))
        throw new CErr(line, `#${w} isn't supported in the preview (only #include)`);
      i = e; continue;
    }
    if (/[A-Za-z_]/.test(c)) { let j = i + 1; while (j < n && /\w/.test(src[j])) j++; tok("id", src.slice(i, j)); i = j; continue; }
    if (/[0-9]/.test(c)) {
      let j = i, v;
      if (c === "0" && /[xX]/.test(src[i + 1])) { j = i + 2; while (j < n && /[0-9a-fA-F]/.test(src[j])) j++; v = parseInt(src.slice(i + 2, j), 16); }
      else { while (j < n && /[0-9]/.test(src[j])) j++; v = parseInt(src.slice(i, j), /^0\d/.test(src.slice(i, j)) ? 8 : 10); }
      if (j < n && /[.eE]/.test(src[j]) && !(src[j] === "." && src[j + 1] === "."))
        throw new CErr(line, "decimal numbers (float, double) aren't supported in the preview: int and char only");
      if (j < n && /[A-Za-z_]/.test(src[j])) throw new CErr(line, `the number ${src.slice(i, j + 1)}… isn't supported in the preview: write a plain int`);
      if (isNaN(v)) v = 0;
      tok("num", v | 0); i = j; continue;
    }
    if (c === "'") {
      let j = i + 1, v;
      if (src[j] === "\\") { v = esc(j, line); j += 2; } else { v = src.charCodeAt(j); j++; }
      if (j > n || v === null || isNaN(v)) { if (partial) break; throw new CErr(line, "a character like 'a' is never closed"); }
      if (src[j] !== "'") { if (partial && j >= n) break; throw new CErr(line, "a character like 'a' is never closed"); }
      tok("chr", (v << 24) >> 24); i = j + 1; continue;
    }
    if (c === '"') {
      let j = i + 1, s = "", ok = false;
      while (j < n && src[j] !== "\n") {
        if (src[j] === '"') { ok = true; break; }
        if (src[j] === "\\") { const v = esc(j, line); if (v === null) break; s += String.fromCharCode(v); j += 2; }
        else { s += String.fromCharCode(src.charCodeAt(j) & 255); j++; }
      }
      if (!ok) { if (partial && src.indexOf("\n", i) < 0) break; throw new CErr(line, "a string is never closed: it needs a \" before the end of the line"); }
      tok("str", s); i = j + 1; continue;
    }
    const op = OPS.find(o => src.startsWith(o, i));
    if (!op) throw new CErr(line, `the character ${c} isn't C the preview understands`);
    tok("op", op); i += op.length;
  }
  return { toks, line };
}

/* ---------- half-typed code: finish it so it parses ----------
   Everything up to the last ; { or } you typed is kept. Blocks still open get their } back.
   What comes after that (a half-typed line) is the "tail": it is previewed, not run. */
function splitPrefix(toks) {
  const stack = []; let paren = 0, last = -1;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]; if (t.k !== "op") continue;
    const top = stack.length ? stack[stack.length - 1] : null, inInit = top && top.kind === "init";
    if (t.v === "(" || t.v === "[") paren++;
    else if (t.v === ")" || t.v === "]") paren = Math.max(0, paren - 1);
    else if (t.v === "{") {
      const p = toks[i - 1], p2 = toks[i - 2];
      let kind = "block";
      if (paren > 0 || inInit || (p && p.k === "op" && (p.v === "=" || p.v === ","))) kind = "init";
      else if ((p && p.k === "id" && p2 && p2.v === "struct") || (p && p.v === "struct")) kind = "struct";
      stack.push({ kind, i });
      if (kind !== "init") last = i;
    }
    else if (t.v === "}") { const s = stack.pop(); if (s && s.kind !== "init") last = i; }
    else if (t.v === ";" && paren === 0 && !inInit) last = i;
  }
  const open = stack.filter(s => s.kind !== "init" && s.i <= last);
  return { keep: toks.slice(0, last + 1), tail: toks.slice(last + 1), open, lastTok: last >= 0 ? toks[last] : null };
}

/* ---------- parser ---------- */
const KEYWORDS = new Set(["int", "char", "void", "struct", "if", "else", "while", "for", "return", "break", "continue", "sizeof"]);
const NOT_TYPES = "(int and char only)";
const BAD = {
  long: `long isn't supported in the preview ${NOT_TYPES}`, short: `short isn't supported in the preview ${NOT_TYPES}`,
  unsigned: `unsigned isn't supported in the preview ${NOT_TYPES}`, signed: `signed isn't supported in the preview ${NOT_TYPES}`,
  float: `float isn't supported in the preview ${NOT_TYPES}`, double: `double isn't supported in the preview ${NOT_TYPES}`,
  size_t: `size_t isn't supported in the preview: use int`, bool: `bool isn't supported in the preview: use int`, _Bool: `_Bool isn't supported in the preview: use int`,
  const: "const isn't supported in the preview: leave it out", static: "static isn't supported in the preview", extern: "extern isn't supported in the preview",
  volatile: "volatile isn't supported in the preview", register: "register isn't supported in the preview", auto: "auto isn't supported in the preview", inline: "inline isn't supported in the preview",
  typedef: "typedef isn't supported in the preview: write struct ListNode instead of a typedef name",
  enum: "enum isn't supported in the preview", union: "union isn't supported in the preview",
  switch: "switch isn't supported in the preview: use if / else if", case: "case isn't supported in the preview: use if / else if", default: "default isn't supported in the preview",
  do: "do … while isn't supported in the preview: use while", goto: "goto isn't supported in the preview",
};
const PREC = { "||": 1, "&&": 2, "|": 3, "^": 4, "&": 5, "==": 6, "!=": 6, "<": 7, ">": 7, "<=": 7, ">=": 7, "<<": 8, ">>": 8, "+": 9, "-": 9, "*": 10, "/": 10, "%": 10 };
const ASSIGN = new Set(["=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>="]);
const isTypeStart = t => t && t.k === "id" && (t.v === "int" || t.v === "char" || t.v === "void" || t.v === "struct");

class Parser {
  constructor(toks, prog) { this.t = toks; this.i = 0; this.prog = prog; this.fn = null; this.blocks = []; }
  peek(k) { return this.t[this.i + (k || 0)] || this.t[this.t.length - 1]; }
  next() { const t = this.peek(); if (this.i < this.t.length - 1) this.i++; return t; }
  is(v, k) { const t = this.peek(k); return (t.k === "op" || t.k === "id") && t.v === v; }
  eat(v) { if (this.is(v)) { this.next(); return true; } return false; }
  expect(v, what) {
    if (this.eat(v)) return;
    const t = this.peek();
    throw new CErr(t.line, t.k === "eof" ? `the code ends before the "${v}"${what ? " " + what : ""}` : `expected "${v}"${what ? " " + what : ""}, found "${t.v}"`);
  }
  fail(t, msg) { throw new CErr(t.line, msg || (t.k === "eof" ? "the code ends in the middle of something" : `didn't expect "${t.v}" here`)); }

  program() {
    while (this.peek().k !== "eof") {
      const t = this.peek();
      if (t.k === "tail") { this.next(); continue; }
      if (this.eat(";")) continue;
      if (this.is("struct") && this.peek(1).k === "id" && this.is("{", 2)) { this.structDef(); this.expect(";", "after the struct's }"); continue; }
      const base = this.base();
      if (!base) this.fail(t, `didn't expect "${t.v}" here: the preview wants structs and functions at the top level`);
      if (this.eat(";")) continue;                                    /* struct ListNode; */
      const d = this.declarator(base);
      if (!this.is("(")) throw new CErr(d.line, `global variables aren't supported in the preview: declare ${d.name} inside a function`);
      this.func(d);
    }
  }
  structDef() {
    this.next(); const nt = this.next(), S = this.structOf(nt.v);
    if (S.complete) throw new CErr(nt.line, `struct ${nt.v} is defined twice`);
    this.expect("{");
    const fields = [];
    while (!this.is("}")) {
      const t = this.peek(); if (t.k === "eof") this.fail(t, `struct ${nt.v}'s { is never closed`);
      const b = this.base(); if (!b) this.fail(t, `expected a field like "int val;" in struct ${nt.v}, found "${t.v}"`);
      do {
        const d = this.declarator(b);
        if (d.t.k === "arr" && d.t.n == null) throw new CErr(d.line, `the array field ${d.name} needs a size`);
        if (d.t.k === "void") throw new CErr(d.line, `a field can't be void`);
        if (d.t.k === "struct" && !this.prog.structs[d.t.name].complete) throw new CErr(d.line, `struct ${d.t.name} is used before it's defined (a pointer to it is fine)`);
        if (fields.some(f => f.name === d.name)) throw new CErr(d.line, `struct ${nt.v} has two fields called ${d.name}`);
        fields.push({ name: d.name, t: d.t, line: d.line });
      } while (this.eat(","));
      this.expect(";", "after the field");
    }
    this.next();
    let off = 0, al = 1;
    for (const f of fields) { const a = alignOf(f.t, this.prog); off = roundUp(off, a); f.off = off; off += sizeOf(f.t, this.prog); al = Math.max(al, a); }
    Object.assign(S, { fields, size: roundUp(off, al), align: al, complete: true, line: nt.line });
    this.prog.order.push(S);
  }
  structOf(name) { return this.prog.structs[name] || (this.prog.structs[name] = { name, fields: [], complete: false }); }
  base() {
    const t = this.peek(); if (t.k !== "id") return null;
    if (BAD[t.v]) throw new CErr(t.line, BAD[t.v]);
    if (t.v === "int") { this.next(); return INT; }
    if (t.v === "char") { this.next(); return CHAR; }
    if (t.v === "void") { this.next(); return VOID; }
    if (t.v === "struct") {
      this.next(); const nt = this.next();
      if (nt.k !== "id" || KEYWORDS.has(nt.v)) this.fail(nt, `expected a struct name after "struct"`);
      this.structOf(nt.v); return st(nt.v);
    }
    return null;
  }
  declarator(base) {
    let t = base; while (this.eat("*")) t = ptr(t);
    if (this.is("(")) this.fail(this.peek(), "function pointers aren't supported in the preview");
    const nt = this.next();
    if (nt.k !== "id" || KEYWORDS.has(nt.v)) this.fail(nt, nt.k === "eof" ? "the code ends before the variable's name" : `expected a name, found "${nt.v}"`);
    if (BAD[nt.v]) throw new CErr(nt.line, BAD[nt.v]);
    if (this.eat("[")) {
      let n = null;
      if (!this.is("]")) { const e = this.expr(); n = this.constant(e); if (n <= 0) throw new CErr(nt.line, `the array ${nt.v} needs a size above 0`); }
      this.expect("]");
      if (this.is("[")) this.fail(this.peek(), "arrays of arrays aren't supported in the preview");
      t = arr(t, n);
    }
    return { name: nt.v, t, line: nt.line };
  }
  constant(e) {
    if (e.k === "num") return e.v;
    if (e.k === "sizeofT") return sizeOf(e.t, this.prog);
    if (e.k === "bin" && "+-*/".includes(e.op)) { const a = this.constant(e.a), b = this.constant(e.b);
      return e.op === "+" ? a + b : e.op === "-" ? a - b : e.op === "*" ? a * b : Math.trunc(a / b); }
    throw new CErr(e.line, "an array size must be a number");
  }
  func(d) {
    this.expect("(");
    const params = [];
    if (this.is("void") && this.is(")", 1)) { this.next(); this.next(); }
    else if (!this.eat(")")) {
      do {
        const t = this.peek(), b = this.base(); if (!b) this.fail(t, `expected a parameter like "int n", found "${t.v}"`);
        const p = this.declarator(b);
        if (p.t.k === "arr") p.t = ptr(p.t.of);                          /* int vals[] is really int *vals */
        if (p.t.k === "void") throw new CErr(p.line, "a parameter can't be void");
        params.push({ name: p.name, t: p.t, decl: p.line, arg: true });
      } while (this.eat(","));
      this.expect(")", "after the parameters");
    }
    if (d.t.k === "struct") throw new CErr(d.line, "returning a struct by value isn't supported in the preview: return a pointer");
    if (d.t.k === "arr") throw new CErr(d.line, "a function can't return an array");
    const old = this.prog.funcs[d.name];
    if (this.eat(";")) { if (!old) this.prog.funcs[d.name] = { name: d.name, ret: d.t, params, body: null, line: d.line }; return; }
    if (!this.is("{")) this.fail(this.peek(), `expected "{" to start ${d.name}'s body`);
    if (old && old.body) throw new CErr(d.line, `${d.name}() is defined twice`);
    const fn = { name: d.name, ret: d.t, params, body: null, line: d.line, slots: [], addrTaken: new Set(), braceLine: this.peek().line };
    this.fn = fn;
    fn.body = this.block(true);
    fn.endLine = fn.body.end;
    fn.scope = [...params, ...fn.body.decls];
    this.fn = null;
    this.prog.funcs[d.name] = fn;
  }
  block(isFn) {
    const open = this.next(), b = { k: "block", stmts: [], decls: [], line: open.line, end: open.line, fnBody: !!isFn };
    this.blocks.push(b);
    while (!this.is("}")) {
      if (this.peek().k === "eof") this.fail(this.peek(), `the { on line ${open.line} is never closed`);
      b.stmts.push(this.stmt());
    }
    b.end = this.next().line;
    this.blocks.pop();
    return b;
  }
  addSlot(d) {
    if (d.t.k === "void") throw new CErr(d.line, "a variable can't be void");
    const s = { name: d.name, t: d.t, decl: d.line, arg: false, idx: this.fn.slots.length };
    this.fn.slots.push(s); this.blocks[this.blocks.length - 1].decls.push(s);
    return s;
  }
  stmt() {
    const t = this.peek();
    if (t.k === "tail") { this.next(); return this.tailStmt(t); }
    if (t.k === "id") switch (t.v) {
      case "if": { this.next(); this.expect("(", "after if"); const cond = this.expr(); this.expect(")", "after the if condition");
        const then = this.stmt(); const els = this.eat("else") ? this.stmt() : null; return { k: "if", cond, then, els, line: t.line }; }
      case "while": { this.next(); this.expect("(", "after while"); const cond = this.expr(); this.expect(")", "after the while condition");
        return { k: "while", cond, body: this.stmt(), line: t.line }; }
      case "for": {
        this.next(); this.expect("(", "after for");
        const scope = []; this.blocks.push({ decls: scope });
        let init = null;
        if (this.eat(";")) init = null;
        else if (isTypeStart(this.peek()) || BAD[this.peek().v]) init = this.decl();
        else { init = { k: "expr", e: this.expr(), line: t.line }; this.expect(";", "in the for"); }
        const cond = this.is(";") ? null : this.expr(); this.expect(";", "in the for");
        const step = this.is(")") ? null : this.expr(); this.expect(")", "to close the for");
        const body = this.stmt(); this.blocks.pop();
        return { k: "for", init, cond, step, body, scope, line: t.line };
      }
      case "return": { this.next(); const e = this.is(";") ? null : this.expr(); this.expect(";", "after return"); return { k: "return", e, line: t.line }; }
      case "break": case "continue": this.next(); this.expect(";", "after " + t.v); return { k: t.v, line: t.line };
      case "else": this.fail(t, `"else" without an if before it`);
    }
    if (this.is("{")) return this.block(false);
    if (this.eat(";")) return { k: "empty" };
    if (isTypeStart(t) || (t.k === "id" && BAD[t.v])) return this.decl();
    const e = this.expr(); this.expect(";", "at the end of the line");
    return { k: "expr", e, line: t.line };
  }
  decl() {
    const b = this.base(), items = [];
    do {
      const d = this.declarator(b);
      const slot = this.addSlot(d); let init = null;
      if (this.eat("=")) init = this.is("{") ? this.initList() : this.assign();
      if (slot.t.k === "arr" && slot.t.n == null) {
        const n = init && init.k === "list" ? init.items.length : init && init.k === "str" ? init.v.length + 1 : 0;
        if (!n) throw new CErr(d.line, `the array ${d.name} needs a size, like ${d.name}[4]`);
        slot.t = arr(slot.t.of, n);
      }
      items.push({ slot, init, line: d.line });
    } while (this.eat(","));
    this.expect(";", "after the declaration");
    return { k: "decl", items, line: items[0].line };
  }
  initList() {
    const open = this.next(), items = [];
    while (!this.is("}")) {
      items.push(this.is("{") ? this.initList() : this.assign());
      if (!this.eat(",")) break;
    }
    this.expect("}", "to close the { … } list");
    return { k: "list", items, line: open.line };
  }
  /* the half-typed line: declare what it names, and remember a malloc( that has started */
  tailStmt(t) {
    const toks = t.toks, info = { decls: [], alloc: null };
    const sub = new Parser([...toks, { k: "eof", v: "", line: t.line }], this.prog); sub.fn = this.fn; sub.blocks = this.blocks;
    try {
      if (isTypeStart(sub.peek())) {
        const b = sub.base();
        while (sub.peek().k !== "eof") {
          let ty = b; while (sub.eat("*")) ty = ptr(ty);
          const nt = sub.peek(); if (nt.k !== "id" || KEYWORDS.has(nt.v) || BAD[nt.v]) break; sub.next();
          if (sub.is("[")) { sub.next(); const e = sub.expr(); sub.expect("]"); ty = arr(ty, sub.constant(e)); }
          if (ty.k === "void") break;
          info.decls.push(this.addSlot({ name: nt.v, t: ty, line: nt.line }));
          if (sub.eat("=")) { info.alloc = this.allocOf(sub.t.slice(sub.i, -1)); break; }
          if (!sub.eat(",")) break;
        }
      }
    } catch (e) { if (!(e instanceof CErr)) throw e; }
    return { k: "tail", info, line: t.line, empty: t.empty };
  }
  allocOf(toks) {
    let i = 0;
    if (toks[0] && toks[0].v === "(" && isTypeStart(toks[1])) { while (i < toks.length && toks[i].v !== ")") i++; i++; }   /* (struct ListNode *) */
    const f = toks[i];
    if (!f || !(f.v === "malloc" || f.v === "calloc") || !toks[i + 1] || toks[i + 1].v !== "(") return null;
    let depth = 0, j = i + 2;
    for (; j < toks.length; j++) { if (toks[j].v === "(") depth++; else if (toks[j].v === ")") { if (!depth) break; depth--; } }
    const at = toks.slice(i + 2, j), want = f.v === "malloc" ? 1 : 2;
    let args = null;
    if (at.length) try {
      const p = new Parser([...at, { k: "eof", v: "", line: f.line }], this.prog); p.fn = this.fn;
      args = []; do args.push(p.assign()); while (p.eat(","));
      if (p.peek().k !== "eof" || args.length !== want) args = null;
    } catch (e) { if (!(e instanceof CErr)) throw e; args = null; }
    return { fn: f.v, args, line: f.line };
  }

  expr() {
    const e = this.assign();
    if (this.is(",")) this.fail(this.peek(), "the comma operator isn't supported in the preview: use two statements");
    return e;
  }
  assign() {
    const a = this.cond(), t = this.peek();
    if (t.k === "op" && ASSIGN.has(t.v)) { this.next(); return { k: "assign", op: t.v, a, b: this.assign(), line: t.line }; }
    return a;
  }
  cond() {
    const c = this.bin(1);
    if (this.is("?")) { const t = this.next(), a = this.expr(); this.expect(":", "in the ? : expression"); return { k: "cond", c, a, b: this.cond(), line: t.line }; }
    return c;
  }
  bin(min) {
    let a = this.unary();
    for (;;) {
      const t = this.peek(), p = t.k === "op" ? PREC[t.v] : 0;
      if (!p || p < min) return a;
      this.next(); a = { k: "bin", op: t.v, a, b: this.bin(p + 1), line: t.line };
    }
  }
  unary() {
    const t = this.peek();
    if (t.k === "op") {
      if (t.v === "++" || t.v === "--") { this.next(); return { k: "pre", op: t.v, a: this.unary(), line: t.line }; }
      if (["-", "+", "!", "~", "*", "&"].includes(t.v)) {
        this.next(); const a = this.unary();
        if (t.v === "&" && this.fn) { let b = a; while (b.k === "index" || b.k === "dot") b = b.a; if (b.k === "id") this.fn.addrTaken.add(b.name); }
        return { k: "un", op: t.v, a, line: t.line };
      }
      if (t.v === "(" && (isTypeStart(this.peek(1)) || BAD[this.peek(1).v])) {
        this.next(); const ty = this.typeName(); this.expect(")", "after the type");
        return { k: "cast", t: ty, a: this.unary(), line: t.line };
      }
    }
    if (t.k === "id" && t.v === "sizeof") {
      this.next();
      if (this.is("(") && (isTypeStart(this.peek(1)) || BAD[this.peek(1).v])) { this.next(); const ty = this.typeName(); this.expect(")", "after sizeof's type"); return { k: "sizeofT", t: ty, line: t.line }; }
      return { k: "sizeofE", a: this.unary(), line: t.line };
    }
    return this.postfix();
  }
  typeName() {
    const b = this.base(); let t = b; while (this.eat("*")) t = ptr(t);
    if (this.is("[")) this.fail(this.peek(), "array types in casts aren't supported in the preview");
    return t;
  }
  postfix() {
    let e = this.primary();
    for (;;) {
      const t = this.peek();
      if (this.is("[")) { this.next(); const ix = this.expr(); this.expect("]"); e = { k: "index", a: e, b: ix, line: t.line }; }
      else if (this.is("(")) {
        if (e.k !== "id") this.fail(t, "only calls like name(…) are supported in the preview");
        this.next(); const args = [];
        if (!this.is(")")) do args.push(this.assign()); while (this.eat(","));
        this.expect(")", "to close the call to " + e.name);
        e = { k: "call", name: e.name, args, line: e.line };
      }
      else if (this.is(".") || this.is("->")) {
        this.next(); const nt = this.next();
        if (nt.k !== "id") this.fail(nt, `expected a field name after "${t.v}"`);
        e = { k: t.v === "." ? "dot" : "arrow", a: e, f: nt.v, line: t.line };
      }
      else if (this.is("++") || this.is("--")) { this.next(); e = { k: "post", op: t.v, a: e, line: t.line }; }
      else return e;
    }
  }
  primary() {
    const t = this.next();
    if (t.k === "num") return { k: "num", v: t.v, line: t.line };
    if (t.k === "chr") return { k: "num", v: t.v, line: t.line };
    if (t.k === "str") { let s = t.v; while (this.peek().k === "str") s += this.next().v; this.prog.lit(s); return { k: "str", v: s, line: t.line }; }
    if (t.k === "id") {
      if (BAD[t.v]) throw new CErr(t.line, BAD[t.v]);
      if (KEYWORDS.has(t.v)) this.fail(t);
      return { k: "id", name: t.v, line: t.line };
    }
    if (t.k === "op" && t.v === "(") { const e = this.expr(); this.expect(")"); return e; }
    this.fail(t, t.k === "eof" ? "the code ends in the middle of an expression" : undefined);
  }
}

function sizeOf(t, prog, line) {
  switch (t.k) {
    case "int": return 4; case "char": return 1; case "void": return 1; case "ptr": return 8;
    case "arr": return t.n * sizeOf(t.of, prog, line);
    case "struct": { const S = prog.structs[t.name];
      if (!S || !S.complete) throw new CErr(line || 0, `struct ${t.name} isn't defined yet`); return S.size; }
  }
  return 0;
}
function alignOf(t, prog) {
  switch (t.k) {
    case "int": return 4; case "char": case "void": return 1; case "ptr": return 8;
    case "arr": return alignOf(t.of, prog);
    case "struct": { const S = prog.structs[t.name]; return S && S.complete ? S.align : 1; }
  }
  return 1;
}
const hasArray = (t, prog) => t.k === "arr" || (t.k === "struct" && (prog.structs[t.name].fields || []).some(f => hasArray(f.t, prog)));

/* ---------- gcc -O0's stack frame: where each local and parameter lives ----------
   gcc sorts locals by size (bigger first), then puts later declarations first. With a stack protector
   (any array, or a local whose address is taken) the canary comes first, then char arrays, then other arrays.
   Parameters are copied in below the locals, starting on a 16-byte boundary. */
function layout(fn, prog) {
  const locals = fn.slots, params = fn.params;
  const alignL = t => (t.k === "arr" || t.k === "struct") && sizeOf(t, prog) >= 16 ? 16 : alignOf(t, prog);
  const prot = locals.some(s => hasArray(s.t, prog)) || [...locals, ...params].some(s => fn.addrTaken.has(s.name));
  const regs = held(fn.body);                                              /* callee-saved registers gcc pushes */
  const base = locals.some(s => alignL(s.t) === 16) ? -roundUp(8 * regs, 16) : -8 * regs;
  let off = base, canary = null;
  if (prot) { off -= 8; canary = off; }
  const phase = s => !prot ? 0 : s.t.k === "arr" && s.t.of.k === "char" ? 1 : hasArray(s.t, prog) ? 2 : 0;
  const sorted = locals.slice().sort((a, b) => sizeOf(b.t, prog) - sizeOf(a.t, prog) || alignL(b.t) - alignL(a.t) || b.idx - a.idx);
  for (const ph of [1, 2, 0]) for (const s of sorted) if (phase(s) === ph) {
    off -= sizeOf(s.t, prog); off = -roundUp(-off, alignL(s.t)); s.off = off;
  }
  if (params.length) {
    off = base - roundUp(base - off, 16);
    for (const p of params) { off -= sizeOf(p.t, prog); off = -roundUp(-off, Math.max(4, alignL(p.t))); p.off = off; }   /* a char comes in a 32-bit register */
  }
  const leaf = !hasCall(fn.body);
  fn.layout = { canary, regs, minOff: off, frame: leaf && -off <= 128 ? 0 : roundUp(-off, 16), prot };
  fn.protected = prot;
}
/* does this statement or expression call anything? */
function hasCall(n) {
  if (!n || typeof n !== "object") return false;
  if (n.k === "call") return true;
  for (const key in n) {
    if (key === "slot" || key === "info" || key === "t" || key === "scope" || key === "decls") continue;
    const v = n[key];
    if (Array.isArray(v)) { if (v.some(hasCall)) return true; }
    else if (v && typeof v === "object" && hasCall(v)) return true;
  }
  return false;
}
/* how many call results gcc must keep in callee-saved registers while it makes another call (push rbx …) */
function need(e) {
  if (!e || typeof e !== "object") return 0;
  switch (e.k) {
    case "call": { let h = 0, best = 0;                                  /* arguments run last to first */
      for (let i = e.args.length - 1; i >= 0; i--) { const c = hasCall(e.args[i]); best = Math.max(best, need(e.args[i]) + (c ? h : 0)); if (c) h++; }
      return best; }
    case "bin": if (e.op === "&&" || e.op === "||") return Math.max(need(e.a), need(e.b));
      return Math.max(need(e.a), need(e.b) + (hasCall(e.a) && hasCall(e.b) ? 1 : 0));
    case "index": return Math.max(need(e.a), need(e.b) + (hasCall(e.a) && hasCall(e.b) ? 1 : 0));
    case "assign": return Math.max(need(e.b), need(e.a) + (hasCall(e.a) && hasCall(e.b) ? 1 : 0));
    case "cond": return Math.max(need(e.c), need(e.a), need(e.b));
    case "un": case "pre": case "post": case "cast": case "dot": case "arrow": return need(e.a);
    case "list": return Math.max(0, ...e.items.map(need));
  }
  return 0;
}
function held(s) {
  if (!s || typeof s !== "object") return 0;
  switch (s.k) {
    case "block": return Math.max(0, ...s.stmts.map(held));
    case "decl": return Math.max(0, ...s.items.map(i => need(i.init)));
    case "expr": return need(s.e);
    case "if": return Math.max(need(s.cond), held(s.then), held(s.els));
    case "while": return Math.max(need(s.cond), held(s.body));
    case "for": return Math.max(held(s.init), need(s.cond), need(s.step), held(s.body));
    case "return": return need(s.e);
  }
  return 0;
}

/* ---------- memory: the stack, the heap, the string literals ---------- */
const hex = b => { let s = ""; for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16); return s; };
function u64bytes(v) { const b = new Uint8Array(8); let lo = v % 4294967296, hi = Math.floor(v / 4294967296);
  if (v < 0) { const x = BigInt.asUintN(64, BigInt(Math.trunc(v))); lo = Number(x & 0xffffffffn); hi = Number(x >> 32n); }
  for (let i = 0; i < 4; i++) { b[i] = lo & 255; lo = Math.floor(lo / 256); b[4 + i] = hi & 255; hi = Math.floor(hi / 256); } return b; }
const xor64 = (a, b) => Number(BigInt(a) ^ BigInt(b));

class Mem {
  constructor() { this.regions = []; }
  add(lo, size, name, ro) { const r = { lo, hi: lo + size, buf: new Uint8Array(size), name, ro: !!ro }; if (name === "stack") r.init = new Uint8Array(size); this.regions.push(r); return r; }
  find(a, n) { for (const r of this.regions) if (a >= r.lo && a + n <= r.hi) return r; return null; }
  ok(a, n) { return !!this.find(a, n); }
  read(a, n) { const r = this.find(a, n); if (!r) throw new Crash("SIGSEGV", a); return r.buf.slice(a - r.lo, a - r.lo + n); }
  write(a, b) {
    const r = this.find(a, b.length); if (!r || r.ro) throw new Crash("SIGSEGV", a);
    r.buf.set(b, a - r.lo); if (r.init) r.init.fill(1, a - r.lo, a - r.lo + b.length);
  }
  u64(a) { const b = this.read(a, 8); let lo = 0, hi = 0; for (let i = 3; i >= 0; i--) { lo = lo * 256 + b[i]; hi = hi * 256 + b[4 + i]; } return hi * 4294967296 + lo; }
  i32(a) { const b = this.read(a, 4); return b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24); }
  i8(a) { return (this.read(a, 1)[0] << 24) >> 24; }
  cstr(a) { let s = ""; for (let k = 0; k < 100000; k++) { const c = this.read(a + k, 1)[0]; if (!c) return s; s += String.fromCharCode(c); } return s; }
  setU64(a, v) { this.write(a, u64bytes(v)); }
  initMask(a, n) { const r = this.find(a, n); if (!r || !r.init) return "1".repeat(n); let s = ""; for (let i = 0; i < n; i++) s += r.init[a - r.lo + i] ? "1" : "0"; return s; }
}

/* ---------- glibc malloc, small version: chunks carved from the top, tcache (7 per size), fastbins ---------- */
class Heap {
  constructor(m) { this.m = m; this.mem = m.mem; this.r = null; this.size = new Map(); this.tc = {}; this.fast = {}; this.big = [];
    this.FREED = new Set(); this.ALLOCED = new Set(); this.ORDER = []; }
  init() {
    if (this.r) return;
    this.r = this.mem.add(HEAP_LO, HEAP_GROW, "heap"); this.lo = HEAP_LO; this.hi = HEAP_LO + HEAP_GROW;
    this.mem.setU64(this.lo + 8, 0x291);                                  /* tcache_perthread_struct, 0x290 bytes */
    this.top = this.lo + 0x290; this.topHdr();
  }
  topHdr() { this.mem.setU64(this.top + 8, (this.hi - this.top) + 1); }
  grow(cs) {
    while (this.top + cs + 32 > this.hi) {
      if (this.hi - this.lo > 0x4000000) return false;
      const nb = new Uint8Array(this.r.buf.length + HEAP_GROW); nb.set(this.r.buf); this.r.buf = nb; this.hi += HEAP_GROW; this.r.hi = this.hi;
    }
    return true;
  }
  csize(n) { return Math.max(32, Math.floor((n + 8 + 15) / 16) * 16); }
  tcSync(cs) {                                                            /* counts[] and entries[] inside the tcache struct */
    const i = (cs - 32) / 16; if (i < 0 || i >= 64) return;
    const L = this.tc[cs] || [];
    this.mem.write(this.lo + 0x10 + i * 2, [L.length & 255, L.length >> 8]);
    this.mem.setU64(this.lo + 0x10 + 128 + i * 8, L.length ? L[L.length - 1] : 0);
  }
  plan(cs) {                                                              /* the words trace.py would watch */
    const out = [], seen = new Set();
    for (let k = this.ORDER.length - 1; k >= 0 && out.length < 4; k--) { const p = this.ORDER[k];
      if (this.FREED.has(p) && !seen.has(p) && this.size.get(p) === cs) { seen.add(p); out.push(p, p + 8); } }
    return out;
  }
  malloc(n, fn, line, arg) {
    this.init();
    if (n < 0 || n > 0x1000000) return 0;
    const cs = this.csize(n), watched = this.plan(cs), writes = [];
    let p = 0;
    const tc = this.tc[cs];
    if (fn === "malloc" && tc && tc.length) {                              /* tcache: the newest freed block of this size */
      p = tc.pop(); this.tcSync(cs);
      const old = hex(this.mem.read(p + 8, 8));
      this.mem.write(p + 8, new Uint8Array(8));
      if (old !== ZERO8) writes.push({ addr: p + 8, size: 8, old, new: ZERO8, in: "__GI___libc_malloc" });
    } else if (this.fast[cs] && this.fast[cs].length) p = this.fast[cs].pop();
    else {
      const k = this.big.findIndex(q => this.size.get(q) === cs);
      if (k >= 0) p = this.big.splice(k, 1)[0];
      else {
        if (!this.grow(cs)) return 0;
        p = this.top + 16; this.mem.setU64(p - 8, cs + 1); this.top += cs; this.topHdr(); this.size.set(p, cs);
      }
    }
    if (fn === "calloc") this.mem.write(p, new Uint8Array(cs - 16));
    this.FREED.delete(p); this.ALLOCED.add(p);
    const w4 = watched.slice(0, 4);                                       /* trace.py only sees writes to the words it watches */
    if (w4.length) this.m.lib.push({ func: fn, line, arg, watched: w4, writes: writes.filter(x => w4.includes(x.addr)) });
    return p;
  }
  free(p, line) {
    if (p === 0) return;
    if (!this.ALLOCED.has(p) || !this.size.has(p)) throw new Crash("bad free", p);
    if (this.FREED.has(p)) throw new Crash("double free", p);
    const cs = this.size.get(p), w0 = hex(this.mem.read(p, 8)), w1 = hex(this.mem.read(p + 8, 8)), writes = [];
    const tc = this.tc[cs] || (this.tc[cs] = []);
    let where = "tcache_put";
    if (tc.length < 7 && cs <= 0x410) {
      const next = tc.length ? tc[tc.length - 1] : 0;
      this.mem.write(p + 8, TCACHE_KEY); this.mem.setU64(p, xor64(Math.floor(p / 4096), next)); tc.push(p); this.tcSync(cs);
    } else if (cs <= 0x80) {
      const L = this.fast[cs] || (this.fast[cs] = []), next = L.length ? L[L.length - 1] : 0;
      this.mem.setU64(p, xor64(Math.floor(p / 4096), next)); L.push(p); where = "_int_free";
    } else {
      this.mem.setU64(p, 0x7ffff7e03b20); this.mem.setU64(p + 8, 0x7ffff7e03b20); where = "_int_free";
      if (p - 16 + cs === this.top) { this.top = p - 16; this.size.delete(p); this.topHdr(); } else this.big.push(p);
    }
    const n1 = hex(this.mem.read(p + 8, 8)), n0 = hex(this.mem.read(p, 8));
    if (n1 !== w1) writes.push({ addr: p + 8, size: 8, old: w1, new: n1, in: where });
    if (n0 !== w0) writes.push({ addr: p, size: 8, old: w0, new: n0, in: where });
    this.FREED.add(p); this.ORDER.push(p);
    const nx = p - 16 + cs;
    this.m.lib.push({ func: "free", line, arg: p, watched: [p, p + 8, nx, nx + 8], writes });
  }
  chunks() {                                                              /* like trace.py's chunks_now() */
    if (!this.r) return [];
    const out = [{ addr: this.lo + 16, size: 0x290, state: "used", what: "tcache" }];
    for (const p of [...this.size.keys()].sort((a, b) => a - b)) {
      if (out.length >= CHUNK_MAX) break;
      const used = !this.FREED.has(p);
      out.push({ addr: p, size: this.size.get(p), state: used ? "used" : "freed", what: used && !this.ALLOCED.has(p) ? "malloc" : null });
    }
    out.push({ addr: this.top + 16, size: this.hi - this.top, state: "top", what: null });
    return out;
  }
}

/* ---------- the interpreter ---------- */
class Machine {
  constructor(prog, opts) {
    this.prog = prog; this.opts = opts || {};
    this.mem = new Mem(); this.stack = this.mem.add(STACK_TOP - STACK_SIZE, STACK_SIZE, "stack");
    this.ro = this.mem.add(RODATA, Math.max(16, prog.roSize), "rodata", false);
    for (const [s, a] of prog.lits) this.mem.write(a, [...s].map(c => c.charCodeAt(0)).concat([0]));
    this.ro.ro = true;
    this.heap = new Heap(this);
    this.frames = []; this.steps = []; this.meta = []; this.lib = []; this.out = "";
    this.KNOWN = new Map(); this.fid = 0; this.last = null; this.ops = 0; this.rax = 0;
  }
  top() { return this.frames[this.frames.length - 1]; }
  line() { const f = this.top(); return f ? f.line : 0; }

  /* one gdb "step": a snapshot before the line runs. Two stops on the same line in the same frame are one step. */
  stop(line, force, events) {
    const f = this.top(); f.line = line;
    if (!force && this.last && this.last.fid === f.id && this.last.line === line) return;
    this.last = { fid: f.id, line };
    this.snapshot(line, events);
  }
  snapshot(line, events) {
    if (this.steps.length >= MAX_STEPS) throw new Halt("limit");
    const frames = [], meta = [];
    for (let k = this.frames.length - 1; k >= 0; k--) {
      const f = this.frames[k], vars = this.vars(f);
      const fr = { func: f.fn.name, at: f.line, sig: f.fn.sig, vars };
      Object.assign(fr, this.frameMem(f, vars));
      frames.push(fr);
      if (this.opts.meta) meta.push(vars.map(v => this.mem.initMask(v.addr, v.size)));
    }
    const chunks = this.heap.chunks();
    const starts = new Set(chunks.filter(c => c.state === "used").map(c => c.addr)), locals = new Set();
    frames.forEach(fr => fr.vars.forEach(v => { if (v.kind === "other" && v.type.startsWith("struct ") && !v.type.includes("[")) locals.add(v.addr); }));
    const real = chunks.length ? a => starts.has(a) || locals.has(a) : a => locals.has(a);
    frames.forEach(fr => this.discover(fr.vars, real));
    let ret = null;
    const P = this.steps[this.steps.length - 1];
    if (P && frames.length < P.frames.length) {                            /* a function just returned: what's in rax */
      const fn = this.prog.funcs[P.frames[0].func];
      if (fn && fn.ret.k !== "void") ret = { func: fn.name, type: typeStr(fn.ret), value: isPtr(fn.ret) ? this.rax : this.rax | 0 };
    }
    const step = { line, func: frames[0].func, frames, heap: this.heapNow(), chunks, ret, out: this.out,
      lib: this.lib.filter(c => c.writes.length || ["malloc", "calloc", "realloc", "free"].includes(c.func)), preview: true };
    if (events) step.events = events;
    this.lib = [];
    this.steps.push(step);
    if (this.opts.meta) this.meta.push(meta);
    return step;
  }
  vars(f) {
    const out = [];
    for (let k = f.scopes.length - 1; k >= 0; k--) for (const s of f.scopes[k]) {
      const t = s.t, a = f.rbp + s.off, size = sizeOf(t, this.prog);
      const kind = isPtr(t) ? "ptr" : isInt(t) ? "int" : "other";
      let value = null;
      if (kind === "ptr") value = this.mem.u64(a); else if (t.k === "int") value = this.mem.i32(a); else if (t.k === "char") value = this.mem.i8(a);
      out.push({ name: s.name, type: typeStr(t), addr: a, value, kind,
        struct: isPtr(t) && t.to.k === "struct" ? typeStr(t.to) : null, size, bytes: hex(this.mem.read(a, size)),
        arg: !!s.arg, target: isPtr(t) ? typeStr(t.to) : null, decl: s.decl });
    }
    return out;
  }
  frameMem(f, vars) {
    const rbp = f.rbp, rsp = f.rsp;
    let lo = Math.min(rsp, ...vars.filter(v => v.addr < rbp).map(v => v.addr)); lo -= lo % 8;
    if (rbp + 16 - lo > FRAME_MAX) return {};
    return { rbp, rsp, lo, frame_bytes: hex(this.mem.read(lo, rbp + 16 - lo)) };
  }
  readBlock(addr, sname) {
    const S = this.prog.structs[sname.slice(7)];
    if (!S || !S.complete || !this.mem.ok(addr, S.size)) return null;
    const fields = S.fields.map(f => {
      const a = addr + f.off, kind = isPtr(f.t) ? "ptr" : isInt(f.t) ? "int" : "other";
      const value = kind === "ptr" ? this.mem.u64(a) : f.t.k === "int" ? this.mem.i32(a) : f.t.k === "char" ? this.mem.i8(a) : null;
      return { name: f.name, type: typeStr(f.t), kind, value, offset: f.off, size: sizeOf(f.t, this.prog), target: kind === "ptr" ? typeStr(f.t.to) : null };
    });
    return { addr, type: sname, fields, freed: false, size: S.size, bytes: hex(this.mem.read(addr, S.size)),
      header: this.mem.ok(addr - 16, 16) ? hex(this.mem.read(addr - 16, 16)) : null };
  }
  discover(vars, real) {                                                  /* every block reachable from these variables */
    const q = vars.filter(v => v.struct && v.value).map(v => [v.value, v.struct]);
    while (q.length && this.KNOWN.size < NODE_MAX) {
      const [a, sn] = q.shift();
      if (!a || this.KNOWN.has(a) || this.heap.FREED.has(a) || !real(a)) continue;
      const b = this.readBlock(a, sn); if (!b) continue;
      this.KNOWN.set(a, sn);
      b.fields.forEach((f, i) => { const ft = this.prog.structs[sn.slice(7)].fields[i].t;
        if (f.kind === "ptr" && f.value && ft.to.k === "struct") q.push([f.value, typeStr(ft.to)]); });
    }
  }
  heapNow() {
    const out = [];
    for (const [a, sn] of this.KNOWN) { const b = this.readBlock(a, sn); if (!b) continue; b.freed = this.heap.FREED.has(a); out.push(b); }
    return out.sort((x, y) => x.addr - y.addr);
  }

  /* ---------- calls ---------- */
  callFn(fn, args, line) {
    if (!fn.body) throw new CErr(line, `${fn.name}() has no body yet`);
    if (this.frames.length >= MAX_DEPTH) throw new Halt("depth");           /* deeper would overflow JavaScript's own stack */
    const caller = this.top(), L = fn.layout;
    const rbp = caller ? caller.rsp - 16 : MAIN_RBP;
    const f = { id: ++this.fid, fn, rbp, rsp: rbp - L.frame, line: fn.braceLine, scopes: [fn.scope] };
    if (rbp + L.minOff - 256 < this.stack.lo) throw new Crash("SIGSEGV", rbp + L.minOff, "stack overflow: the recursion never stops");
    this.mem.setU64(rbp, caller ? caller.rbp : MAIN_SAVED_RBP);
    this.mem.setU64(rbp + 8, caller ? CODE + ((line * 13) % 0x200) : LIBC_RET);
    this.stack.init.fill(0, rbp + Math.min(L.minOff, -L.frame) - 8 - this.stack.lo, rbp - this.stack.lo);   /* leftover bytes: not set yet */
    if (L.canary !== null) this.mem.write(rbp + L.canary, CANARY);
    fn.params.forEach((p, i) => this.store(rbp + p.off, p.t, args[i]));
    this.frames.push(f);
    let rv;
    try {
      if (fn.protected) this.stop(fn.braceLine);
      this.block(fn.body);
    } catch (e) { if (!(e instanceof Ret)) throw e; rv = e.v; }
    f.scopes.length = 1;
    this.stop(fn.endLine);
    this.frames.pop();
    if (caller) this.last = { fid: caller.id, line: caller.line };
    return fn.ret.k === "void" ? { t: VOID, v: 0 } : rv === undefined ? { t: fn.ret, v: this.rax } : rv;
  }
  setRax(v) { if (v && v.t && isScalar(v.t)) this.rax = isPtr(v.t) ? v.v : v.v >>> 0; }

  /* ---------- statements ---------- */
  block(b) {
    const f = this.top(), push = !b.fnBody && b.decls.length;
    if (push) f.scopes.push(b.decls);
    try { for (const s of b.stmts) this.exec(s); }
    finally { if (push) f.scopes.pop(); }
  }
  exec(s) {
    switch (s.k) {
      case "block": return this.block(s);
      case "decl": {
        const first = s.items.find(i => i.init);
        if (first) this.stop(first.line);
        for (const it of s.items) if (it.init) { this.top().line = it.line; this.init(this.top().rbp + it.slot.off, it.slot.t, it.init); }
        return;
      }
      case "expr": this.stop(s.line); this.setRax(this.rv(s.e)); return;
      case "if": this.stop(s.line); if (this.truth(this.rv(s.cond))) this.exec(s.then); else if (s.els) this.exec(s.els); return;
      case "while":                                                       /* while (1) has no code on its own line */
        for (;;) {
          if (s.cond.k !== "num") this.stop(s.line);
          if (!this.truth(this.rv(s.cond))) return;
          try { this.exec(s.body); } catch (e) { if (e === BRK) return; if (e !== CONT) throw e; }
        }
      case "for": {
        const f = this.top(), push = s.scope.length;
        if (push) f.scopes.push(s.scope);
        try {
          const test = s.cond && s.cond.k !== "num";                        /* for (;;) has no code on its own line */
          if (s.init || test) this.stop(s.line);
          if (s.init) { if (s.init.k === "decl") { for (const it of s.init.items) if (it.init) this.init(f.rbp + it.slot.off, it.slot.t, it.init); } else this.rv(s.init.e); }
          for (;;) {
            if (s.cond && !this.truth(this.rv(s.cond))) return;
            try { this.exec(s.body); } catch (e) { if (e === BRK) return; if (e !== CONT) throw e; }
            if (s.step || test) this.stop(s.line);
            if (s.step) this.rv(s.step);
          }
        } finally { if (push) f.scopes.pop(); }
      }
      case "return": {
        this.stop(s.line);
        const fn = this.top().fn;
        if (!s.e) { if (fn.ret.k !== "void") throw new CErr(s.line, `${fn.name}() must return a ${typeStr(fn.ret)}`); throw new Ret(undefined); }
        if (fn.ret.k === "void") throw new CErr(s.line, `${fn.name}() is void: it can't return a value`);
        const v = this.conv(this.rv(s.e), fn.ret, s.line); this.setRax(v);
        throw new Ret(v);
      }
      case "break": this.stop(s.line); throw BRK;
      case "continue": this.stop(s.line); throw CONT;
      case "empty": return;
      case "tail": return this.tail(s);
    }
  }
  /* the half-typed line: show what it would do so far, then stop */
  tail(s) {
    const info = s.info, f = this.top();
    let empty = false;
    if (info.alloc) {
      let a = null;
      if (info.alloc.args) try { a = info.alloc.args.map(e => this.int(this.rv(e), e.line)); }
      catch (e) { if (!(e instanceof CErr) && !(e instanceof Crash)) throw e; a = null; }
      this.lib = [];
      if (a === null) { this.heap.init(); empty = true; }
      else this.heap.malloc(info.alloc.fn === "malloc" ? a[0] : a[0] * a[1], info.alloc.fn, info.alloc.line, a[0]);
    }
    f.line = s.line;
    const step = this.snapshot(s.line);
    if (empty) {                                                          /* malloc( with no size yet: an empty block */
      const top = step.chunks.pop();
      step.chunks.push({ addr: top.addr, size: 16, state: "used", what: null }, { addr: top.addr + 16, size: top.size - 16, state: "top", what: null });
    }
    throw new Halt("tail");
  }
  init(a, t, e) {
    if (e.k === "list") {
      if (t.k === "arr") {
        if (e.items.length > t.n) throw new CErr(e.line, `too many values for an array of ${t.n}`);
        this.mem.write(a, new Uint8Array(sizeOf(t, this.prog)));
        e.items.forEach((x, i) => this.init(a + i * sizeOf(t.of, this.prog), t.of, x));
      } else if (t.k === "struct") {
        const S = this.prog.structs[t.name];
        if (e.items.length > S.fields.length) throw new CErr(e.line, `too many values for struct ${t.name}`);
        this.mem.write(a, new Uint8Array(S.size));
        e.items.forEach((x, i) => this.init(a + S.fields[i].off, S.fields[i].t, x));
      } else throw new CErr(e.line, "a { … } list only fits an array or a struct");
      return;
    }
    if (t.k === "arr" && t.of.k === "char" && e.k === "str") {
      if (e.v.length > t.n) throw new CErr(e.line, `"${e.v}" doesn't fit in ${t.n} chars`);
      const b = new Uint8Array(t.n); [...e.v].forEach((c, i) => { b[i] = c.charCodeAt(0); }); this.mem.write(a, b); return;
    }
    if (t.k === "arr") throw new CErr(e.line, "an array starts with a { … } list");
    const v = this.rv(e); this.setRax(v); this.store(a, t, v, e.line);
  }

  /* ---------- expressions ---------- */
  tick(line) { if (++this.ops > MAX_OPS) throw new CErr(line, "this runs a very long time without finishing: is there an endless loop?"); }
  lookup(name, line) {
    const f = this.top();
    for (let k = f.scopes.length - 1; k >= 0; k--) { const sc = f.scopes[k]; for (let j = sc.length - 1; j >= 0; j--) if (sc[j].name === name) return sc[j]; }
    if (this.prog.funcs[name] || BUILTIN.has(name)) throw new CErr(line, `${name} is a function: call it with ${name}(…)`);
    throw new CErr(line, `there's no variable called ${name} here`);
  }
  truth(v) { if (v.t.k === "struct") throw new CErr(0, "a struct can't be true or false"); return v.v !== 0; }
  int(v, line) { if (!isScalar(v.t)) throw new CErr(line, "expected a number here"); return isPtr(v.t) ? v.v : v.v; }
  field(t, name, line, how) {
    if (t.k !== "struct") throw new CErr(line, `${how === "->" ? "-> needs a pointer to a struct" : ". needs a struct"}, but this is ${typeStr(t)}`);
    const S = this.prog.structs[t.name];
    if (!S || !S.complete) throw new CErr(line, `struct ${t.name} isn't defined yet`);
    const f = S.fields.find(x => x.name === name);
    if (!f) throw new CErr(line, `struct ${t.name} has no field called ${name}`);
    return f;
  }
  lv(e) {
    this.tick(e.line);
    switch (e.k) {
      case "id": { if (e.name === "NULL") throw new CErr(e.line, "NULL can't be assigned to");
        const s = this.lookup(e.name, e.line); return { t: s.t, a: this.top().rbp + s.off }; }
      case "un": if (e.op === "*") {
        const p = this.rv(e.a);
        if (!isPtr(p.t)) throw new CErr(e.line, `* needs a pointer, but this is ${typeStr(p.t)}`);
        if (p.t.to.k === "void") throw new CErr(e.line, "can't use * on a void pointer: cast it first");
        return { t: p.t.to, a: p.v };
      } break;
      case "index": {
        const b = this.rv(e.a), i = this.rv(e.b);
        if (!isPtr(b.t)) throw new CErr(e.line, `[ ] needs an array or a pointer, but this is ${typeStr(b.t)}`);
        if (!isInt(i.t)) throw new CErr(e.line, "an index must be a number");
        return { t: b.t.to, a: b.v + i.v * sizeOf(b.t.to, this.prog, e.line) };
      }
      case "dot": { const s = this.lv(e.a), f = this.field(s.t, e.f, e.line, "."); return { t: f.t, a: s.a + f.off }; }
      case "arrow": {
        const p = this.rv(e.a);
        if (!isPtr(p.t)) throw new CErr(e.line, `-> needs a pointer to a struct, but this is ${typeStr(p.t)}`);
        const f = this.field(p.t.to, e.f, e.line, "->"); return { t: f.t, a: p.v + f.off };
      }
      case "str": return { t: arr(CHAR, e.v.length + 1), a: this.prog.lits.get(e.v) };
    }
    throw new CErr(e.line, "this can't be assigned to or have its address taken");
  }
  load(l) {
    const t = l.t;
    if (t.k === "arr") return { t: ptr(t.of), v: l.a };
    if (t.k === "struct") return { t, a: l.a, bytes: this.mem.read(l.a, sizeOf(t, this.prog)) };
    if (t.k === "int") return { t, v: this.mem.i32(l.a) };
    if (t.k === "char") return { t, v: this.mem.i8(l.a) };
    if (t.k === "ptr") return { t, v: this.mem.u64(l.a) };
    throw new CErr(this.line(), "a void value can't be used");
  }
  conv(v, t, line) {
    if (t.k === "void") return { t, v: 0 };
    if (t.k === "struct") {
      if (v.t.k !== "struct" || v.t.name !== t.name) throw new CErr(line, `can't turn ${typeStr(v.t)} into ${typeStr(t)}`);
      return v;
    }
    if (!isScalar(v.t)) throw new CErr(line, `can't turn ${typeStr(v.t)} into ${typeStr(t)}`);
    if (t.k === "int") return { t, v: isPtr(v.t) ? Number(BigInt.asIntN(32, BigInt(Math.trunc(v.v)))) : v.v | 0 };
    if (t.k === "char") return { t, v: ((isPtr(v.t) ? Number(BigInt.asIntN(8, BigInt(Math.trunc(v.v)))) : v.v) << 24) >> 24 };
    if (t.k === "ptr") return { t, v: isPtr(v.t) ? v.v : v.v < 0 ? Number(BigInt.asUintN(64, BigInt(v.v))) : v.v };
    throw new CErr(line, `can't turn ${typeStr(v.t)} into ${typeStr(t)}`);
  }
  store(a, t, v, line) {
    if (t.k === "arr") throw new CErr(line, "an array can't be assigned: set its elements one by one");
    const c = this.conv(v, t, line);
    if (t.k === "struct") return this.mem.write(a, c.bytes);
    if (t.k === "int") return this.mem.write(a, [c.v & 255, (c.v >> 8) & 255, (c.v >> 16) & 255, (c.v >> 24) & 255]);
    if (t.k === "char") return this.mem.write(a, [c.v & 255]);
    return this.mem.write(a, u64bytes(c.v));
  }
  rv(e) {
    this.tick(e.line);
    switch (e.k) {
      case "num": return { t: INT, v: e.v };
      case "str": return { t: CHARP, v: this.prog.lits.get(e.v) };
      case "id": if (e.name === "NULL") return { t: VOIDP, v: 0 }; return this.load(this.lv(e));
      case "un": {
        if (e.op === "*") return this.load(this.lv(e));
        if (e.op === "&") { if (e.a.k === "id" && e.a.name === "NULL") throw new CErr(e.line, "NULL has no address");
          const l = this.lv(e.a); return { t: ptr(l.t), v: l.a }; }
        const a = this.rv(e.a);
        if (e.op === "!") { if (!isScalar(a.t)) throw new CErr(e.line, "! needs a number or a pointer"); return { t: INT, v: a.v === 0 ? 1 : 0 }; }
        if (!isInt(a.t)) throw new CErr(e.line, `${e.op} needs a number`);
        return { t: INT, v: e.op === "-" ? (-a.v) | 0 : e.op === "~" ? ~a.v : a.v };
      }
      case "pre": case "post": {
        const l = this.lv(e.a), old = this.load(l);
        if (!isScalar(old.t)) throw new CErr(e.line, `${e.op} needs a number or a pointer`);
        const nv = this.arith(e.op === "++" ? "+" : "-", old, { t: INT, v: 1 }, e.line);
        this.store(l.a, l.t, nv, e.line);
        return e.k === "pre" ? this.conv(nv, l.t, e.line) : old;
      }
      case "bin": {
        if (e.op === "&&") return { t: INT, v: this.truth(this.rv(e.a)) && this.truth(this.rv(e.b)) ? 1 : 0 };
        if (e.op === "||") return { t: INT, v: this.truth(this.rv(e.a)) || this.truth(this.rv(e.b)) ? 1 : 0 };
        const a = this.rv(e.a), b = this.rv(e.b);
        return this.arith(e.op, a, b, e.line);
      }
      case "assign": {
        let b = this.rv(e.b);
        const l = this.lv(e.a);
        if (l.t.k === "arr") throw new CErr(e.line, "an array can't be assigned: set its elements one by one");
        if (e.op !== "=") b = this.arith(e.op.slice(0, -1), this.load(l), b, e.line);
        const v = this.conv(b, l.t, e.line);
        this.store(l.a, l.t, v, e.line);
        return v;
      }
      case "cond": return this.truth(this.rv(e.c)) ? this.rv(e.a) : this.rv(e.b);
      case "call": return this.call(e);
      case "index": case "dot": case "arrow": return this.load(this.lv(e));
      case "cast": {
        const v = this.rv(e.a);
        if (e.t.k === "void") return { t: VOID, v: 0 };
        if (e.t.k === "struct") throw new CErr(e.line, "casting to a struct isn't supported");
        return this.conv(v, e.t, e.line);
      }
      case "sizeofT": return { t: INT, v: sizeOf(e.t, this.prog, e.line) };
      case "sizeofE": return { t: INT, v: sizeOf(this.typeOf(e.a), this.prog, e.line) };
    }
    throw new CErr(e.line, "the preview can't work this out");
  }
  typeOf(e) {                                                              /* sizeof x: x's type, without running x */
    switch (e.k) {
      case "num": case "sizeofT": case "sizeofE": return INT;
      case "str": return arr(CHAR, e.v.length + 1);
      case "id": return e.name === "NULL" ? VOIDP : this.lookup(e.name, e.line).t;
      case "un": { const t = this.typeOf(e.a);
        if (e.op === "*") { if (t.k === "ptr") return t.to; if (t.k === "arr") return t.of; throw new CErr(e.line, "* needs a pointer"); }
        if (e.op === "&") return ptr(t); return INT; }
      case "pre": case "post": case "assign": return this.typeOf(e.a);
      case "index": { const t = this.typeOf(e.a); if (t.k === "ptr") return t.to; if (t.k === "arr") return t.of; throw new CErr(e.line, "[ ] needs an array or a pointer"); }
      case "dot": return this.field(this.typeOf(e.a), e.f, e.line, ".").t;
      case "arrow": { const t = this.typeOf(e.a); if (!isPtr(t)) throw new CErr(e.line, "-> needs a pointer to a struct"); return this.field(t.to, e.f, e.line, "->").t; }
      case "call": { if (e.name === "malloc" || e.name === "calloc") return VOIDP; if (e.name === "free") return VOID;
        if (BUILTIN.has(e.name)) return INT; const fn = this.prog.funcs[e.name]; if (!fn) throw new CErr(e.line, `${e.name}() isn't defined`); return fn.ret; }
      case "cast": return e.t;
      case "cond": return this.typeOf(e.a);
      case "bin": { if (["+", "-"].includes(e.op)) { const a = this.typeOf(e.a), b = this.typeOf(e.b), pa = a.k === "ptr" || a.k === "arr", pb = b.k === "ptr" || b.k === "arr";
          if (pa && !pb) return a.k === "arr" ? ptr(a.of) : a; if (pb && !pa) return b.k === "arr" ? ptr(b.of) : b; } return INT; }
    }
    return INT;
  }
  arith(op, a, b, line) {
    const pa = isPtr(a.t), pb = isPtr(b.t);
    if (a.t.k === "struct" || b.t.k === "struct") throw new CErr(line, `${op} doesn't work on a struct`);
    if (["==", "!=", "<", ">", "<=", ">="].includes(op)) {
      const x = a.v, y = b.v;
      return { t: INT, v: (op === "==" ? x === y : op === "!=" ? x !== y : op === "<" ? x < y : op === ">" ? x > y : op === "<=" ? x <= y : x >= y) ? 1 : 0 };
    }
    if (op === "+" || op === "-") {
      if (pa && pb) {
        if (op === "+") throw new CErr(line, "two pointers can't be added");
        return { t: INT, v: Math.trunc((a.v - b.v) / sizeOf(a.t.to, this.prog, line)) | 0 };
      }
      if (pa) return { t: a.t, v: a.v + (op === "+" ? 1 : -1) * b.v * sizeOf(a.t.to, this.prog, line) };
      if (pb) { if (op === "-") throw new CErr(line, "a number minus a pointer doesn't make sense"); return { t: b.t, v: b.v + a.v * sizeOf(b.t.to, this.prog, line) }; }
      return { t: INT, v: op === "+" ? (a.v + b.v) | 0 : (a.v - b.v) | 0 };
    }
    if (pa || pb) throw new CErr(line, `${op} doesn't work on pointers`);
    const x = a.v | 0, y = b.v | 0;
    switch (op) {
      case "*": return { t: INT, v: Math.imul(x, y) };
      case "/": case "%":
        if (y === 0 || (x === -2147483648 && y === -1)) throw new Crash("SIGFPE", 0, "division by zero");
        return { t: INT, v: op === "/" ? (x / y) | 0 : (x % y) | 0 };
      case "&": return { t: INT, v: x & y }; case "|": return { t: INT, v: x | y }; case "^": return { t: INT, v: x ^ y };
      case "<<": return { t: INT, v: x << (y & 31) }; case ">>": return { t: INT, v: x >> (y & 31) };
    }
    throw new CErr(line, `the operator ${op} isn't supported in the preview`);
  }
  call(e) {
    const line = e.line, n = e.args.length;
    const fn = this.prog.funcs[e.name];
    if (!fn && !BUILTIN.has(e.name)) throw new CErr(line, `${e.name}() isn't supported in the preview (only malloc, calloc, free, printf, puts, putchar and your own functions)`);
    const want = fn ? fn.params.length : { malloc: 1, calloc: 2, free: 1, puts: 1, putchar: 1 }[e.name];
    if (want !== undefined && n !== want) throw new CErr(line, `${e.name}() takes ${want} argument${want === 1 ? "" : "s"}, not ${n}`);
    if (e.name === "printf" && !n) throw new CErr(line, "printf() needs a format string");
    const args = new Array(n);
    for (let i = n - 1; i >= 0; i--) args[i] = this.rv(e.args[i]);             /* gcc works out the last argument first */
    let r;
    if (fn) r = this.callFn(fn, fn.params.map((p, i) => this.conv(args[i], p.t, line)), line);
    else r = this.builtin(e.name, args, line);
    this.setRax(r);
    return r;
  }
  builtin(name, a, line) {
    const num = (v, what) => { if (!isScalar(v.t)) throw new CErr(line, `${name}() needs a number for ${what}`); return v.v; };
    switch (name) {
      case "malloc": case "calloc": {
        const n = name === "malloc" ? num(a[0], "the size") : num(a[0], "the count") * num(a[1], "the size");
        const p = this.heap.malloc(n, name, line, num(a[0]));
        this.rax = p;
        this.stop(this.top().line, true);                                   /* gdb stops again when malloc returns */
        return { t: VOIDP, v: p };
      }
      case "free": {
        if (!isPtr(a[0].t)) throw new CErr(line, "free() needs a pointer");
        this.heap.free(a[0].v, line); return { t: VOID, v: 0 };
      }
      case "printf": {
        if (!isPtr(a[0].t)) throw new CErr(line, "printf()'s first argument must be a string");
        const f = this.mem.cstr(a[0].v); let s = "", k = 1;
        for (let i = 0; i < f.length; i++) {
          if (f[i] !== "%") { s += f[i]; continue; }
          const c = f[++i];
          if (c === "%") { s += "%"; continue; }
          if (!"disucxp".includes(c) || c === undefined) throw new CErr(line, `printf's %${c || ""} isn't supported in the preview (use %d, %s or %c)`);
          if (k >= a.length) throw new CErr(line, `printf has more % than values: %${c} has nothing to print`);
          const v = a[k++];
          if (c === "s") { if (!isPtr(v.t)) throw new CErr(line, "%s needs a string (a char pointer)"); s += v.v === 0 ? "(null)" : this.mem.cstr(v.v); }
          else if (c === "c") s += String.fromCharCode(num(v, "%c") & 255);
          else if (c === "p") s += v.v === 0 ? "(nil)" : "0x" + v.v.toString(16);
          else if (c === "u") s += String(num(v, "%u") >>> 0);
          else if (c === "x") s += (num(v, "%x") >>> 0).toString(16);
          else s += String(isPtr(v.t) ? Number(BigInt.asIntN(32, BigInt(v.v))) : v.v | 0);
        }
        this.out += s; return { t: INT, v: s.length };
      }
      case "puts": { if (!isPtr(a[0].t)) throw new CErr(line, "puts() needs a string"); const s = this.mem.cstr(a[0].v) + "\n"; this.out += s; return { t: INT, v: s.length }; }
      case "putchar": { const c = num(a[0], "the character") & 255; this.out += String.fromCharCode(c); return { t: INT, v: c }; }
    }
  }

  /* the program dies: one last step that the viewer marks as a bug */
  crash(c) {
    const f = this.top(); if (!f) return null;
    const line = f.line;
    let ev, msg;
    if (c.kind === "double free") { ev = { kind: "double free", addr: c.addr }; msg = `line ${line}: free() of a block that is already freed (double free). glibc would stop the program here`; }
    else if (c.kind === "bad free") { ev = { kind: "bad free", addr: c.addr }; msg = `line ${line}: free() of an address malloc never gave out. glibc would stop the program here`; }
    else {
      ev = { kind: "signal", name: c.kind, addr: c.addr, pending: true };
      msg = c.kind === "SIGFPE" ? `line ${line}: division by zero: the program would crash here (SIGFPE)`
        : c.msg ? `line ${line}: ${c.msg} (SIGSEGV)`
        : c.addr < 4096 ? `line ${line}: NULL dereference: this line reads or writes through a NULL pointer, so the program would crash here (SIGSEGV)`
        : `line ${line}: this line touches address 0x${c.addr.toString(16)}, which isn't the program's memory, so it would crash here (SIGSEGV)`;
    }
    this.last = null;
    this.snapshot(line, [ev]);
    return msg;
  }
}
const BUILTIN = new Set(["malloc", "calloc", "free", "printf", "puts", "putchar"]);

/* ---------- blueprints: what /blueprints (blueprints.py) sends, worked out here ---------- */
function blueprints(prog) {
  return prog.order.map(S => {
    const fields = []; let end = 0;
    for (const f of S.fields) {
      if (f.off > end) fields.push({ name: null, type: null, offset: end, size: f.off - end });
      const size = sizeOf(f.t, prog);
      fields.push({ name: f.name, type: typeStr(f.t), offset: f.off, size }); end = f.off + size;
    }
    if (S.size > end) fields.push({ name: null, type: null, offset: end, size: S.size - end });
    return { name: "struct " + S.name, size: S.size, fields };
  });
}

function newProg() {
  const prog = { structs: {}, order: [], funcs: {}, lits: new Map(), roSize: 0 };
  prog.lit = s => { if (!prog.lits.has(s)) { prog.lits.set(s, RODATA + prog.roSize); prog.roSize += s.length + 1; } };
  return prog;
}
function parse(toks) {
  const prog = newProg();
  const last = toks.length ? toks[toks.length - 1].line : 1;
  new Parser([...toks, { k: "eof", v: "", line: last }], prog).program();
  for (const name in prog.funcs) { const fn = prog.funcs[name]; if (!fn.body) continue;
    layout(fn, prog);
    fn.sig = `${joinTN(typeStr(fn.ret), fn.name)}(${fn.params.map(p => joinTN(typeStr(p.t), p.name)).join(", ")})`; }
  return prog;
}

/* the code you typed, up to the cursor, made whole: open blocks closed, the half-typed line marked as the tail */
function partialTokens(src, caret) {
  const before = src.slice(0, caret), after = src.slice(caret);
  const A = lex(before, true), sp = splitPrefix(A.toks);
  const caretLine = A.line;
  const inFn = sp.open.some(o => o.kind === "block");
  const toks = sp.keep.slice();
  const tailLine = sp.tail.length ? sp.tail[0].line : Math.max(caretLine, sp.lastTok ? sp.lastTok.line + 1 : 1);
  if (inFn) toks.push({ k: "tail", toks: sp.tail, line: tailLine, empty: !sp.tail.length });
  for (let k = sp.open.length - 1; k >= 0; k--) {
    toks.push({ k: "op", v: "}", line: tailLine });
    if (sp.open[k].kind === "struct") toks.push({ k: "op", v: ";", line: tailLine });
  }
  /* the code after the cursor: skip the rest of what you're in, keep the functions after it (main, often) */
  let rest = [];
  try { rest = lex(after, false, caretLine).toks; } catch (e) { if (!(e instanceof CErr)) throw e; rest = []; }
  const midToken = /\w$/.test(before) && /^\w/.test(after);
  let depth = sp.open.length, j = 0;
  if (depth > 0) {
    for (; j < rest.length && depth > 0; j++) { if (rest[j].v === "{") depth++; else if (rest[j].v === "}") depth--; }
    if (depth > 0) j = rest.length;
    else if (sp.open[0].kind === "struct" && rest[j] && rest[j].v === ";") j++;
  } else if (sp.tail.length || midToken) {
    let d = 0;
    for (; j < rest.length; j++) {
      const v = rest[j].v;
      if (v === "{") d++;
      else if (v === "}") { d--; if (d <= 0) { j++; if (rest[j] && rest[j].v === ";") j++; break; } }
      else if (v === ";" && d === 0) { j++; break; }
    }
  }
  return { toks: toks.concat(rest.slice(j)), tail: sp.tail, tailLine };
}

function run(src, opts) {
  opts = opts || {};
  const caret = opts.caret == null ? src.length : Math.max(0, Math.min(src.length, opts.caret));
  const res = { trace: null, error: null, bug: null, note: "", highlight: null, blueprints: [], partial: false, steps: 0 };
  let prog = null, firstErr = null, pt = null;
  try {
    if (src.slice(caret).trim() === "") {
      try { prog = parse(lex(src, false).toks); }
      catch (e) { if (!(e instanceof CErr)) throw e; firstErr = e; }
    }
    if (!prog) {
      pt = partialTokens(src, caret);
      try { prog = parse(pt.toks); res.partial = true; }
      catch (e) { if (!(e instanceof CErr)) throw e; throw firstErr && firstErr.line < e.line ? firstErr : e; }
    }
  } catch (e) {
    if (!(e instanceof CErr)) { res.error = { line: 0, msg: "the preview failed: " + e.message }; return res; }
    res.error = { line: e.line, msg: e.message }; return res;
  }
  try { res.blueprints = blueprints(prog); } catch (e) { res.blueprints = []; }
  if (pt) for (let k = 0; k < pt.tail.length - 1; k++) {                /* "struct ListNode" typed: its blueprint lights up */
    const a = pt.tail[k], b = pt.tail[k + 1], S = prog.structs[b.v];
    if (a.v === "struct" && b.k === "id" && S && S.complete) res.highlight = "struct " + b.v;
  }
  const main = prog.funcs.main;
  if (!main || !main.body) { res.note = "no main() yet: the preview runs main"; return res; }
  const m = new Machine(prog, opts);
  let atCursor = false;
  try { m.callFn(main, [], main.line); }
  catch (e) {
    if (e instanceof Halt) {
      if (e.why === "limit") res.note = `stopped after ${MAX_STEPS} steps, like trace.py`;
      if (e.why === "depth") res.note = `stopped at ${MAX_DEPTH} calls inside each other: does the recursion ever end?`;
      atCursor = e.why === "tail";
    }
    else if (e instanceof Crash) res.bug = m.crash(e);
    else if (e instanceof CErr) res.error = { line: e.line || m.line(), msg: e.message };
    else if (e === BRK || e === CONT) res.error = { line: m.line(), msg: "break or continue outside a loop" };
    else { res.error = { line: m.line(), msg: "the preview failed: " + (e && e.message) }; if (opts.debug) throw e; }
  }
  res.steps = m.steps.length;
  if (m.steps.length) res.trace = { file: "preview", allocs_tracked: true, watchpoints: true, preview: true, steps: m.steps };
  if (res.trace && atCursor) res.trace.stopped_at_cursor = true;         /* the program hasn't ended: no leak report yet */
  if (opts.meta) res.meta = m.meta;
  return res;
}

const API = { run, version: 1 };
if (typeof module !== "undefined" && module.exports) module.exports = API;
else root.CPreview = API;
})(typeof window !== "undefined" ? window : this);
