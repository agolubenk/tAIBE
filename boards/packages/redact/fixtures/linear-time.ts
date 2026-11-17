// TB-205, TB-209: a time check that holds on a slow or busy CI runner. The
// work runs at n and at n / SCALE, back to back, so both runs see the same
// runner: linear work grows SCALE times, quadratic work SCALE² times. An
// absolute limit in milliseconds failed on the shared runner, which was 10 to
// 17 times slower than a Mac (redact 256 000 characters: 6 ms on a Mac, up to
// 330 ms on the runner; restore 7000 blocks: 65 ms and up to 1112 ms), on
// PRs that did not change the code it timed.
export const SCALE = 4;
// Between the linear SCALE and the quadratic SCALE².
export const MAX_GROWTH = 10;
const ROUNDS = 3;
// A run shorter than the timer can tell apart counts as this long.
const MIN_MS = 0.05;

function timed(run: () => unknown): number {
  const started = performance.now();
  run();
  return Math.max(performance.now() - started, MIN_MS);
}

// How many times the work grows from n / SCALE to n. Each size counts its
// fastest run: a pause of the runner only makes a run slower, so the check
// takes up to ROUNDS rounds before it reports a growth. The inputs are built
// before the clock starts, and the first run, with cold code, is not counted.
export function growth<T>(
  make: (n: number) => T,
  work: (input: T) => unknown,
  n: number,
): number {
  const small = make(Math.floor(n / SCALE));
  const large = make(n);
  work(small);
  let fastSmall = Number.POSITIVE_INFINITY;
  let fastLarge = Number.POSITIVE_INFINITY;
  for (let round = 0; round < ROUNDS; round += 1) {
    fastSmall = Math.min(
      fastSmall,
      timed(() => work(small)),
    );
    fastLarge = Math.min(
      fastLarge,
      timed(() => work(large)),
    );
    if (fastLarge / fastSmall < MAX_GROWTH) break;
  }
  return fastLarge / fastSmall;
}
