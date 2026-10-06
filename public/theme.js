/** Applies the saved theme before first paint; keep its storage key and values in sync with src/ui/theme.ts. */
try {
  const theme = localStorage.getItem("theme");
  if (theme === "light" || theme === "dark") {
    document.documentElement.dataset.theme = theme;
  }
} catch {
  // Storage is unavailable (private browsing), so the page follows the OS theme.
}
