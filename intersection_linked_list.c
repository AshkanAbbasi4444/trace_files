struct ListNode *getIntersectionNode(struct ListNode *headA,
                                     struct ListNode *headB) {
  currentB = headB while (headA != NULL) {
    while (currentB != NULL) {
      if (headA == currentB) {
        return headA;
      } else {
        currentB = currentB->next;
      }
      headA = headA->next;
    }
    currentB = headB;
  }
  return NULL;
}
