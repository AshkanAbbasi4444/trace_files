#include <stdlib.h>

struct ListNode {
  int val;
  struct ListNode *next;
};

int main() {
  struct ListNode *a = malloc(sizeof(struct ListNode));
  a->val = 5;
  free(a);
  free(a);
  return 0;
}
