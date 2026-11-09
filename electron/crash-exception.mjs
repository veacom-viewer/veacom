export function exceptionClass(error) {
  if (!Error.isError(error)) return 'unknown';
  const prototype = Object.getPrototypeOf(error);
  if (prototype === TypeError.prototype) return 'type';
  if (prototype === RangeError.prototype) return 'range';
  if (prototype === ReferenceError.prototype) return 'reference';
  if (prototype === SyntaxError.prototype) return 'syntax';
  return 'unknown';
}
