export type Logger = {
  info: (event: string, payload?: Record<string, unknown>) => void;
  error: (event: string, payload?: Record<string, unknown>) => void;
};

export function createLogger(component: string): Logger {
  const emit = (level: 'INFO' | 'ERROR', event: string, payload?: Record<string, unknown>) => {
    const record = {
      level,
      component,
      event,
      timestamp: new Date().toISOString(),
      payload: payload ?? {}
    };
    console.log(JSON.stringify(record));
  };

  return {
    info: (event, payload) => emit('INFO', event, payload),
    error: (event, payload) => emit('ERROR', event, payload)
  };
}
