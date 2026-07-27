export const normalizeVerificationCode = (value: string): string =>
  value
    .toLocaleUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);

export const isValidVerificationCode = (value: string): boolean =>
  /^[A-Z0-9]{6}$/.test(value);
