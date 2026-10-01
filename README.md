# C memory viewer

See what a C program does to memory, one line at a time: stack frames, heap blocks, pointers, and bugs such as leaks and use-after-free.

- `trace.py` is a gdb script. It steps through a compiled program and writes `prog.json`.
- `node_cards_viewer.html` draws a trace as node cards or as a byte-by-byte memory layout.
- `server.py` serves the viewer on http://localhost:8000. Its **Write code** box compiles and traces what you type.
- `preview.js` draws a preview while you type, before gcc and gdb have finished (see below).
- `cases.py` runs your list functions on edge cases for the **Test cases** panel (see below).

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

## Edge-case tester

Click **Test cases** (next to **Write code**) to run one of your list functions on the cases that usually break them. The panel lists every function in the Write code box that takes a `struct ListNode *` (or `struct ListNode **`), plus maybe some ints. If the function takes ints, like `remove_elements(struct ListNode *head, int val)`, you type their values once for all cases.

- **Cases.** These are built in: `[]`, `[1]`, `[1,1,1]`, `[1,2,3]`, `[1,1,2]`, `[1,2,2]`, `[2,1,1,2]`, `[6,11,11]`, and a 20-node list. You can add your own, like `3, 3, 1`. Any case can have an expected result, like `1, 2` (or `[]` for an empty list). Your cases, expected results and int values are remembered.
- **How a case runs.** `POST /cases` (in `cases.py`) adds a test `main` after your code. Your own `main` is renamed to `user_main` with `#define main user_main`, the same as `-Dmain=user_main`. The test `main` builds the list from the case, calls your function, prints the list it left, and frees whatever is still in that list. So any leak it reports is one your function caused. Each case is compiled with `gcc -g -fsanitize=address` and gets 2 seconds.
- **What you see.** Each case gets ✓ or ✗, the list before and after (and the return value, if it returns an int), and the reason in plain words:
  - a NULL dereference, use-after-free, double free or crash, with the line
  - a leak: how many bytes, and which line allocated them
  - an endless loop (still running after 2 seconds)
  - a result list that loops back on itself
  - a wrong result, when you gave an expected list
- **Stepping through a case.** Click a case. The same test program, without `-fsanitize`, goes through the normal `/run` pipeline (gcc + gdb `trace.py`) and opens in the viewer, at the start of your function. Your code in the Write code box isn't changed. The tester's `main` appears below your code, and your lines keep their numbers.

`python3 test_cases.py` checks that the tester names each kind of bug correctly.

### Checking the preview against gcc + gdb

```
node test_preview.js            # every .c file here and in tests/
node test_preview.js tests/list_ops.c
```

For each file, the test runs the real pipeline (`gcc -g -O0`, then `gdb -q -nx -batch -x trace.py ./prog`) and the interpreter, then compares every step. It checks the line, the function, the frames, each variable that has been set (with its offset from rbp), return values, output, and heap links: which block points to which. Addresses may differ, so pointers are compared by what they point to. It also checks the half-typed-line stages above, and that unsupported C gets a message naming the line.

Two differences are allowed:
- gdb sometimes stops twice on the same line when a watchpoint in `trace.py` interrupts a step inside `printf`. This depends on leftover register values, so the test skips a real step that repeats the one before it.
- After a double free, the real program aborts, while the preview adds a bug step.
