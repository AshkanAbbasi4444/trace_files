#include <stdio.h>
#include <stdlib.h>

struct Pair {
  char tag;
  int count;
  struct Pair *next;
};

int count_char(char *s, char c) {
  int n = 0;
  while (*s != '\0') {
    if (*s == c) {
      n += 1;
    }
    s++;
  }
  return n;
}

struct Pair *make(char tag, int count) {
  struct Pair *p = (struct Pair *)malloc(sizeof *p);
  p->tag = tag;
  p->count = count;
  p->next = NULL;
  return p;
}

int main() {
  char text[12] = "banana band";
  struct Pair *list = NULL;
  struct Pair *nodes[9];
  int total = 0;

  for (int i = 0; i < 9; i++) {
    nodes[i] = make('a' + i, i * i);
  }
  for (int i = 0; i < 9; i++) {
    if (i % 2 == 0) {
      continue;
    }
    nodes[i]->next = list;
    list = nodes[i];
  }
  while (1) {
    if (list == NULL) {
      break;
    }
    total += list->count > 10 ? list->count : -1;
    list = list->next;
  }
  printf("%s has %d a's, total %d\n", text, count_char(text, 'a'), total);
  for (int i = 8; i >= 0; i--) {
    free(nodes[i]);
  }
  nodes[0] = make('z', 1);
  nodes[1] = make('y', 2);
  printf("%c%c\n", nodes[0]->tag, nodes[1]->tag);
  free(nodes[1]);
  free(nodes[0]);
  return 0;
}
