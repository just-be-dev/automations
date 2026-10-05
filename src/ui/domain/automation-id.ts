export const invalidError = "Automation IDs use letters, numbers, - and _ (up to 80 characters)";

export const isValid = (value: string) => /^[a-zA-Z0-9_-]{1,80}$/.test(value.trim());
