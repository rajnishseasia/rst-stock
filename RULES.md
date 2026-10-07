# Development Rules

These rules define coding standards for this project.

---

## Code Quality Standards

- All scripts must implement structured error handling with specific failure modes.
- Every function must include a concise, purpose-driven docstring.
- Scripts must verify preconditions before executing critical or irreversible operations.
- Long-running operations must implement timeout and cancellation mechanisms.
- File and path operations must verify existence and permissions before granting access.
- Always use `catchError` from `@trade-bot/utils` instead of try/catch.
- Never write unused code.
- Code should be CLEAN, DRY, MAINTAINABLE.

---

## Security Guidelines

- Hardcoded credentials are strictly forbidden—use environment variables.
- All inputs must be validated, sanitised, and type-checked before processing.
- Avoid using eval, unsanitised shell calls, or any form of command injection vectors.
- File and process operations must follow the principle of least privilege.
- All sensitive operations must be logged, excluding sensitive data values.

---

## Design Philosophy

### KISS (Keep It Simple, Stupid)

- Solutions must be straightforward and easy to understand.
- Avoid over-engineering or unnecessary abstraction.
- Prioritise code readability and maintainability.

### YAGNI (You Aren't Gonna Need It)

- Do not add speculative features or future-proofing unless explicitly required.
- Focus only on immediate requirements and deliverables.
- Minimise code bloat and long-term technical debt.

### SOLID Principles

- **Single Responsibility** — each module or function should do one thing only.
- **Open-Closed** — software entities should be open for extension but closed for modification.
- **Liskov Substitution** — derived classes must be substitutable for their base types.
- **Interface Segregation** — prefer many specific interfaces over one general-purpose interface.
- **Dependency Inversion** — depend on abstractions, not concrete implementations.

---

## Error Handling Pattern

Always use `catchError` for async operations:

```typescript
import { catchError } from "@trade-bot/utils";

const [error, data] = await catchError(someAsyncOperation());
if (error) {
  logger.error("context", "Operation failed", { error: error.message });
  return;
}
// Use data safely
```

---

## Process Execution

- All actions should be logged with appropriate severity (INFO, WARNING, ERROR).
- Any failed task must include a clear, human-readable error report.
- Retry logic must include exponential backoff and failure limits.
- Long-running tasks should expose progress indicators or checkpoints.
