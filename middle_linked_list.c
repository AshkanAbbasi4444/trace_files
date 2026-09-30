#include <stdio.h>
#include <stdlib.h>

struct ListNode {
  int val;
  struct ListNode *next;
};

struct ListNode *build(int vals[], int n) {
  struct ListNode *head = NULL;
  struct ListNode *tail;
  int i;

  for (i = 0; i < n; i++) {
    struct ListNode *node = malloc(sizeof(struct ListNode));
    node->val = vals[i];
    node->next = NULL;

    if (head == NULL) {
      head = node;
    } else {
      tail->next = node;
    }
    tail = node;
  }

  return head;
}

void print_list(struct ListNode *head) {
  while (head != NULL) {
    printf("%d -> ", head->val);
    head = head->next;
  }
  printf("NULL\n");
}

struct ListNode *middle_node(struct ListNode *head) {
  struct ListNode *list1 = head;
  struct ListNode *list2 = head;

  while (list2->next != NULL && list2->next->next != NULL) {
    list2 = list2->next->next;
    list1 = list1->next;
  }
  return list1;
}

struct ListNode *remove_elements(struct ListNode *head, int val) {
  struct ListNode *current;

  while (head != NULL && head->val == val) {
    head = head->next;
  }

  current = head;
  while (current != NULL && current->next != NULL) {
    if (current->next->val == val) {
      current->next = current->next->next;
    } else {
      current = current->next;
    }
  }

  return head;
}

void free_list(struct ListNode *head) {
  struct ListNode *doomed;

  while (head != NULL) {
    doomed = head;
    head = head->next;
    free(doomed);
  }
}

int main(void) {
  int vals[] = {1, 6, 7, 19, 11, 11, 19, 7, 6, 1};
  struct ListNode *head = build(vals, 10);
  struct ListNode *mid = middle_node(head);
  struct ListNode *second = mid->next;
  mid->next = NULL;

  print_list(head);
  print_list(second);
  print_list(mid);
  free_list(head);

  return 0;
}
