import type { ErrorCategory, StageFailure, StageId } from "./types.js";

/** An expected failure with a category and a next step, shown verbatim in the report. */
export class StageError extends Error {
  constructor(
    readonly stage: StageId,
    readonly category: ErrorCategory,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "StageError";
  }

  toFailure(): StageFailure {
    return { stage: this.stage, category: this.category, message: this.message, hint: this.hint };
  }
}

/** Anything that is not a StageError is a bug in Theme QA and is reported as "internal". */
export function toStageFailure(error: unknown, stage: StageId): StageFailure {
  if (error instanceof StageError) return error.toFailure();
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return { stage, category: "internal", message, hint: "Re-run the job. If it repeats, report this log." };
}

export async function retry<T>(
  action: (attempt: number) => Promise<T>,
  options: { attempts: number; delayMs: number; shouldRetry?: (error: unknown) => boolean },
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      return await action(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === options.attempts || (options.shouldRetry && !options.shouldRetry(error))) break;
      await new Promise((resolve) => setTimeout(resolve, options.delayMs * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}
