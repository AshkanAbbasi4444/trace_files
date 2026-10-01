"""python3 test_cases.py: does the edge-case tester (cases.py) give each bug the right name?
It runs list functions with known bugs through the same code POST /cases uses (gcc -fsanitize=address)."""
import json, sys
import cases

CODE = r"""#include <stdio.h>
#include <stdlib.h>

struct ListNode {
  int val;
  struct ListNode *next;
};

struct ListNode *remove_duplicates(struct ListNode *head) {
  struct ListNode *cur = head;

  while (cur != NULL && cur->next != NULL) {
    if (cur->val == cur->next->val) {
      struct ListNode *dup = cur->next;
      cur->next = dup->next;
      free(dup);
    } else {
      cur = cur->next;
    }
  }
  return head;
}

struct ListNode *dedupe_leaky(struct ListNode *head) {
  struct ListNode *cur = head;

  while (cur->next != NULL) {
    if (cur->val == cur->next->val) {
      cur->next = cur->next->next;
    } else {
      cur = cur->next;
    }
  }
  return head;
}

struct ListNode *dedupe_uaf(struct ListNode *head) {
  struct ListNode *cur = head;

  while (cur != NULL && cur->next != NULL) {
    if (cur->val == cur->next->val) {
      free(cur->next);
      cur->next = cur->next->next;
    } else {
      cur = cur->next;
    }
  }
  return head;
}

struct ListNode *dedupe_loop(struct ListNode *head) {
  struct ListNode *cur = head;

  while (cur != NULL && cur->next != NULL) {
    if (cur->val == cur->next->val) {
      cur->next = cur->next->next;
    }
  }
  return head;
}

void free_twice(struct ListNode **head) {
  if (*head != NULL) {
    free(*head);
    free(*head);
    *head = NULL;
  }
}

struct ListNode *drop_first(struct ListNode *head) {
  free(head);
  return head;
}

struct ListNode *make_cycle(struct ListNode *head) {
  struct ListNode *last = head;

  while (last != NULL && last->next != NULL) {
    last = last->next;
  }
  if (last != NULL) {
    last->next = head;
  }
  return head;
}

void remove_value(struct ListNode **head, int val) {
  while (*head != NULL) {
    if ((*head)->val == val) {
      struct ListNode *doomed = *head;
      *head = doomed->next;
      free(doomed);
    } else {
      head = &(*head)->next;
    }
  }
}

int main() {
  return 0;
}
"""

# function, extra arguments, list, expected list or None, the reason kinds it must report (in this order)
CHECKS = [
  ("remove_duplicates", {}, [1, 1, 2], [1, 2], []),
  ("remove_duplicates", {}, [], [], []),
  ("remove_duplicates", {}, [1, 2, 2], [1, 2, 2], ["wrong result"]),
  ("dedupe_leaky", {}, [], None, ["NULL dereference"]),
  ("dedupe_leaky", {}, [1, 1, 2], None, ["leak"]),
  ("dedupe_uaf", {}, [6, 11, 11], None, ["use-after-free"]),
  ("dedupe_loop", {}, [1, 2, 3], None, ["endless loop"]),
  ("free_twice", {}, [1, 2], None, ["double free"]),
  ("drop_first", {}, [1, 2], None, ["use-after-free"]),
  ("make_cycle", {}, [1, 2, 3], None, ["cycle"]),
  ("remove_value", {"val": 6}, [6, 1, 6], [1], []),
]

bad = 0
by = {}
for fn, args, vals, expect, kinds in CHECKS:
    by.setdefault((fn, json.dumps(args)), []).append((vals, expect, kinds))
for (fn, args), group in by.items():
    ok, text = cases.handle(json.dumps({"code": CODE, "func": fn, "args": json.loads(args),
                                        "cases": [{"vals": v, "expect": e} for v, e, _ in group]}))
    out = json.loads(text)
    if "error" in out:
        print("FAIL %s: %s" % (fn, out["error"])); bad += 1; continue
    for (vals, expect, kinds), r in zip(group, out["results"]):
        got = [x["kind"] for x in r["reasons"]]
        good = got == kinds and r["pass"] == (not kinds)
        bad += not good
        print("%s %s%s: %s" % ("ok  " if good else "FAIL", fn, vals, "; ".join(x["text"] for x in r["reasons"]) or "passes" if good
                                else "wanted %s, got %s" % (kinds, r["reasons"])))
print("\nall passed" if not bad else "\n%d failed" % bad)
sys.exit(1 if bad else 0)
