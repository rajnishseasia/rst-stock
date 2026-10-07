export class SubmissionAttemptGuard {
  private currentAttempt = 0;

  begin(): number {
    this.currentAttempt += 1;
    return this.currentAttempt;
  }

  cancel(): void {
    this.currentAttempt += 1;
  }

  isCurrent(attempt: number): boolean {
    return attempt === this.currentAttempt;
  }
}

export function visiblePerpSubmitError(
  message: string | null,
  reviewOpen: boolean,
): string | null {
  return reviewOpen ? null : message;
}
