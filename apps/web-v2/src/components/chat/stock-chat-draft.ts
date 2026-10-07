export type GeneratedDraftResult = {
  value: string;
  accepted: boolean;
};

/** Apply a generated prompt without overwriting text the user entered. */
export function applyGeneratedDraft(
  current: string,
  previousGenerated: string | null,
  nextGenerated: string,
): GeneratedDraftResult {
  if (!current.trim() || current === previousGenerated) {
    return { value: nextGenerated, accepted: true };
  }
  return { value: current, accepted: false };
}
