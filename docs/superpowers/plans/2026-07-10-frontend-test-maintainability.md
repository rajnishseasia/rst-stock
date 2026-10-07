# Frontend Test Maintainability Plan

## Goal

Stop source-string UI tests from expanding and begin replacing them with behavior-level contracts before the largest terminal components are extracted.

## Changes

- Extract generated-chat-draft behavior into a pure helper and test empty, generated, and user-authored states directly.
- Add an explicit, shrinking allowlist of legacy tests that read implementation source.
- Fail the web suite when a new source-contract test is introduced.

## Follow-up

Each future component extraction should remove its test from the allowlist after replacing the source assertions with rendered interaction or pure state tests. The guard must shrink, never grow without explicit review.
