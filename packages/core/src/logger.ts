const LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const
/** Minimum level that gets printed. `'silent'` prints nothing. */
export type LogLevel = (typeof LEVELS)[number]
type Method = Exclude<LogLevel, 'silent'>
export type Logger = Record<Method, (...args: unknown[]) => void>

/** `sink` receives the messages that pass the level filter; defaults to `console`. */
export function createLogger(level: LogLevel = 'info', sink: Logger = console): Logger {
  const min = LEVELS.indexOf(level)
  const at =
    (method: Method) =>
    (...args: unknown[]) => {
      if (LEVELS.indexOf(method) >= min) sink[method]('[ceiba]', ...args)
    }
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }
}
