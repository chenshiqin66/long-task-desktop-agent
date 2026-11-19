/** Replies in a row that each made exactly one tool call before the next request says so. */
export const BATCH_REMINDER_AFTER = 4;

/**
 * Text added to the system part of the next request, only while the streak lasts.
 * It is not written to the transcript. A reply with two or more calls ends the streak.
 */
export function batchReminderText(singleCallStreak: number): string | undefined {
  if (singleCallStreak < BATCH_REMINDER_AFTER) return undefined;
  return [
    `Batching reminder: your last ${singleCallStreak} replies each made one tool call. If the next calls do not depend on each other's results, put them in one response.`,
    "Where another rule says a call goes alone or first, follow that rule.",
    "Do not mention this reminder.",
  ].join("\n");
}
