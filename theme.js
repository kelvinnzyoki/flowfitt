// FLOWFIT — Theme System
// PRELOAD: prevent flash of wrong theme before JS runs
// Syncs BOTH html.light-mode class (for .light-mode CSS rules)
// AND data-theme attribute (for [data-theme="light"] CSS rules)
(function () {
    const saved = localStorage.getItem('flowfit-theme');
    if (saved === 'light') {
        document.documentElement.classList.add('light-mode');
        document.documentElement.dataset.theme = 'light';
    } else {
        // Ensure dark theme is explicitly set (prevents any ambiguity)
        document.documentElement.dataset.theme = 'dark';
    }
})();

document.addEventListener('DOMContentLoaded', () => {
    const btn  = document.getElementById('themeToggle');
    const icon = document.getElementById('themeIcon');  // emoji icon (landing pages)
    const root = document.documentElement;

    function updateIcon() {
        // Emoji icon toggle (landing pages with id="themeIcon")
        if (icon) {
            // In light mode show Moon (to go dark). In dark mode show Sun (to go light).
            icon.textContent = root.classList.contains('light-mode') ? '\u{1F319}' : '\u2600\uFE0F';
        }
        // SVG icon toggle (dashboard pages with .icon-moon / .icon-sun)
        // Handled purely by CSS: html.light-mode .icon-moon { display:none }
        // html.light-mode .icon-sun { display:block } — no JS needed here
    }

    updateIcon();

    if (btn) {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const isLight = root.classList.toggle('light-mode');
            // Sync data-theme attribute for [data-theme] CSS selectors
            root.dataset.theme = isLight ? 'light' : 'dark';
            localStorage.setItem('flowfit-theme', isLight ? 'light' : 'dark');
            updateIcon();
        });
    }
});
