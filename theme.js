// FLOWFIT — Theme System
// PRELOAD: prevent flash of wrong theme before JS runs
(function () {
    const saved = localStorage.getItem('flowfit-theme');
    if (saved === 'light') document.documentElement.classList.add('light-mode');
})();

document.addEventListener('DOMContentLoaded', () => {
    const btn  = document.getElementById('themeToggle');
    const icon = document.getElementById('themeIcon');
    const root = document.documentElement;

    function updateIcon() {
        if (!icon) return;
        // In light mode show Moon (click to go dark). In dark mode show Sun (click to go light).
        icon.textContent = root.classList.contains('light-mode') ? '🌙' : '☀️';
    }

    updateIcon();

    if (btn) {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            root.classList.toggle('light-mode');
            const isLight = root.classList.contains('light-mode');
            localStorage.setItem('flowfit-theme', isLight ? 'light' : 'dark');
            updateIcon();
        });
    }
});
