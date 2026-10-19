export function or<T>(value: T | undefined | null, fallback: T): T {
  return value ?? fallback
}

export function firstOf(fallback: string, ...values: (string | undefined)[]): string {
  return values.find((value) => value !== undefined) ?? fallback
}
