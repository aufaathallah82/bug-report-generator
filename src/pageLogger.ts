const CONSOLE_EVENT_NAME = 'bug-report-generator:console';
const PAGE_LOGGER_FLAG = '__bugReportGeneratorPageLoggerInstalled';
const MAX_SERIALIZED_LENGTH = 2000;

type ConsolePatchWindow = Window & {
  [PAGE_LOGGER_FLAG]?: boolean;
};

const pageWindow = window as ConsolePatchWindow;

if (!pageWindow[PAGE_LOGGER_FLAG]) {
  pageWindow[PAGE_LOGGER_FLAG] = true;
  patchConsoleError();
  captureRuntimeErrors();
  captureUnhandledRejections();
}

function patchConsoleError(): void {
  const originalConsoleError = console.error.bind(console);

  console.error = (...args: unknown[]) => {
    emitConsoleEvent({
      level: 'console.error',
      message: args.map(serializeValue).join(' '),
      arguments: args.map(serializeValue),
      stack: new Error().stack,
    });

    originalConsoleError(...args);
  };
}

function captureRuntimeErrors(): void {
  window.addEventListener('error', (event) => {
    if (!event.message) {
      return;
    }

    emitConsoleEvent({
      level: 'runtime-error',
      message: event.message,
      source: event.filename || undefined,
      line: event.lineno || undefined,
      column: event.colno || undefined,
      stack: event.error instanceof Error ? event.error.stack : undefined,
    });
  });
}

function captureUnhandledRejections(): void {
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;

    emitConsoleEvent({
      level: 'unhandled-rejection',
      message: reason instanceof Error ? reason.message : serializeValue(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
}

function emitConsoleEvent(event: {
  level: 'console.error' | 'runtime-error' | 'unhandled-rejection';
  message: string;
  source?: string;
  line?: number;
  column?: number;
  stack?: string;
  arguments?: string[];
}): void {
  window.dispatchEvent(
    new CustomEvent(CONSOLE_EVENT_NAME, {
      detail: {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        ...event,
      },
    }),
  );
}

function serializeValue(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }

  if (value instanceof Element) {
    return value.outerHTML.slice(0, MAX_SERIALIZED_LENGTH);
  }

  if (typeof value === 'string') {
    return trimSerialized(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return String(value);
  }

  try {
    return trimSerialized(JSON.stringify(value, getCircularReferenceReplacer()));
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function trimSerialized(value: string): string {
  return value.length > MAX_SERIALIZED_LENGTH ? `${value.slice(0, MAX_SERIALIZED_LENGTH)}...` : value;
}

function getCircularReferenceReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();

  return (_key, value) => {
    if (typeof value !== 'object' || value === null) {
      return value;
    }

    if (seen.has(value)) {
      return '[Circular]';
    }

    seen.add(value);
    return value;
  };
}
