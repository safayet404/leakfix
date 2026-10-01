// A rotation is a list of small, reversible steps. The engine runs them in
// order; if one fails, it undoes the completed ones in reverse, so a half-done
// rotation never leaves the app pointing at a credential that doesn't exist.

export interface Step {
  /** Short human description, shown in the plan and the audit log. */
  title: string;
  run(): Promise<void>;
  /** Undo this step if a later one fails. Omit for steps with nothing to undo. */
  undo?(): Promise<void>;
  /**
   * Steps after a point of no return (e.g. deleting the old credential) are
   * only run once everything before them succeeded and are never undone.
   */
  final?: boolean;
}

export interface Plan {
  /** e.g. "MONGODB_URI (MongoDB Atlas user collabify)" */
  target: string;
  steps: Step[];
}

export interface AuditEvent {
  at: string;
  target: string;
  step: string;
  status: "ok" | "failed" | "undone" | "undo-failed" | "skipped";
  error?: string;
}

export type Logger = (event: AuditEvent) => void;

export interface RunResult {
  target: string;
  ok: boolean;
  /** true: the whole rotation was undone; false with ok=false: rotated, but a final step needs a human. */
  rolledBack: boolean;
  error?: string;
  events: AuditEvent[];
}

export async function execute(plan: Plan, log: Logger = () => {}): Promise<RunResult> {
  const events: AuditEvent[] = [];
  const emit = (step: string, status: AuditEvent["status"], error?: string) => {
    const e: AuditEvent = { at: new Date().toISOString(), target: plan.target, step, status, ...(error ? { error } : {}) };
    events.push(e);
    log(e);
  };

  const done: Step[] = [];
  const finalErrors: string[] = [];
  for (const step of plan.steps) {
    try {
      await step.run();
      emit(step.title, "ok");
      done.push(step);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit(step.title, "failed", message);
      // Past the point of no return the app already runs on the new credential
      // and passed its checks. Rolling back would put it back on the leaked
      // one, so record the failure, try the remaining final steps, and report.
      if (step.final) {
        finalErrors.push(`${step.title}: ${message}`);
        continue;
      }
      // Roll back everything that can be rolled back, newest first.
      for (const prev of [...done].reverse()) {
        if (prev.final || !prev.undo) continue;
        try {
          await prev.undo();
          emit(prev.title, "undone");
        } catch (undoErr) {
          emit(prev.title, "undo-failed", undoErr instanceof Error ? undoErr.message : String(undoErr));
        }
      }
      for (const rest of plan.steps.slice(plan.steps.indexOf(step) + 1)) emit(rest.title, "skipped");
      return { target: plan.target, ok: false, rolledBack: true, error: message, events };
    }
  }
  if (finalErrors.length) {
    return {
      target: plan.target, ok: false, rolledBack: false, events,
      error: `Rotated, but finish these by hand: ${finalErrors.join("; ")}`,
    };
  }
  return { target: plan.target, ok: true, rolledBack: false, events };
}
