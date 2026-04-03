// theme-toggle.js - Global Dark/Light Mode for FlowFit

function initThemeToggle() {
  const themeToggle = document.getElementById('themeToggle');
  const themeIcon = document.getElementById('themeIcon');
  const body = document.body;

  // Load saved preference
  const savedTheme = localStorage.getItem('flowfit-theme') || 'dark';

  if (savedTheme === 'light') {
    body.classList.add('light-mode');
    if (themeIcon) themeIcon.textContent = '🌙';
  } else {
    if (themeIcon) themeIcon.textContent = '☀️';
  }

  // Toggle handler
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      body.classList.toggle('light-mode');
      
      const isLight = body.classList.contains('light-mode');
      
      if (isLight) {
        if (themeIcon) themeIcon.textContent = '🌙';
        localStorage.setItem('flowfit-theme', 'light');
      } else {
        if (themeIcon) themeIcon.textContent = '☀️';
        localStorage.setItem('flowfit-theme', 'dark');
      }
    });
  }
}

// Auto-initialize when the script loads
document.addEventListener('DOMContentLoaded', initThemeToggle);
