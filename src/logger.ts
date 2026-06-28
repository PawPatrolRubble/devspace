import type { Request } from "express";

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";
export type LogFormat = "json" | "pretty";

export interface LoggingConfig {
  level: LogLevel;
  format: LogFormat;
  requests: boolean;
  assets: boolean;
  toolCalls: boolean;
  shellCommands: boolean;
  trustProxy: boolean;
}

type LogFields = Record<string, unknown>;

export interface ServerLogEntry {
  id: string;
  sequence: number;
  ts: string;
  level: Exclude<LogLevel, "silent">;
  event: string;
  fields: LogFields;
  line: string;
}

export interface ServerLogSnapshot {
  entries: ServerLogEntry[];
}

export type ServerLogListener = (entry: ServerLogEntry) => void;

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

const serverLogEntries: ServerLogEntry[] = [];
const serverLogListeners = new Set<ServerLogListener>();
let serverLogSequence = 0;
const SERVER_LOG_LIMIT = 200;

export function shouldLog(config: LoggingConfig, level: Exclude<LogLevel, "silent">): boolean {
  return LEVEL_WEIGHT[config.level] >= LEVEL_WEIGHT[level];
}

export function logEvent(
  config: LoggingConfig,
  level: Exclude<LogLevel, "silent">,
  event: string,
  fields: LogFields = {},
): void {
  if (!shouldLog(config, level)) return;

  const ts = new Date().toISOString();
  const entry = {
    ts,
    level,
    event,
    ...fields,
  };

  const line = config.format === "pretty" ? formatPretty(entry) : JSON.stringify(entry);
  recordServerLog({ ts, level, event, fields, line });
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function serverLogSnapshot(): ServerLogSnapshot {
  return {
    entries: [...serverLogEntries],
  };
}

export function subscribeServerLogs(listener: ServerLogListener): () => void {
  serverLogListeners.add(listener);

  return () => {
    serverLogListeners.delete(listener);
  };
}

export function requestIp(req: Request, trustProxy: boolean): string | undefined {
  if (trustProxy) {
    const cfConnectingIp = firstHeaderValue(req.header("cf-connecting-ip"));
    if (cfConnectingIp) return cfConnectingIp;

    const forwardedFor = firstHeaderValue(req.header("x-forwarded-for"));
    if (forwardedFor) return forwardedFor;
  }

  return req.ip ?? req.socket.remoteAddress;
}

export function requestPath(req: Request): string {
  return req.path || req.url.split("?")[0] || req.url;
}

export function sessionIdPrefix(sessionId: string | undefined): string | undefined {
  return sessionId ? sessionId.slice(0, 8) : undefined;
}

export function commandPreview(command: string): string {
  const normalized = command.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function firstHeaderValue(value: string | undefined): string | undefined {
  return value?.split(",")[0]?.trim() || undefined;
}

function formatPretty(entry: LogFields): string {
  const ts = String(entry.ts);
  const level = String(entry.level).toUpperCase();
  const event = String(entry.event);
  const rest = Object.entries(entry)
    .filter(([key, value]) => !["ts", "level", "event"].includes(key) && value !== undefined)
    .map(([key, value]) => `${key}=${formatPrettyValue(value)}`)
    .join(" ");

  return rest ? `${ts} ${level} ${event} ${rest}` : `${ts} ${level} ${event}`;
}

function formatPrettyValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  return JSON.stringify(value);
}

function recordServerLog({
  ts,
  level,
  event,
  fields,
  line,
}: {
  ts: string;
  level: Exclude<LogLevel, "silent">;
  event: string;
  fields: LogFields;
  line: string;
}): void {
  const sequence = serverLogSequence + 1;
  serverLogSequence = sequence;
  const entry: ServerLogEntry = {
    id: `log_${sequence}`,
    sequence,
    ts,
    level,
    event,
    fields,
    line,
  };
  serverLogEntries.unshift(entry);
  if (serverLogEntries.length > SERVER_LOG_LIMIT) serverLogEntries.pop();
  for (const listener of serverLogListeners) {
    listener(entry);
  }
}
