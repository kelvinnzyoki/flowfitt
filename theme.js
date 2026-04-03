// ====================== PRELOAD THEME (NO FLASH) ======================
(function () {
  const savedTheme = localStorage.getItem('flowfit-theme');
  if (savedTheme === 'light') {
    document.documentElement.classList.add('light-mode');
  }
})();

// ====================== MAIN TOGGLE ======================
function initThemeToggle() {
  const themeToggle = document.getElementById('themeToggle');
  const themeIcon = document.getElementById('themeIcon');

  const root = document.documentElement;

  // Set initial icon
  const isLight = root.classList.contains('light-mode');
  if (themeIcon) {
    themeIcon.textContent = isLight ? '🌙' : '☀️';
  }

  // Toggle handler
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      root.classList.toggle('light-mode');

      const isLightNow = root.classList.contains('light-mode');

      if (themeIcon) {
        themeIcon.textContent = isLightNow ? '🌙' : '☀️';
      }

      localStorage.setItem('flowfit-theme', isLightNow ? 'light' : 'dark');
    });
  }
}

// ====================== INIT ======================
document.addEventListener('DOMContentLoaded', initThemeToggle);
