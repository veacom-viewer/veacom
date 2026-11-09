export type ExceptionClass = 'type' | 'range' | 'reference' | 'syntax' | 'unknown';
export function exceptionClass(error: unknown): ExceptionClass;
