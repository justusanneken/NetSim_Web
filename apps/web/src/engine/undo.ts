/**
 * Undo/Redo für Topologie- und Konfigurationsänderungen: Schnappschüsse des Entwurfszustands (`designJson`),
 * begrenzt nach Schrittzahl und Gesamtgröße. Unabhängig vom Schritt-zurück der Simulation (SimController.history):
 * dieser betrifft nur den Laufzeitverlauf, Undo den Entwurf.
 */
export interface UndoInfo {
  undo: number;
  redo: number;
}

export class UndoManager {
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private chars = 0;
  private depth = 0;
  /** Zählt jede Entwurfsänderung (Autosave prüft, ob sich etwas getan hat). */
  revision = 0;

  constructor(
    private readonly snapshot: () => string,
    private readonly restore: (s: string) => boolean,
    private readonly onChange: (i: UndoInfo) => void = () => undefined,
    private readonly maxSteps = 100,
    private readonly maxChars = 64_000_000,
  ) {}

  info(): UndoInfo {
    return { undo: this.undoStack.length, redo: this.redoStack.length };
  }

  /** Führt `fn` aus und legt bei geänderter Entwurfs-Darstellung einen Undo-Schritt an (nur die äußerste Ebene). */
  run<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    const pre = this.snapshot();
    this.depth++;
    let r: T;
    try {
      r = fn();
    } finally {
      this.depth--;
    }
    this.commit(pre);
    return r;
  }

  /** Wie `run`, für Fälle, in denen der Vorher-Zustand getrennt erfasst wird (CLI-Eingabe). */
  commit(pre: string, post?: string): void {
    const now = post ?? this.snapshot();
    if (now === pre) return;
    this.revision++;
    this.push(this.undoStack, pre);
    this.redoStack = [];
    this.trim();
    this.onChange(this.info());
  }

  capture(): string {
    return this.snapshot();
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (prev === undefined) return false;
    const cur = this.snapshot();
    this.chars -= prev.length;
    if (!this.restore(prev)) {
      this.onChange(this.info());
      return false;
    }
    this.revision++;
    this.push(this.redoStack, cur);
    this.onChange(this.info());
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (next === undefined) return false;
    const cur = this.snapshot();
    this.chars -= next.length;
    if (!this.restore(next)) {
      this.onChange(this.info());
      return false;
    }
    this.revision++;
    this.push(this.undoStack, cur);
    this.onChange(this.info());
    return true;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.chars = 0;
    this.onChange(this.info());
  }

  private push(stack: string[], s: string): void {
    stack.push(s);
    this.chars += s.length;
  }

  private trim(): void {
    while (
      this.undoStack.length > 0 &&
      (this.undoStack.length > this.maxSteps || this.chars > this.maxChars)
    ) {
      const old = this.undoStack.shift() as string;
      this.chars -= old.length;
    }
  }
}
