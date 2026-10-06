/** Reads error messages across local and RPC boundaries, where errors may be plain objects. */
export const messageOf = (error: unknown, fallback = "Unexpected error") =>
  typeof error === "object" &&
  error !== null &&
  "message" in error &&
  typeof error.message === "string"
    ? error.message
    : fallback;
