# C memory viewer

See what a C program does to memory, one line at a time: stack frames, heap blocks, pointers, and bugs such as leaks and use-after-free.

- `trace.py` is a gdb script. It steps through a compiled program and writes `prog.json`.
- `node_cards_viewer.html` draws a trace as node cards or as a byte-by-byte memory layout.
- `server.py` serves the viewer on http://localhost:8000. Its **Write code** box compiles and traces what you type.
- `preview.js` draws a preview while you type, before gcc and gdb have finished (see below).

```
python3 server.py
```

Then open http://localhost:8000/node_cards_viewer.html and click **✎ Write code**.

## How the preview works

`preview.js` is a small C interpreter that runs in the page. Each time you type, it runs your code up to the cursor and writes steps in the same JSON shape as `trace.py`. The viewer draws them with its usual code, and a **preview** badge appears next to the step counter. When your code compiles, the real gcc + gdb trace replaces the preview.

- **Half-typed code.** Everything up to the last `;`, `{` or `}` runs. Blocks you haven't closed yet are closed for you, and functions after the cursor, such as `main`, are kept. The line you're typing is previewed but not run. For example, while you type `struct ListNode *a = malloc(sizeof(struct ListNode));`:
  - `struct ListNode` highlights its blueprint card.
  - `*a` adds `a` to the stack: 8 bytes, not set.
  - `= malloc(` shows an empty heap block.
  - `sizeof(struct ListNode)` makes the block 16 bytes.
  - `;` runs the line, so the arrow goes from `a` to the block.
- **Memory like x86-64 gcc -O0.** `int` is 4 bytes, pointers 8, and structs get gcc's padding (`struct ListNode` is `val` 4 + padding 4 + `next` 8 = 16). Stack frames use gcc's layout: locals are sorted by size, there is a canary when the function has an array, and parameters are copied in below the locals. The heap copies glibc's malloc: chunk headers, a tcache of 7 blocks per size, and the words `free()` overwrites.
- **Steps like gdb.** A step stops before each line runs, and a loop condition is a step each time it is checked. A line that calls `malloc` stops twice, like the real trace. Uninitialized locals start with whatever bytes were left on the stack, so they show as not set.
- **Bugs.** Freed blocks stay in the trace, so the viewer marks use-after-free the same way it does for real traces. A NULL dereference, a double free, or a bad free ends the preview with a bug step. The leak report appears when the program reaches the end.
- **Supported C.** `int`, `char`, int and char arrays, structs, pointers (including `**`), `malloc`/`calloc`/`free`, `-> . * &`, `if`/`else`, `while`, `for`, `break`/`continue`, functions with parameters and return values (including recursion), `printf` with `%d %s %c`, and `NULL`. For anything else, the preview stops and names the line, for example: `preview stops at line 3: switch isn't supported in the preview: use if / else if`.

Example:

```c
#include <stdio.h>
#include <stdlib.h>

struct ListNode {
  int val;
  struct ListNode *next;
};

int main() {
  struct ListNode *a = malloc(sizeof(struct ListNode));
  a->val = 7;
  a->next = NULL;
  printf("%d\n", a->val);
  free(a);
  return 0;
}
```

### Checking the preview against gcc + gdb

```
node test_preview.js            # every .c file here and in tests/
node test_preview.js tests/list_ops.c
```

For each file, the test runs the real pipeline (`gcc -g -O0`, then `gdb -q -nx -batch -x trace.py ./prog`) and the interpreter, then compares every step. It checks the line, the function, the frames, each variable that has been set (with its offset from rbp), return values, output, and heap links: which block points to which. Addresses may differ, so pointers are compared by what they point to. It also checks the half-typed-line stages above, and that unsupported C gets a message naming the line.

Two differences are allowed:
- gdb sometimes stops twice on the same line when a watchpoint in `trace.py` interrupts a step inside `printf`. This depends on leftover register values, so the test skips a real step that repeats the one before it.
- After a double free, the real program aborts, while the preview adds a bug step.
