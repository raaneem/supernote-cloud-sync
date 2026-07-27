export type SettingsFlowLeaveResult = "back" | "close" | "confirm-discard";

export class SettingsFlowController {
  private readonly stack: string[];
  private changed = false;

  constructor(initialView: string) {
    this.stack = [initialView];
  }

  get current(): string {
    return this.stack.at(-1)!;
  }

  get depth(): number {
    return this.stack.length;
  }

  get dirty(): boolean {
    return this.changed;
  }

  push(view: string): void {
    this.stack.push(view);
    this.changed = false;
  }

  setDirty(dirty: boolean): void {
    this.changed = dirty;
  }

  requestLeave(): SettingsFlowLeaveResult {
    return this.changed ? "confirm-discard" : this.leaveCurrent();
  }

  discardAndLeave(): Exclude<SettingsFlowLeaveResult, "confirm-discard"> {
    this.changed = false;
    return this.leaveCurrent();
  }

  afterSave(): Exclude<SettingsFlowLeaveResult, "confirm-discard"> {
    this.changed = false;
    return this.leaveCurrent();
  }

  private leaveCurrent(): "back" | "close" {
    if (this.stack.length > 1) {
      this.stack.pop();
      return "back";
    }
    return "close";
  }
}
