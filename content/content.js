(function() {
  'use strict';

  const MAX_LOOKBACK = 60;

  let snippetCache = [];
  let userInfoCache = { name: '', role: '' };
  let isExpanding = false;

  /**
   * Carrega snippets e perfil do usuario do storage local.
   */
  async function loadData() {
    try {
      const storage = await chrome.storage.local.get(['teamSnippets', 'userInfo']);
      snippetCache = storage.teamSnippets || [];
      userInfoCache = storage.userInfo || { name: '', role: '' };
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
      userInfoCache = changes.userInfo.newValue || { name: '', role: '' };
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
   * Executa a expansao do snippet no elemento alvo.
   */
  function expandSnippet(target, shortcut, text) {
    isExpanding = true;
    try {
      const success = target.type === 'input'
        ? replaceInInput(target.element, shortcut, text)
        : replaceInRichEditor(target.element, shortcut, text);

      if (success) {
        try {
          chrome.runtime.sendMessage({ action: 'logUsage', trigger: shortcut });
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

    // O evento 'input' disparado dentro da Shadow DOM do modal assistente
    // (kan2sci-assistant) também é observado aqui, pois é "composed".
    // Por causa do "event retargeting" do Shadow DOM, e.target aparece
    // como o próprio elemento host do modal (não o input real dentro dele),
    // então basta checar o id do host para ignorar esses eventos.
    if (e.target && e.target.id === 'kan2sci-assistant') return;

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

  document.addEventListener('input', handleInput, true);

  console.log('[kan2sci] Content script ativo. Modal interativo pronto.');
})();