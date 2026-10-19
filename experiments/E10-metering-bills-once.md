# E10: a step bills once however many times it runs

**Claim in submission (B Decision 5):** the Invocation record's key is derived from `(org, batch, image, step)`, not from the attempt. The record is written with a conditional put. A retried-but-successful step produces one billable record; duplicate deliveries are no-ops.

**Prediction:** re-invoking `ValidateOutput` by hand with the exact payload of a completed marketplace step returns `metering: 'duplicate'` and `advance: 'duplicate'`; the Invocation table still has one row for that `invocationId`. For a step whose first run failed (record `status: error, billable: false`) and whose retry passed, the success replaces the error record once, and a further replay is a duplicate.

**Commands**

```
npm run cli -- rerun-validate <imageId>       # replays the ValidateOutput input found in the execution history
npm run cli -- invocations                    # this month's Invocation records for the org
```

**Result (demo, section 11: a plain duplicate)**

```
ValidateOutput invoked a second time with the same payload:
  {"advance":"duplicate","invocationId":"1d8af589848dfb52db55f8e522376eae","metering":"duplicate", ...}
sepia-3p           image img_5bf4fba65684 attempt 1 status=ok    billable=true
sepia-3p-liar      image img_8f3d8b214b41 attempt 1 status=error billable=false errorClass=filter
sepia-3p-hostile   image img_5fce8897467a attempt 1 status=ok    billable=true
```

**Result (E9's batch: error record upgraded by the passing retry, then duplicate)**

```
rerun-validate img_07d0be4b3a8a  ->  "advance":"duplicate", "metering":"recorded"     <- replaced the error record
rerun-validate img_07d0be4b3a8a  ->  "advance":"duplicate", "metering":"duplicate"
invocations: 829e2dbffd373c0ebf5d02c514ed277a  img_07d0be4b3a8a  step 2  sepia-3p  attempt 1  ok  billable=true   (one row)
```

**Explanation:** `invocationId = sha256(org|batch|image|step)[:32]`, so every attempt at the same step computes the same id, and the DynamoDB item key is `ORG#<o>#<yyyy-mm> / INVOCATION#<id>`. Success writes with the condition "no item yet, or the existing item is an error"; `RecordFailure` writes with "no item yet". The reachable states are therefore: nothing → error → ok, or nothing → ok, and never ok → anything. That is what "bills once" means operationally: the number of `billable: true` rows per (image, step) is at most one, whatever Step Functions, retries or a replayed Lambda did. The liar's record (`error / filter / billable false`) is the other half of B Decision 5: failures are metered too, with a class, so the developer's error rate is visible and the customer is not charged for it.

A detail the first E9 run exposed: before the "or error" clause, the error record from run 1 would have blocked the passing retry's success record, and a step that eventually produced a correct result would have been recorded as a non-billable failure. The design intent was always one billable record for a successful step; the condition now says so.

**Teach-back:** _(write in your own words after reading)_
