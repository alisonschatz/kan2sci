/**
 * Responsavel por sincronizacao, cache e orquestracao de dados.
 */

importScripts('lib/utils.js', 'lib/yaml-parser.js');

const IS_DEV = true; // <-- Mude para false antes de publicar

const CONFIG = {
  GITHUB_YAML_URL: IS_DEV
    ? chrome.runtime.getURL('snippets.yml')   // arquivo local na extensão
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
});

chrome.runtime.onStartup.addListener(() => {
  setupPeriodicSync();
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
        sendResponse({ userInfo: data.userInfo || { name: '', role: '' } });
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