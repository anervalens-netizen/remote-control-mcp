# Contributor instructions

Read README.md and the relevant source/tests before editing. Preserve concurrent changes. Run relevant type, functional and operational tests; do not weaken assertions to obtain a passing result. Keep installed application identifiers stable unless a deliberate compatibility migration is planned.

This repository is public. Use wholly synthetic fixtures and generic examples. Never commit personal information, customer or employee data, production databases, credentials, password verifiers, private endpoints, local work reports or screenshots of real data. Keep project memory and deployment records in private owner-controlled storage, not issues, comments, logs or commits. Use a noreply Git author address.

Production operations must use explicitly configured hosts, secrets and data directories; a repository checkout is not evidence of runtime identity or deployment health. Preserve a verified recovery copy before changing persistent production data.


## Public merge identity

Every reachable author and committer must use an `@users.noreply.github.com`
address. Create qualified merges locally with the configured noreply identity
and run the normal pre-push history check before publication. Do not rely on a
server-side merge action to select that identity. Preserve concurrent work and
verify the exact remote head before correcting published metadata. Keep recovery
bundles and deployment records in private operator storage.
