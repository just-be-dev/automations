import { expect, test } from "bun:test";
import { formatTime } from "@/lib/format";
import { fieldLabel, formatText } from "./record.ts";

test("field names read as labels", () => {
  expect(fieldLabel("start_date")).toBe("Start date");
  expect(fieldLabel("attendeeEmails")).toBe("Attendee emails");
  expect(fieldLabel("ts")).toBe("Sent");
  expect(fieldLabel("messageId")).toBe("Message ID");
});

test("dates, times, and Slack timestamps read as times; other text stays as written", () => {
  expect(formatText("ts", "1791183262.473")).toBe(formatTime(1791183262473));
  expect(formatText("start", "2026-11-02T09:30:00.000Z")).toBe(
    formatTime(Date.parse("2026-11-02T09:30:00.000Z")),
  );
  expect(formatText("start_date", "2026-11-02")).toBe("Nov 2, 2026");
  expect(formatText("channel", "#random")).toBe("#random");
  expect(formatText("count", "1791183262.473")).toBe("1791183262.473");
});
