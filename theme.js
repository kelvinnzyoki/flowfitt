// PRELOAD (prevents flash)
(function () {
  const savedTheme = localStorage.getItem('flowfit-theme');
  if (savedTheme === 'light') {
    document.documentElement.classList.add('light-mode');
  }
})();

function initThemeToggle() {
  const btn = document.getElementById('themeToggle');
  const icon = document.getElementById('themeIcon');
  const root = document.documentElement;

  function updateIcon() {
    if (!icon) return;
    icon.textContent = root.classList.contains('light-mode') ? '🌙' : '☀️';
  }

  updateIcon();

  if (btn) {
    btn.addEventListener('click', () => {
      root.classList.toggle('light-mode');

      const isLight = root.classList.contains('light-mode');
      localStorage.setItem('flowfit-theme', isLight ? 'light' : 'dark');

      updateIcon();
    });
  }
}

document.addEventListener('DOMContentLoaded', initThemeToggle);
