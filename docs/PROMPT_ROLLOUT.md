# Prompt Rollout Runbook

Authoring, rolling out, and rolling back LLM system prompts in MedCore.

MedCore ships prompts in two layers:

1. **Code-level fallback** — the `PROMPTS` constant in
   `apps/api/src/services/ai/prompts.ts`. This is what the API uses when the
   DB has no row (fresh deploy) or the DB call fails.
2. **DB registry** — `prompts` table, managed by
   `apps/api/src/services/ai/prompt-registry.ts` and the admin API under
   `/api/v1/ai/admin/prompts/*`. When an active row exists for a key, it
   wins over the code-level fallback. A 60-second in-memory cache sits in
   front of the DB so the hot path (every triage / scribe call) doesn't
   pay a round-trip cost.

Read the cached active version with:

```ts
const prompt = await getActivePrompt("TRIAGE_SYSTEM");
```

---

## 1. Author a new prompt version locally

Prompts are user-visible LLM behaviour. **Always eval before rollout.**

1. Write the new prompt as a string and commit it to the companion seed
   script alongside the code-level fallback update:

   ```ts
   // packages/db/src/seed-prompt-v2-triage.ts (or v3, vN...)
   const TRIAGE_SYSTEM_V2 = `...`;
   ```

2. Run it through the eval harness against the golden set:

   ```bash
   # from repo root
   npx tsx packages/ai-evals/src/runner.ts --key TRIAGE_SYSTEM --candidate ./new-prompt.txt
   ```

   Block rollout if:
   - Red-flag recall drops (we require 100% on the ER-routing set).
   - Hindi handling regresses.
   - JSON-schema adherence drops below 95% on the synth set.

3. Stage the seed in your local DB:

   ```bash
   npm -w @medcore/db run db:seed-prompts-v2
   ```

   The script is idempotent — safe to re-run.

4. Verify the row exists and is **inactive**:

   ```bash
   npm -w @medcore/db run db:studio
   # or:
   psql $DATABASE_URL -c "select id,key,version,active,\"createdBy\" from prompts where key='TRIAGE_SYSTEM' order by version;"
   ```

---

## 2. Create a version via the admin API

Once the eval looks good, create the DB row against staging / prod. This
is the same thing the seed script does but works against environments where
you don't run seeds (e.g. prod, where we deliberately keep seeding
out of the deploy script).

```bash
curl -X POST https://api.medcore.example/api/v1/ai/admin/prompts/TRIAGE_SYSTEM/versions \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "You are MedCore'\''s AI appointment booking assistant...",
    "notes": "V2: explicit red-flag ack + tightened JSON-only directive"
  }'
```

Response:

```json
{
  "success": true,
  "data": {
    "id": "ckxx...",
    "key": "TRIAGE_SYSTEM",
    "version": 2,
    "active": false,
    ...
  },
  "error": null
}
```

Capture the `id` — you'll need it for activation.

Notes:
- The endpoint requires an `ADMIN` JWT. Every create/activate/rollback
  writes an `audit_logs` row (action: `PROMPT_VERSION_CREATE`,
  `PROMPT_VERSION_ACTIVATE`, `PROMPT_VERSION_ROLLBACK`).
- `version` auto-increments per key starting at 1.
- New versions are **always inactive** — they never replace the live
  prompt without a separate activation step.

---

## 3. Activate (roll out)

```bash
curl -X POST https://api.medcore.example/api/v1/ai/admin/prompts/versions/$V2_ID/activate \
  -H "Authorization: Bearer $ADMIN_JWT"
```

What happens:
- The target row's `active` flag flips to true.
- The previously-active row (if any) for the same key flips to false.
- The in-memory registry cache is cleared on the handling process. Other
  API processes pick up the change within 60 s (cache TTL) — the
  rollout is NOT simultaneous across the fleet.

**Therefore:** after activation, wait 60 s before declaring rollout done,
and watch the live `ai_call` log line (see §5) for the modelVersion /
responseTime deltas. If something looks off, roll back (§4) — don't wait.

---

## 4. Roll back

```bash
curl -X POST https://api.medcore.example/api/v1/ai/admin/prompts/TRIAGE_SYSTEM/rollback \
  -H "Authorization: Bearer $ADMIN_JWT"
```

Flips to the version immediately prior to the current active one. Fails
with **409** if there is no prior version (e.g. only v1 exists). The
cache is cleared same as activation; budget 60 s for fleet propagation.

If you need to go further back than one step, call `activatePromptVersion`
directly with the specific version id from the list endpoint:

```bash
# List history newest-first
curl https://api.medcore.example/api/v1/ai/admin/prompts/TRIAGE_SYSTEM/versions \
  -H "Authorization: Bearer $ADMIN_JWT"

# Jump to an arbitrary version
curl -X POST https://api.medcore.example/api/v1/ai/admin/prompts/versions/$TARGET_ID/activate \
  -H "Authorization: Bearer $ADMIN_JWT"
```

---

## 5. Verify in prod via observability

Every LLM call emits a structured `ai_call` log line with:

- `feature` — e.g. `triage`, `scribe`.
- `modelVersion` — the LLM model id (Sarvam-M, Llama-3.1-8B, etc).
- `latencyMs`, `tokensIn`, `tokensOut`.
- `sessionId` where applicable.

Soon (tracked separately) each line will also carry the `promptVersion`
served to that call so you can grep for the new version post-rollout:

```bash
# On the prod server
tail -f /var/log/medcore/api.log | grep '"feature":"triage"' | jq '{
  feature, modelVersion, promptVersion, latencyMs, tokensIn, tokensOut
}'
```

Until `promptVersion` lands in the log line, use the audit trail to
confirm the activate call succeeded, then spot-check a triage session
against the expected V2 behaviour (e.g. V2's explicit red-flag
acknowledgement text appears in the assistant reply).

Rough sanity queries:

```sql
-- Confirm which version is live right now
select key, version, "createdBy", "createdAt"
  from prompts
 where active = true and key = 'TRIAGE_SYSTEM';

-- Audit trail for the last rollout
select "createdAt", action, "userId", metadata
  from audit_logs
 where action like 'PROMPT_VERSION_%'
 order by "createdAt" desc
 limit 20;
```

---

## 6. Failure modes

| Symptom | Meaning | Action |
|---|---|---|
| `404 Prompt version not found` on activate | Bad version id | Re-list and try again |
| `409 no prior version` on rollback | Only v1 exists; nothing to roll back to | You authored this v1 — fix forward, don't try to roll back |
| `getActivePrompt` returns the code-fallback text after activate | DB lookup failed; you're being served the static `PROMPTS` constant | Check DB connectivity and `[prompt-registry] DB lookup failed` warnings |
| Cache serves old prompt after rollout | Process is still inside the 60 s TTL window | Wait 60 s, or restart the API worker to force-clear |

The registry is designed to degrade gracefully: if Postgres is down we
serve `PROMPTS[key]` from the code constant so triage never 500s.
