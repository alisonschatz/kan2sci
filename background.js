/**
 * kan2sci — service worker: sincronizacao/cache dos snippets (em segundo
 * plano, via chrome.alarms) e automacao de criacao de Solicitacoes SCI a
 * partir do modal do Kanboard (acao 'PROCESS_FULL_REQUEST').
 */

importScripts('lib/utils.js', 'lib/yaml-parser.js');

// Extensões instaladas via Chrome Web Store (ou política) sempre têm
// "update_url" resolvido no manifest; unpacked (dev), nunca têm.
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

// ── Menu de contexto (botão direito): insere o snippet escolhido no campo
// clicado, sem precisar digitar o gatilho. ──────────────────────────────

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

// Mensagens entre contextos (snippets, perfil, stats)
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

// ── Automação de Solicitação SCI: abre o formulário real numa aba em
// segundo plano, preenche via DOM e clica em "Confirmar". ───────────────

const KANBOARD_REQUEST_FORM_URL = 'https://www.s1991.com.br/solicitacaoInternoForm.php?sistemaId=43';
const KR_NAV_TIMEOUT_MS = 20000;
const KR_POLL_INTERVAL_MS = 300;
const KR_LOGIN_WAIT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos pra logar / resolver reCAPTCHA manualmente
const KR_LOGIN_POLL_INTERVAL_MS = 1000;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'PROCESS_FULL_REQUEST') {
    runKanboardRequestAutomation(request.payload)
      .then(result => sendResponse({ success: true, ...result }))
      .catch(error => sendResponse({
        success: false,
        error: error.message,
        tabId: error.tabId || null,
        partial: !!error.partial,
        solicitacaoId: error.solicitacaoId || null
      }));
    return true; // mantém o canal aberto para resposta assíncrona
  }
});

async function runKanboardRequestAutomation(payload) {
  const tab = await chrome.tabs.create({ url: KANBOARD_REQUEST_FORM_URL, active: false });
  const tabId = tab.id;

  try {
    // ─── ETAPA 1: criar a solicitação ───────────────────────────────
    await krWaitForComplete(tabId);
    await krEnsureOnFormPage(tabId); // espera login manual se a sessão tiver caído

    const fillResult = await krExecInTab(tabId, krFillStep1Form, [payload]);
    if (!fillResult.ok) throw krTaggedError(fillResult.error, tabId);

    if (payload.anexo) {
      const attachResult = await krExecInTab(tabId, krAttachFile, [
        payload.anexo.name, payload.anexo.type, payload.anexo.buffer, 'file'
      ]);
      if (!attachResult.ok) throw krTaggedError(attachResult.error, tabId);
    }

    const beforeUrl1 = (await chrome.tabs.get(tabId)).url;

    const clickResult1 = await krExecInTab(tabId, krClickSubmit, []);
    if (!clickResult1.ok) throw krTaggedError(clickResult1.error, tabId);

    await krWaitForNavigation(tabId, beforeUrl1);

    const info = await krExecInTab(tabId, krExtractResultInfo, []);

    // ─── ETAPA 2: classificação/criticidade/status ──────────────────
    // A página real, depois de criar a solicitação, já costuma navegar pra
    // cá sozinha (mesma aba). Só automatizamos se ela realmente chegou nessa
    // tela E se o usuário preencheu esses campos no modal.
    const onStep2Page = await krExecInTab(tabId, krIsStep2Page, []);
    const hasStep2Data = payload.classificacao && payload.criticidade && payload.statusForm;

    if (onStep2Page && hasStep2Data) {
      const fillResult2 = await krExecInTab(tabId, krFillStep2Form, [payload]);
      if (!fillResult2.ok) {
        const err = krTaggedError(fillResult2.error, tabId);
        err.partial = true;
        err.solicitacaoId = info.solicitacaoId;
        throw err;
      }

      const beforeUrl2 = (await chrome.tabs.get(tabId)).url;

      const clickResult2 = await krExecInTab(tabId, krClickConfirmStatus, []);
      if (!clickResult2.ok) {
        const err = krTaggedError(clickResult2.error, tabId);
        err.partial = true;
        err.solicitacaoId = info.solicitacaoId;
        throw err;
      }

      await krWaitForNavigation(tabId, beforeUrl2);

      // Tudo automatizado com sucesso — fecha a aba, não precisa de ação manual.
      try { await chrome.tabs.remove(tabId); } catch (e) { /* aba pode já ter fechado */ }

      return {
        solicitacaoId: info.solicitacaoId,
        resultUrl: info.url,
        manualStep2: false
      };
    }

    // Não deu pra automatizar a Etapa 2 (página diferente do esperado, ou o
    // usuário deixou Classificação/Criticidade/Status em branco no modal) —
    // traz a aba pra frente pra o usuário terminar manualmente.
    await chrome.tabs.update(tabId, { active: true });

    return {
      solicitacaoId: info.solicitacaoId,
      resultUrl: info.url,
      tabId,
      manualStep2: true
    };
  } catch (err) {
    // Não fecha a aba em caso de erro — deixa em foco pra o usuário ver
    // exatamente o que a página real mostrou, em vez de esconder o problema.
    try { await chrome.tabs.update(tabId, { active: true }); } catch (e) { /* aba pode já ter sido fechada */ }
    throw err;
  }
}

function krTaggedError(message, tabId) {
  const err = new Error(message);
  err.tabId = tabId;
  return err;
}

async function krExecInTab(tabId, func, args) {
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return result;
}

function krWaitForComplete(tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('A página demorou demais para carregar.'));
    }, KR_NAV_TIMEOUT_MS);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);

    // Caso a aba já esteja completa no instante em que começamos a escutar.
    chrome.tabs.get(tabId).then(tab => {
      if (tab.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });
}

async function krWaitForNavigation(tabId, previousUrl) {
  const start = Date.now();
  while (Date.now() - start < KR_NAV_TIMEOUT_MS) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete' && tab.url !== previousUrl) return;
    await krSleep(KR_POLL_INTERVAL_MS);
  }
  throw new Error('A página não navegou depois do clique em Confirmar — pode ter ficado numa tela de erro/validação. Veja a aba aberta.');
}

function krSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Garante que a aba chegou no formulário de verdade antes de preencher
 * qualquer coisa. Se a sessão da Intranet tiver caído, o servidor redireciona
 * pra tela de login (com reCAPTCHA) em vez do formulário — nesse caso, NÃO
 * tentamos automatizar o login (reCAPTCHA existe justamente pra impedir
 * isso). Em vez disso, trazemos a aba pra frente e esperamos o usuário logar
 * manualmente, verificando a cada segundo se o formulário já apareceu.
 */
async function krEnsureOnFormPage(tabId) {
  let status = await krExecInTab(tabId, krCheckPageStatus, []);
  if (status.formReady) return;

  if (!status.looksLikeLogin) {
    // Não é a tela de login nem o formulário — pode já estar logado mas ter
    // caído em outra tela (ex: dashboard). Tenta ir direto pro formulário
    // antes de desistir.
    await chrome.tabs.update(tabId, { url: KANBOARD_REQUEST_FORM_URL });
    await krWaitForComplete(tabId);
    status = await krExecInTab(tabId, krCheckPageStatus, []);
    if (status.formReady) return;
    if (!status.looksLikeLogin) {
      throw krTaggedError('A página carregada não é o formulário esperado nem a tela de login. Confira a aba manualmente.', tabId);
    }
  }

  // Tela de login confirmada: traz a aba pra frente pro usuário logar (e
  // resolver o reCAPTCHA) manualmente.
  await chrome.tabs.update(tabId, { active: true });

  const start = Date.now();
  let reNavigated = false;

  while (Date.now() - start < KR_LOGIN_WAIT_TIMEOUT_MS) {
    await krSleep(KR_LOGIN_POLL_INTERVAL_MS);

    const tab = await chrome.tabs.get(tabId);
    if (tab.status !== 'complete') continue;

    const s = await krExecInTab(tabId, krCheckPageStatus, []);
    if (s.formReady) return;

    if (!s.looksLikeLogin && !reNavigated) {
      // Login concluído, mas caiu em outra tela (ex: dashboard) em vez de
      // voltar pro formulário sozinho — tenta navegar pra lá uma vez.
      reNavigated = true;
      await chrome.tabs.update(tabId, { url: KANBOARD_REQUEST_FORM_URL });
      await krWaitForComplete(tabId);
    }
  }

  throw krTaggedError('Login não foi concluído em 5 minutos. Faça login na aba aberta e tente novamente.', tabId);
}

function krCheckPageStatus() {
  const formReady = !!document.getElementById('clienteId');
  const looksLikeLogin = !formReady && !!document.querySelector('input[type="password"]');
  return { formReady, looksLikeLogin };
}

// ═══════════════════════════════════════════════════════════════════════
// FUNÇÕES INJETADAS NA PÁGINA REAL (chrome.scripting.executeScript)
// Precisam ser autocontidas — não podem referenciar nada fora delas, pois
// rodam isoladas no contexto da página, não no do service worker.
// ═══════════════════════════════════════════════════════════════════════

function krFillStep1Form(payload) {
  function setValue(selector, value) {
    const el = document.querySelector(selector);
    if (!el) return false;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  const missing = [];
  if (!setValue('#clienteId', payload.clienteId)) missing.push('Cliente ID (#clienteId)');
  if (!setValue('input[name="nomeSolicitante"]', payload.nomeSolicitante)) missing.push('Nome do Solicitante');
  if (!setValue('#tipoSolicitacao', payload.tipoSolicitacao)) missing.push('Tipo de Solicitação');
  if (payload.versaoSolicitacao) setValue('input[name="versaoSolicitacao"]', payload.versaoSolicitacao);
  if (!setValue('#emailParaRetorno', payload.emailParaRetorno)) missing.push('E-mail para Retorno');
  if (payload.emailParaRetornoPrestador) setValue('#emailParaRetornoPrestador', payload.emailParaRetornoPrestador);
  if (!setValue('#titulo', payload.titulo)) missing.push('Título');
  if (!setValue('textarea[name="descricaoSolicitacao"]', payload.descricaoSolicitacao)) missing.push('Descrição');
  if (payload.comentarioSCI) setValue('textarea[name="comentarioSCI"]', payload.comentarioSCI);
  if (payload.empresa) setValue('input[name="empresa"]', payload.empresa);
  if (payload.referencia) setValue('input[name="referencia"]', payload.referencia);

  if (missing.length) {
    return { ok: false, error: 'Campo(s) não encontrado(s) na página (pode ter mudado de estrutura): ' + missing.join(', ') };
  }
  return { ok: true };
}

function krAttachFile(fileName, fileType, bufferArray, inputId) {
  const input = document.getElementById(inputId);
  if (!input) return { ok: false, error: `Campo de anexo (#${inputId}) não encontrado na página.` };
  try {
    const bytes = new Uint8Array(bufferArray);
    const file = new File([bytes], fileName, { type: fileType || 'application/octet-stream' });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: 'Falha ao anexar arquivo: ' + err.message };
  }
}

function krClickSubmit() {
  const btn = document.getElementById('btnSubmit');
  if (!btn) return { ok: false, error: 'Botão "Confirmar" (#btnSubmit) não encontrado na página.' };
  btn.click();
  return { ok: true };
}

/**
 * Detecta se a aba já está na tela de Classificação/Criticidade/Status
 * (a página que sobra depois de criar a solicitação).
 */
function krIsStep2Page() {
  return !!document.getElementById('btnConfirmaStatus');
}

/**
 * Preenche Classificação/Criticidade/Status na tela de Etapa 2.
 *
 * Os valores de "statusForm" precisam ser o TEXTO do option (ex: "Pertinente"),
 * não o código numérico — o código só existe no atributo "alt" da option, que
 * não é enviado no formulário. Além disso, boa parte dos status nascem
 * disabled (só os que fazem sentido a partir do status atual ficam
 * clicáveis); se o valor pedido corresponder a uma option desabilitada, o
 * <select> simplesmente não muda e isso é reportado como erro aqui.
 */
function krFillStep2Form(payload) {
  function setSelect(selector, value) {
    const el = document.querySelector(selector);
    if (!el) return { ok: false, reason: 'campo não encontrado' };

    const option = Array.from(el.options).find(o => o.value === value);
    if (!option) return { ok: false, reason: 'opção não existe' };
    if (option.disabled) return { ok: false, reason: 'opção desabilitada nesse estado atual da solicitação' };

    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }

  const problems = [];

  const r1 = setSelect('#classificacao', payload.classificacao);
  if (!r1.ok) problems.push(`Classificação (${r1.reason})`);

  const r2 = setSelect('#criticidade', payload.criticidade);
  if (!r2.ok) problems.push(`Criticidade (${r2.reason})`);

  const r3 = setSelect('#statusForm', payload.statusForm);
  if (!r3.ok) problems.push(`Status (${r3.reason})`);

  if (problems.length) {
    return { ok: false, error: 'Falha ao preencher a Etapa 2: ' + problems.join('; ') };
  }
  return { ok: true };
}

/**
 * Clica em "Confirmar e alterar status". O botão nasce com o atributo
 * disabled e alguma validação JS da própria página é quem o habilita — como
 * já garantimos que os campos obrigatórios estão certos, removemos o
 * disabled diretamente antes de clicar, em vez de tentar adivinhar qual
 * evento exato a página escuta para habilitá-lo sozinha.
 */
function krClickConfirmStatus() {
  const btn = document.getElementById('btnConfirmaStatus');
  if (!btn) return { ok: false, error: 'Botão "Confirmar e alterar status" (#btnConfirmaStatus) não encontrado.' };
  if (btn.disabled) btn.disabled = false;
  btn.click();
  return { ok: true };
}

/**
 * ⚠️ Melhor esforço: extrai o ID da solicitação pela URL ou, na falta dela,
 * por um padrão de texto no corpo da página de resultado. Ajustar para um
 * seletor exato assim que o HTML dessa tela for confirmado.
 */
function krExtractResultInfo() {
  const url = location.href;
  let solicitacaoId = null;

  const urlMatch = url.match(/solicitacaoId=(\d{3,7})/i);
  if (urlMatch) solicitacaoId = urlMatch[1];

  if (!solicitacaoId) {
    const bodyText = document.body ? document.body.innerText || '' : '';
    const textMatch = bodyText.match(/solicita[cç][aã]o[^\d]{0,20}(\d{4,7})/i);
    if (textMatch) solicitacaoId = textMatch[1];
  }

  return { solicitacaoId, url, title: document.title };
}