#include <stdio.h>
#include <stdlib.h>

struct ListNode {
  int val;
  struct ListNode *next;
};

int main() {
  struct ListNode *head = malloc(sizeof(struct ListNode));
  head->val = 1;
  head->next = NULL;
  printf("%d\n", head->next->val);
  free(head);
  return 0;
}
