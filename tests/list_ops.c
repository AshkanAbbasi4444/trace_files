#include <stdio.h>
#include <stdlib.h>

struct ListNode {
  int val;
  struct ListNode *next;
};

void push_front(struct ListNode **head, int val) {
  struct ListNode *node = malloc(sizeof(struct ListNode));
  node->val = val;
  node->next = *head;
  *head = node;
}

struct ListNode *reverse(struct ListNode *head) {
  struct ListNode *prev = NULL;
  struct ListNode *next;

  while (head != NULL) {
    next = head->next;
    head->next = prev;
    prev = head;
    head = next;
  }
  return prev;
}

int length(struct ListNode *head) {
  if (head == NULL) {
    return 0;
  }
  return 1 + length(head->next);
}

int main() {
  struct ListNode *head = NULL;
  struct ListNode local;
  struct ListNode *extra = calloc(1, sizeof(struct ListNode));
  int i;

  for (i = 1; i <= 3; i++) {
    push_front(&head, i * 10);
  }
  local.val = 99;
  local.next = head;
  extra->val = length(&local);
  head = reverse(head);
  printf("len=%d first=%d\n", extra->val, head->val);
  free(extra);
  while (head != NULL) {
    struct ListNode *doomed = head;
    head = head->next;
    free(doomed);
  }
  extra = malloc(sizeof(struct ListNode));
  extra->next = NULL;
  free(extra);
  return 0;
}
