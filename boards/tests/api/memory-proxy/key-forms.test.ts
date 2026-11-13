import {
  MAX_MEMORY_KEYS,
  memoryKeyForm,
} from "../../../packages/claude-mem-reader/src/memory-keys";
import { describe, expect, it } from "vite-plus/test";
import { memoryLookupQuery } from "../../../apps/api/src/forest/routes/memory-schema";
import { keyForm, MAX_KEYS } from "../../../deploy/vps/mac/card-memory-db.mjs";

// TB-113: one key form lives in three places — the package (cards ask with
// it), the API query (`ticketKey`, `queueItemId`) and the proxy on the Mac,
// which cannot import the package. A drift answers a card as if it had no
// memory, so the three are compared on the same keys.

const PROJECT_KEYS = [
  "",
  "Q",
  "TB",
  "T1",
  "1T",
  "tb",
  "Tb",
  "ABCDEFGHIJ",
  "ABCDEFGHIJK",
  "HR-OPS",
  "TÉ",
  "T_B",
];
const NUMBERS = ["", "0", "1", "01", "123456", "1234567", "1a", "-1"];

function boundaryKeys() {
  const keys = PROJECT_KEYS.flatMap((project) =>
    NUMBERS.map((number) => `${project}-${number}`),
  );
  const id = "a1b2c3d4e5f6g7h8i9j0k1l2";
  keys.push(id, id.slice(1), `${id}x`, id.toUpperCase(), `${id.slice(1)}-`);
  keys.push(
    "d-tb113-mem-1311",
    "ab",
    "a-b",
    "a--b",
    "a-b-",
    "-a-b",
    "A-b",
    "a-b-c-d-e-f-g-h",
    "a-b-c-d-e-f-g-h-i",
    `a-${"b".repeat(62)}`,
    `a-${"b".repeat(61)}`,
    " TB-1",
    "TB-1 ",
    "TB 1",
    "TB-1\n",
  );
  return keys;
}

// A fixed seed: the same strings on every run, so a failure repeats.
function fuzzKeys(count: number) {
  const alphabet = "ATZaz09-_ ";
  let seed = 0x1b113;
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  };
  return Array.from({ length: count }, () => {
    const length = 1 + (next() % 14);
    let key = "";
    for (let i = 0; i < length; i++) key += alphabet[next() % alphabet.length];
    return key;
  });
}

const KEYS = [...boundaryKeys(), ...fuzzKeys(2000)];

describe("memory key forms stay equal", () => {
  it("covers every form and a refusal", () => {
    const forms = new Set(KEYS.map((key) => memoryKeyForm(key)));
    expect(forms).toEqual(new Set(["id", "key", "queue", null]));
  });

  it("gives the proxy on the Mac the same form as the package", () => {
    const drift = KEYS.filter((key) => keyForm(key) !== memoryKeyForm(key));
    expect(drift).toEqual([]);
    expect(MAX_KEYS).toBe(MAX_MEMORY_KEYS);
  });

  it("accepts a ticketKey exactly when the package reads it as a card key", () => {
    const drift = KEYS.filter((key) => {
      const accepted = memoryLookupQuery.safeParse({ ticketKey: key }).success;
      return accepted !== (memoryKeyForm(key.trim().toUpperCase()) === "key");
    });
    expect(drift).toEqual([]);
  });

  it("accepts a queueItemId exactly when the package reads it as a queue id", () => {
    const drift = KEYS.filter((key) => {
      const accepted = memoryLookupQuery.safeParse({
        queueItemId: key,
      }).success;
      return accepted !== (memoryKeyForm(key) === "queue");
    });
    expect(drift).toEqual([]);
  });
});
