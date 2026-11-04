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

<!-- portfolio-review:start -->
## Development review

For application changes, the development agent requests/reuses both Codex Connector and DSH reviews of the current PR head, resolves confirmed findings, and checks required CI before normal merge/deploy. The owner does not coordinate mentions. Finish a stable, locally validated candidate before requesting reviewers. Use the shared review-cycle.py helper to reuse requests and publish explicit, version-bound dispositions; read back closure of the grouped ContextKeep review task. A merge alone does not close review work. Verify deployed read-only contracts for cross-application changes. Attribute developer decisions to the development agent, not to the owner. Reuse requests on retries; record both review URLs, SHAs and dispositions in the active ContextKeep task. Status/read-only/trivial formatting work needs no worker. Incident restoration may precede review with a recorded follow-up. DSH reports must not mention other bots or request their own review. Use the concise shared workflow: https://github.com/anervalens-netizen/astancu-website/blob/master/ops/dsh-integration/DEVELOPMENT-WORKFLOW.md .

## Code Review Rules

- Bind actions and receipts to the intended device, identity and execution. A disconnect is not proof that an action did not start.
- Preserve bounded output with explicit truncation and recovery; avoid duplicate execution on retries.
<!-- portfolio-review:end -->
