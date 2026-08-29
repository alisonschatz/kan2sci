/**
 * kan2sci — controla a interface do popup: perfil, listagem e busca.
 * Le dados diretamente do storage local para evitar dependencia do service worker.
 *
 * Nao ha botao de sincronizar: a sincronizacao roda inteiramente em segundo
 * plano (background.js, via chrome.alarms). Ao abrir o popup, apenas
 * disparamos um pedido de sincronizacao "silencioso" (sem UI de status) como
 * reforco, e ouvimos mudancas no storage para refletir a lista assim que
 * ela for atualizada, mesmo que isso aconteca enquanto o popup esta aberto.
 */

document.addEventListener('DOMContentLoaded', async () => {
  await initializePopup();
  setupEventListeners();
});

/**
 * Inicializa o estado do popup ao abrir.
 */
async function initializePopup() {
  await loadUserProfile();
  await loadSnippets();
  loadSyncStatus();
  triggerBackgroundSync();
}

/**
 * Configura todos os event listeners.
 */
function setupEventListeners() {
  document.getElementById('saveProfileBtn').addEventListener('click', saveUserProfile);
  document.getElementById('profileEditBtn').addEventListener('click', () => showProfileForm(true));
  document.getElementById('cancelProfileBtn').addEventListener('click', cancelProfileEdit);
  document.getElementById('snippetSearch').addEventListener('input', handleSearch);
  document.getElementById('searchClear').addEventListener('click', clearSearch);
}

/**
 * Pede ao background para sincronizar agora, de forma totalmente silenciosa
 * (sem indicador, sem bloquear a UI). Serve como reforco alem do alarme
 * periodico, cobrindo o caso do navegador ter ficado fechado por muito tempo.
 * Erros sao ignorados propositalmente: se o service worker estiver inativo
 * no momento, a sincronizacao periodica agendada cobre isso mais tarde.
 */
function triggerBackgroundSync() {
  try {
    chrome.runtime.sendMessage({ action: 'forceSync' }, () => {
      void chrome.runtime.lastError; // ignora silenciosamente
    });
  } catch (err) {
    // noop — popup continua funcional mesmo sem conseguir falar com o background
  }
}

/**
 * Mantem a lista de snippets e o indicador de sincronizacao em dia caso uma
 * sincronizacao termine enquanto o popup ainda esta aberto.
 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  if (changes.teamSnippets) {
    const snippets = changes.teamSnippets.newValue || [];
    renderSnippetList(snippets);
    updateCount(snippets.length);
    reapplySearchFilter();
  }

  if (changes.syncStatus || changes.lastSync) {
    chrome.storage.local.get(['syncStatus', 'lastSync']).then((data) => {
      applySyncStatus(data.syncStatus || null, data.lastSync || null);
    });
  }
});

/**
 * ============================================================
 * Indicador de sincronizacao (header)
 * ============================================================
 * A sincronizacao roda inteiramente em segundo plano (chrome.alarms em
 * background.js); sem este indicador o usuario nao tem nenhuma pista de
 * que ela existe, quando rodou pela ultima vez, ou se falhou.
 */

/**
 * Busca o status mais recente salvo pelo background e reflete no header.
 */
function loadSyncStatus() {
  try {
    chrome.runtime.sendMessage({ action: 'getSyncStatus' }, (res) => {
      if (chrome.runtime.lastError || !res) {
        applySyncStatus(null, null);
        return;
      }
      applySyncStatus(res.status, res.lastSync);
    });
  } catch (err) {
    applySyncStatus(null, null);
  }
}

/**
 * Decide o estado visual (sincronizando / sincronizado / erro) a partir
 * do status salvo e do timestamp da ultima sincronizacao bem-sucedida.
 */
function applySyncStatus(status, lastSync) {
  if (!lastSync && !status) {
    setSyncIndicator('syncing', 'Sincronizando\u2026');
    return;
  }

  if (status && status.success === false) {
    setSyncIndicator('error', 'Falha na sincroniza\u00e7\u00e3o');
    return;
  }

  const relative = formatRelativeTime(lastSync);
  setSyncIndicator('synced', relative ? `Atualizado ${relative}` : 'Sincronizado');
}

/**
 * Aplica o estado visual (cor do ponto + texto) ao indicador do header.
 */
function setSyncIndicator(state, label) {
  const indicator = document.getElementById('syncIndicator');
  const dot = document.getElementById('syncDot');
  const labelEl = document.getElementById('syncLabel');
  if (!indicator || !dot || !labelEl) return;

  dot.classList.remove('is-synced', 'is-syncing', 'is-error');
  dot.classList.add(`is-${state}`);
  indicator.classList.toggle('is-error', state === 'error');
  labelEl.textContent = label;
  indicator.title = state === 'error'
    ? 'A extens\u00e3o vai tentar sincronizar novamente automaticamente.'
    : 'Sincroniza\u00e7\u00e3o autom\u00e1tica em segundo plano';
}

/**
 * Formata um timestamp ISO como tempo relativo em portugues ("h\u00e1 5 min").
 */
function formatRelativeTime(isoString) {
  if (!isoString) return null;
  const diffMs = Date.now() - new Date(isoString).getTime();
  if (Number.isNaN(diffMs)) return null;

  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 10) return 'agora mesmo';
  if (diffSec < 60) return `h\u00e1 ${diffSec}s`;

  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `h\u00e1 ${diffMin} min`;

  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `h\u00e1 ${diffHour}h`;

  const diffDay = Math.round(diffHour / 24);
  return `h\u00e1 ${diffDay}d`;
}

// Mantem o texto relativo ("ha 5 min") em dia enquanto a popup fica aberta,
// sem precisar de nenhum evento externo.
setInterval(() => {
  chrome.storage.local.get(['syncStatus', 'lastSync']).then((data) => {
    applySyncStatus(data.syncStatus || null, data.lastSync || null);
  });
}, 30000);

/**
 * Carrega o perfil do usuario e decide o estado inicial da secao:
 * recolhido (resumo) se ja houver nome salvo, expandido (formulario) caso contrario.
 */
async function loadUserProfile() {
  try {
    const info = await fetchAndFillProfile();

    if (info.name && info.name.trim()) {
      renderProfileSummary(info);
      setProfileView('summary');
      // Perfil ja preenchido: o proximo passo mais provavel do usuario e
      // buscar um snippet, entao o foco vai direto pra busca.
      document.getElementById('snippetSearch').focus();
    } else {
      document.getElementById('cancelProfileBtn').hidden = true;
      setProfileView('form');
      // Primeiro uso: sem perfil nao ha nome/cargo pra preencher nos
      // templates, entao o foco vai pro campo que falta preencher.
      document.getElementById('userName').focus();
    }
  } catch (err) {
    console.error('[kan2sci] Erro ao carregar perfil:', err);
    setProfileView('form');
  }
}

/**
 * Preenche o card de resumo com nome e "cargo · setor".
 * O avatar agora e sempre a logo da SCI (fixa no HTML), sem depender do nome.
 */
function renderProfileSummary(info) {
  document.getElementById('profileSummaryName').textContent = info.name || '';
  document.getElementById('profileSummaryRole').textContent =
    [info.role, info.sector].filter(Boolean).join(' · ');
}

const PROFILE_TRANSITION_MS = 140;

/**
 * Alterna instantaneamente (sem transicao) entre resumo e formulario.
 * Usado apenas no carregamento inicial do popup, para nao "piscar" ao abrir.
 */
function setProfileView(view) {
  document.getElementById('profileSummary').hidden = view !== 'summary';
  document.getElementById('profileForm').hidden = view !== 'form';
}

/**
 * Faz a troca suave (fade-out do estado atual -> fade-in do novo estado),
 * evitando a transicao seca entre o resumo recolhido e o formulario expandido.
 */
function crossfadeProfileView(view, onShown) {
  const summary = document.getElementById('profileSummary');
  const form = document.getElementById('profileForm');
  const hideEl = view === 'summary' ? form : summary;
  const showEl = view === 'summary' ? summary : form;

  hideEl.classList.add('is-fading');

  setTimeout(() => {
    hideEl.hidden = true;
    hideEl.classList.remove('is-fading');

    showEl.hidden = false;
    showEl.classList.add('is-fading');
    void showEl.offsetWidth; // forca reflow para a transicao de entrada funcionar
    showEl.classList.remove('is-fading');

    if (onShown) onShown();
  }, PROFILE_TRANSITION_MS);
}

/**
 * Exibe o resumo recolhido do perfil e esconde o formulario, com transicao suave.
 */
function showProfileSummary() {
  crossfadeProfileView('summary');
}

/**
 * Exibe o formulario de edicao do perfil, com transicao suave.
 * @param {boolean} isEditingExisting - se true, mostra o botao "Cancelar" (ha um resumo para voltar).
 */
function showProfileForm(isEditingExisting) {
  document.getElementById('cancelProfileBtn').hidden = !isEditingExisting;
  crossfadeProfileView('form', () => document.getElementById('userName').focus());
}

/**
 * Busca os dados de perfil no storage e preenche os campos do formulario.
 */
async function fetchAndFillProfile() {
  const data = await chrome.storage.local.get('userInfo');
  const info = data.userInfo || { name: '', role: '', sector: '' };

  document.getElementById('userName').value = info.name || '';
  document.getElementById('userRole').value = info.role || '';
  document.getElementById('userSector').value = info.sector || '';

  return info;
}

/**
 * Cancela a edicao, descarta alteracoes nao salvas e volta para o resumo (ou formulario vazio).
 */
async function cancelProfileEdit() {
  try {
    const info = await fetchAndFillProfile();
    if (info.name && info.name.trim()) {
      renderProfileSummary(info);
      showProfileSummary();
    } else {
      showProfileForm(false);
    }
  } catch (err) {
    console.error('[kan2sci] Erro ao cancelar edicao:', err);
  }
}

/**
 * Salva o perfil do usuario.
 */
async function saveUserProfile() {
  const btn = document.getElementById('saveProfileBtn');
  const originalText = btn.textContent;

  try {
    const name = document.getElementById('userName').value.trim();
    const role = document.getElementById('userRole').value.trim();
    const sector = document.getElementById('userSector').value.trim();

    btn.textContent = 'Salvando...';
    btn.disabled = true;

    await chrome.storage.local.set({ userInfo: { name, role, sector } });

    btn.textContent = 'Perfil Salvo';
    btn.classList.add('is-success');

    if (name) {
      renderProfileSummary({ name, role, sector });
      showProfileSummary();
    }

    setTimeout(() => {
      btn.textContent = originalText;
      btn.classList.remove('is-success');
      btn.disabled = false;
    }, 500);
  } catch (err) {
    console.error('[kan2sci] Erro ao salvar perfil:', err);
    btn.textContent = 'Erro ao Salvar';
    btn.classList.add('is-error');
    setTimeout(() => {
      btn.textContent = originalText;
      btn.classList.remove('is-error');
      btn.disabled = false;
    }, 1200);
  }
}

let currentSnippets = [];

/**
 * Carrega e renderiza a lista de snippets diretamente do storage.
 */
async function loadSnippets() {
  try {
    const data = await chrome.storage.local.get('teamSnippets');
    const snippets = data.teamSnippets || [];
    renderSnippetList(snippets);
    updateCount(snippets.length);
  } catch (err) {
    console.error('[kan2sci] Erro ao carregar snippets:', err);
    showEmptyState('Erro ao carregar snippets', 'A sincronizacao automatica tenta novamente em breve.');
    updateCount(0);
  }
}

/**
 * Renderiza a lista de snippets no container.
 * Cada item e clicavel por inteiro (nao so o chip do atalho) e navegavel
 * por teclado, ja que a area do chip sozinho e um alvo pequeno demais
 * numa popup de 380px.
 */
function renderSnippetList(snippets) {
  currentSnippets = snippets || [];
  const container = document.getElementById('snippetContainer');

  if (!currentSnippets.length) {
    showEmptyState('Nenhum snippet carregado', 'A sincronizacao automatica atualiza a lista em segundo plano.');
    return;
  }

  container.innerHTML = '';

  currentSnippets.forEach(item => {
    const div = document.createElement('div');
    div.className = 'snippet-item';
    div.setAttribute('role', 'button');
    div.setAttribute('tabindex', '0');
    div.setAttribute('aria-label', `Copiar atalho ${item.trigger} de ${item.name || 'snippet'}`);
    div.title = 'Clique para copiar o atalho';
    div.innerHTML = `
      <span class="snippet-name">${escapeHtml(item.name || 'Sem nome')}</span>
      <span class="snippet-trigger">${escapeHtml(item.trigger)}</span>
    `;

    const triggerEl = div.querySelector('.snippet-trigger');
    const activate = () => copyTriggerToClipboard(triggerEl, item.trigger);

    div.addEventListener('click', activate);
    div.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activate();
      }
    });

    container.appendChild(div);
  });
}

/**
 * Copia o texto para a area de transferencia, com fallback para navegadores/contextos
 * sem suporte a navigator.clipboard, e da feedback visual no elemento clicado.
 */
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) { /* cai no fallback abaixo */ }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    return true;
  } catch (e) {
    return false;
  }
}

async function copyTriggerToClipboard(el, trigger) {
  const originalText = el.textContent;
  const ok = await copyText(trigger);

  el.textContent = ok ? 'Copiado!' : 'Erro ao copiar';
  el.classList.toggle('copied', ok);

  setTimeout(() => {
    el.textContent = originalText;
    el.classList.remove('copied');
  }, 1200);
}

/**
 * Filtra snippets com base na busca. Diferencia explicitamente "nenhum
 * snippet carregado ainda" de "a busca nao encontrou nada" — sem isso,
 * uma pesquisa sem resultado deixava a lista simplesmente em branco,
 * como se fosse um erro.
 */
function handleSearch(e) {
  const query = e.target.value.toLowerCase().trim();
  document.getElementById('searchClear').hidden = query === '';

  if (!currentSnippets.length) return; // nada carregado ainda, nao ha o que filtrar

  const items = document.querySelectorAll('.snippet-item');
  let visibleCount = 0;

  items.forEach(item => {
    const name = item.querySelector('.snippet-name').textContent.toLowerCase();
    const trigger = item.querySelector('.snippet-trigger').textContent.toLowerCase();
    const match = name.includes(query) || trigger.includes(query);
    item.style.display = match ? 'flex' : 'none';
    if (match) visibleCount++;
  });

  toggleNoResultsMessage(visibleCount === 0 && query !== '');
}

/**
 * Reaplica o filtro de busca atual depois que a lista e re-renderizada
 * (ex: uma sincronizacao em segundo plano trouxe snippets novos enquanto
 * o popup estava aberto e o usuario ja tinha algo digitado na busca).
 */
function reapplySearchFilter() {
  const searchInput = document.getElementById('snippetSearch');
  if (searchInput.value.trim() !== '') {
    handleSearch({ target: searchInput });
  }
}

/**
 * Limpa a busca e devolve o foco ao campo, pronto pra proxima digitacao.
 */
function clearSearch() {
  const searchInput = document.getElementById('snippetSearch');
  searchInput.value = '';
  handleSearch({ target: searchInput });
  searchInput.focus();
}

/**
 * Mostra ou esconde a mensagem de "nenhum resultado encontrado" dentro
 * da lista, sem apagar os itens (eles continuam no DOM, so ocultos).
 */
function toggleNoResultsMessage(show) {
  const container = document.getElementById('snippetContainer');
  let noResultsEl = document.getElementById('noResultsState');

  if (!show) {
    if (noResultsEl) noResultsEl.hidden = true;
    return;
  }

  if (!noResultsEl) {
    noResultsEl = document.createElement('div');
    noResultsEl.id = 'noResultsState';
    noResultsEl.className = 'empty-state';
    noResultsEl.innerHTML = `
      <p class="empty-text">Nenhum resultado encontrado</p>
      <p class="empty-sub">Tente outro termo de busca.</p>
    `;
    container.appendChild(noResultsEl);
  }
  noResultsEl.hidden = false;
}

/**
 * Exibe estado vazio na lista.
 */
function showEmptyState(title, subtitle) {
  const container = document.getElementById('snippetContainer');
  container.innerHTML = `
    <div class="empty-state">
      <p class="empty-text">${escapeHtml(title)}</p>
      <p class="empty-sub">${escapeHtml(subtitle)}</p>
    </div>
  `;
}

/**
 * Atualiza o contador de snippets.
 */
function updateCount(count) {
  document.getElementById('snippetCount').textContent = count;
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}