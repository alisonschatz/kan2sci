/**
 * Controla a pagina de configuracoes avancadas.
 * Le dados diretamente do storage local para evitar dependencia do service worker.
 */

document.addEventListener('DOMContentLoaded', () => {
  initializeNavigation();
  loadProfile();
  loadSnippetsTable();
  loadSyncStatus();
  setupEventListeners();
});

/**
 * Inicializa navegacao por abas.
 */
function initializeNavigation() {
  const links = document.querySelectorAll('.nav-link');
  const sections = document.querySelectorAll('.content-section');

  links.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const target = link.dataset.section;

      links.forEach(l => l.classList.remove('active'));
      link.classList.add('active');

      sections.forEach(s => s.classList.remove('active'));
      document.getElementById(target).classList.add('active');
    });
  });
}

/**
 * Carrega perfil do usuario.
 */
async function loadProfile() {
  try {
    const data = await chrome.storage.local.get('userInfo');
    const info = data.userInfo || {};
    document.getElementById('optName').value = info.name || '';
    document.getElementById('optRole').value = info.role || '';
    document.getElementById('optEmail').value = info.email || '';
  } catch (err) {
    console.error('[SCI Options] Erro ao carregar perfil:', err);
  }
}

/**
 * Salva perfil do usuario.
 */
async function saveProfile() {
  const btn = document.getElementById('saveProfileOpt');
  const status = document.getElementById('saveStatus');

  try {
    const data = {
      name: document.getElementById('optName').value.trim(),
      role: document.getElementById('optRole').value.trim(),
      email: document.getElementById('optEmail').value.trim()
    };

    btn.textContent = 'Salvando...';
    btn.disabled = true;

    await chrome.storage.local.set({ userInfo: data });

    status.textContent = 'Alteracoes salvas com sucesso.';
    status.className = 'save-status success';
  } catch (err) {
    status.textContent = 'Erro ao salvar. Tente novamente.';
    status.className = 'save-status error';
    console.error(err);
  } finally {
    btn.textContent = 'Salvar Alteracoes';
    btn.disabled = false;
    setTimeout(() => { status.textContent = ''; }, 3000);
  }
}

/**
 * Carrega tabela de snippets.
 */
async function loadSnippetsTable() {
  try {
    const data = await chrome.storage.local.get('teamSnippets');
    const snippets = data.teamSnippets || [];
    renderTable(snippets);
    document.getElementById('snippetCountOpt').textContent = snippets.length;
  } catch (err) {
    console.error('[SCI Options] Erro ao carregar snippets:', err);
  }
}

/**
 * Carrega status de sincronizacao.
 */
async function loadSyncStatus() {
  try {
    const data = await chrome.storage.local.get(['syncStatus', 'lastSync']);
    const status = data.syncStatus;

    if (status) {
      document.getElementById('syncState').textContent = status.success ? 'Sucesso' : 'Falha';
      document.getElementById('syncState').className = 'status-value ' + (status.success ? 'success' : 'error');
      document.getElementById('syncDate').textContent = data.lastSync
        ? new Date(data.lastSync).toLocaleString('pt-BR')
        : 'Nunca';
      document.getElementById('syncCount').textContent = status.count || 0;
      document.getElementById('syncMessage').textContent = status.message || '--';
    } else {
      document.getElementById('syncState').textContent = 'Nunca sincronizado';
      document.getElementById('syncState').className = 'status-value';
      document.getElementById('syncDate').textContent = '--';
      document.getElementById('syncCount').textContent = '--';
      document.getElementById('syncMessage').textContent = '--';
    }
  } catch (err) {
    console.error('[SCI Options] Erro ao carregar status:', err);
  }
}

/**
 * Envia mensagem para o background com timeout.
 */
function sendMessage(message, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error('Tempo de resposta excedido.'));
      }
    }, timeoutMs);

    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response || {});
        }
      });
    } catch (err) {
      if (!resolved) { resolved = true; clearTimeout(timer); reject(err); }
    }
  });
}

/**
 * Sincroniza manualmente.
 */
async function handleSync() {
  const btn = document.getElementById('forceSyncOpt');
  btn.textContent = 'Sincronizando...';
  btn.disabled = true;

  try {
    await sendMessage({ action: 'forceSync' }, 15000);
    await loadSyncStatus();
    await loadSnippetsTable();
  } catch (err) {
    console.error('[SCI Options] Erro na sincronizacao:', err);
    alert('Falha na sincronizacao: ' + err.message);
  } finally {
    btn.textContent = 'Sincronizar Agora';
    btn.disabled = false;
  }
}

function renderTable(snippets) {
  const tbody = document.getElementById('snippetTableBody');

  if (!snippets.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="2">Nenhum snippet carregado. Sincronize para atualizar.</td></tr>';
    return;
  }

  tbody.innerHTML = snippets.map(s => `
    <tr>
      <td><code class="table-code">${escapeHtml(s.trigger)}</code></td>
      <td>${escapeHtml(s.name)}</td>
    </tr>
  `).join('');
}

function filterTable(query) {
  const rows = document.querySelectorAll('#snippetTableBody tr:not(.empty-row)');
  const lower = query.toLowerCase();
  rows.forEach(row => {
    row.style.display = row.textContent.toLowerCase().includes(lower) ? '' : 'none';
  });
}

function setupEventListeners() {
  document.getElementById('saveProfileOpt').addEventListener('click', saveProfile);
  document.getElementById('forceSyncOpt').addEventListener('click', handleSync);
  document.getElementById('snippetSearchOpt').addEventListener('input', (e) => {
    filterTable(e.target.value);
  });
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}