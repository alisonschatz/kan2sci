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
 * Mantem a lista de snippets em dia caso uma sincronizacao termine
 * enquanto o popup ainda esta aberto.
 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.teamSnippets) {
    const snippets = changes.teamSnippets.newValue || [];
    renderSnippetList(snippets);
    updateCount(snippets.length);
  }
});

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
    } else {
      document.getElementById('cancelProfileBtn').hidden = true;
      setProfileView('form');
    }
  } catch (err) {
    console.error('[kan2sci] Erro ao carregar perfil:', err);
    setProfileView('form');
  }
}

/**
 * Preenche o card de resumo com nome, cargo e iniciais.
 */
function renderProfileSummary(info) {
  document.getElementById('profileAvatar').textContent = getInitials(info.name);
  document.getElementById('profileSummaryName').textContent = info.name || '';
  document.getElementById('profileSummaryRole').textContent = info.role || '';
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
  const info = data.userInfo || { name: '', role: '' };

  document.getElementById('userName').value = info.name || '';
  document.getElementById('userRole').value = info.role || '';

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
 * Gera iniciais (ate 2 letras) a partir do nome completo.
 */
function getInitials(name) {
  if (!name || !name.trim()) return '?';
  const parts = name.trim().split(/\s+/);
  const first = parts[0][0] || '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
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

    btn.textContent = 'Salvando...';
    btn.disabled = true;

    await chrome.storage.local.set({ userInfo: { name, role } });

    btn.textContent = 'Perfil Salvo';
    btn.style.background = '#2e7d32';

    if (name) {
      renderProfileSummary({ name, role });
      showProfileSummary();
    }

    setTimeout(() => {
      btn.textContent = originalText;
      btn.style.background = '';
      btn.disabled = false;
    }, 500);
  } catch (err) {
    console.error('[kan2sci] Erro ao salvar perfil:', err);
    btn.textContent = 'Erro ao Salvar';
    btn.style.background = '#c62828';
    setTimeout(() => {
      btn.textContent = originalText;
      btn.style.background = '';
      btn.disabled = false;
    }, 1200);
  }
}

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
 */
function renderSnippetList(snippets) {
  const container = document.getElementById('snippetContainer');

  if (!snippets || snippets.length === 0) {
    showEmptyState('Nenhum snippet carregado', 'A sincronizacao automatica atualiza a lista em segundo plano.');
    return;
  }

  container.innerHTML = '';

  snippets.forEach(item => {
    const div = document.createElement('div');
    div.className = 'snippet-item';
    div.innerHTML = `
      <span class="snippet-name">${escapeHtml(item.name || 'Sem nome')}</span>
      <span class="snippet-trigger" title="Clique para copiar">${escapeHtml(item.trigger)}</span>
    `;

    const triggerEl = div.querySelector('.snippet-trigger');
    triggerEl.addEventListener('click', () => copyTriggerToClipboard(triggerEl, item.trigger));

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
 * Filtra snippets com base na busca.
 */
function handleSearch(e) {
  const query = e.target.value.toLowerCase().trim();
  const items = document.querySelectorAll('.snippet-item');

  items.forEach(item => {
    const name = item.querySelector('.snippet-name').textContent.toLowerCase();
    const trigger = item.querySelector('.snippet-trigger').textContent.toLowerCase();
    const match = name.includes(query) || trigger.includes(query);
    item.style.display = match ? 'flex' : 'none';
  });
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
