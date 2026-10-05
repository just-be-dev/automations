// Applies the saved color theme before the first paint, so the page doesn't flash the OS theme
// while the app loads. `src/ui/theme.ts` owns the storage key and values; keep the two in sync.
try {
  const theme = localStorage.getItem("theme");
  if (theme === "light" || theme === "dark") {
    document.documentElement.dataset.theme = theme;
  }
} catch {
  // Storage is unavailable (private browsing), so the page follows the OS theme.
}
