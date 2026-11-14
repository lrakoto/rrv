(() => {
  const root = document.documentElement;
  const languagePicker = document.querySelector('#language');
  const storageKey = 'rrv-language';
  const languages = ['fr', 'mg', 'en'];
  const content = window.RRV_CONTENT || {};
  const interfaceText = {
    fr: {
      menu: 'Ouvrir le menu',
      closeMenu: 'Fermer le menu',
      summaryLabel: 'Résumé du projet',
      copied: 'Résumé copié.',
      manualCopy: 'Sélectionnez puis copiez le résumé.',
      share: 'Ouvrir dans mon application de messagerie',
    },
    mg: {
      share: 'Sokafy amin’ny fampiasa fandefasana mailaka',
      pageTitle: 'RRV | Fanorenana sy asa vaventy eto Madagasikara',
    },
    en: {
      share: 'Open in my email app',
      pageTitle: 'RRV | Construction and civil works in Madagascar',
    },
  };

  const localizedFields = [];
  const frenchText = {};
  for (const [dataAttribute, attribute] of [
    ['data-i18n', null],
    ['data-i18n-placeholder', 'placeholder'],
    ['data-i18n-alt', 'alt'],
    ['data-i18n-label', 'aria-label'],
  ]) {
    for (const element of document.querySelectorAll(`[${dataAttribute}]`)) {
      const key = element.getAttribute(dataAttribute);
      const original = attribute ? element.getAttribute(attribute) : element.textContent;
      localizedFields.push({ element, dataAttribute, attribute, original });
      frenchText[key] ??= original;
    }
  }

  const pageTitle = document.title;
  const description = document.querySelector('meta[name="description"]');
  const frenchDescription = description?.content;
  const header = document.querySelector('.site-header');
  const menuButton = document.querySelector('#menu-toggle');
  const siteNav = document.querySelector('#site-nav');
  const mobileLayout = window.matchMedia('(max-width: 760px)');
  const form = document.querySelector('#project-form');
  const projectType = document.querySelector('#project-type');
  const projectLocation = document.querySelector('#project-location');
  const projectDetails = document.querySelector('#project-details');
  const summaryPanel = document.querySelector('#summary-panel');
  const summary = document.querySelector('#project-summary');
  const shareLink = document.querySelector('#share-project');
  const copyButton = document.querySelector('#copy-summary');
  const copyStatus = document.querySelector('#copy-status');
  const contactAddress = window.RRV_CONFIG?.email;
  const configuredEmail = typeof contactAddress === 'string' ? contactAddress.trim() : '';
  const email = /^[\w.!'+-]+@[\w-]+(?:\.[\w-]+)+$/.test(configuredEmail)
    ? encodeURIComponent(configuredEmail).replace('%40', '@')
    : null;

  let locale = 'fr';
  let draft;
  let menuOpen = false;

  function getText(key, original = frenchText[key]) {
    return content[locale]?.[key] ?? interfaceText[locale][key] ?? original ?? interfaceText.fr[key] ?? '';
  }

  function setMenu(open) {
    if (!header || !menuButton) return;
    const label = open ? 'closeMenu' : 'menu';
    menuOpen = open;
    header.classList.toggle('is-open', open);
    menuButton.setAttribute('aria-expanded', String(open));
    menuButton.setAttribute('data-i18n-label', label);
    menuButton.setAttribute('aria-label', getText(label));
  }

  function showSummary() {
    if (!draft) return;
    const typeLabel = Array.from(projectType.options).find(option => option.value === draft.type)?.textContent;
    const subject = `${getText('summaryLabel')} — RRV`;
    summary.value = [
      subject,
      '',
      `${getText('typeLabel')}: ${typeLabel ?? ''}`,
      `${getText('locationLabel')}: ${draft.location}`,
      '',
      `${getText('detailsLabel')}:`,
      draft.details,
    ].join('\n');
    summaryPanel.hidden = false;
    if (copyStatus) copyStatus.textContent = '';

    if (shareLink && email) {
      const query = new URLSearchParams({ subject, body: summary.value.replace(/\n/g, '\r\n') });
      shareLink.href = `mailto:${email}?${query.toString().replace(/\+/g, '%20')}`;
      shareLink.hidden = false;
    }
  }

  function applyLanguage(language) {
    locale = language;
    root.lang = locale;
    if (languagePicker) languagePicker.value = locale;
    for (const { element, dataAttribute, attribute, original } of localizedFields) {
      const key = element.getAttribute(dataAttribute);
      const translation = getText(key, original);
      if (attribute) element.setAttribute(attribute, translation);
      else element.textContent = translation;
    }
    setMenu(menuOpen);
    document.title = interfaceText[locale].pageTitle ?? pageTitle;
    if (description) description.content = content[locale]?.heroBody ?? frenchDescription;
    showSummary();
  }

  let savedLanguage;
  try {
    savedLanguage = window.localStorage.getItem(storageKey);
  } catch {
    // The picker can still change the page if the browser has disabled storage.
  }
  const requestedLanguage = new URLSearchParams(window.location.search).get('lang');
  applyLanguage([requestedLanguage, savedLanguage].find(language => languages.includes(language)) ?? 'fr');

  languagePicker?.addEventListener('change', () => {
    const language = languagePicker.value;
    if (!languages.includes(language)) return;
    applyLanguage(language);
    try {
      window.localStorage.setItem(storageKey, language);
    } catch {
      // The language remains available for this page visit.
    }
    try {
      const url = new URL(window.location.href);
      if (language === 'fr') url.searchParams.delete('lang');
      else url.searchParams.set('lang', language);
      window.history.replaceState(window.history.state, '', url);
    } catch {
      // A browser may block URL changes when opening a local file directly.
    }
  });

  if (header && menuButton && siteNav) {
    menuButton.addEventListener('click', () => {
      setMenu(!menuOpen);
    });
    siteNav.addEventListener('click', event => {
      if (event.target.closest('a[href^="#"]')) setMenu(false);
    });
    document.addEventListener('pointerdown', event => {
      if (menuOpen && !header.contains(event.target)) setMenu(false);
    });
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !menuOpen) return;
      setMenu(false);
      menuButton.focus();
    });
    mobileLayout.addEventListener('change', () => setMenu(false));
  }

  if (email) {
    for (const link of document.querySelectorAll('a[data-contact]')) {
      link.href = `mailto:${email}`;
      if (!link.textContent.trim()) link.textContent = configuredEmail;
      link.hidden = false;
    }
  }

  if (form && projectType && projectLocation && projectDetails && summaryPanel && summary) {
    for (const link of document.querySelectorAll('[data-project-type]')) {
      link.addEventListener('click', () => {
        projectType.value = link.dataset.projectType;
      });
    }

    form.addEventListener('submit', event => {
      event.preventDefault();
      projectLocation.value = projectLocation.value.trim();
      projectDetails.value = projectDetails.value.trim();
      if (!form.reportValidity()) return;
      draft = { type: projectType.value, location: projectLocation.value, details: projectDetails.value };
      showSummary();
      summary.focus();
    });

    copyButton?.addEventListener('click', async () => {
      const text = summary.value;
      try {
        await navigator.clipboard.writeText(text);
        if (copyStatus && summary.value === text) copyStatus.textContent = getText('copied');
      } catch {
        if (summary.value !== text) return;
        summary.focus();
        summary.select();
        if (copyStatus) copyStatus.textContent = getText('manualCopy');
      }
    });

    form.hidden = false;
    const noScriptMessage = document.querySelector('#form-nojs');
    if (noScriptMessage) noScriptMessage.hidden = true;
  }

  root.classList.add('js');
})();
