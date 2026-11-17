export type FloatingWindowRole = "avatar" | "subtitle";
export type FloatingRendererStatus = "closed" | "loading" | "ready" | "stopped" | "unresponsive" | "recovering" | "error";

export interface FloatingRendererState {
  status: FloatingRendererStatus;
  enabled: boolean;
  visible?: boolean;
  pid: number;
  changedAt: string;
  lastReadyAt: string | null;
  reason: string | null;
  exitCode: number | null;
  message: string | null;
}

export type FloatingRendererSnapshot = Record<FloatingWindowRole, FloatingRendererState>;
export interface FloatingDiagnosticEvent {
  kind: string;
  role: FloatingWindowRole;
  reason?: string;
  exitCode?: number;
  rendererPid: number;
  lastReadyAt: string | null;
  message?: string;
}

/** Tracks rendering independently from the existence or visibility of a window. */
export class FloatingRendererHealth {
  private readonly states: FloatingRendererSnapshot;
  private readonly versions = { avatar: 0, subtitle: 0 };

  constructor(private readonly options: {
    onChange: (state: FloatingRendererSnapshot) => void;
    onDiagnostic: (event: FloatingDiagnosticEvent) => void;
    now?: () => Date;
  }) {
    const initial = (): FloatingRendererState => ({
      status: "closed", enabled: true, pid: 0, changedAt: this.timestamp(),
      lastReadyAt: null, reason: null, exitCode: null, message: null,
    });
    this.states = { avatar: initial(), subtitle: initial() };
  }

  snapshot(): FloatingRendererSnapshot {
    return { avatar: { ...this.states.avatar }, subtitle: { ...this.states.subtitle } };
  }

  version(role: FloatingWindowRole): number {
    return this.versions[role];
  }

  setEnabled(role: FloatingWindowRole, enabled: boolean): void {
    this.states[role].enabled = enabled;
    this.options.onChange(this.snapshot());
  }

  loading(role: FloatingWindowRole): void {
    this.update(role, { status: this.states[role].status === "recovering" ? "recovering" : "loading", pid: 0 });
  }

  ready(role: FloatingWindowRole, pid: number, expectedVersion: number): boolean {
    if (expectedVersion !== this.versions[role] || pid <= 0) return false;
    const recovered = this.states[role].status === "recovering";
    this.update(role, { status: "ready", pid, lastReadyAt: this.timestamp(), reason: null, exitCode: null, message: null });
    if (recovered) this.emit(role, "manual-recovery-completed");
    return true;
  }

  stopped(role: FloatingWindowRole, reason: string, exitCode: number): void {
    this.emit(role, "renderer-process-gone", { reason, exitCode });
    this.update(role, { status: "stopped", pid: 0, reason, exitCode, message: "描画プロセスが停止しました。" });
  }

  failed(role: FloatingWindowRole, reason: string, message: string): void {
    this.emit(role, "renderer-error", { reason, message: message.slice(0, 400) });
    this.update(role, { status: "error", reason, message: message.slice(0, 400) });
  }

  unresponsive(role: FloatingWindowRole): void {
    this.emit(role, "renderer-unresponsive");
    this.update(role, { status: "unresponsive", reason: "unresponsive", message: "表示が応答していません。" });
  }

  recovering(role: FloatingWindowRole): void {
    this.emit(role, "manual-recovery-requested");
    this.update(role, { status: "recovering", reason: null, exitCode: null, message: null });
  }

  closed(role: FloatingWindowRole): void {
    this.update(role, { status: "closed", pid: 0 });
  }

  private update(role: FloatingWindowRole, patch: Partial<FloatingRendererState>): void {
    this.versions[role] += 1;
    Object.assign(this.states[role], patch, { changedAt: this.timestamp() });
    this.options.onChange(this.snapshot());
  }

  private emit(role: FloatingWindowRole, kind: string, extra: Partial<FloatingDiagnosticEvent> = {}): void {
    const state = this.states[role];
    this.options.onDiagnostic({ kind, role, rendererPid: state.pid, lastReadyAt: state.lastReadyAt, ...extra });
  }

  private timestamp(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }
}

/** Coalesces repeated clicks; recovery only runs when explicitly requested. */
export class ManualFloatingRecovery {
  private pending: Promise<void> | null = null;

  run(recover: () => Promise<void>): Promise<void> {
    if (this.pending) return this.pending;
    const task = Promise.resolve().then(recover);
    this.pending = task;
    void task.finally(() => { if (this.pending === task) this.pending = null; }).catch(() => undefined);
    return task;
  }
}
