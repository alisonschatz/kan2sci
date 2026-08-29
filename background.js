/**
 * kan2sci — service worker responsavel por sincronizacao, cache e
 * orquestracao de dados dos snippets. A sincronizacao roda 100% em
 * segundo plano (na instalacao, no startup do navegador e a cada
 * CONFIG.SYNC_INTERVAL_MINUTES via chrome.alarms) — nao ha nenhuma
 * acao manual do usuario necessaria.
 */

importScripts('lib/utils.js', 'lib/yaml-parser.js');

// Detecta automaticamente se a extensão está em modo desenvolvedor (carregada
// via "Carregar sem compactação"), em vez de depender de uma flag manual que
// é fácil esquecer de trocar antes de publicar. Extensões instaladas pela
// Chrome Web Store (ou distribuídas por política) sempre têm "update_url" no
// manifest resolvido pelo Chrome; extensões unpacked, nunca têm.
const IS_DEV = !('update_url' in chrome.runtime.getManifest());

const CONFIG = {
  GITHUB_YAML_URL: IS_DEV
    ? chrome.runtime.getURL('data/snippets.yml')   // arquivo local na extensão
    : 'https://raw.githubusercontent.com/alisonschatz/sci-snippets/main/snippets.yml',
  
  SYNC_INTERVAL_MINUTES: 30,
  RETRY_ATTEMPTS: 3,
  RETRY_DELAY_MS: 2000,
  STORAGE_KEYS: {
    SNIPPETS: 'teamSnippets',
    LAST_SYNC: 'lastSync',
    SYNC_STATUS: 'syncStatus',
    USER_INFO: 'userInfo',
    STATS: 'usageStats'
  }
};

/**
 * Busca o YAML com retry automatico em caso de falha.
 */
async function fetchWithRetry(url, attempts = CONFIG.RETRY_ATTEMPTS) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url, {
        cache: 'no-store',
        headers: {
          'Accept': 'text/plain, application/yaml, text/yaml',
          'Cache-Control': 'no-cache'
        }
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return await response.text();
    } catch (err) {
      lastError = err;
      SCIUtils.log('warn', `Tentativa ${i + 1} falhou. Retentando...`, err.message);
      if (i < attempts - 1) {
        await new Promise(r => setTimeout(r, CONFIG.RETRY_DELAY_MS * (i + 1)));
      }
    }
  }
  throw lastError;
}

/**
 * Sincroniza snippets do repositorio remoto.
 */
async function syncSnippets(force = false) {
  const status = {
    success: false,
    timestamp: new Date().toISOString(),
    message: '',
    count: 0,
    error: null
  };

  try {
    SCIUtils.log('log', 'Iniciando sincronizacao de snippets...');

    const yamlText = await fetchWithRetry(CONFIG.GITHUB_YAML_URL);
    const snippets = SCIYamlParser.parse(yamlText);

    if (!Array.isArray(snippets) || snippets.length === 0) {
      throw new Error('Nenhum snippet valido encontrado no YAML.');
    }

    await chrome.storage.local.set({
      [CONFIG.STORAGE_KEYS.SNIPPETS]: snippets,
      [CONFIG.STORAGE_KEYS.LAST_SYNC]: status.timestamp,
      [CONFIG.STORAGE_KEYS.SYNC_STATUS]: { ...status, success: true, message: 'Sincronizado com sucesso', count: snippets.length }
    });

    SCIUtils.log('log', `Sincronizacao concluida. Total de snippets: ${snippets.length}`);
    return { success: true, count: snippets.length };
  } catch (err) {
    status.success = false;
    status.message = err.message;
    status.error = err.stack;

    await chrome.storage.local.set({
      [CONFIG.STORAGE_KEYS.SYNC_STATUS]: status
    });

    SCIUtils.log('error', 'Falha na sincronizacao', err);
    return { success: false, error: err.message };
  }
}

/**
 * ===========================================================
 * Menu de contexto (botao direito) — insercao de snippet no
 * campo em que o usuario clicou, sem precisar digitar o gatilho.
 * ===========================================================
 */

const CONTEXT_MENU_ROOT_ID = 'kan2sci-root';
const CONTEXT_MENU_PREFIX = 'kan2sci:';

/**
 * Reconstroi o submenu "kan2sci" a partir da lista de snippets atual.
 * Chamado sempre que os snippets mudam no storage (sync concluida,
 * edicao manual, etc.) e tambem no boot do service worker, ja que
 * chrome.contextMenus nao mantem estado entre reinicios.
 */
function buildContextMenus(snippets) {
  chrome.contextMenus.removeAll(() => {
    // Ignora erro de "nao havia menus para remover" na primeira execucao.
    void chrome.runtime.lastError;

    chrome.contextMenus.create({
      id: CONTEXT_MENU_ROOT_ID,
      title: 'kan2sci',
      contexts: ['editable']
    });

    if (!snippets || snippets.length === 0) {
      chrome.contextMenus.create({
        id: `${CONTEXT_MENU_PREFIX}__empty__`,
        parentId: CONTEXT_MENU_ROOT_ID,
        title: 'Nenhum snippet carregado',
        enabled: false,
        contexts: ['editable']
      });
      return;
    }

    snippets.forEach((item) => {
      if (!item.trigger) return;
      chrome.contextMenus.create({
        id: CONTEXT_MENU_PREFIX + item.trigger,
        parentId: CONTEXT_MENU_ROOT_ID,
        // Mostra nome + gatilho, ex: "Abertura de Solicitação (:abrir)"
        title: item.name ? `${item.name}  (${item.trigger})` : item.trigger,
        contexts: ['editable']
      });
    });
  });
}

/**
 * Carrega os snippets atuais do storage e (re)monta o menu.
 * Usado no onInstalled/onStartup, quando o service worker acorda
 * "do zero" e o menu nativo precisa ser recriado.
 */
function refreshContextMenusFromStorage() {
  chrome.storage.local.get([CONFIG.STORAGE_KEYS.SNIPPETS]).then((data) => {
    buildContextMenus(data[CONFIG.STORAGE_KEYS.SNIPPETS] || []);
  });
}

// Sempre que a lista de snippets mudar no storage (sync automatica,
// principalmente), o menu e reconstruido para refletir a lista nova.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[CONFIG.STORAGE_KEYS.SNIPPETS]) {
    buildContextMenus(changes[CONFIG.STORAGE_KEYS.SNIPPETS].newValue || []);
  }
});

// Clique em um item do submenu: repassa o gatilho escolhido para o
// content script da aba, que sabe qual campo estava com o menu aberto
// e faz a insercao exatamente na posicao do cursor.
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (typeof info.menuItemId !== 'string') return;
  if (!info.menuItemId.startsWith(CONTEXT_MENU_PREFIX)) return;
  if (!tab || tab.id === undefined) return;

  const trigger = info.menuItemId.slice(CONTEXT_MENU_PREFIX.length);
  if (!trigger || trigger === '__empty__') return;

  chrome.tabs.sendMessage(
    tab.id,
    { action: 'insertContextMenuSnippet', trigger },
    { frameId: info.frameId },
    () => {
      // Se o content script nao existir na pagina (ex: chrome://, PDF
      // viewer), apenas ignora o erro em vez de quebrar o service worker.
      void chrome.runtime.lastError;
    }
  );
});

/**
 * Agenda sincronizacao periodica via alarmes.
 */
function setupPeriodicSync() {
  chrome.alarms.get('sciSyncTask', (existing) => {
    if (!existing) {
      chrome.alarms.create('sciSyncTask', {
        periodInMinutes: CONFIG.SYNC_INTERVAL_MINUTES
      });
      SCIUtils.log('log', `Sincronizacao periodica agendada a cada ${CONFIG.SYNC_INTERVAL_MINUTES} minutos.`);
    }
  });
}

// Eventos de lifecycle
chrome.runtime.onInstalled.addListener((details) => {
  SCIUtils.log('log', 'Extensao instalada/atualizada', details.reason);
  syncSnippets(true);
  setupPeriodicSync();
  refreshContextMenusFromStorage();
});

chrome.runtime.onStartup.addListener(() => {
  setupPeriodicSync();
  refreshContextMenusFromStorage();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'sciSyncTask') {
    syncSnippets();
  }
});

// Mensagens entre contextos
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'forceSync') {
    syncSnippets(true).then(result => {
      sendResponse({ status: result.success ? 'success' : 'error', ...result });
    });
    return true; // Async response
  }

  if (message.action === 'getSyncStatus') {
    chrome.storage.local.get([CONFIG.STORAGE_KEYS.SYNC_STATUS, CONFIG.STORAGE_KEYS.LAST_SYNC])
      .then(data => {
        sendResponse({
          status: data.syncStatus || null,
          lastSync: data.lastSync || null
        });
      });
    return true;
  }

  if (message.action === 'getSnippets') {
    chrome.storage.local.get([CONFIG.STORAGE_KEYS.SNIPPETS])
      .then(data => {
        sendResponse({ snippets: data.teamSnippets || [] });
      });
    return true;
  }

  if (message.action === 'saveUserInfo') {
    chrome.storage.local.set({ [CONFIG.STORAGE_KEYS.USER_INFO]: message.data })
      .then(() => sendResponse({ status: 'success' }));
    return true;
  }

  if (message.action === 'getUserInfo') {
    chrome.storage.local.get([CONFIG.STORAGE_KEYS.USER_INFO])
      .then(data => {
        sendResponse({ userInfo: data.userInfo || { name: '', role: '', sector: '' } });
      });
    return true;
  }

  if (message.action === 'getUsageStats') {
    chrome.storage.local.get([CONFIG.STORAGE_KEYS.STATS])
      .then(data => {
        sendResponse({ stats: data.usageStats || {} });
      });
    return true;
  }

  if (message.action === 'logUsage') {
    chrome.storage.local.get([CONFIG.STORAGE_KEYS.STATS]).then(data => {
      const stats = data.usageStats || {};
      const trigger = message.trigger;
      stats[trigger] = (stats[trigger] || 0) + 1;
      stats._lastUsed = new Date().toISOString();
      chrome.storage.local.set({ [CONFIG.STORAGE_KEYS.STATS]: stats });
    });
    sendResponse({ status: 'logged' });
    return false;
  }
});