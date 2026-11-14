(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const accessForm = $('#access-form');
  const accessTitle = $('#access-title');
  const accessDescription = $('#access-description');
  const accessError = $('#access-error');
  const editor = $('#editor');
  const dialogContent = $('#dialog-content');
  const clientSearch = $('#client-search');
  const sectionContent = $('#section-content');
  const sectionNav = $('#section-nav');
  const workspaceTitle = $('#workspace-title');
  const workspaceMessage = $('#workspace-message');
  const headingActions = $('#heading-actions');

  const projectStatuses = {
    planning: 'En préparation',
    active: 'En cours',
    on_hold: 'En pause',
    complete: 'Terminé',
  };
  const documentStatuses = {
    contract: { draft: 'Brouillon', pending: 'En attente', approved: 'Signé', expired: 'Expiré' },
    permit: { draft: 'En préparation', pending: 'Déposé', approved: 'Délivré', expired: 'Expiré' },
  };
  const accessStatuses = {
    none: 'Non invité',
    invited: 'Invitation en attente',
    active: 'Accès actif',
    revoked: 'Accès révoqué',
  };
  const statusColors = { active: 'active', pending: 'active', complete: 'positive', approved: 'positive', on_hold: 'warning', expired: 'warning', invited: 'warning' };
  const documentLabels = {
    contract: { list: 'Contrats', single: 'contrat', empty: 'Aucun contrat' },
    permit: { list: 'Permis', single: 'permis', empty: 'Aucun permis' },
  };

  const state = { user: null, csrf: '', clients: [], project: null, selectedId: null, tab: 'overview', invitations: new Map() };
  let sessionRevision = 0;
  let loadingProject = 0;
  let announcementTimer;
  let activationToken = readActivationToken();

  function readActivationToken() {
    const token = new URLSearchParams(location.hash.slice(1)).get('activate');
    if (token !== null) {
      const address = new URL(location.href);
      address.hash = '';
      history.replaceState(history.state, '', address);
    }
    return token;
  }

  function isRetired(error) {
    return error.name === 'AbortError';
  }

  const dates = new Intl.DateTimeFormat('fr-MG', { dateStyle: 'medium', timeZone: 'UTC' });
  const clock = new Intl.DateTimeFormat('fr-MG', { dateStyle: 'medium', timeStyle: 'short' });

  function formattedDate(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? '' : dates.format(date);
  }

  function expiryText(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? '' : `Expiration : ${clock.format(date)}`;
  }

  function node(tag, attributes = {}, ...children) {
    const element = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
      if (value === null || value === undefined || value === false) continue;
      element.setAttribute(name, value === true ? '' : String(value));
    }
    element.append(...children.flat().filter((child) => child !== null && child !== undefined));
    return element;
  }

  function button(label, action, attributes = {}) {
    return node('button', { type: 'button', class: 'button secondary', 'data-action': action, ...attributes }, label);
  }

  function badge(label, status) {
    return node('span', { class: ['badge', statusColors[status]].filter(Boolean).join(' ') }, label);
  }

  function setMessage(element, text = '', error = false) {
    element.textContent = text;
    element.hidden = !text;
    element.classList.toggle('danger', error);
  }

  function announce(text) {
    const element = $('#global-message');
    setMessage(element, text);
    clearTimeout(announcementTimer);
    announcementTimer = setTimeout(() => setMessage(element), 4500);
  }

  function initials(value) {
    return value.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((part) => [...part][0]).join('');
  }

  function owner() {
    return state.user?.role === 'owner';
  }

  function currentClient() {
    return state.project?.client ?? null;
  }

  function requestUrl(action, id) {
    const address = new URL('./api.php', location.href);
    address.searchParams.set('action', action);
    if (id !== undefined && id !== null) address.searchParams.set('id', String(id));
    return address;
  }

  async function request(action, { data, id } = {}) {
    const openedIn = sessionRevision;
    const headers = { Accept: 'application/json' };
    const options = { headers, credentials: 'same-origin', cache: 'no-store' };
    if (data !== undefined) {
      options.method = 'POST';
      headers['X-CSRF-Token'] = state.csrf;
      if (data instanceof FormData) {
        options.body = data;
      } else {
        headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(data);
      }
    }
    let response;
    try {
      response = await fetch(requestUrl(action, id), options);
    } catch {
      if (openedIn !== sessionRevision) throw new DOMException('', 'AbortError');
      throw new Error('Connexion au serveur impossible. Vérifiez votre accès à Internet et réessayez.');
    }
    const result = await response.json().catch(() => null);
    if (openedIn !== sessionRevision) throw new DOMException('', 'AbortError');
    if (!response.ok || !result || result.error) {
      if (response.status === 401 && state.user && action !== 'login' && action !== 'activate') {
        setSession({ user: null });
        showAccess();
        setMessage(accessError, 'Votre session a expiré. Reconnectez-vous pour continuer.', true);
        throw new DOMException('', 'AbortError');
      }
      const defaults = {
        403: 'Cette action n’est pas disponible avec votre accès.',
        413: 'Le fichier dépasse la taille autorisée.',
        429: 'Trop de tentatives. Attendez quelques minutes avant de réessayer.',
      };
      throw new Error(result?.error || defaults[response.status] || 'L’opération n’a pas abouti. Réessayez dans un instant.');
    }
    return result;
  }

  function setSession(session) {
    sessionRevision += 1;
    state.user = session.user;
    state.csrf = session.csrf || '';
    loadingProject += 1;
    state.clients = [];
    state.project = null;
    state.selectedId = null;
    state.tab = 'overview';
    state.invitations.clear();
    sectionContent.replaceChildren();
    $('#client-list').replaceChildren();
    headingActions.replaceChildren();
    clientSearch.value = '';
    workspaceTitle.textContent = 'Espace projets';
    $('#workspace-context').textContent = '';
    $('#workspace-subtitle').textContent = '';
    setMessage(workspaceMessage);
    setMessage($('#global-message'));
    if (editor.open) editor.close();
    dialogContent.replaceChildren();
  }

  function updateHeader() {
    const user = state.user;
    $('#header-account').hidden = !user;
    $('#site-link').hidden = Boolean(user);
    $('#account-icon').textContent = user ? initials(user.email) : '';
    $('#account-name').textContent = user?.email || '';
    $('#account-role').textContent = user ? (owner() ? 'Administration' : 'Client') : '';
  }

  function showAccess() {
    const activating = activationToken !== null;
    $('#header-account').hidden = true;
    $('#site-link').hidden = false;
    $('#startup').hidden = true;
    $('#workspace').hidden = true;
    $('#sign-in').hidden = false;
    setMessage(accessError);
    accessForm.reset();
    accessForm.elements.email.closest('label').hidden = activating;
    accessForm.elements.email.required = !activating;
    accessForm.elements.password.autocomplete = activating ? 'new-password' : 'current-password';
    const password = accessForm.elements.password;
    password.minLength = activating ? 12 : 0;
    if (activating) password.setAttribute('aria-describedby', 'access-hint');
    else password.removeAttribute('aria-describedby');
    $('#password-label').textContent = activating ? 'Nouveau mot de passe' : 'Mot de passe';
    accessTitle.textContent = activating ? 'Activez votre accès.' : 'Connectez-vous.';
    accessDescription.textContent = activating
      ? 'Choisissez votre mot de passe pour accéder à votre espace RRV.'
      : 'Suivez votre chantier et retrouvez les documents partagés par RRV.';
    $('#access-submit').replaceChildren(
      activating ? 'Activer mon accès' : 'Se connecter',
      node('span', { 'aria-hidden': 'true' }, '↗'),
    );
    $('#access-hint').hidden = !activating;
    $('#invite-note').hidden = activating;
    $('#back-to-login').hidden = !activating;
    if (activating && !/^[a-f0-9]{64}$/.test(activationToken)) {
      setMessage(accessError, 'Ce lien d’activation est invalide ou incomplet.', true);
    }
  }

  async function start() {
    $('#startup').hidden = false;
    try {
      setSession(await request('session'));
      if (activationToken !== null || !state.user) {
        showAccess();
        return;
      }
      await showWorkspace();
    } catch (error) {
      if (isRetired(error)) return;
      $('#startup').classList.add('danger');
      $('#startup').replaceChildren(
        node('p', {}, error.message),
        button('Réessayer', 'reload'),
      );
    }
  }

  async function showWorkspace() {
    updateHeader();
    $('#startup').hidden = true;
    $('#sign-in').hidden = true;
    $('#workspace').hidden = false;
    $('#workspace').classList.toggle('client-view', !owner());
    $('#client-sidebar').hidden = !owner();
    $('#access-tab').hidden = !owner();
    try {
      if (owner()) {
        await refreshClients();
        if (state.clients.length) {
          await selectClient(state.selectedId ?? state.clients[0].id);
        } else {
          renderWorkspace();
        }
      } else {
        await selectClient(state.user.client_id);
      }
    } catch (error) {
      if (state.user && !isRetired(error)) showWorkspaceError(error);
    }
  }

  function showWorkspaceError(error) {
    renderWorkspace();
    setMessage(workspaceMessage, error.message, true);
    if (!state.project) sectionContent.replaceChildren(button('Réessayer', 'retry-workspace'));
  }

  async function refreshClients() {
    state.clients = (await request('clients')).clients;
    renderClients();
  }

  function searchKey(value) {
    return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  }

  function renderClients() {
    if (!owner()) return;
    const query = searchKey(clientSearch.value.trim());
    const matching = state.clients.filter((client) => searchKey(`${client.name} ${client.email} ${client.project}`).includes(query));
    const list = $('#client-list');
    list.replaceChildren();
    if (!matching.length) {
      list.append(node('p', {}, state.clients.length ? 'Aucun résultat.' : 'Aucun client pour le moment.'));
      return;
    }
    for (const client of matching) {
      const choice = node('button', {
        type: 'button',
        class: 'client-choice',
        'data-action': 'select-client',
        'data-id': client.id,
        'aria-current': Number(client.id) === state.selectedId ? 'true' : null,
      }, node('span', { class: 'client-avatar', 'aria-hidden': 'true' }, initials(client.name)),
      node('span', { class: 'client-choice-label' }, node('strong', {}, client.name), node('small', {}, client.project || client.email)));
      list.append(choice);
    }
  }

  async function selectClient(id, { preserveTab = false, focus = false } = {}) {
    const requestId = ++loadingProject;
    state.selectedId = Number(id);
    if (!preserveTab) {
      state.project = null;
      state.tab = 'overview';
      setMessage(workspaceMessage);
      renderClients();
      headingActions.replaceChildren();
      sectionNav.hidden = true;
      workspaceTitle.textContent = 'Dossier client';
      $('#workspace-context').textContent = owner() ? 'Administration' : 'Espace client';
      $('#workspace-subtitle').textContent = '';
      sectionContent.replaceChildren(node('p', { class: 'empty-line', role: 'status' }, 'Chargement du dossier…'));
    }
    try {
      const project = await request('project', { id });
      if (requestId !== loadingProject) return;
      state.project = project;
      renderWorkspace();
      if (focus) {
        workspaceTitle.focus({ preventScroll: true });
        workspaceTitle.scrollIntoView({ block: 'nearest' });
      }
    } catch (error) {
      if (requestId === loadingProject && state.user && !isRetired(error)) showWorkspaceError(error);
    }
  }

  async function afterSaving(message, beforeReload = null) {
    const savedId = state.selectedId;
    const savedIn = sessionRevision;
    try {
      if (owner()) await refreshClients();
      if (beforeReload) await beforeReload();
      else if (savedId !== null && savedId === state.selectedId) await selectClient(savedId, { preserveTab: true });
    } catch (error) {
      if (state.user && !isRetired(error)) setMessage(workspaceMessage, error.message, true);
    }
    if (savedIn === sessionRevision) announce(message);
  }

  function renderWorkspace() {
    const client = currentClient();
    setMessage(workspaceMessage);
    $('#workspace-context').textContent = owner() ? 'Administration' : 'Espace client';
    workspaceTitle.textContent = client ? (client.project || client.name) : 'Tableau de bord';
    $('#workspace-subtitle').textContent = client
      ? [client.project ? client.name : '', client.location].filter(Boolean).join(' · ')
      : '';
    headingActions.replaceChildren();
    sectionNav.hidden = !client;
    if (!client) {
      sectionContent.replaceChildren(empty(
        owner() ? 'Ajoutez votre premier client' : 'Votre dossier n’est pas disponible',
        owner() ? 'Créez un dossier pour suivre son chantier, ses tâches et ses documents.' : 'Contactez RRV pour vérifier votre accès.',
        owner() ? button('Ajouter un client', 'new-client', { class: 'button primary' }) : null,
      ));
      return;
    }
    if (owner()) headingActions.append(button('Modifier le dossier', 'edit-client'));

    for (const item of sectionNav.querySelectorAll('button[data-tab]')) {
      if (item.dataset.tab === state.tab) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    }

    if (state.tab === 'overview') sectionContent.replaceChildren(renderOverview(client));
    if (state.tab === 'tasks') sectionContent.replaceChildren(renderTasks(state.project.tasks));
    if (state.tab === 'contract' || state.tab === 'permit') {
      sectionContent.replaceChildren(renderDocuments(state.tab, state.project.documents));
    }
    if (state.tab === 'access' && owner()) sectionContent.replaceChildren(renderAccess(client));
  }

  function empty(title, description, action) {
    return node('div', { class: 'empty' }, node('h2', {}, title), node('p', {}, description), action);
  }

  function panel(title, description, action, ...content) {
    return node('section', { class: 'panel' },
      node('header', { class: 'panel-head' },
        node('div', {}, node('h2', {}, title), description ? node('p', {}, description) : null),
        action,
      ),
      ...content,
    );
  }

  function metric(title, value, extra) {
    return node('article', { class: 'stat-card' }, node('h2', {}, title), node('strong', {}, value), extra);
  }

  function details(pairs) {
    return node('dl', { class: 'detail-grid' }, pairs.map(([label, description]) => node('div', {},
      node('dt', {}, label),
      node('dd', {}, description || '—'),
    )));
  }

  function renderOverview(client) {
    const progress = Number(client.progress) || 0;
    const tasks = state.project.tasks;
    const completed = tasks.filter((task) => task.done).length;
    const notes = client.notes || 'Aucune note d’avancement pour le moment.';
    const wrapper = node('div', {},
      node('div', { class: 'stats' },
        metric('Avancement', `${progress} %`, node('progress', { max: 100, value: progress, 'aria-label': 'Avancement du chantier' })),
        metric('État du chantier', projectStatuses[client.status] || 'En préparation'),
        metric(owner() ? 'Tâches terminées' : 'Tâches partagées terminées', `${completed} / ${tasks.length}`),
      ),
      panel('Dernier point d’avancement', owner() ? 'Cette note est visible dans l’espace client.' : null,
        owner() ? button('Mettre à jour', 'edit-progress') : null,
        node('p', { class: 'note' }, notes),
      ),
    );
    if (owner()) {
      wrapper.append(panel('Coordonnées et accès', null, button('Gérer l’accès', 'show-access'),
        details([
          ['Client', client.name],
          ['Adresse e-mail', client.email],
          ['Lieu du chantier', client.location],
          ['Accès client', badge(accessStatuses[client.access] || accessStatuses.none, client.access)],
        ]),
      ));
    }
    return wrapper;
  }

  function taskRow(task) {
    const due = formattedDate(task.due_date);
    const toggleTitle = task.done ? 'Rouvrir la tâche' : 'Marquer comme terminée';
    return node('li', { class: 'data-row' },
      node('div', { class: 'row-main' },
        node('h3', {}, task.title),
        node('div', { class: 'row-meta' },
          badge(task.done ? 'Terminée' : 'À faire', task.done ? 'complete' : ''),
          due ? node('span', {}, `Échéance : ${due}`) : null,
          owner() ? node('span', {}, task.shared ? 'Partagée avec le client' : 'Interne') : null,
        ),
      ),
      owner() ? node('div', { class: 'row-actions' },
        button(toggleTitle, 'toggle-task', { 'data-id': task.id }),
        button('Modifier', 'edit-task', { 'data-id': task.id, 'aria-label': `Modifier : ${task.title}` }),
        button('Supprimer', 'delete-task', { class: 'button remove', 'data-id': task.id, 'aria-label': `Supprimer : ${task.title}` }),
      ) : null,
    );
  }

  function renderTasks(tasks) {
    return panel(owner() ? 'Tâches du chantier' : 'Tâches partagées', null,
      owner() ? button('Ajouter une tâche', 'new-task', { class: 'button primary' }) : null,
      tasks.length ? node('ul', { class: 'data-list' }, tasks.map(taskRow)) : node('p', { class: 'empty-line' },
        owner() ? 'Aucune tâche pour ce dossier.' : 'Aucune tâche n’a été partagée.',
      ),
    );
  }

  function documentRow(documentRecord) {
    const due = formattedDate(documentRecord.due_date);
    const status = documentStatuses[documentRecord.kind]?.[documentRecord.status] || 'En préparation';
    const download = documentRecord.has_file
      ? node('a', {
        class: 'button secondary', href: requestUrl('download', documentRecord.id).href,
        'aria-label': `Télécharger le PDF : ${documentRecord.title}`,
      }, 'Télécharger le PDF')
      : null;
    return node('li', { class: 'data-row' },
      node('div', { class: 'row-main' }, node('h3', {}, documentRecord.title), node('div', { class: 'row-meta' },
        badge(status, documentRecord.status),
        documentRecord.reference ? node('span', {}, `Réf. ${documentRecord.reference}`) : null,
        due ? node('span', {}, `Échéance : ${due}`) : null,
        owner() ? node('span', {}, documentRecord.shared ? 'Partagé avec le client' : 'Interne') : null,
      )),
      node('div', { class: 'row-actions' }, download,
        owner() ? button('Modifier', 'edit-document', { 'data-id': documentRecord.id, 'aria-label': `Modifier : ${documentRecord.title}` }) : null,
        owner() ? button('Supprimer', 'delete-document', { class: 'button remove', 'data-id': documentRecord.id, 'aria-label': `Supprimer : ${documentRecord.title}` }) : null,
      ),
    );
  }

  function renderDocuments(kind, records) {
    const labels = documentLabels[kind];
    const visible = records.filter((record) => record.kind === kind);
    return panel(labels.list, null,
      owner() ? button(`Ajouter un ${labels.single}`, 'new-document', { class: 'button primary', 'data-kind': kind }) : null,
      visible.length ? node('ul', { class: 'data-list' }, visible.map(documentRow)) : node('p', { class: 'empty-line' },
        owner() ? `${labels.empty} pour ce dossier.` : `${labels.empty} n’a été partagé.`,
      ),
    );
  }

  function renderAccess(client) {
    const status = client.access || 'none';
    const inviteLabel = status === 'invited' ? 'Générer un nouveau lien' : status === 'active' ? 'Réinitialiser l’accès' : 'Créer une invitation';
    const actions = node('div', { class: 'panel-actions' }, button(inviteLabel, 'invite', { class: 'button primary' }));
    if (status === 'invited' || status === 'active') actions.append(button('Révoquer l’accès', 'revoke', { class: 'button remove' }));
    const issued = state.invitations.get(Number(client.id));
    const invitation = status === 'invited' && new Date(issued?.expiresAt).valueOf() > Date.now() ? issued : null;
    const invitationPanel = invitation ? node('div', { class: 'access-block' },
      node('label', {}, 'Lien d’activation à transmettre au client',
        node('input', { type: 'text', id: 'invite-link', value: invitation.url, readonly: true, spellcheck: 'false', autocomplete: 'off' }),
      ),
      node('p', { class: 'field-help' }, [expiryText(invitation.expiresAt), 'Ce lien fonctionne une seule fois.'].filter(Boolean).join(' · ')),
      node('div', { class: 'panel-actions' }, button('Copier le lien', 'copy-invite')),
    ) : null;
    return panel('Accès au dossier', 'Une invitation personnelle permet à ce client de choisir son mot de passe.',
      badge(accessStatuses[status] || accessStatuses.none, status),
      details([['Adresse de connexion', client.email]]), actions, invitationPanel,
    );
  }

  function field(label, control, hint) {
    return node('label', {}, label, control, hint ? node('span', { class: 'field-help' }, hint) : null);
  }

  function input(name, value = '', options = {}) {
    return node('input', { name, value, ...options });
  }

  function select(name, value, choices) {
    const element = node('select', { name, required: true },
      Object.entries(choices).map(([choice, label]) => node('option', { value: choice }, label)),
    );
    element.value = value;
    return element;
  }

  function check(name, label, checked) {
    return node('label', { class: 'check-field' },
      node('input', { name, type: 'checkbox', checked }),
      node('span', {}, label),
    );
  }

  function textValue(data, key) {
    return String(data.get(key) || '').trim();
  }

  function dialog(title, content) {
    $('#dialog-title').textContent = title;
    dialogContent.replaceChildren(content);
    if (!editor.open) editor.showModal();
  }

  function editorForm(title, fields, save, submitLabel = 'Enregistrer', destructive = false) {
    const form = node('form', { class: 'field-stack', method: 'post' }, fields);
    const feedback = node('p', { class: 'form-message danger', role: 'alert', hidden: true });
    const submit = node('button', { type: 'submit', class: destructive ? 'button secondary remove' : 'button primary' }, submitLabel);
    form.append(feedback, node('div', { class: 'dialog-actions' },
      button('Annuler', 'close-editor'), submit,
    ));
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (submit.disabled) return;
      submit.disabled = true;
      editor.setAttribute('aria-busy', 'true');
      const closeButtons = editor.querySelectorAll('button[data-action="close-editor"]');
      for (const control of closeButtons) control.disabled = true;
      setMessage(feedback);
      try {
        await save(new FormData(form));
        if (editor.open && editor.contains(form)) editor.close();
      } catch (error) {
        if (!isRetired(error)) setMessage(feedback, error.message, true);
      } finally {
        submit.disabled = false;
        editor.removeAttribute('aria-busy');
        for (const control of closeButtons) control.disabled = false;
      }
    });
    dialog(title, form);
    const firstField = form.querySelector('input:not([readonly]), textarea, select');
    if (firstField) firstField.focus();
  }

  function clientValues(client) {
    return {
      ...(client?.id ? { id: client.id } : {}),
      name: client?.name || '',
      email: client?.email || '',
      project: client?.project || '',
      location: client?.location || '',
      status: client?.status || 'planning',
      progress: client?.progress || 0,
      notes: client?.notes || '',
    };
  }

  function clientEditor(client = null, progressOnly = false) {
    const fields = [];
    const current = clientValues(client);
    if (!progressOnly) {
      const lockedEmail = client?.access === 'active' || client?.access === 'invited';
      fields.push(
        field('Nom du client', input('name', current.name, { required: true, maxlength: 160, autocomplete: 'section-client name' })),
        field('Adresse e-mail', input('email', current.email, { type: 'email', required: true, maxlength: 254, autocomplete: 'section-client email', readonly: lockedEmail }),
          lockedEmail ? 'Révoquez l’accès dans l’onglet Accès client pour modifier cette adresse.' : null),
        node('div', { class: 'field-row' },
          field('Nom du chantier', input('project', current.project, { required: true, maxlength: 200 })),
          field('Lieu du chantier', input('location', current.location, { maxlength: 200, placeholder: 'P. ex. Antananarivo' })),
        ),
      );
    }
    if (client) {
      fields.push(
        node('div', { class: 'field-row' },
          field('État du chantier', select('status', current.status, projectStatuses)),
          field('Avancement (%)', input('progress', current.progress, { type: 'number', min: 0, max: 100, step: 1, required: true })),
        ),
        field('Note d’avancement visible par le client',
          node('textarea', { name: 'notes', rows: 4, maxlength: 5000 }, current.notes),
        ),
      );
    }
    editorForm(progressOnly ? 'Mettre à jour l’avancement' : client ? 'Modifier le dossier' : 'Ajouter un client', fields, async (formData) => {
      const payload = { ...current };
      for (const key of ['name', 'email', 'project', 'location', 'status', 'notes']) {
        if (formData.has(key)) payload[key] = textValue(formData, key);
      }
      if (formData.has('progress')) payload.progress = Number(formData.get('progress'));
      const response = await request('save_client', { data: payload });
      if (!client) clientSearch.value = '';
      await afterSaving(client ? 'Dossier mis à jour.' : 'Dossier client créé.', client ? null : () => selectClient(response.id, { focus: true }));
    }, client ? 'Enregistrer' : 'Créer le dossier');
  }

  function taskPayload(task, changes = {}) {
    return {
      client_id: currentClient().id,
      ...(task?.id ? { id: task.id } : {}),
      title: task?.title || '',
      due_date: task?.due_date || '',
      done: Boolean(task?.done),
      shared: Boolean(task?.shared),
      ...changes,
    };
  }

  function taskEditor(task = null) {
    editorForm(task ? 'Modifier la tâche' : 'Ajouter une tâche', [
      field('Intitulé', input('title', task?.title, { maxlength: 200, required: true })),
      field('Échéance', input('due_date', task?.due_date || '', { type: 'date' })),
      check('done', 'Tâche terminée', task?.done),
      check('shared', 'Partager avec le client', task?.shared),
    ], async (formData) => {
      await request('save_task', { data: taskPayload(task, {
        title: textValue(formData, 'title'),
        due_date: textValue(formData, 'due_date'),
        done: formData.has('done'),
        shared: formData.has('shared'),
      }) });
      await afterSaving('Tâche enregistrée.');
    });
  }

  function documentEditor(kind, record = null) {
    const labels = documentLabels[kind];
    const existingFile = record?.has_file ? `Fichier actuel : ${record.filename || 'PDF'}` : 'PDF de 8 Mo maximum.';
    editorForm(record ? `Modifier le ${labels.single}` : `Ajouter un ${labels.single}`, [
      field('Intitulé', input('title', record?.title, { required: true, maxlength: 200 })),
      node('div', { class: 'field-row' },
        field('État', select('status', record?.status || 'draft', documentStatuses[kind])),
        field('Échéance', input('due_date', record?.due_date || '', { type: 'date' })),
      ),
      field('Référence', input('reference', record?.reference, { maxlength: 200 })),
      field('Joindre un PDF', input('file', null, { type: 'file', accept: '.pdf,application/pdf' }), existingFile),
      check('shared', 'Partager avec le client', record?.shared),
    ], async (data) => {
      const file = data.get('file');
      if (file?.size > 8 * 1024 * 1024) throw new Error('Le fichier PDF ne peut pas dépasser 8 Mo.');
      if (!file?.size) data.delete('file');
      data.set('client_id', currentClient().id);
      data.set('kind', kind);
      data.set('shared', data.has('shared') ? '1' : '0');
      if (record?.id) data.set('id', record.id);
      await request('save_document', { data });
      await afterSaving('Document enregistré.');
    });
  }

  function confirmAction(title, detail, label, callback, destructive = true) {
    editorForm(title, [node('p', { class: 'dialog-prompt' }, detail)], callback, label, destructive);
    editor.querySelector('button[data-action="close-editor"]').focus();
  }

  async function issueInvitation() {
    const client = currentClient();
    const result = await request('invite', { data: { client_id: client.id } });
    const url = new URL('./', location.href);
    url.hash = new URLSearchParams({ activate: result.token }).toString();
    state.invitations.set(Number(client.id), { url: url.href, expiresAt: result.expires_at });
    await afterSaving(`Lien créé pour ${client.name}. Copiez-le pour le transmettre.`);
    setTimeout(() => {
      if (state.selectedId === Number(client.id)) $('#invite-link')?.focus();
    }, 0);
  }

  async function copyInvitation() {
    const input = $('#invite-link');
    if (!input) return;
    try {
      await navigator.clipboard.writeText(input.value);
      announce('Lien copié.');
    } catch {
      input.focus();
      input.select();
      setMessage(workspaceMessage, 'Sélectionnez le lien puis copiez-le.');
    }
  }

  async function revokeAccess() {
    const id = currentClient().id;
    await request('revoke', { data: { client_id: id } });
    state.invitations.delete(Number(id));
    await afterSaving('Accès révoqué.');
  }

  async function signOut() {
    const result = await request('logout', { data: {} });
    setSession(result);
    activationToken = null;
    showAccess();
    accessForm.elements.email.focus();
  }

  accessForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = $('#access-submit');
    if (submit.disabled) return;
    if (activationToken !== null && !/^[a-f0-9]{64}$/.test(activationToken)) {
      setMessage(accessError, 'Ce lien d’activation est invalide ou incomplet.', true);
      return;
    }
    setMessage(accessError);
    submit.disabled = true;
    try {
      if (!state.csrf) setSession(await request('session'));
      const submittedToken = activationToken;
      const activating = submittedToken !== null;
      const password = accessForm.elements.password.value;
      const data = activating
        ? { token: submittedToken, password }
        : { email: accessForm.elements.email.value.trim(), password };
      const result = await request(activating ? 'activate' : 'login', { data });
      setSession(result);
      accessForm.reset();
      if (activationToken !== submittedToken) {
        showAccess();
        return;
      }
      activationToken = null;
      await showWorkspace();
      if (state.user) workspaceTitle.focus();
    } catch (error) {
      if (!isRetired(error)) setMessage(accessError, error.message, true);
    } finally {
      submit.disabled = false;
    }
  });

  $('#sign-out').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await signOut();
    } catch (error) {
      if (state.user && !isRetired(error)) setMessage(workspaceMessage, error.message, true);
    } finally {
      button.disabled = false;
    }
  });

  editor.addEventListener('cancel', (event) => {
    if (editor.getAttribute('aria-busy') === 'true') event.preventDefault();
  });
  editor.addEventListener('close', () => {
    if (!editor.open) dialogContent.replaceChildren();
  });
  clientSearch.addEventListener('input', renderClients);
  sectionNav.addEventListener('click', (event) => {
    const tab = event.target.closest('button[data-tab]')?.dataset.tab;
    if (tab) {
      state.tab = tab;
      renderWorkspace();
    }
  });

  document.addEventListener('click', async (event) => {
    const pressed = event.target.closest('button[data-action]');
    if (!pressed) return;
    const { action, id, kind } = pressed.dataset;
    if (action === 'close-editor') {
      editor.close();
      return;
    }
    if (action === 'reload') {
      location.reload();
      return;
    }
    if (action === 'retry-workspace') {
      await showWorkspace();
      return;
    }
    if (!owner()) return;
    const client = currentClient();
    const task = state.project?.tasks.find((item) => Number(item.id) === Number(id));
    const documentRecord = state.project?.documents.find((item) => Number(item.id) === Number(id));

    try {
      switch (action) {
        case 'select-client': await selectClient(id, { focus: true }); break;
        case 'new-client': clientEditor(); break;
        case 'edit-client': if (client) clientEditor(client); break;
        case 'edit-progress': if (client) clientEditor(client, true); break;
        case 'new-task': if (client) taskEditor(); break;
        case 'edit-task': if (task) taskEditor(task); break;
        case 'toggle-task':
          if (!task) break;
          pressed.disabled = true;
          await request('save_task', { data: taskPayload(task, { done: !task.done }) });
          await afterSaving(task.done ? 'Tâche rouverte.' : 'Tâche terminée.');
          break;
        case 'delete-task':
          if (task) confirmAction('Supprimer la tâche', `Supprimer « ${task.title} » du dossier ?`, 'Supprimer', async () => {
            await request('delete_task', { data: { id: task.id, client_id: client.id } });
            await afterSaving('Tâche supprimée.');
          });
          break;
        case 'new-document': if (client && documentLabels[kind]) documentEditor(kind); break;
        case 'edit-document': if (documentRecord) documentEditor(documentRecord.kind, documentRecord); break;
        case 'delete-document':
          if (documentRecord) confirmAction('Supprimer le document', `Supprimer « ${documentRecord.title} » et son éventuel PDF ?`, 'Supprimer', async () => {
            await request('delete_document', { data: { id: documentRecord.id, client_id: client.id } });
            await afterSaving('Document supprimé.');
          });
          break;
        case 'show-access':
          state.tab = 'access';
          renderWorkspace();
          $('#access-tab').focus();
          break;
        case 'invite':
          if (!client) break;
          if (client.access === 'active' || client.access === 'invited') {
            confirmAction('Créer un nouveau lien', client.access === 'active'
              ? 'Le client devra choisir un nouveau mot de passe à partir du lien que vous lui transmettrez.'
              : 'Le lien d’activation précédent ne pourra plus être utilisé.',
            'Créer le lien', issueInvitation, false);
            break;
          }
          pressed.disabled = true;
          await issueInvitation();
          break;
        case 'copy-invite': await copyInvitation(); break;
        case 'revoke':
          if (client) confirmAction('Révoquer l’accès', 'Le client ne pourra plus ouvrir ce dossier ou ses documents.', 'Révoquer', revokeAccess);
          break;
        default: break;
      }
    } catch (error) {
      if (state.user && !isRetired(error)) setMessage(workspaceMessage, error.message, true);
    } finally {
      pressed.disabled = false;
    }
  });

  window.addEventListener('hashchange', () => {
    const token = readActivationToken();
    if (token === null) return;
    activationToken = token;
    if (editor.open) editor.close();
    showAccess();
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) location.reload();
  });

  start();
})();
