(() => {
  const VERSION = '2026-08-22-v1';
  const LOCALE = 'cs-CZ';
  const TEXT_HASH = '7a8317129ba7b3934d67672661b2cca636422208dcbe875da9667e00c9ee3642';
  const DIGITAL_VERSION = '2026-08-22-draft-v1';
  const DIGITAL_TEXT_HASH = 'b5e8c4ade8f253852bf54eed31985a8bde98c9b9db23ff282c5ede77fb783e8b';
  const PHOTO_ACCEPT = '.jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp';
  const template = document.getElementById('fma-photo-authorization-template');
  if (!template) return;

  const property = (form, name) => form.querySelector(`[name="properties[${name}]" ]`);
  const setProperty = (form, name, value, enabled) => {
    const input = property(form, name);
    if (!input) return;
    input.value = enabled ? value : '';
    input.disabled = !enabled;
  };
  const isPdf = (form) => [...form.querySelectorAll('input:checked,select')]
    .some((input) => /PDF/i.test(`${input.value ?? ''} ${input.selectedOptions?.[0]?.textContent ?? ''}`));

  function install(form) {
    if (form.fmaAuthorizationSync) return form.fmaAuthorizationSync();
    if (!form.querySelector('input[type="file"]')) return;
    form.dataset.fmaAuthorizationInstalled = 'true';
    const fragment = template.content ? template.content.cloneNode(true) : null;
    const host = fragment ?? document.createElement('div');
    if (!fragment) host.innerHTML = template.innerHTML;
    const authorization = host.querySelector('[data-fma-photo-authorization]');
    const firstUpload = form.querySelector('input[type="file"]');
    const uploadGroup = firstUpload.closest('.tpo_option-set-container,.tpo_option-container,.tpo_option-wrapper') ?? firstUpload;
    uploadGroup.before(authorization);
    const digital = host.querySelector('[data-fma-digital-performance]');
    authorization.before(digital);

    const checkbox = authorization.querySelector('[data-fma-photo-authorization-checkbox]');
    const digitalCheckbox = digital.querySelector('[data-fma-digital-performance-checkbox]');
    const error = authorization.querySelector('[role="alert"]');
    let acceptedAt = null;
    let digitalAcceptedAt = null;

    const sync = () => {
      const accepted = checkbox.checked;
      const pdf = isPdf(form);
      if (accepted && !acceptedAt) acceptedAt = new Date().toISOString();
      if (!accepted) acceptedAt = null;
      if (pdf && digitalCheckbox.checked && !digitalAcceptedAt) digitalAcceptedAt = new Date().toISOString();
      if (!pdf || !digitalCheckbox.checked) digitalAcceptedAt = null;
      digital.hidden = !pdf;
      digitalCheckbox.required = pdf;
      if (!pdf) digitalCheckbox.checked = false;
      form.querySelectorAll('input[type="file"]').forEach((input) => {
        input.disabled = !accepted;
        input.accept = PHOTO_ACCEPT;
      });
      const blocked = !accepted || (pdf && !digitalCheckbox.checked);
      form.querySelectorAll('[type="submit"][name="add"],button[type="submit"],.shopify-payment-button button').forEach((button) => {
        button.setAttribute('aria-disabled', String(blocked));
      });
      setProperty(form, '_Photo authorization accepted', 'true', accepted);
      setProperty(form, '_Photo authorization version', VERSION, accepted);
      setProperty(form, '_Photo authorization accepted at', acceptedAt, accepted);
      setProperty(form, '_Photo authorization locale', LOCALE, accepted);
      setProperty(form, '_Photo authorization text hash', TEXT_HASH, accepted);
      setProperty(form, '_Digital immediate performance accepted', 'true', pdf && digitalCheckbox.checked);
      setProperty(form, '_Digital immediate performance accepted at', digitalAcceptedAt, pdf && digitalCheckbox.checked);
      setProperty(form, '_Digital immediate performance version', DIGITAL_VERSION, pdf && digitalCheckbox.checked);
      setProperty(form, '_Digital immediate performance locale', LOCALE, pdf && digitalCheckbox.checked);
      setProperty(form, '_Digital immediate performance text hash', DIGITAL_TEXT_HASH, pdf && digitalCheckbox.checked);
      if (accepted) error.hidden = true;
    };

    checkbox.addEventListener('change', sync);
    digitalCheckbox.addEventListener('change', sync);
    form.addEventListener('change', (event) => { if (event.target.matches('input[type="radio"],select')) sync(); });
    form.addEventListener('change', (event) => {
      if (!event.target.matches('input[type="file"]')) return;
      const unsupported = [...event.target.files].find((file) => !/\.(jpe?g|png|webp)$/i.test(file.name));
      if (!unsupported) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      event.target.value = '';
      error.textContent = 'Tento formát fotografie zatím neumíme bezpečně zpracovat. Použijte prosím JPG, PNG nebo WebP.';
      error.hidden = false;
      event.target.focus();
    }, true);
    form.addEventListener('submit', (event) => {
      if (checkbox.checked && (!isPdf(form) || digitalCheckbox.checked)) return;
      event.preventDefault();
      error.textContent = checkbox.checked ? 'Před přidáním PDF do košíku potvrďte prosím okamžité digitální plnění.' : 'Než nahrajete fotografie nebo přidáte výrobek do košíku, potvrďte prosím oprávnění k fotografiím.';
      error.hidden = false;
      (checkbox.checked ? digitalCheckbox : checkbox).focus();
    }, true);
    form.addEventListener('click', (event) => {
      if (!event.target.closest('[type="submit"],.shopify-payment-button button')) return;
      if (checkbox.checked && (!isPdf(form) || digitalCheckbox.checked)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      error.textContent = checkbox.checked ? 'Před přidáním PDF do košíku potvrďte prosím okamžité digitální plnění.' : 'Než nahrajete fotografie nebo přidáte výrobek do košíku, potvrďte prosím oprávnění k fotografiím.';
      error.hidden = false;
      (checkbox.checked ? digitalCheckbox : checkbox).focus();
    }, true);
    form.fmaAuthorizationSync = sync;
    sync();
  }

  const installAll = () => document.querySelectorAll('form[action*="/cart/add"]').forEach(install);
  installAll();
  new MutationObserver(installAll).observe(document.documentElement, { childList: true, subtree: true });
})();
