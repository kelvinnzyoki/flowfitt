// PRELOAD (prevents flash of dark mode before JS loads)
(function () {
  const savedTheme = localStorage.getItem('flowfit-theme');
  if (savedTheme === 'light') {
    document.documentElement.classList.add('light-mode');
  }
})();

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('themeToggle');
  const icon = document.getElementById('themeIcon');
  const root = document.documentElement;

  // Function to set the correct icon based on current state
  function updateIcon() {
    if (!icon) return;
    // If in light mode, show Moon (to click to go dark). If dark, show Sun.
    icon.textContent = root.classList.contains('light-mode') ? '🌙' : '☀️';
  }

  // Set initial icon on load
  updateIcon();

  // If the button exists on this specific page, attach the listener
  if (btn) {
    btn.addEventListener('click', () => {
      // Toggle the class on the <html> tag
      root.classList.toggle('light-mode');

      // Save preference
      const isLight = root.classList.contains('light-mode');
      localStorage.setItem('flowfit-theme', isLight ? 'light' : 'dark');

      // Update the emoji
      updateIcon();
    });
  } else {
    console.warn("Theme toggle button with id 'themeToggle' not found on this page.");
  }
});
