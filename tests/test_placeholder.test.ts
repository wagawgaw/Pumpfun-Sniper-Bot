import assert from "node:assert";
import { computeEventFingerprint } from "../dexter_phase2";

void (async function testFingerprint() {
  const fp = computeEventFingerprint({
    source: "t",
    signature: "s",
    log_index: 0,
    event_type: "swaps",
    mint_id: "m",
    payload: { a: 1 },
  });
  assert.strictEqual(typeof fp, "string");
  assert.strictEqual(fp.length, 64);
})();
