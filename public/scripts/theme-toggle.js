(function () {
  const KEY = 'sso:theme';
  const order = ['light', 'contrast', 'dark'];
  const labels = { light: 'Lys', contrast: 'Kontrast', dark: 'M\u00F8rk' };
  const symbols = { light: '#ico-sun', contrast: '#ico-contrast', dark: '#ico-moon' };

  // Fallback-ikoner hvis <use> eller sprite mangler
  const inlineIcons = {
    light:
      '<circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"></circle>' +
      '<path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path>',
    contrast:
      '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"></circle>' +
      '<path d="M12 3v18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path>',
    dark:
      '<path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>'
  };

  const root  = document.documentElement;
  const btn   = document.getElementById('theme-toggle');
  const useEl = document.getElementById('theme-toggle-use'); // <use> inni knappen
  const svgEl = document.querySelector('#theme-toggle .icon__svg'); // selve <svg>

  // Manuell override hvis lagret
  const saved = localStorage.getItem(KEY);
  if (saved) root.dataset.theme = saved;

  function inferFromOS() {
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function currentTheme() {
    return root.dataset.theme || inferFromOS();
  }

  function updateIcon(theme) {
    const ref = symbols[theme] || symbols.light;
    const symbolId = ref.slice(1); // f.eks. "ico-sun"
    const symbolExists = !!document.getElementById(symbolId);

    if (useEl && symbolExists) {
      // Bruk sprite -> <use href="#ico-...">
      useEl.setAttribute('href', ref);
      useEl.setAttribute('xlink:href', ref); // fallback for eldre motorer
      // sørg for at <svg> ikke har gammel inline-grafikk hengende igjen
      if (svgEl) svgEl.innerHTML = `<use id="theme-toggle-use" href="${ref}" xlink:href="${ref}"></use>`;
    } else if (svgEl) {
      // Fallback: inline-grafikk direkte i <svg>
      svgEl.innerHTML = inlineIcons[theme] || inlineIcons.light;
    }
  }

  function updateButtonUI(theme) {
    const text = labels[theme] || theme;
    if (btn) {
      btn.setAttribute('aria-label', `Tema: ${text}`);
      btn.title = `Tema: ${text}`;
    }
    updateIcon(theme);
  }

  function nextTheme() {
    const cur = currentTheme();
    const idx = order.indexOf(cur);
    return order[(idx + 1) % order.length];
  }

  function applyTheme(theme) {
    root.dataset.theme = theme;
    localStorage.setItem(KEY, theme);
    updateButtonUI(theme);
  }

  // Init
  updateButtonUI(currentTheme());

  // Klikk â†’ sykle tema
  btn?.addEventListener('click', () => applyTheme(nextTheme()));

  // Hvis OS-tema endres og bruker IKKE har valgt manuelt, oppdater ikon/label
  const mq = matchMedia('(prefers-color-scheme: dark)');
  if (mq.addEventListener) {
    mq.addEventListener('change', () => {
      if (!localStorage.getItem(KEY)) updateButtonUI(inferFromOS());
    });
  } else if (mq.addListener) {
    // Eldre motorer
    mq.addListener(() => {
      if (!localStorage.getItem(KEY)) updateButtonUI(inferFromOS());
    });
  }
})();





