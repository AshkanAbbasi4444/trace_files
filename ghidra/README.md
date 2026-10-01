# StackFrameDraw — stack frames as an HTML page

A Ghidra script that draws every function's stack frame as a column of boxes,
so you can see buffers, the saved frame pointer and the return address at a
glance — and how many bytes separate a buffer from the return address. It also
puts a red badge on any function that calls a dangerous libc routine
(`gets`, `scanf`, `strcpy`, `strcat`, `sprintf`, `memcpy`).

Files:

- `StackFrameDraw.py` — the script.
- `vuln.c` — a tiny overflow target to try it on.

## What it draws

One card per function (external and PLT/thunk stubs are skipped). Inside a card,
boxes are stacked with the **highest address on top**, so you read down the
stack the way it grows:

```
  return address     <- top of the frame
  saved rbp
  stack canary       (if the binary has a stack protector)
  ... locals ...
  char buf[64]       <- a buffer, with "N bytes to return address"
```

Each box shows the name, the offset relative to the frame pointer (hex, like
`rbp-0x40`), the size in bytes, and the type. Box height is proportional to the
size. Colours:

| colour | meaning |
|--------|---------|
| yellow | buffer (array type) |
| purple | stack canary |
| blue   | saved rbp |
| red    | return address |
| grey   | ordinary local variable |

For every buffer the box is annotated with the distance from the **start of the
buffer** to the return address — the number of bytes an overflow must cover to
reach it (buffer size + anything between it and the return address, e.g. the
canary and the saved rbp).

The output is a single self-contained HTML file (no external CSS/JS/fonts,
light mode only), so you can open it straight in a browser or hand it to someone.

## Python runtime (Jython vs PyGhidra)

The script is written to run under **both** Ghidra Python runtimes:

- **Older Ghidra** ships Jython (Python 2.7).
- **Newer Ghidra** supports PyGhidra (CPython 3) — enable it in the installer or
  with `support/pyghidra` / the *PyGhidra* option in the Script Manager.

To stay compatible with both it uses no f-strings, no type hints, only `%`
formatting, and guards its imports. You do not need to pick a runtime; whichever
your Ghidra uses, the script works. There is nothing to configure.

## Run it from the GUI

1. Open the binary in the CodeBrowser and let auto-analysis finish.
2. **Window ▸ Script Manager**, then add this `ghidra/` folder to the script
   directories (the *Manage Script Directories* / "bundles" button at the top)
   if it is not already listed.
3. Find **StackFrameDraw.py** (category *Analysis.StackFrame*) and run it.
4. It asks where to save the HTML; pick a path. If you cancel, it writes next to
   the binary as `<program-name>_stackframes.html`.

## Run it headless

In headless mode there is no dialog, so the script skips the prompt and writes
`<program-name>_stackframes.html` next to the imported binary.

```sh
# from the Ghidra install dir; adjust paths as needed
./support/analyzeHeadless /tmp proj \
  -import ./vuln \
  -scriptPath "$(pwd)/ghidra" \
  -postScript StackFrameDraw.py \
  -deleteProject
```

`-scriptPath` must point at the folder containing `StackFrameDraw.py` (this
`ghidra/` folder). `-deleteProject` throws the temporary project away after the
run. Watch the console for the line:

```
StackFrameDraw: wrote /path/to/vuln_stackframes.html (N functions, M flagged)
```

## Try it on vuln.c

```sh
gcc -O0 vuln.c -o vuln          # no -g, like a stripped-of-symbols RE binary
```

Then import `./vuln` and run the script (GUI or headless). In `main` you should
see a 64-byte buffer (Ghidra will auto-name it, e.g. `local_58`, since there is
no debug info) and its distance to the return address. If your toolchain enabled
the stack protector (`-fstack-protector-strong` is the default on most modern
distros), a **stack canary** box appears between the buffer and the saved rbp;
`main` is badged because it calls `scanf`.

## Notes and limitations

- **Offsets** are relative to the frame pointer. Ghidra models the return
  address at `getReturnAddressOffset()` (0 on x86); the saved frame pointer sits
  one pointer-width below it, locals below that. The `rbp-0x..` labels are
  derived from that model.
- **Saved rbp** is synthesized for x86/x86-64 only. On other architectures the
  saved frame pointer / return address live in registers or at
  architecture-specific slots, so only the return address row (from
  `getReturnAddressOffset()`) and the recovered variables are drawn.
- **The canary** is shown when Ghidra recovered a variable in its slot, or
  inferred (marked *canary (inferred)*) when the function calls
  `__stack_chk_fail` but Ghidra named no variable there. Without the stack
  protector there is no canary and none is drawn.
- **What you see depends on Ghidra's analysis.** Better analysis (more complete
  decompilation, applied data types) yields better-named and better-typed boxes.
  Without debug info, names are auto-generated and a buffer may appear as
  `undefined1[64]` rather than `char[64]`; it is still detected as a buffer.
- **Dangerous-call detection** follows thunks/PLT and matches fortified and
  versioned variants (`__isoc99_scanf`, `__strcpy_chk`, `memcpy@GLIBC...`).
