# Verifier Reports

Store completed RST ticket reviews here. For each reviewed ticket, keep one
canonical report at `docs/tasks/reviews/verify-RST-NNN.md`; record each review
round in that report rather than creating an empty placeholder during setup.

The assigned verifier owns only its report. It does not edit application
source, tests, the ledger, role definitions, the checklist, or another report.
Use current evidence from the exact reviewed tree and distinguish local fixture
results from operational cutover requirements and live-release proof.

Each report must include:

- Ticket ID, exact base SHA, reviewed-tree SHA, verifier model, and review round.
- An explicit `ACCEPT` or `REJECT` result.
- Findings with exact file-and-line references and reproducible corrections, or
  an explicit statement that no findings remain.
- Commands run and their results, including focused tests; cite canonical gates
  only when they ran against the exact reviewed tree.
- The result and evidence for every applicable item in
  `docs/tasks/rst-strict-audit-checklist.md`; explain every `N/A`.
- Any remaining operational or release proof, or an explicit statement that
  none remains.

Suggested report structure:

```markdown
# Verification: RST-NNN

- Ticket ID:
- Base SHA:
- Reviewed-tree SHA:
- Model: Luna 5.6, max reasoning
- Round:
- Result: ACCEPT | REJECT

## Findings

## Strict Checklist Results

## Commands and Results

## Remaining Operational or Release Proof
```
