// The saved theme before the page paints (a file, not an inline script: the panel's CSP allows only its own scripts).
try { const t = localStorage.getItem('agc_theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch (e) { /* private mode */ }
