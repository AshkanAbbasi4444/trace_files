/* vuln.c - a classic stack buffer overflow target for StackFrameDraw.py.
   scanf("%s", buf) writes an unbounded string into a 64-byte buffer, so a
   long line runs off the end of buf, past the saved rbp, into the return
   address. Compile WITHOUT -g, the way a real RE binary comes:

     gcc -O0 vuln.c -o vuln

   Then import ./vuln into Ghidra and run StackFrameDraw.py (see README.md).
   main should show a 64-byte buffer and the byte distance from it to the
   return address (a stack canary may sit in between). */
#include <stdio.h>

int main(void) {
  char buf[64];

  scanf("%s", buf);
  printf("you said: %s\n", buf);
  return 0;
}
