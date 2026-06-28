import { startTransition, useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./dashboard-app.css";

interface DashboardStatus {
  ok: boolean;
  name: string;
  uptimeSeconds: number;
  server: {
    host: string;
    port: number;
    localMcpUrl: string;
    publicMcpUrl: string;
    localDashboardUrl: string;
    publicBaseUrl: string;
    node: string;
    platform: string;
    activeMcpSessions: number;
  };
  access: {
    dashboard: string;
    allowedRoots: string[];
    allowedHosts: string[];
    oauthOwnerToken: string;
    oauthScopes: string[];
    oauthRedirectHosts: string[];
  };
  features: {
    toolMode: string;
    toolNaming: string;
    widgets: string;
    skills: boolean;
  };
  storage: {
    stateDir: string;
    worktreeRoot: string;
    agentDir: string;
  };
  interactions: InteractionSummary;
  logging: Record<string, string | boolean>;
  logs: ServerLogSnapshot;
}

interface ServerLogEntry {
  id: string;
  sequence: number;
  ts: string;
  level: "error" | "warn" | "info" | "debug";
  event: string;
  fields: Record<string, unknown>;
  line: string;
}

interface ServerLogSnapshot {
  entries: ServerLogEntry[];
}

interface InteractionLogEvent {
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

interface InteractionSummary {
  total: number;
  succeeded: number;
  failed: number;
  byTool: Record<string, number>;
  lastEventId?: string;
}

interface InteractionSnapshot {
  summary: InteractionSummary;
  events: InteractionLogEvent[];
}

interface InteractionUpdate {
  event: InteractionLogEvent;
  summary: InteractionSummary;
}

interface ServerLogUpdate {
  entry: ServerLogEntry;
}

type InteractionStreamState = "connecting" | "live" | "offline";

const rootElement = document.querySelector<HTMLElement>("#dashboard-root");

if (!rootElement) {
  throw new Error("Missing #dashboard-root element.");
}

createRoot(rootElement).render(<DashboardApp />);

function DashboardApp() {
  const [status, setStatus] = useState<DashboardStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [interactionEvents, setInteractionEvents] = useState<InteractionLogEvent[]>([]);
  const [interactionSummary, setInteractionSummary] = useState<InteractionSummary | null>(null);
  const [serverLogEntries, setServerLogEntries] = useState<ServerLogEntry[]>([]);
  const [streamState, setStreamState] = useState<InteractionStreamState>("connecting");

  useEffect(() => {
    let cancelled = false;

    async function loadStatus(silent = false): Promise<void> {
      if (!silent) setRefreshing(true);

      try {
        const nextStatus = await fetchDashboardStatus();
        if (cancelled) return;

        startTransition(() => {
          setStatus(nextStatus);
          setInteractionSummary(nextStatus.interactions);
          setServerLogEntries(nextStatus.logs.entries);
          setError(null);
          setLastUpdatedAt(new Date());
        });
      } catch (loadError) {
        if (cancelled) return;

        setError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        if (!cancelled) setRefreshing(false);
      }
    }

    void loadStatus();
    const refreshTimer = window.setInterval(() => void loadStatus(true), 5000);

    return () => {
      cancelled = true;
      window.clearInterval(refreshTimer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    function applySnapshot(snapshot: InteractionSnapshot): void {
      if (cancelled) return;

      startTransition(() => {
        setInteractionSummary(snapshot.summary);
        setInteractionEvents(snapshot.events);
        setStreamState("live");
      });
    }

    function applyLogSnapshot(snapshot: ServerLogSnapshot): void {
      if (cancelled) return;

      startTransition(() => {
        setServerLogEntries(snapshot.entries);
        setStreamState("live");
      });
    }

    if (!("EventSource" in window)) {
      setStreamState("offline");
      void fetchInteractionSnapshot().then(applySnapshot).catch(() => setStreamState("offline"));
      void fetchDashboardStatus().then((nextStatus) => applyLogSnapshot(nextStatus.logs)).catch(() => setStreamState("offline"));
      return () => {
        cancelled = true;
      };
    }

    setStreamState("connecting");
    const source = new EventSource("/app/events");

    const onSnapshot = (message: MessageEvent<string>) => {
      applySnapshot(JSON.parse(message.data) as InteractionSnapshot);
    };
    const onLogsSnapshot = (message: MessageEvent<string>) => {
      applyLogSnapshot(JSON.parse(message.data) as ServerLogSnapshot);
    };
    const onInteraction = (message: MessageEvent<string>) => {
      if (cancelled) return;

      const update = JSON.parse(message.data) as InteractionUpdate;
      startTransition(() => {
        setInteractionSummary(update.summary);
        setInteractionEvents((events) => [
          update.event,
          ...events.filter((event) => event.id !== update.event.id),
        ].slice(0, 100));
        setStreamState("live");
      });
    };
    const onServerLog = (message: MessageEvent<string>) => {
      if (cancelled) return;

      const update = JSON.parse(message.data) as ServerLogUpdate;
      startTransition(() => {
        setServerLogEntries((entries) => [
          update.entry,
          ...entries.filter((entry) => entry.id !== update.entry.id),
        ].slice(0, 200));
        setStreamState("live");
      });
    };

    source.addEventListener("open", () => {
      if (!cancelled) setStreamState("live");
    });
    source.addEventListener("snapshot", onSnapshot);
    source.addEventListener("logs_snapshot", onLogsSnapshot);
    source.addEventListener("interaction", onInteraction);
    source.addEventListener("server_log", onServerLog);
    source.addEventListener("error", () => {
      if (!cancelled) setStreamState("offline");
    });

    return () => {
      cancelled = true;
      source.close();
    };
  }, []);

  function refreshNow(): void {
    setRefreshing(true);
    void fetchDashboardStatus()
      .then((nextStatus) => {
        startTransition(() => {
          setStatus(nextStatus);
          setInteractionSummary(nextStatus.interactions);
          setError(null);
          setLastUpdatedAt(new Date());
        });
      })
      .catch((loadError: unknown) => {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      })
      .finally(() => setRefreshing(false));
  }

  if (!status && !error) {
    return <LoadingView />;
  }

  if (!status) {
    return <ErrorView message={error ?? "Unable to load DevSpace status."} onRetry={refreshNow} />;
  }

  const interactions = interactionSummary ?? status.interactions;

  return (
    <div className="dashboard-page">
      <header className="console-header">
        <div>
          <p className="eyebrow">Local control plane</p>
          <h1>DevSpace Console</h1>
        </div>
        <div className="header-actions">
          <StatusPill activeSessions={status.server.activeMcpSessions} />
          <button className="ghost-button" type="button" onClick={refreshNow} disabled={refreshing}>
            {refreshing ? "Refreshing" : "Refresh"}
          </button>
        </div>
      </header>

      {error ? <div className="inline-error">{error}</div> : null}

      <section className="route-band" aria-label="Connection route">
        <RouteStep label="Console" value={status.server.localDashboardUrl} tone="local" />
        <RouteStep label="Domain" value={status.server.publicBaseUrl} tone="public" />
        <RouteStep label="MCP" value={status.server.publicMcpUrl} tone="mcp" />
        <RouteStep label="OAuth key" value={status.access.oauthOwnerToken} tone="oauth" />
      </section>

      <section className="metric-grid" aria-label="Runtime summary">
        <Metric label="Uptime" value={formatUptime(status.uptimeSeconds)} detail={status.server.platform} />
        <Metric label="MCP sessions" value={String(status.server.activeMcpSessions)} detail="Active transports" />
        <Metric label="Interactions" value={String(interactions.total)} detail={`${interactions.succeeded} succeeded`} />
        <Metric label="Failures" value={String(interactions.failed)} detail="Tool calls with errors" />
      </section>

      <InteractionPanel
        events={interactionEvents}
        summary={interactions}
        streamState={streamState}
      />

      <ServerLogPanel entries={serverLogEntries} />

      <section className="dashboard-grid">
        <Panel title="Connect" eyebrow="Endpoints">
          <EndpointRow label="Local MCP" value={status.server.localMcpUrl} />
          <EndpointRow label="Public MCP" value={status.server.publicMcpUrl} />
          <EndpointRow label="Latest domain" value={status.server.publicBaseUrl} />
        </Panel>

        <Panel title="Access" eyebrow="Security boundary">
          <FactRow label="Dashboard" value={status.access.dashboard} />
          <EndpointRow label="OAuth key" value={status.access.oauthOwnerToken} />
          <FactRow label="OAuth scopes" value={status.access.oauthScopes.join(", ") || "none"} />
          <TagList label="Allowed hosts" values={status.access.allowedHosts} />
          <PathList label="Allowed roots" paths={status.access.allowedRoots} />
        </Panel>

        <Panel title="Runtime" eyebrow="Process">
          <FactRow label="Host" value={`${status.server.host}:${status.server.port}`} />
          <FactRow label="Node" value={status.server.node} />
          <FactRow label="Platform" value={status.server.platform} />
          <FactRow label="Tool mode" value={`${status.features.toolMode} / ${status.features.toolNaming}`} />
          <FactRow label="Widgets" value={status.features.widgets} />
          <FactRow label="Skills" value={status.features.skills ? "enabled" : "off"} />
          <FactRow label="Last refresh" value={lastUpdatedAt ? formatTime(lastUpdatedAt) : "Pending"} />
        </Panel>

        <Panel title="Storage" eyebrow="Local paths">
          <PathList label="State" paths={[status.storage.stateDir]} />
          <PathList label="Worktrees" paths={[status.storage.worktreeRoot]} />
          <PathList label="Agent files" paths={[status.storage.agentDir]} />
        </Panel>

        <Panel title="Logging" eyebrow="Signals">
          {Object.entries(status.logging).map(([key, value]) => (
            <FactRow key={key} label={formatLabel(key)} value={formatValue(value)} />
          ))}
        </Panel>

        <Panel title="Redirects" eyebrow="OAuth clients">
          <TagList label="Allowed redirect hosts" values={status.access.oauthRedirectHosts} />
        </Panel>
      </section>
    </div>
  );
}

async function fetchDashboardStatus(): Promise<DashboardStatus> {
  const response = await fetch("/app/status", {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Status request failed: ${response.status}`);
  }

  return response.json() as Promise<DashboardStatus>;
}

async function fetchInteractionSnapshot(): Promise<InteractionSnapshot> {
  const response = await fetch("/app/interactions", {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Interaction request failed: ${response.status}`);
  }

  return response.json() as Promise<InteractionSnapshot>;
}

function LoadingView() {
  return (
    <div className="dashboard-page centered">
      <section className="empty-state">
        <p className="eyebrow">DevSpace</p>
        <h1>Loading console</h1>
      </section>
    </div>
  );
}

function ErrorView({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="dashboard-page centered">
      <section className="empty-state error-state">
        <p className="eyebrow">Status unavailable</p>
        <h1>Console could not connect</h1>
        <p>{message}</p>
        <button className="ghost-button" type="button" onClick={onRetry}>Retry</button>
      </section>
    </div>
  );
}

function StatusPill({ activeSessions }: { activeSessions: number }) {
  const online = activeSessions > 0;
  return (
    <span className={`status-pill ${online ? "online" : "idle"}`}>
      <span aria-hidden="true" />
      {online ? "Connected" : "Idle"}
    </span>
  );
}

function RouteStep({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className={`route-step ${tone}`}>
      <span className="route-label">{label}</span>
      <span className="route-value" title={value}>{value}</span>
    </div>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <article className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function Panel({
  title,
  eyebrow,
  children,
  className = "",
}: {
  title: string;
  eyebrow: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`dashboard-panel ${className}`.trim()}>
      <div className="panel-heading">
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
      </div>
      <div className="panel-body">{children}</div>
    </section>
  );
}

function InteractionPanel({
  events,
  summary,
  streamState,
}: {
  events: InteractionLogEvent[];
  summary: InteractionSummary;
  streamState: InteractionStreamState;
}) {
  const tools = Object.entries(summary.byTool).sort(([, left], [, right]) => right - left);

  return (
    <Panel title="Live interactions" eyebrow="Tool activity" className="interaction-panel">
      <div className="interaction-toolbar">
        <div className="interaction-counts" aria-label="Interaction counts">
          <SummaryChip label="Total" value={summary.total} />
          <SummaryChip label="Succeeded" value={summary.succeeded} tone="success" />
          <SummaryChip label="Failed" value={summary.failed} tone={summary.failed > 0 ? "danger" : "muted"} />
        </div>
        <span className={`stream-pill ${streamState}`}>
          <span aria-hidden="true" />
          {streamLabel(streamState)}
        </span>
      </div>

      <div className="tool-mix" aria-label="Tool call distribution">
        {tools.length > 0
          ? tools.map(([tool, count]) => <code key={tool}>{tool} x{count}</code>)
          : <code>No tool calls yet</code>}
      </div>

      <div className="interaction-list" aria-live="polite" aria-label="Recent interactions">
        {events.length > 0
          ? events.map((event) => <InteractionRow key={event.id} event={event} />)
          : <div className="interaction-empty">Waiting for the first MCP tool call.</div>}
      </div>
    </Panel>
  );
}

function SummaryChip({
  label,
  value,
  tone = "muted",
}: {
  label: string;
  value: number;
  tone?: "muted" | "success" | "danger";
}) {
  return (
    <span className={`summary-chip ${tone}`}>
      <strong>{value}</strong>
      {label}
    </span>
  );
}

function InteractionRow({ event }: { event: InteractionLogEvent }) {
  return (
    <article className={`interaction-row ${event.success ? "success" : "failed"}`}>
      <div className="interaction-main">
        <div className="interaction-line">
          <strong>{event.tool}</strong>
          <time dateTime={event.ts}>{formatEventTime(event.ts)}</time>
        </div>
        <div className="interaction-target" title={event.target ?? event.workspaceId ?? event.tool}>
          {event.target ?? event.workspaceId ?? "workspace"}
        </div>
        <p>{interactionDetail(event)}</p>
      </div>
      <div className="interaction-meta">
        <span>{event.durationMs}ms</span>
        <span>{event.success ? "ok" : "failed"}</span>
      </div>
    </article>
  );
}

function ServerLogPanel({ entries }: { entries: ServerLogEntry[] }) {
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [entries[0]?.id]);

  return (
    <Panel title="Server logs" eyebrow="Recent events" className="server-log-panel">
      <div ref={listRef} className="server-log-list" aria-live="polite" aria-label="Recent server logs">
        {entries.length > 0
          ? entries.map((entry) => <ServerLogRow key={entry.id} entry={entry} />)
          : <div className="interaction-empty">Waiting for the first server log entry.</div>}
      </div>
    </Panel>
  );
}

function ServerLogRow({ entry }: { entry: ServerLogEntry }) {
  const fields = logFieldSummary(entry.fields);

  return (
    <article className={`server-log-row ${entry.level}`}>
      <div className="server-log-meta">
        <time dateTime={entry.ts}>{formatEventTime(entry.ts)}</time>
        <span>{entry.level}</span>
      </div>
      <div className="server-log-body">
        <strong>{entry.event}</strong>
        <code title={entry.line}>{fields || entry.line}</code>
      </div>
    </article>
  );
}

function EndpointRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="endpoint-row">
      <div>
        <span>{label}</span>
        <code title={value}>{value}</code>
      </div>
      <CopyButton value={value} />
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  const [state, setState] = useState<"ready" | "copied" | "failed">("ready");

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
      window.setTimeout(() => setState("ready"), 1200);
    } catch {
      setState("failed");
      window.setTimeout(() => setState("ready"), 1600);
    }
  }

  return (
    <button className="copy-button" type="button" onClick={() => void copy()}>
      {state === "copied" ? "Copied" : state === "failed" ? "Failed" : "Copy"}
    </button>
  );
}

function FactRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="fact-row">
      <span>{label}</span>
      <strong title={value}>{value}</strong>
    </div>
  );
}

function TagList({ label, values }: { label: string; values: string[] }) {
  return (
    <div className="tag-block">
      <span>{label}</span>
      <div className="tag-list">
        {values.length > 0 ? values.map((value) => <code key={value}>{value}</code>) : <code>none</code>}
      </div>
    </div>
  );
}

function PathList({ label, paths }: { label: string; paths: string[] }) {
  return (
    <div className="path-block">
      <span>{label}</span>
      <div className="path-list">
        {paths.map((path) => <code key={`${label}:${path}`} title={path}>{path}</code>)}
      </div>
    </div>
  );
}

function streamLabel(state: InteractionStreamState): string {
  switch (state) {
    case "connecting":
      return "Connecting";
    case "live":
      return "Live";
    case "offline":
      return "Offline";
  }
}

function interactionDetail(event: InteractionLogEvent): string {
  if (event.commandPreview) return `$ ${event.commandPreview}`;
  if (event.commandRedacted) return "Shell command hidden by DEVSPACE_LOG_SHELL_COMMANDS=0";
  if (event.error) return event.error;
  if (event.workspaceId) return `Workspace ${event.workspaceId}`;
  return "Tool call completed";
}

function logFieldSummary(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatLogValue(value)}`)
    .join(" ");
}

function formatLogValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  return JSON.stringify(value);
}

function formatEventTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatUptime(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatLabel(value: string): string {
  return value.replace(/([A-Z])/g, " $1").replace(/^./, (letter) => letter.toUpperCase());
}

function formatValue(value: string | boolean): string {
  if (typeof value === "boolean") return value ? "on" : "off";
  return value;
}
