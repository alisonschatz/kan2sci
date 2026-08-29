(function() {
  'use strict';

  let activeModal = null;
  let originalTarget = null;

  const MODAL_ID = 'kan2sci-assistant';
  const ACCESS_TYPES = ['Administrador', 'Cliente', 'Usuário adicional', 'Colaborador'];

  /**
   * Insere texto em input/textarea na posição do cursor.
   */
  function insertTextInInput(element, text) {
    const start = element.selectionStart || 0;
    const end = element.selectionEnd || 0;
    const value = element.value || '';

    const before = value.substring(0, start);
    const after = value.substring(end);

    element.value = before + text + after;
    const newPos = before.length + text.length;
    element.setSelectionRange(newPos, newPos);

    element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    return true;
  }

  /**
   * Insere texto em editor rico (contentEditable) na posição do cursor.
   */
  function insertTextInRichEditor(element, text) {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return false;

    const range = selection.getRangeAt(0);

    // Estratégia 1: execCommand
    const success = document.execCommand('insertText', false, text);

    if (!success) {
      // Estratégia 2: DOM direto
      try {
        const textNode = document.createTextNode(text);
        range.deleteContents();
        range.insertNode(textNode);

        const newRange = document.createRange();
        newRange.setStartAfter(textNode);
        newRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(newRange);
      } catch (err) {
        console.error('[kan2sci] Falha ao inserir em editor rico:', err);
        return false;
      }
    }

    element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    return true;
  }

  /**
   * Rótulos que fazem mais sentido como textarea (mesmo sendo campo de linha única
   * no template), pois tendem a receber respostas mais longas.
   */
  function isLongLabel(label) {
    const l = label.toLowerCase();
    return ['comportamento', 'descri', 'motivo', 'dúvida', 'duvida', 'observa', 'testar',
      'feito', 'correç', 'cenári', 'valida', 'quest', 'impact', 'alteraç']
      .some(k => l.includes(k));
  }

  /**
   * Detecta se o template tem uma seção "## Evidências" (com qualquer nível de
   * cabeçalho e variação de acento). Essa seção é só texto estático — não vira
   * campo editável — então, sem essa checagem, ela nunca apareceria no modal e
   * o usuário poderia esquecer de anexar print/vídeo ao card antes de enviar.
   */
  function hasEvidenceSection(template) {
    return /^\s{0,3}#{1,3}\s+.*evid[êe]ncia/im.test(template || '');
  }

  function autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /**
   * Abre o modal assistido para um snippet.
   * @param {Object} snippet - Objeto do snippet (trigger, name, replace, interactive)
   * @param {Object} target - { element, type } retornado por getActiveTextElement
   * @param {Object} userInfo - { name, role }
   */
  function openAssistant(snippet, target, userInfo) {
    if (activeModal) closeAssistant();

    originalTarget = target;

    const fields = SCIUtils.extractEditableFields(snippet.replace);
    // Processa variáveis dinâmicas (data, nome) no template base
    const baseTemplate = SCIUtils.parseTemplate(snippet.replace, userInfo || { name: '', role: '' });

    // Agrupa os campos por seção (título ## mais próximo), preservando a ordem do template
    const sections = [];
    fields.forEach(field => {
      const key = field.section || '';
      let bucket = sections.find(s => s.key === key);
      if (!bucket) {
        bucket = { key, fields: [] };
        sections.push(bucket);
      }
      bucket.fields.push(field);
    });

    // Container com Shadow DOM
    const host = document.createElement('div');
    host.id = MODAL_ID;
    host.style.cssText = `
      position: fixed;
      top: 0; left: 0; width: 100%; height: 100%;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0,0,0,0.45);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    `;

    const shadow = host.attachShadow({ mode: 'open' });

    // HTML interno do modal
    shadow.innerHTML = `
      <style>
        * { box-sizing: border-box; }
        .sci-modal {
          background: #fff;
          width: 620px;
          max-width: 94vw;
          max-height: 90vh;
          border-radius: 12px;
          box-shadow: 0 20px 60px rgba(0,0,0,0.3);
          display: flex;
          flex-direction: column;
          overflow: hidden;
          animation: sciSlideIn 0.22s ease;
        }
        @keyframes sciSlideIn {
          from { opacity: 0; transform: translateY(-16px) scale(0.97); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        .sci-header {
          background: #38486c;
          color: #fff;
          padding: 14px 20px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          flex-shrink: 0;
        }
        .sci-header-text h3 { margin: 0; font-size: 15px; font-weight: 600; }
        .sci-header-text p { margin: 2px 0 0; font-size: 11.5px; color: #b7c3dc; }
        .sci-header .sci-trigger {
          background: rgba(145,216,247,0.25);
          color: #91d8f7;
          padding: 3px 10px;
          border-radius: 4px;
          font-family: 'SFMono-Regular', Consolas, monospace;
          font-size: 12px;
          font-weight: 700;
          flex-shrink: 0;
        }
        .sci-body {
          padding: 16px 20px;
          overflow-y: auto;
          flex: 1;
        }
        .sci-section {
          margin-bottom: 16px;
        }
        .sci-section-title {
          font-size: 10.5px;
          font-weight: 800;
          color: #8b96ab;
          text-transform: uppercase;
          letter-spacing: 0.6px;
          margin: 0 0 8px;
          padding-bottom: 5px;
          border-bottom: 1px solid #eef1f6;
        }
        .sci-section-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 10px 12px;
        }
        .sci-notice {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          background: #fff6e5;
          border: 1px solid #f3d9a4;
          color: #7a5b16;
          font-size: 12px;
          font-weight: 600;
          line-height: 1.4;
          border-radius: 8px;
          padding: 10px 12px;
          margin-bottom: 16px;
        }
        .sci-notice .sci-notice-icon {
          flex-shrink: 0;
          font-size: 14px;
          line-height: 1.4;
        }
        .sci-field {
          min-width: 0;
        }
        .sci-field.full {
          grid-column: 1 / -1;
        }
        .sci-field label {
          display: flex;
          align-items: center;
          gap: 4px;
          font-size: 11px;
          font-weight: 700;
          color: #38486c;
          margin-bottom: 4px;
        }
        .sci-field .sci-required {
          color: #c62828;
        }
        .sci-field .sci-hint {
          font-weight: 500;
          color: #9aa4b8;
          text-transform: none;
          font-size: 10.5px;
        }
        .sci-field input,
        .sci-field textarea {
          width: 100%;
          padding: 8px 11px;
          border: 1px solid #d8dde8;
          border-radius: 6px;
          font-size: 13px;
          font-family: inherit;
          color: #38486c;
          outline: none;
          transition: border-color 0.15s, box-shadow 0.15s;
        }
        .sci-field input:focus,
        .sci-field textarea:focus {
          border-color: #38486c;
          box-shadow: 0 0 0 3px rgba(56,72,108,0.08);
        }
        .sci-field textarea {
          resize: none;
          min-height: 38px;
          line-height: 1.5;
          overflow: hidden;
        }
        .sci-field.sci-invalid input,
        .sci-field.sci-invalid textarea {
          border-color: #c62828;
          box-shadow: 0 0 0 3px rgba(198,40,40,0.08);
        }
        .sci-select-group {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }
        .sci-pill {
          padding: 7px 14px;
          border-radius: 999px;
          border: 1.5px solid #d8dde8;
          background: #fff;
          color: #38486c;
          font-size: 12.5px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.15s ease;
          font-family: inherit;
        }
        .sci-pill:hover { border-color: #91d8f7; background: #f4f9fd; }
        .sci-pill.selected {
          background: #38486c;
          border-color: #38486c;
          color: #fff;
        }
        .sci-field.sci-invalid .sci-select-group {
          outline: 2px solid rgba(198,40,40,0.3);
          outline-offset: 3px;
          border-radius: 999px;
        }
        .sci-access-rows {
          display: flex;
          flex-direction: column;
          gap: 6px;
          margin-bottom: 8px;
        }
        .sci-access-row {
          display: flex;
          gap: 6px;
          align-items: center;
        }
        .sci-access-type {
          flex: 0 0 138px;
          padding: 7px 8px;
          border: 1px solid #d8dde8;
          border-radius: 6px;
          font-size: 12px;
          font-family: inherit;
          color: #38486c;
          background: #fff;
          outline: none;
        }
        .sci-access-value {
          flex: 1;
          padding: 7px 10px;
          border: 1px solid #d8dde8;
          border-radius: 6px;
          font-size: 13px;
          font-family: inherit;
          color: #38486c;
          outline: none;
          min-width: 0;
        }
        .sci-access-value:focus, .sci-access-type:focus {
          border-color: #38486c;
          box-shadow: 0 0 0 3px rgba(56,72,108,0.08);
        }
        .sci-access-remove {
          flex-shrink: 0;
          width: 28px;
          height: 28px;
          border-radius: 6px;
          border: 1px solid #d8dde8;
          background: #f4f6f9;
          color: #c62828;
          font-size: 15px;
          line-height: 1;
          cursor: pointer;
        }
        .sci-access-remove:hover { background: #fde8e8; }
        .sci-access-remove:disabled {
          color: #c3cad9;
          cursor: not-allowed;
          background: #f4f6f9;
        }
        .sci-access-remove:disabled:hover { background: #f4f6f9; }
        .sci-add-access {
          padding: 6px 12px;
          border-radius: 6px;
          border: 1px dashed #91d8f7;
          background: rgba(145,216,247,0.12);
          color: #38486c;
          font-size: 12px;
          font-weight: 700;
          cursor: pointer;
          font-family: inherit;
        }
        .sci-add-access:hover { background: rgba(145,216,247,0.22); }
        .sci-footer {
          padding: 12px 20px;
          border-top: 1px solid #e8ecf2;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
          background: #fafbfc;
          flex-shrink: 0;
        }
        .sci-footer-hint {
          font-size: 11px;
          color: #9aa4b8;
        }
        .sci-footer-hint kbd {
          background: #eef1f6;
          border: 1px solid #d8dde8;
          border-radius: 3px;
          padding: 1px 5px;
          font-family: inherit;
          font-size: 10.5px;
        }
        .sci-footer-actions {
          display: flex;
          gap: 10px;
        }
        .sci-btn {
          padding: 8px 18px;
          border-radius: 6px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          border: none;
          transition: all 0.15s;
          font-family: inherit;
        }
        .sci-btn-secondary {
          background: #f4f6f9;
          color: #6b7a99;
          border: 1px solid #d8dde8;
        }
        .sci-btn-secondary:hover { background: #e8ecf2; }
        .sci-btn-primary {
          background: #38486c;
          color: #fff;
        }
        .sci-btn-primary:hover { background: #2a3652; }
      </style>
      <div class="sci-modal">
        <div class="sci-header">
          <div class="sci-header-text">
            <h3>${escapeHtml(snippet.name)}</h3>
            <p>Preencha os campos e envie</p>
          </div>
          <span class="sci-trigger">${escapeHtml(snippet.trigger)}</span>
        </div>
        <div class="sci-body">
          <div id="sciSections"></div>
        </div>
        <div class="sci-footer">
          <span class="sci-footer-hint"><kbd>Ctrl</kbd>+<kbd>Enter</kbd> insere rápido</span>
          <div class="sci-footer-actions">
            <button class="sci-btn sci-btn-secondary" id="sciCancel">Cancelar</button>
            <button class="sci-btn sci-btn-primary" id="sciInsert">✓ Inserir no Ticket</button>
          </div>
        </div>
      </div>
    `;

    // Registro de controladores por campo (label -> { getValue, focus, wrapper })
    const fieldControllers = {};

    // Renderiza os campos agrupados por seção
    const sectionsContainer = shadow.getElementById('sciSections');

    // Aviso fixo de evidências: a seção "## Evidências" do template é só texto
    // estático (não vira campo), então sem isso ela nunca apareceria no modal.
    if (hasEvidenceSection(snippet.replace)) {
      const notice = document.createElement('div');
      notice.className = 'sci-notice';
      notice.innerHTML = `
        <span class="sci-notice-icon">⚠️</span>
        <span>Obrigatório anexar evidências (print e/ou vídeo) ao card.</span>
      `;
      sectionsContainer.appendChild(notice);
    }

    sections.forEach(section => {
      const sectionEl = document.createElement('div');
      sectionEl.className = 'sci-section';

      if (section.key) {
        const title = document.createElement('p');
        title.className = 'sci-section-title';
        title.textContent = section.key;
        sectionEl.appendChild(title);
      }

      const grid = document.createElement('div');
      grid.className = 'sci-section-grid';

      section.fields.forEach(field => {
        const wrapper = document.createElement('div');
        const isBlock = field.type === 'block';
        const isFull = isBlock || field.type === 'access' || field.type === 'select';
        wrapper.className = 'sci-field' + (isFull ? ' full' : '');

        // Blocos (passos/bullets) sem rótulo próprio herdam o título da seção
        // (ex: "## COMO REPRODUZIR" -> label "COMO REPRODUZIR"). Isso repetia o
        // mesmo texto duas vezes no modal: uma no título da seção, outra no
        // rótulo do campo. Aqui trocamos por um rótulo curto e genérico só na
        // exibição — a chave interna (field.label) continua igual, então
        // validação e valores preenchidos não são afetados.
        const isRedundantBlockLabel = isBlock && field.label && field.section &&
          field.label.trim().toLowerCase() === field.section.trim().toLowerCase();
        const displayLabel = isRedundantBlockLabel
          ? (field.bulletStyle === 'numbered' ? 'Passos' : 'Itens')
          : field.label;

        const label = document.createElement('label');
        label.innerHTML = `${escapeHtml(displayLabel)}${field.required ? ' <span class="sci-required">*</span>' : ''}${isBlock ? ' <span class="sci-hint">(um por linha)</span>' : ''}`;
        wrapper.appendChild(label);

        if (field.type === 'select') {
          // ═══════════════════════════════════════════════════
          // CAMPO DE SELEÇÃO ÚNICA (pills) — ex: Ambiente, Dependência
          // ═══════════════════════════════════════════════════
          const group = document.createElement('div');
          group.className = 'sci-select-group';
          let selected = field.currentValue || '';
          const buttons = [];

          field.options.forEach(opt => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'sci-pill';
            btn.textContent = opt;
            if (opt === selected) btn.classList.add('selected');
            btn.addEventListener('click', () => {
              selected = opt;
              buttons.forEach(b => b.classList.toggle('selected', b === btn));
              wrapper.classList.remove('sci-invalid');
            });
            buttons.push(btn);
            group.appendChild(btn);
          });

          wrapper.appendChild(group);
          fieldControllers[field.label] = {
            getValue: () => selected,
            focus: () => buttons[0] && buttons[0].focus(),
            wrapper
          };
        } else if (field.type === 'access') {
          // ═══════════════════════════════════════════════════
          // CAMPO DE ACESSOS DINÂMICO — só entra no ticket o que for preenchido
          // Sempre nasce com 1 linha visível (nunca em branco/vazio na tela),
          // e essa linha não pode ser removida quando é a única restante —
          // só as extras (adicionadas via "+ Adicionar acesso") podem ser
          // removidas livremente.
          // ═══════════════════════════════════════════════════
          const rowsContainer = document.createElement('div');
          rowsContainer.className = 'sci-access-rows';
          const rows = [];

          const updateRemoveButtons = () => {
            rows.forEach(r => {
              r.removeBtn.disabled = rows.length <= 1;
            });
          };

          const addRow = (focusValue) => {
            const row = document.createElement('div');
            row.className = 'sci-access-row';

            const typeSelect = document.createElement('select');
            typeSelect.className = 'sci-access-type';
            ACCESS_TYPES.forEach(t => {
              const opt = document.createElement('option');
              opt.value = t;
              opt.textContent = t;
              typeSelect.appendChild(opt);
            });
            const used = rows.map(r => r.typeSelect.value);
            const next = ACCESS_TYPES.find(t => !used.includes(t));
            if (next) typeSelect.value = next;

            const valueInput = document.createElement('input');
            valueInput.type = 'text';
            valueInput.className = 'sci-access-value';
            valueInput.placeholder = 'usuário de acesso...';

            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'sci-access-remove';
            removeBtn.innerHTML = '&times;';
            removeBtn.title = 'Remover acesso';
            removeBtn.addEventListener('click', () => {
              if (rows.length <= 1) return; // sempre mantém pelo menos 1 linha
              rowsContainer.removeChild(row);
              const idx = rows.findIndex(r => r.row === row);
              if (idx > -1) rows.splice(idx, 1);
              updateRemoveButtons();
            });

            row.appendChild(typeSelect);
            row.appendChild(valueInput);
            row.appendChild(removeBtn);
            rowsContainer.appendChild(row);
            rows.push({ row, typeSelect, valueInput, removeBtn });
            updateRemoveButtons();

            if (focusValue) valueInput.focus();
          };

          wrapper.appendChild(rowsContainer);

          // Linha inicial: já vem no modal, sem precisar clicar em "+ Adicionar acesso".
          addRow(false);

          const addBtn = document.createElement('button');
          addBtn.type = 'button';
          addBtn.className = 'sci-add-access';
          addBtn.textContent = '+ Adicionar acesso';
          addBtn.addEventListener('click', () => addRow(true));
          wrapper.appendChild(addBtn);

          fieldControllers[field.label] = {
            getValue: () => rows.map(r => ({ type: r.typeSelect.value, value: r.valueInput.value })),
            focus: () => rows[0] ? rows[0].valueInput.focus() : addBtn.focus(),
            wrapper
          };
        } else {
          // ═══════════════════════════════════════════════════
          // CAMPO DE TEXTO (linha única ou bloco de itens)
          // ═══════════════════════════════════════════════════
          const useTextarea = isBlock || isLongLabel(field.label);
          const input = document.createElement(useTextarea ? 'textarea' : 'input');
          if (!useTextarea) input.type = 'text';
          input.placeholder = field.placeholder;

          if (useTextarea) {
            input.rows = isBlock ? 3 : 2;
            input.addEventListener('input', () => autoGrow(input));
          }
          input.addEventListener('input', () => wrapper.classList.remove('sci-invalid'));

          wrapper.appendChild(input);
          fieldControllers[field.label] = {
            getValue: () => input.value,
            focus: () => input.focus(),
            wrapper
          };
        }

        grid.appendChild(wrapper);
      });

      sectionEl.appendChild(grid);
      sectionsContainer.appendChild(sectionEl);
    });

    // Cancelar
    shadow.getElementById('sciCancel').addEventListener('click', closeAssistant);

    // Inserir (com validação leve de campos obrigatórios)
    const doInsert = () => {
      const currentValues = {};
      Object.entries(fieldControllers).forEach(([label, ctrl]) => {
        currentValues[label] = ctrl.getValue();
      });

      let firstInvalid = null;
      fields.forEach(field => {
        if (!field.required) return;
        const ctrl = fieldControllers[field.label];
        if (!ctrl) return;

        const val = currentValues[field.label];
        const filled = field.type === 'access'
          ? Array.isArray(val) && val.some(e => e.value && e.value.trim())
          : String(val || '').trim().length > 0;

        ctrl.wrapper.classList.toggle('sci-invalid', !filled);
        if (!filled && !firstInvalid) firstInvalid = ctrl;
      });

      if (firstInvalid) {
        firstInvalid.focus();
        return;
      }

      const filledTemplate = SCIUtils.applyFieldValues(baseTemplate, fields, currentValues);
      const finalText = SCIUtils.parseTemplate(filledTemplate, userInfo || { name: '', role: '' });

      if (originalTarget.type === 'input') {
        insertTextInInput(originalTarget.element, finalText);
      } else {
        insertTextInRichEditor(originalTarget.element, finalText);
      }

      // Sem isso, snippets interativos (todos, atualmente) nunca apareciam
      // em usageStats — só o fluxo direto (sem modal) registrava uso.
      try {
        chrome.runtime.sendMessage({ action: 'logUsage', trigger: snippet.trigger });
      } catch (e) {}

      closeAssistant();
    };
    shadow.getElementById('sciInsert').addEventListener('click', doInsert);

    // Atalhos de teclado: ESC fecha, Ctrl+Enter (ou Cmd+Enter) insere rápido.
    // Registrado no HOST (não em document) de propósito — ver bloco de isolamento
    // de teclado abaixo para o motivo.
    const keyHandler = (e) => {
      if (e.key === 'Escape') {
        closeAssistant();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        doInsert();
      }
    };
    host.addEventListener('keydown', keyHandler);

    // ═══════════════════════════════════════════════════════════════════
    // ISOLAMENTO DE TECLADO/FOCO DO MODAL
    // ═══════════════════════════════════════════════════════════════════
    // Muitos sites (ex: Kanboard) têm atalhos de teclado globais de uma letra
    // só (ex: "r", "t") ouvidos em document/body. Bibliotecas de atalho
    // costumam checar se o evento veio de um campo de texto (input/textarea/
    // contentEditable) e, se sim, ignorar o atalho. Só que, como este modal
    // vive dentro de uma Shadow DOM, o evento de teclado sofre "event
    // retargeting": para um listener fora da shadow root (como o da própria
    // página), e.target aparece como o elemento HOST do modal (uma <div>),
    // nunca como o <input>/<textarea> real que está focado. Isso faz a
    // biblioteca de atalhos da página achar que o foco não está em um campo
    // de texto, e o atalho de uma letra acaba disparando enquanto o usuário
    // está digitando dentro do modal.
    //
    // A correção: impedir que qualquer evento de teclado (e de digitação)
    // originado dentro do modal continue se propagando para fora dele. Como
    // esses listeners globais de atalho normalmente escutam na fase de
    // "bubble" (o padrão em addEventListener/jQuery), interceptar aqui no
    // host — parando a propagação antes que o evento suba até document/body —
    // resolve o problema na grande maioria dos casos.
    const isolateFromPage = (e) => e.stopPropagation();
    ['keydown', 'keyup', 'keypress', 'input', 'beforeinput'].forEach(type => {
      host.addEventListener(type, isolateFromPage);
    });

    // Fecha clicando no backdrop.
    // IMPORTANTE: não usar e.target aqui — dentro de Shadow DOM, cliques em qualquer
    // elemento interno (botões, inputs etc.) sofrem "event retargeting" e aparecem
    // como se o alvo fosse o próprio host quando o listener está fora do shadow root.
    // e.composedPath()[0] retorna o elemento real onde o clique ocorreu.
    host.addEventListener('click', (e) => {
      if (e.composedPath()[0] === host) closeAssistant();
    });

    // Também isola cliques do modal (evita que a página reaja a cliques
    // "atrás" do modal, ex: fechar menus, desmarcar seleções do Kanboard).
    ['click', 'mousedown', 'mouseup'].forEach(type => {
      host.addEventListener(type, isolateFromPage);
    });

    document.body.appendChild(host);
    activeModal = host;

    // Ajusta a altura de todas as textareas ao conteúdo/placeholder já no primeiro
    // render — sem isso, o texto (ou o placeholder de várias linhas, como em
    // "Como Reproduzir") ficava cortado até o usuário digitar algo.
    shadow.querySelectorAll('textarea').forEach(autoGrow);

    // Foco no primeiro campo
    setTimeout(() => {
      const firstFocusable = sectionsContainer.querySelector('input, textarea, button');
      if (firstFocusable) firstFocusable.focus();
    }, 60);
  }

  /**
   * Fecha e remove o modal.
   */
  function closeAssistant() {
    if (!activeModal) return;
    // Todos os listeners do modal (teclado, isolamento, clique) foram
    // registrados diretamente no host, então activeModal.remove() já é
    // suficiente para limpá-los — não há nada solto em document/body.
    activeModal.remove();
    activeModal = null;
    originalTarget = null;
  }

  // Expõe globalmente para o content.js chamar
  window.SCIAssistant = { open: openAssistant, close: closeAssistant };
})();