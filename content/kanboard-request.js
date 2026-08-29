/**
 * kan2sci — botão flutuante + modal de "Nova Solicitação SCI", injetados
 * apenas em https://kanboard.sci.com.br/* (ver manifest.json). O modal roda
 * em Shadow DOM para não herdar/colidir com o CSS do Kanboard; ao submeter,
 * o payload vai para o background.js (ação 'PROCESS_FULL_REQUEST'), que
 * preenche o formulário real da Intranet numa aba em segundo plano.
 *
 * IDs prefixados com "kan2sci-kanboard-" para não colidir com o restante da
 * extensão (ex: o modal do assistente de snippets, kan2sci-assistant).
 */
(function () {
  'use strict';

  const TIPOS_SOLICITACAO = [
    'Adaptativa', 'Ajuste', 'Inovação', 'Erro de versão',
    'Erro de versão especial', 'Incremental', 'TA - Erro Fábrica', 'TA - Manutenção'
  ];

  const CLASSIFICACOES = ['Tecnologia', 'Recurso', 'Legislação'];
  const CRITICIDADES = ['Crítica', 'Urgente', 'Alta', 'Normal'];

  // Valores reais confirmados na tela de Etapa 2 (solicitacaoForm.php). O
  // "value" enviado no formulário é o TEXTO da option, não um código numérico
  // — o código só existe no atributo "alt", que não é submetido. Esta lista
  // cobre as opções que ficam HABILITADAS partindo do status inicial
  // "Solicitação registrada"; os demais status (Liberada, Cancelada, Em
  // desenvolvimento etc.) nascem desabilitados até a solicitação avançar no
  // fluxo, então não fazem sentido aqui.
  const STATUS_OPCOES = [
    'Pertinente',
    'Pertinente COM priorização',
    'Aguardando aprovação do orçamento',
    'Orçamento aprovado',
    'Próximas versões',
    'Aguardando retorno do solicitante',
    'Importa para o Visual Suporte'
  ];

  const MAX_ANEXO_BYTES = 30 * 1024 * 1024; // 30MB
  const MAX_TITULO_CHARS = 150;
  const DEFAULTS_KEY = 'kanboardRequestDefaults';

  const FAB_ID = 'kan2sci-kanboard-fab';
  const MODAL_HOST_ID = 'kan2sci-kanboard-request-host';
  const TOAST_ID = 'kan2sci-kanboard-toast';

  let modalOpen = false;

  // ═══════════════════════════════════════════════════
  // BOTÃO FLUTUANTE
  // ═══════════════════════════════════════════════════
  function injectFloatingButton() {
    if (document.getElementById(FAB_ID)) return;

    const btn = document.createElement('button');
    btn.id = FAB_ID;
    btn.type = 'button';
    btn.title = 'Nova Solicitação SCI';
    btn.textContent = '+ Solicitação SCI';
    btn.addEventListener('click', () => openModal());

    document.body.appendChild(btn);
  }

  // Permite que o popup da extensão peça pra abrir o modal nesta aba.
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'OPEN_MODAL') {
      openModal();
      sendResponse({ opened: true });
    }
  });

  // ═══════════════════════════════════════════════════
  // MODAL (Shadow DOM — isolado do CSS do Kanboard)
  // ═══════════════════════════════════════════════════
  function openModal() {
    if (modalOpen) return;
    modalOpen = true;

    const host = document.createElement('div');
    host.id = MODAL_HOST_ID;
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });

    shadow.innerHTML = buildModalHtml();
    injectModalStyles(shadow);

    const closeModal = () => {
      host.remove();
      modalOpen = false;
    };

    shadow.getElementById('kiOverlay').addEventListener('click', (e) => {
      if (e.target.id === 'kiOverlay') closeModal();
    });
    shadow.getElementById('kiCancelBtn').addEventListener('click', closeModal);
    shadow.getElementById('kiCloseBtn').addEventListener('click', closeModal);

    populateSelect(shadow.getElementById('kiTipoSolicitacao'), TIPOS_SOLICITACAO);
    populateSelect(shadow.getElementById('kiClassificacao'), CLASSIFICACOES);
    populateSelect(shadow.getElementById('kiCriticidade'), CRITICIDADES);
    populateSelect(shadow.getElementById('kiStatusForm'), STATUS_OPCOES);

    prefillDefaults(shadow);

    shadow.getElementById('kiForm').addEventListener('submit', (e) => {
      e.preventDefault();
      handleSubmit(shadow, closeModal);
    });

    setTimeout(() => shadow.getElementById('kiClienteId').focus(), 0);
  }

  function populateSelect(select, labels, values) {
    labels.forEach((label, i) => {
      const opt = document.createElement('option');
      opt.value = values ? values[i] : label;
      opt.textContent = label;
      select.appendChild(opt);
    });
  }

  async function prefillDefaults(shadow) {
    try {
      const data = await chrome.storage.local.get(DEFAULTS_KEY);
      const defaults = data[DEFAULTS_KEY] || {};
      if (defaults.nomeSolicitante) shadow.getElementById('kiNomeSolicitante').value = defaults.nomeSolicitante;
      if (defaults.emailParaRetorno) shadow.getElementById('kiEmailParaRetorno').value = defaults.emailParaRetorno;
      if (defaults.clienteId) shadow.getElementById('kiClienteId').value = defaults.clienteId;
    } catch (e) { /* sem defaults salvos ainda, tudo bem */ }
  }

  async function saveDefaults(payload) {
    try {
      await chrome.storage.local.set({
        [DEFAULTS_KEY]: {
          nomeSolicitante: payload.nomeSolicitante,
          emailParaRetorno: payload.emailParaRetorno,
          clienteId: payload.clienteId
        }
      });
    } catch (e) { /* não é crítico, ignora falha */ }
  }

  // ═══════════════════════════════════════════════════
  // VALIDAÇÃO
  // ═══════════════════════════════════════════════════
  function validate(payload, anexoFile) {
    const errors = [];

    if (!payload.clienteId.trim()) errors.push('Cliente ID é obrigatório.');
    else if (!/^\d{1,6}$/.test(payload.clienteId.trim())) errors.push('Cliente ID deve ser numérico, com no máximo 6 dígitos.');

    if (!payload.nomeSolicitante.trim()) errors.push('Nome do solicitante é obrigatório.');
    if (!payload.tipoSolicitacao) errors.push('Tipo de solicitação é obrigatório.');

    if (!payload.emailParaRetorno.trim()) errors.push('E-mail para retorno é obrigatório.');
    else if (!/^\S+@\S+\.\S+$/.test(payload.emailParaRetorno.trim())) errors.push('E-mail para retorno parece inválido.');

    if (!payload.titulo.trim()) errors.push('Título é obrigatório.');
    else if (payload.titulo.length > MAX_TITULO_CHARS) errors.push(`Título deve ter no máximo ${MAX_TITULO_CHARS} caracteres.`);

    if (!payload.descricaoSolicitacao.trim()) errors.push('Descrição da solicitação é obrigatória.');

    if (!payload.classificacao) errors.push('Classificação é obrigatória.');
    if (!payload.criticidade) errors.push('Criticidade é obrigatória.');
    if (!payload.statusForm) errors.push('Status é obrigatório.');

    if (anexoFile && anexoFile.size > MAX_ANEXO_BYTES) {
      errors.push('O anexo excede o limite de 30MB.');
    }

    return errors;
  }

  // ═══════════════════════════════════════════════════
  // SUBMISSÃO
  // ═══════════════════════════════════════════════════
  async function handleSubmit(shadow, closeModal) {
    const anexoInput = shadow.getElementById('kiAnexo');
    const anexoFile = anexoInput.files[0] || null;

    const payload = {
      clienteId: shadow.getElementById('kiClienteId').value,
      nomeSolicitante: shadow.getElementById('kiNomeSolicitante').value,
      tipoSolicitacao: shadow.getElementById('kiTipoSolicitacao').value,
      versaoSolicitacao: shadow.getElementById('kiVersaoSolicitacao').value,
      emailParaRetorno: shadow.getElementById('kiEmailParaRetorno').value,
      emailParaRetornoPrestador: shadow.getElementById('kiEmailPrestador').value,
      titulo: shadow.getElementById('kiTitulo').value,
      descricaoSolicitacao: shadow.getElementById('kiDescricao').value,
      comentarioSCI: shadow.getElementById('kiComentario').value,
      empresa: shadow.getElementById('kiEmpresa').value,
      referencia: shadow.getElementById('kiReferencia').value,
      classificacao: shadow.getElementById('kiClassificacao').value,
      criticidade: shadow.getElementById('kiCriticidade').value,
      statusForm: shadow.getElementById('kiStatusForm').value
    };

    const errors = validate(payload, anexoFile);
    const errorBox = shadow.getElementById('kiErrors');

    if (errors.length) {
      errorBox.innerHTML = errors.map(e => `<li>${escapeHtml(e)}</li>`).join('');
      errorBox.hidden = false;
      return;
    }
    errorBox.hidden = true;

    const confirmed = confirm(
      `Confirma a criação da solicitação "${payload.titulo}"?\n\nUma aba vai abrir em segundo plano, preencher a Etapa 1 e a Etapa 2 (Classificação/Criticidade/Status) reais da Intranet, e clicar em Confirmar em cada uma por você. Isso grava direto na Intranet e não pode ser desfeito por aqui.`
    );
    if (!confirmed) return;

    const submitBtn = shadow.getElementById('kiSubmitBtn');
    const originalText = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Enviando...';

    if (anexoFile) {
      try {
        const buffer = await anexoFile.arrayBuffer();
        payload.anexo = { name: anexoFile.name, type: anexoFile.type, buffer };
      } catch (err) {
        submitBtn.disabled = false;
        submitBtn.textContent = originalText;
        errorBox.innerHTML = `<li>Falha ao ler o anexo: ${escapeHtml(err.message)}</li>`;
        errorBox.hidden = false;
        return;
      }
    }

    chrome.runtime.sendMessage({ action: 'PROCESS_FULL_REQUEST', payload }, (response) => {
      submitBtn.disabled = false;
      submitBtn.textContent = originalText;

      if (chrome.runtime.lastError) {
        errorBox.innerHTML = `<li>Falha de comunicação com a extensão: ${escapeHtml(chrome.runtime.lastError.message)}</li>`;
        errorBox.hidden = false;
        return;
      }

      if (response.success) {
        saveDefaults(payload);
        onAutomationSuccess(response);
        closeModal();
        return;
      }

      if (response.partial) {
        // Etapa 1 já criou a solicitação — não deixa parecer que nada
        // aconteceu, pra não arriscar reenviar e duplicar.
        errorBox.innerHTML = `
          <li>${escapeHtml(response.error)}</li>
          <li>Solicitação #${escapeHtml(response.solicitacaoId || '?')} já foi criada na Intranet — a aba foi deixada aberta e em foco pra você terminar Classificação/Criticidade/Status manualmente.</li>
        `;
        errorBox.hidden = false;
        return;
      }

      errorBox.innerHTML = `
        <li>${escapeHtml(response.error)}</li>
        <li>A aba com o formulário foi deixada aberta e em foco — confira o que a página mostrou antes de tentar de novo, pra não duplicar a solicitação.</li>
      `;
      errorBox.hidden = false;
    });
  }

  /**
   * Atualiza a UI do Kanboard após sucesso (Etapa 1 + Etapa 2 automatizadas).
   * O ID (result.solicitacaoId) é melhor esforço.
   *
   * ⚠️ INTEGRAÇÃO PENDENTE: o seletor abaixo (.board-column .task-list) é um
   * placeholder — ajuste para o seletor real da lista de backlog do Kanboard
   * usado pela equipe.
   */
  function onAutomationSuccess(result) {
    const label = result.solicitacaoId
      ? `Solicitação #${result.solicitacaoId} criada e classificada com sucesso.`
      : 'Solicitação criada e classificada. Não foi possível confirmar o número exato — confira na Intranet.';

    if (result.solicitacaoId) {
      const list = document.querySelector('.board-column .task-list');
      if (list) {
        const row = document.createElement('li');
        row.className = 'task-board-task kan2sci-kanboard-new-row';
        row.textContent = `#${result.solicitacaoId} — criada`;
        list.prepend(row);
      }
    }

    showToast(label);
  }

  function showToast(message) {
    const toast = document.createElement('div');
    toast.id = TOAST_ID;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  // ═══════════════════════════════════════════════════
  // MARKUP
  // ═══════════════════════════════════════════════════
  function buildModalHtml() {
    return `
      <div id="kiOverlay" class="ki-overlay">
        <div class="ki-modal" role="dialog" aria-modal="true" aria-label="Nova Solicitação SCI">
          <header class="ki-header">
            <span class="ki-title">Nova Solicitação SCI</span>
            <button type="button" id="kiCloseBtn" class="ki-close" aria-label="Fechar">&times;</button>
          </header>

          <form id="kiForm" class="ki-body">
            <ul id="kiErrors" class="ki-errors" hidden></ul>

            <div class="ki-section-title">Solicitação</div>
            <div class="ki-grid">
              <div class="ki-field">
                <label for="kiClienteId">Cliente ID *</label>
                <input id="kiClienteId" type="text" inputmode="numeric" maxlength="6" placeholder="Ex: 12345">
              </div>
              <div class="ki-field">
                <label for="kiNomeSolicitante">Nome do Solicitante *</label>
                <input id="kiNomeSolicitante" type="text" placeholder="Nome completo">
              </div>
              <div class="ki-field">
                <label for="kiTipoSolicitacao">Tipo de Solicitação *</label>
                <select id="kiTipoSolicitacao"><option value="">Selecione...</option></select>
              </div>
              <div class="ki-field">
                <label for="kiVersaoSolicitacao">Versão</label>
                <input id="kiVersaoSolicitacao" type="text" placeholder="Opcional">
              </div>
              <div class="ki-field">
                <label for="kiEmailParaRetorno">E-mail para Retorno *</label>
                <input id="kiEmailParaRetorno" type="email" placeholder="cliente@exemplo.com">
              </div>
              <div class="ki-field">
                <label for="kiEmailPrestador">E-mail Prestador</label>
                <input id="kiEmailPrestador" type="email" placeholder="Opcional">
              </div>
              <div class="ki-field full">
                <label for="kiTitulo">Título * <span class="ki-hint">(máx. ${MAX_TITULO_CHARS} caracteres)</span></label>
                <input id="kiTitulo" type="text" maxlength="${MAX_TITULO_CHARS}" placeholder="Resumo curto da solicitação">
              </div>
              <div class="ki-field full">
                <label for="kiDescricao">Descrição *</label>
                <textarea id="kiDescricao" rows="4" placeholder="Detalhe a solicitação..."></textarea>
              </div>
              <div class="ki-field full">
                <label for="kiComentario">Comentário Interno (SCI)</label>
                <textarea id="kiComentario" rows="2" placeholder="Opcional, não visível ao cliente"></textarea>
              </div>
              <div class="ki-field">
                <label for="kiEmpresa">Empresa</label>
                <input id="kiEmpresa" type="text" placeholder="Opcional">
              </div>
              <div class="ki-field">
                <label for="kiReferencia">Referência</label>
                <input id="kiReferencia" type="text" placeholder="Opcional">
              </div>
              <div class="ki-field full">
                <label for="kiAnexo">Anexo <span class="ki-hint">(máx. 30MB)</span></label>
                <input id="kiAnexo" type="file">
              </div>
            </div>

            <div class="ki-section-title">Classificação &amp; Status</div>
            <div class="ki-grid">
              <div class="ki-field">
                <label for="kiClassificacao">Classificação *</label>
                <select id="kiClassificacao"><option value="">Selecione...</option></select>
              </div>
              <div class="ki-field">
                <label for="kiCriticidade">Criticidade *</label>
                <select id="kiCriticidade"><option value="">Selecione...</option></select>
              </div>
              <div class="ki-field">
                <label for="kiStatusForm">Status *</label>
                <select id="kiStatusForm"><option value="">Selecione...</option></select>
              </div>
            </div>
          </form>

          <footer class="ki-footer">
            <button type="button" id="kiCancelBtn" class="ki-btn ki-btn-ghost">Cancelar</button>
            <button type="submit" form="kiForm" id="kiSubmitBtn" class="ki-btn ki-btn-primary">Criar Solicitação</button>
          </footer>
        </div>
      </div>
    `;
  }

  function injectModalStyles(shadow) {
    const style = document.createElement('style');
    // Paleta identica ao restante do kan2sci (--navy / --blue de popup.css).
    style.textContent = `
      :host { all: initial; }
      * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
      .ki-overlay {
        position: fixed; inset: 0; background: rgba(20, 26, 40, 0.55);
        display: flex; align-items: center; justify-content: center;
        z-index: 2147483000;
      }
      .ki-modal {
        width: 100%; max-width: 640px; max-height: 88vh;
        background: #fff; border-radius: 14px; overflow: hidden;
        display: flex; flex-direction: column;
        box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      }
      .ki-header {
        background: #38486c; color: #fff; padding: 16px 20px;
        display: flex; align-items: center; justify-content: space-between;
        flex-shrink: 0;
      }
      .ki-title { font-size: 15px; font-weight: 800; }
      .ki-close {
        background: none; border: none; color: #fff; font-size: 20px;
        cursor: pointer; line-height: 1; opacity: 0.85;
      }
      .ki-close:hover { opacity: 1; }
      .ki-body { padding: 18px 20px; overflow-y: auto; flex: 1; }
      .ki-section-title {
        font-size: 10.5px; font-weight: 800; color: #8b96ab; text-transform: uppercase;
        letter-spacing: 0.6px; margin: 14px 0 8px; padding-bottom: 5px;
        border-bottom: 1px solid #eef1f6;
      }
      .ki-section-title:first-child { margin-top: 0; }
      .ki-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 12px; }
      .ki-field { min-width: 0; }
      .ki-field.full { grid-column: 1 / -1; }
      .ki-field label {
        display: block; font-size: 12px; font-weight: 700; color: #38486c; margin-bottom: 4px;
      }
      .ki-hint { font-weight: 500; color: #9aa4b8; text-transform: none; letter-spacing: 0; }
      .ki-field input, .ki-field select, .ki-field textarea {
        width: 100%; padding: 8px 10px; font-size: 13px; color: #38486c;
        border: 1px solid #d8dde8; border-radius: 6px; background: #fff;
      }
      .ki-field input:focus, .ki-field select:focus, .ki-field textarea:focus {
        outline: none; border-color: #91d8f7; box-shadow: 0 0 0 3px rgba(145,216,247,0.25);
      }
      .ki-field textarea { resize: vertical; font-family: inherit; }
      .ki-errors {
        background: #fdecea; border: 1px solid #f3b3ae; color: #c62828;
        border-radius: 8px; padding: 10px 14px 10px 30px; margin-bottom: 14px; font-size: 12.5px;
      }
      .ki-errors li { margin-bottom: 2px; }
      .ki-footer {
        padding: 14px 20px; border-top: 1px solid #eef1f6;
        display: flex; justify-content: flex-end; gap: 10px; flex-shrink: 0;
      }
      .ki-btn {
        padding: 9px 18px; border-radius: 8px; font-size: 13px; font-weight: 700;
        cursor: pointer; border: none;
      }
      .ki-btn-ghost { background: #fff; color: #38486c; border: 1px solid #d8dde8; }
      .ki-btn-ghost:hover { background: #f4f6f9; }
      .ki-btn-primary { background: #38486c; color: #fff; }
      .ki-btn-primary:hover { background: #2a3652; }
      .ki-btn-primary:disabled { opacity: 0.65; cursor: default; }
    `;
    shadow.appendChild(style);
  }

  // ═══════════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════════
  injectFloatingButton();
  // Kanboard é uma SPA em vários pontos — garante que o botão volta se o DOM
  // for re-renderizado (ex: troca de board) e o elemento antigo for removido.
  new MutationObserver(() => injectFloatingButton()).observe(document.body, { childList: true, subtree: false });

  console.log('[kan2sci] Botão de Nova Solicitação SCI ativo no Kanboard.');
})();