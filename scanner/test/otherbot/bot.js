// A stand-in for "another bot" the operator may run: its own panel on the page + programmatic clicks and typing.
(() => {
  const host = document.createElement('other-bot-panel');
  host.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:2147483647';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<div class="ob"><img src="${chrome.runtime.getURL('dot.png')}"> <b>OtherBot</b> <button>Start</button></div>`;
  document.documentElement.append(host);
  let n = 0;
  setInterval(() => {
    const speed = Number(localStorage.getItem('otherbot') || 0);
    if (!speed) return;
    n++;
    const pick = (s) => { const l = document.querySelectorAll(s); return l[n % Math.max(1, l.length)]; };
    if (location.pathname.endsWith('desk.html')) {
      const steps = [() => pick('.task')?.click(), () => pick('.chat-item')?.click(),
        () => { const t = document.querySelector('.tr-dst') || document.querySelector('textarea'); if (t) { t.value = 'Hi Robert, bot text 777888'; t.dispatchEvent(new Event('input', { bubbles: true })); } },
        () => document.querySelector('.btn-send')?.click()];
      steps[n % steps.length]();
    }
  }, 300);
})();
