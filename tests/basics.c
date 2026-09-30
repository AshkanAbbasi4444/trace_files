#include <stdio.h>

int fact(int n) {
  if (n <= 1) {
    return 1;
  }
  return n * fact(n - 1);
}

void swap(int *a, int *b) {
  int t = *a;
  *a = *b;
  *b = t;
}

int sum(int *xs, int n) {
  int total = 0;
  int i;
  for (i = 0; i < n; i++) {
    total += xs[i];
  }
  return total;
}

int main() {
  int x = 3;
  int y = 7;
  char c = 'A';
  char word[6] = "hello";
  int nums[4] = {5, 10, 15, 20};
  int *p = &nums[1];

  swap(&x, &y);
  printf("x=%d y=%d\n", x, y);
  if (x > y) {
    printf("%c wins\n", c);
  } else if (x == y) {
    printf("tie\n");
  } else {
    printf("%s\n", word);
  }
  *p = *p + 1;
  p++;
  while (x > 0) {
    x = x - 3;
  }
  printf("sum=%d fact=%d\n", sum(nums, 4), fact(4));
  word[0] = c + 1;
  printf("%s %c %d\n", word, word[1], p - nums);
  return 0;
}
