import { expect, test } from "bun:test";
import { isSimulated, recordIsSimulated } from "./operation.ts";

test("an operation is simulated unless the deployment connects it; a result says so itself", () => {
  expect(isSimulated("slack.sendMessage", [])).toBe(true);
  expect(isSimulated("slack.sendMessage", ["slack"])).toBe(false);
  expect(isSimulated("email.send", ["slack"])).toBe(true);
  expect(isSimulated("http.post", [])).toBe(false);
  // A run from before Slack was connected keeps saying it sent nothing.
  expect(recordIsSimulated({ simulated: true, channel: "#team" })).toBe(true);
  expect(recordIsSimulated({ channel: "C1", ts: "1.0" })).toBe(false);
  expect(recordIsSimulated(null)).toBe(false);
});
