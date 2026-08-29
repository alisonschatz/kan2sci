(function() {
  'use strict';

  const MAX_LOOKBACK = 60;

  // Hosts de Shadow DOM próprios da extensão: eventos 'input' vindos de
  // dentro deles sofrem "event retargeting" (e.target vira o host, não o
  // input real) e não devem disparar a expansão de snippet novamente.
  const IGNORED_INPUT_HOST_IDS = new Set([
    'kan2sci-assistant',          // modal interativo de snippets
    'kan2sci-kanboard-request-host' // modal de Nova Solicitação SCI (Kanboard)
  ]);

  let snippetCache = [];
  let userInfoCache = { name: '', role: '', sector: '' };
  let isExpanding = false;

  // Campo que estava em foco quando o menu de contexto abriu. O clique no
  // item do menu é assíncrono e document.activeElement pode não ser mais
  // o mesmo depois que o menu nativo fecha, então guardamos a referência aqui.
  let lastContextMenuTarget = null;

  /**
   * Carrega snippets e perfil do usuario do storage local.
   */
  async function loadData() {
    try {
      const storage = await chrome.storage.local.get(['teamSnippets', 'userInfo']);
      snippetCache = storage.teamSnippets || [];
      userInfoCache = storage.userInfo || { name: '', role: '', sector: '' };
    } catch (err) {
      SCIUtils.log('error', 'Erro ao carregar dados', err);
    }
  }

  loadData();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.teamSnippets) {
      snippetCache = changes.teamSnippets.newValue || [];
    }
    if (changes.userInfo) {
      userInfoCache = changes.userInfo.newValue || { name: '', role: '', sector: '' };
    }
  });

  /**
   * Verifica se o elemento atual e um campo de texto valido.
   */
  function getActiveTextElement() {
    const active = document.activeElement;
    if (!active) return null;

    if (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') {
      return { element: active, type: 'input' };
    }

    if (active.isContentEditable || active.getAttribute('role') === 'textbox') {
      return { element: active, type: 'rich' };
    }

    const editableParent = active.closest('[contenteditable="true"]');
    if (editableParent) {
      return { element: editableParent, type: 'rich' };
    }

    return null;
  }

  /**
   * Retorna os ultimos caracteres digitados antes do cursor.
   */
  function getTextBeforeCursor(target) {
    if (target.type === 'input') {
      const el = target.element;
      const pos = el.selectionStart ?? (el.value || '').length;
      const value = el.value || '';
      return value.substring(Math.max(0, pos - MAX_LOOKBACK), pos);
    }

    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return '';
    const range = selection.getRangeAt(0);
    if (!range.collapsed) return '';

    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return '';

    const offset = range.startOffset;
    const text = node.textContent || '';
    return text.substring(Math.max(0, offset - MAX_LOOKBACK), offset);
  }

  /**
   * Substitui o atalho por texto em input/textarea.
   */
  function replaceInInput(element, shortcut, text) {
    const start = element.selectionStart || 0;
    const end = element.selectionEnd || 0;
    const value = element.value || '';

    if (start < shortcut.length) return false;

    const before = value.substring(0, start - shortcut.length);
    const after = value.substring(end);

    element.value = before + text + after;
    const newPos = before.length + text.length;
    element.setSelectionRange(newPos, newPos);

    element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));

    return true;
  }

  /**
   * Substitui o atalho por texto em editor rico (contentEditable).
   */
  function replaceInRichEditor(element, shortcut, text) {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return false;

    const range = selection.getRangeAt(0);
    const textNode = range.startContainer;

    for (let i = 0; i < shortcut.length; i++) {
      document.execCommand('delete', false, null);
    }

    const success = document.execCommand('insertText', false, text);

    if (!success) {
      try {
        const newRange = document.createRange();
        const newTextNode = document.createTextNode(text);

        if (textNode.nodeType === Node.TEXT_NODE) {
          const offset = range.startOffset;
          const nodeText = textNode.textContent;
          const beforeText = nodeText.substring(0, offset - shortcut.length);
          const afterText = nodeText.substring(offset);

          textNode.textContent = beforeText;
          const insertedNode = textNode.parentNode.insertBefore(newTextNode, textNode.nextSibling);
          const afterNode = document.createTextNode(afterText);
          textNode.parentNode.insertBefore(afterNode, insertedNode.nextSibling);

          newRange.setStartAfter(insertedNode);
          newRange.collapse(true);
          selection.removeAllRanges();
          selection.addRange(newRange);
        }
      } catch (domErr) {
        SCIUtils.log('error', 'Falha na substituicao em editor rico', domErr);
        return false;
      }
    }

    element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    return true;
  }

  /**
   * Executa a expansão do snippet no elemento alvo.
   * `shortcut` é o gatilho a remover antes de inserir (vazio quando vem do
   * menu de contexto). `triggerForLog` é o trigger real, usado só para
   * registrar o uso em usageStats.
   */
  function expandSnippet(target, shortcut, text, triggerForLog = shortcut) {
    isExpanding = true;
    try {
      const success = target.type === 'input'
        ? replaceInInput(target.element, shortcut, text)
        : replaceInRichEditor(target.element, shortcut, text);

      if (success) {
        try {
          chrome.runtime.sendMessage({ action: 'logUsage', trigger: triggerForLog });
        } catch (e) {}
      }

      return success;
    } finally {
      isExpanding = false;
    }
  }

  /**
   * Remove o trigger do input (substitui por texto vazio).
   * Usado antes de abrir o modal interativo.
   */
  function removeTrigger(target, shortcut) {
    isExpanding = true;
    try {
      if (target.type === 'input') {
        return replaceInInput(target.element, shortcut, '');
      } else {
        return replaceInRichEditor(target.element, shortcut, '');
      }
    } finally {
      isExpanding = false;
    }
  }

  /**
   * Handler principal: detecta triggers e decide entre expansão direta ou modal assistido.
   */
  function handleInput(e) {
    if (isExpanding) return;
    if (e.isComposing) return;
    if (!snippetCache.length) return;

    // Eventos 'input' disparados dentro da Shadow DOM de modais próprios da
    // extensão (assistente de snippets, Nova Solicitação SCI) também são
    // observados aqui, pois são "composed". Ignora-os pelo id do host —
    // ver IGNORED_INPUT_HOST_IDS.
    if (e.target && IGNORED_INPUT_HOST_IDS.has(e.target.id)) return;

    const target = getActiveTextElement();
    if (!target) return;

    const textBeforeCursor = getTextBeforeCursor(target);
    if (!textBeforeCursor) return;

    for (const item of snippetCache) {
      if (item.trigger && textBeforeCursor.endsWith(item.trigger)) {
        const processedText = SCIUtils.parseTemplate(item.replace, userInfoCache);

        // ═══════════════════════════════════════════════════
        // MODAL INTERATIVO
        // ═══════════════════════════════════════════════════
        if (item.interactive === true && window.SCIAssistant) {
          // 1. Remove o trigger do input (deixa o cursor no lugar)
          removeTrigger(target, item.trigger);
          // 2. Abre o modal com o template e dados do usuário
          window.SCIAssistant.open(item, target, userInfoCache);
          return;
        }

        // Modo direto (comportamento original)
        expandSnippet(target, item.trigger, processedText);
        break;
      }
    }
  }

  /**
   * Registra o campo ativo sempre que o menu de contexto (botao direito)
   * e aberto sobre um elemento editavel. E o que permite ao menu nativo
   * do Chrome (que roda 100% no background, sem acesso ao DOM da pagina)
   * saber depois, ao receber o clique, ONDE inserir o snippet.
   */
  document.addEventListener('contextmenu', () => {
    lastContextMenuTarget = getActiveTextElement();
  }, true);

  /**
   * Insere o snippet do menu de contexto na posição do cursor. Não há
   * gatilho de texto a remover aqui, então shortcut = ''.
   */
  function insertSnippetFromContextMenu(trigger) {
    const item = snippetCache.find(s => s.trigger === trigger);
    if (!item) {
      SCIUtils.log('warn', 'Snippet do menu de contexto nao encontrado', trigger);
      return;
    }

    // Se o campo ainda existir no DOM, usa o que foi registrado no
    // contextmenu; caso contrario cai de volta no elemento focado agora.
    const target = (lastContextMenuTarget && document.contains(lastContextMenuTarget.element))
      ? lastContextMenuTarget
      : getActiveTextElement();

    if (!target) {
      SCIUtils.log('warn', 'Nenhum campo editavel disponivel para inserir o snippet');
      return;
    }

    if (item.interactive === true && window.SCIAssistant) {
      window.SCIAssistant.open(item, target, userInfoCache);
      return;
    }

    const processedText = SCIUtils.parseTemplate(item.replace, userInfoCache);
    expandSnippet(target, '', processedText, item.trigger);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'insertContextMenuSnippet') {
      insertSnippetFromContextMenu(message.trigger);
    }
  });

  document.addEventListener('input', handleInput, true);

  console.log('[kan2sci] Content script ativo. Modal interativo pronto.');
})();