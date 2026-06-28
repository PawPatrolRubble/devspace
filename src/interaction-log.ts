export interface ToolCallInteractionInput {
  tool: string;
  workspaceId?: string;
  path?: string;
  workingDirectory?: string;
  commandPreview?: string;
  commandRedacted?: boolean;
  commandLength?: number;
  success: boolean;
  durationMs: number;
  error?: string;
}

export interface InteractionLogEvent {
  id: string;
  sequence: number;
  ts: string;
  kind: "tool_call";
  tool: string;
  workspaceId?: string;
  target?: string;
  path?: string;
  workingDirectory?: string;
  commandPreview?: string;
  commandRedacted?: boolean;
  commandLength?: number;
  success: boolean;
  durationMs: number;
  error?: string;
}

export interface InteractionSummary {
  total: number;
  succeeded: number;
  failed: number;
  byTool: Record<string, number>;
  lastEventId?: string;
}

export interface InteractionSnapshot {
  summary: InteractionSummary;
  events: InteractionLogEvent[];
}

export type InteractionListener = (event: InteractionLogEvent) => void;

export class InteractionLog {
  private readonly events: InteractionLogEvent[] = [];
  private readonly listeners = new Set<InteractionListener>();
  private readonly byTool = new Map<string, number>();
  private sequence = 0;
  private total = 0;
  private succeeded = 0;
  private failed = 0;
  private lastEventId: string | undefined;

  constructor(private readonly limit = 200) {}

  recordToolCall(input: ToolCallInteractionInput): InteractionLogEvent {
    const sequence = this.sequence + 1;
    const event: InteractionLogEvent = {
      id: `interaction_${sequence}`,
      sequence,
      ts: new Date().toISOString(),
      kind: "tool_call",
      tool: input.tool,
      workspaceId: input.workspaceId,
      target: input.path ?? input.workingDirectory,
      path: input.path,
      workingDirectory: input.workingDirectory,
      commandPreview: input.commandPreview,
      commandRedacted: input.commandRedacted,
      commandLength: input.commandLength,
      success: input.success,
      durationMs: input.durationMs,
      error: input.error,
    };

    this.sequence = sequence;
    this.total += 1;
    if (input.success) this.succeeded += 1;
    else this.failed += 1;
    this.lastEventId = event.id;
    this.byTool.set(input.tool, (this.byTool.get(input.tool) ?? 0) + 1);

    this.events.unshift(event);
    if (this.events.length > this.limit) this.events.pop();

    for (const listener of this.listeners) {
      listener(event);
    }

    return event;
  }

  summary(): InteractionSummary {
    return {
      total: this.total,
      succeeded: this.succeeded,
      failed: this.failed,
      byTool: Object.fromEntries(
        Array.from(this.byTool.entries()).sort(([left], [right]) => left.localeCompare(right)),
      ),
      lastEventId: this.lastEventId,
    };
  }

  snapshot(): InteractionSnapshot {
    return {
      summary: this.summary(),
      events: [...this.events],
    };
  }

  subscribe(listener: InteractionListener): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }
}