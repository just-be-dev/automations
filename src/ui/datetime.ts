const pad = (value: number) => String(value).padStart(2, "0");

/** An ISO date-time as a `datetime-local` input shows it, in the browser's time zone. */
export const localDateTimeText = (text: string) => {
  const millis = Date.parse(text);
  if (Number.isNaN(millis) || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) {
    return text;
  }
  const date = new Date(millis);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
