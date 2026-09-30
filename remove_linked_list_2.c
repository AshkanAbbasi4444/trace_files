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
 
void remove_elements_ref(struct ListNode **head, int val) {
  struct ListNode *current;
 
  while (*head != NULL && (*head)->val == val) {
    *head = (*head)->next;
  }
 
  current = *head;
  while (current != NULL && current->next != NULL) {
    if (current->next->val == val) {
      current->next = current->next->next;
    } else {
      current = current->next;
    }
  }
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
  int vals[] = {6, 1, 6, 6, 6, 666};
  struct ListNode *head = build(vals, 6);
 
  print_list(head);
  head = remove_elements(head, 6);
  print_list(head);
  free_list(head);
 
  head = build(vals, 6);
 
  print_list(head);
  remove_elements_ref(&head, 6);
  print_list(head);
  free_list(head);
 
  return 0;
}
