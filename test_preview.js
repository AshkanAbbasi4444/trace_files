#!/usr/bin/env node
/* test_preview.js: does the preview interpreter (preview.js) agree with the real gcc + gdb trace?

   node test_preview.js              every .c file here and in tests/
   node test_preview.js a.c b.c      just these

   For each file: gcc -g -O0, then gdb -q -nx -batch -x trace.py ./prog, then preview.js on the same code.
   It compares every step: the line, the function, the frames, each variable that has been set,
   what came back from a return, the program's output, and the heap: which block points to which.
   Addresses may differ, so pointers are compared by what they point to.
   It then checks the half-typed-line preview, stage by stage.

   One thing is allowed to differ: gdb sometimes stops twice on the same line when trace.py's
   watchpoint interrupts a step inside printf (it depends on leftover register values), so a real step
   that repeats the one before it may be skipped. And after a double free the preview adds the bug step
   where the real program just aborts. */
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), { spawnSync } = require("child_process");
const P = require("./preview.js");
const DIR = __dirname;

const files = process.argv.slice(2).length ? process.argv.slice(2).map(f => path.resolve(f))
  : [...fs.readdirSync(DIR).filter(f => f.endsWith(".c") && f !== "prog.c" && f !== "bp.c").map(f => path.join(DIR, f)),   /* those two are server.py's scratch files */
     ...(fs.existsSync(path.join(DIR, "tests")) ? fs.readdirSync(path.join(DIR, "tests")).filter(f => f.endsWith(".c")).map(f => path.join(DIR, "tests", f)) : [])];

function realTrace(code) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mvtest-"));
  try {
    fs.copyFileSync(path.join(DIR, "trace.py"), path.join(tmp, "trace.py"));
    fs.writeFileSync(path.join(tmp, "prog.c"), code);
    const cc = spawnSync("gcc", ["-g", "-O0", "prog.c", "-o", "prog"], { cwd: tmp, encoding: "utf8" });
    if (cc.status !== 0) return { gccError: (cc.stderr || "").trim().split("\n").find(l => /error/.test(l)) || "gcc failed" };
    spawnSync("gdb", ["-q", "-nx", "-batch", "-x", "trace.py", "./prog"], { cwd: tmp, encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"] });
    const out = path.join(tmp, "prog.json");
    if (!fs.existsSync(out)) return { gdbError: "gdb did not write prog.json" };
    return { trace: JSON.parse(fs.readFileSync(out, "utf8")) };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/* ---------- comparing one step ---------- */
const isRodata = a => a >= 0x555555556000 && a < 0x555555558000;
function stackRef(step, a) {                        /* a pointer into a local: which one, counted from main */
  const n = step.frames.length;
  for (let i = 0; i < n; i++) for (const v of step.frames[i].vars)
    if (v.addr && a >= v.addr && a < v.addr + v.size) return `${step.frames[i].func}#${n - 1 - i}:${v.name}+${a - v.addr}`;
  return null;
}
class Pairs {                                      /* real address <-> preview address, one to one on this step */
  constructor() { this.r2p = new Map(); this.p2r = new Map(); this.queue = []; }
  add(ra, pa, where) {
    if (this.r2p.has(ra) || this.p2r.has(pa)) {
      if (this.r2p.get(ra) === pa && this.p2r.get(pa) === ra) return null;
      return `${where}: points somewhere else than in the real trace (the two traces' pointers don't line up)`;
    }
    this.r2p.set(ra, pa); this.p2r.set(pa, ra); this.queue.push([ra, pa, where]); return null;
  }
}
function samePtr(R, Pv, rv, pv, pairs, where) {
  if (rv === 0 || pv === 0) return rv === pv ? null : `${where}: real ${rv === 0 ? "NULL" : "0x" + rv.toString(16)}, preview ${pv === 0 ? "NULL" : "0x" + pv.toString(16)}`;
  if (isRodata(rv) && isRodata(pv)) return null;
  const rs = stackRef(R, rv), ps = stackRef(Pv, pv);
  if (rs || ps) { if (rs !== ps) return `${where}: real points to ${rs || "the heap"}, preview to ${ps || "the heap"}`; }
  return pairs.add(rv, pv, where);
}
function compareStep(R, Pv, meta, k) {
  const errs = [], pairs = new Pairs(), err = m => { if (m) errs.push(m); };
  if (R.frames.length !== Pv.frames.length) return [`${R.frames.length} frames in the real trace, ${Pv.frames.length} in the preview`];
  R.frames.forEach((rf, i) => {
    const pf = Pv.frames[i], where = `frame ${rf.func}`;
    if (rf.func !== pf.func) return err(`${where}: the preview is in ${pf.func}`);
    if (rf.at !== pf.at) err(`${where}: real at line ${rf.at}, preview at line ${pf.at}`);
    if (rf.sig !== pf.sig) err(`${where}: signature "${rf.sig}" vs "${pf.sig}"`);
    const rn = rf.vars.map(v => v.name).join(","), pn = pf.vars.map(v => v.name).join(",");
    if (rn !== pn) return err(`${where}: variables [${rn}] vs [${pn}]`);
    rf.vars.forEach((rv, j) => {
      const pv = pf.vars[j], w = `${rf.func}: ${rv.name}`, mask = meta[i][j];
      for (const key of ["type", "size", "kind", "arg", "decl", "struct", "target"])
        if (rv[key] !== pv[key]) err(`${w}: ${key} is ${JSON.stringify(rv[key])} for real, ${JSON.stringify(pv[key])} in the preview`);
      if ("rbp" in rf && rv.addr - rf.rbp !== pv.addr - pf.rbp) err(`${w}: at rbp${rv.addr - rf.rbp} for real, rbp${pv.addr - pf.rbp} in the preview`);
      if (!mask.includes("1")) return;                                    /* not set yet: leftover bytes differ */
      const full = !mask.includes("0");
      if (rv.kind === "int" && full && rv.value !== pv.value) err(`${w}: real ${rv.value}, preview ${pv.value}`);
      else if (rv.kind === "ptr" && full) err(samePtr(R, Pv, rv.value, pv.value, pairs, w));
      else if (rv.kind === "other" && /^(int|char) \[/.test(rv.type)) {
        for (let b = 0; b < mask.length; b++) if (mask[b] === "1" && rv.bytes.slice(2 * b, 2 * b + 2) !== pv.bytes.slice(2 * b, 2 * b + 2)) { err(`${w}: byte ${b} differs (${rv.bytes} vs ${pv.bytes})`); break; }
      }
      else if (rv.kind === "other" && rv.type.startsWith("struct ")) err(pairs.add(rv.addr, pv.addr, w));   /* compared as a block */
    });
  });
  if (!!R.ret !== !!Pv.ret) err(`return value: real ${JSON.stringify(R.ret)}, preview ${JSON.stringify(Pv.ret)}`);
  else if (R.ret) {
    if (R.ret.func !== Pv.ret.func || R.ret.type !== Pv.ret.type) err(`return value: real ${R.ret.func} ${R.ret.type}, preview ${Pv.ret.func} ${Pv.ret.type}`);
    else if (/\*$/.test(R.ret.type)) err(samePtr(R, Pv, R.ret.value, Pv.ret.value, pairs, `${R.ret.func}() returned`));
    else if (R.ret.value !== Pv.ret.value) err(`${R.ret.func}() returned ${R.ret.value}, preview says ${Pv.ret.value}`);
  }
  if (R.out !== Pv.out) err(`output: real ${JSON.stringify(R.out)}, preview ${JSON.stringify(Pv.out)}`);
  /* the heap: every block reachable from what's set, field by field */
  const rH = new Map(R.heap.map(n => [n.addr, n])), pH = new Map(Pv.heap.map(n => [n.addr, n]));
  while (pairs.queue.length) {
    const [ra, pa, where] = pairs.queue.shift(), rb = rH.get(ra), pb = pH.get(pa);
    if (!rb && !pb) continue;
    if (!rb || !pb) { err(`${where}: points to a block only the ${rb ? "real trace" : "preview"} knows`); continue; }
    if (rb.type !== pb.type || rb.size !== pb.size) { err(`${where}: block ${rb.type}/${rb.size} vs ${pb.type}/${pb.size}`); continue; }
    if (rb.freed !== pb.freed) { err(`${where}: the block is ${rb.freed ? "freed" : "in use"} for real, ${pb.freed ? "freed" : "in use"} in the preview`); continue; }
    if (rb.freed) continue;
    rb.fields.forEach((rf, i) => {
      const pf = pb.fields[i], w = `${where} -> ${rf.name}`;
      if (rf.kind === "int" && rf.value !== pf.value) err(`${w}: real ${rf.value}, preview ${pf.value}`);
      if (rf.kind === "ptr") err(samePtr(R, Pv, rf.value, pf.value, pairs, w));
    });
  }
  /* malloc's chunks, in address order: same sizes, same states */
  const ch = s => (s.chunks || []).filter(c => c.state !== "top" && c.what !== "tcache").map(c => `${c.state}:${c.size}`).join(" ");
  if (ch(R) !== ch(Pv)) err(`chunks: real [${ch(R)}], preview [${ch(Pv)}]`);
  const lib = s => (s.lib || []).map(c => c.func + ":" + c.writes.length).join(" ");
  if (lib(R) !== lib(Pv)) err(`library calls caught: real [${lib(R)}], preview [${lib(Pv)}]`);
  return errs;
}

function compare(real, pv) {
  const rs = real.steps, ps = pv.trace ? pv.trace.steps : [], meta = pv.meta || [];
  const key = s => `${s.func}:${s.line}:${s.frames.length}`;
  let i = 0, j = 0, skipped = 0;
  while (i < rs.length && j < ps.length) {
    if (key(rs[i]) !== key(ps[j])) {
      if (i > 0 && key(rs[i]) === key(rs[i - 1])) { i++; skipped++; continue; }   /* gdb's extra stop, see the top */
      return { ok: false, msg: `step ${i + 1}: real is at ${key(rs[i])}, preview at ${key(ps[j])} (preview step ${j + 1})` };
    }
    const errs = compareStep(rs[i], ps[j], meta[j], i);
    if (errs.length) return { ok: false, msg: `step ${i + 1} (line ${rs[i].line}, ${rs[i].func}):\n      ` + errs.slice(0, 6).join("\n      ") };
    i++; j++;
  }
  while (i < rs.length && i > 0 && key(rs[i]) === key(rs[i - 1])) { i++; skipped++; }
  if (i < rs.length) return { ok: false, msg: `the real trace has ${rs.length - i} more steps, from line ${rs[i].line}${pv.error ? ` (preview: line ${pv.error.line}: ${pv.error.msg})` : ""}` };
  const extra = ps.slice(j);
  if (extra.some(s => !s.events)) return { ok: false, msg: `the preview has ${extra.length} more steps, from line ${extra[0].line}` };
  return { ok: true, msg: `${rs.length} steps agree` + (skipped ? ` (${skipped} repeated gdb stop${skipped === 1 ? "" : "s"} skipped)` : "") + (extra.length ? `, plus the preview's bug step` : "") };
}

/* ---------- 1. every example: preview vs gcc + gdb ---------- */
let bad = 0;
console.log("Preview vs gcc + gdb");
for (const f of files) {
  const code = fs.readFileSync(f, "utf8"), name = path.relative(DIR, f);
  const pv = P.run(code, { meta: true });
  const real = realTrace(code);
  let ok, msg;
  if (real.gccError) {
    ok = !pv.trace;
    msg = ok ? `gcc rejects it, and so does the preview (${pv.error ? `line ${pv.error.line}: ${pv.error.msg}` : pv.note})` : `gcc rejects it (${real.gccError}), but the preview ran it`;
  } else if (real.gdbError) { ok = false; msg = real.gdbError; }
  else if (!pv.trace) { ok = false; msg = `the preview didn't run it: ${pv.error ? `line ${pv.error.line}: ${pv.error.msg}` : pv.note}`; }
  else ({ ok, msg } = compare(real.trace, pv));
  if (!ok) bad++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}: ${msg}${ok && pv.bug ? `\n       preview found: ${pv.bug}` : ""}`);
}

/* ---------- 2. typing a line, one piece at a time ---------- */
console.log("\nTyping one line");
const HEAD = `#include <stdlib.h>

struct ListNode {
  int val;
  struct ListNode *next;
};

int main() {
  `;
const lastStep = r => r.trace && r.trace.steps[r.trace.steps.length - 1];
const aVar = s => s && s.frames[0].vars.find(v => v.name === "a");
const used = s => s ? s.chunks.filter(c => c.state === "used" && c.what !== "tcache") : [];
const stages = [
  ["struct ListNode", r => r.highlight === "struct ListNode" && !aVar(lastStep(r)), "its blueprint card lights up"],
  ["struct ListNode *a", r => { const v = aVar(lastStep(r)); return v && v.size === 8 && v.type === "struct ListNode *" && !v.arg && lastStep(r).steps !== 0; }, "a stack box a, 8 bytes, not set"],
  ["struct ListNode *a = malloc(", r => { const s = lastStep(r); return used(s).length === 1 && used(s)[0].size === 16 && !s.heap.length; }, "an empty heap block"],
  ["struct ListNode *a = malloc(sizeof(struct ListNode)", r => { const s = lastStep(r); return used(s).length === 1 && used(s)[0].size - 16 === 16 && !s.heap.length; }, "the block is 16 bytes"],
  ["struct ListNode *a = malloc(sizeof(struct ListNode));", r => { const s = lastStep(r), v = aVar(s); return v && s.heap.length === 1 && v.value === s.heap[0].addr && s.heap[0].size === 16; }, "a points to the block (the arrow)"],
];
for (const [typed, check, what] of stages) {
  const code = HEAD + typed, r = P.run(code, { caret: code.length });
  const ok = !r.error && r.trace && r.trace.steps.every(s => s.preview === true) && check(r);
  if (!ok) bad++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${JSON.stringify(typed)}: ${what}${ok ? "" : `  (got: ${r.error ? r.error.msg : JSON.stringify({ highlight: r.highlight, chunks: used(lastStep(r)), heap: lastStep(r) && lastStep(r).heap.length })})`}`);
}
/* uninitialized: markInit in the viewer calls a local "not set" when it shows up with leftover bytes and arg false */
{
  const r = P.run(HEAD + "struct ListNode *a;\n  int n;\n  return 0;\n}\n");
  const s = r.trace && r.trace.steps[0], ok = !!s && s.frames[0].vars.every(v => v.arg === false && typeof v.bytes === "string");
  if (!ok) bad++;
  console.log(`  ${ok ? "ok  " : "FAIL"} locals start as leftover bytes (the viewer shows them as not set)`);
}

/* ---------- 3. things the preview doesn't do: a clear message naming the line ---------- */
console.log("\nOutside the subset");
for (const [code, line, word] of [
  ["int main() {\n  int x = 1;\n  switch (x) {\n  }\n  return 0;\n}\n", 3, "switch"],
  ["int main() {\n  double d = 1;\n  return 0;\n}\n", 2, "double"],
  ["#include <string.h>\nint main() {\n  char s[4] = \"hi\";\n  int n = strlen(s);\n  return n;\n}\n", 4, "strlen"],
  ["#include <stdio.h>\nint main() {\n  printf(\"%f\\n\", 1);\n  return 0;\n}\n", 3, "%f"],
]) {
  const r = P.run(code), ok = !!r.error && r.error.line === line && r.error.msg.includes(word);
  if (!ok) bad++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${word}: ${r.error ? `line ${r.error.line}: ${r.error.msg}` : "no error"}`);
}

console.log(bad ? `\n${bad} failed` : "\nall passed");
process.exit(bad ? 1 : 0);
