#include <stdio.h>
#include <stdlib.h>

struct ListNode {
  int val;
  struct ListNode *next;
};

int main() {
  struct ListNode *a = malloc(sizeof(struct ListNode));
  struct ListNode *b = malloc(sizeof(struct ListNode));
  a->val = 1;
  a->next = b;
  b->val = 2;
  b->next = NULL;
  free(b);
  printf("%d\n", a->next->val);
  a = NULL;
  return 0;
}
