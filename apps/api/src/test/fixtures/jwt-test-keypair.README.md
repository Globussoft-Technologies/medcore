# JWT test keypair — NOT FOR PRODUCTION

Generated 2026-05-11 for `services/jwt.test.ts` and the dual-mode rotation
fixtures only.

**Do not use these keys in any deployed environment.** They are committed to
version control and have therefore been exposed publicly the moment this PR
opens. Any token signed with the matching private key is forge-able by
anyone with `git clone` access.

## Files

- `jwt-test-private.pem` — RSA 2048-bit PKCS#8 PEM private key
- `jwt-test-public.pem`  — RSA 2048-bit SPKI PEM public key

## Regenerating

If for some reason the keypair needs to be rotated (e.g. test material got
imported into a real deployment by mistake — please don't), regenerate with:

```bash
node -e "const {generateKeyPairSync}=require('crypto'); \
  const {publicKey,privateKey}=generateKeyPairSync('rsa', { \
    modulusLength: 2048, \
    publicKeyEncoding: { type: 'spki', format: 'pem' }, \
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' } \
  }); \
  require('fs').writeFileSync('apps/api/src/test/fixtures/jwt-test-private.pem', privateKey); \
  require('fs').writeFileSync('apps/api/src/test/fixtures/jwt-test-public.pem', publicKey);"
```

Tests load these files via `fs.readFileSync` — no other change required.

## Real-keypair generation (production)

For the actual RS256 rotation (issue #482), see `docs/JWT_ROTATION.md`. Keys
there are generated on the production host, never committed, and live in the
secrets store. The fixtures in this directory exist purely so the test suite
can exercise the RS256 + dual-verify code paths without spinning up a real
secret-management dependency.
