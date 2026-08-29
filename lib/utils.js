/**
 * Módulo de funções reutilizáveis entre background, content e popup.
 * v3.0 — Campos inteligentes: select (ambiente/dependência) e access (acessos dinâmicos)
 */

const SCIUtils = {
  /**
   * Flag de desenvolvimento: true = usa YAML local, false = usa GitHub raw.
   * (Referência para uso no background.js)
   */
  IS_DEV: true,

  /**
   * Formata uma data no padrão brasileiro (DD/MM/YYYY).
   */
  formatDateBR(date = new Date()) {
    const d = String(date.getDate()).padStart(2, '0');
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const y = date.getFullYear();
    return `${d}/${m}/${y}`;
  },

  /**
   * Processa variáveis dinâmicas em templates de snippet.
   * Suporta: {{current_date}}, {{user_name}}, {{user_role}}
   */
  parseTemplate(template, userInfo = {}) {
    const now = new Date();
    return template
      .replace(/\{\{current_date\}\}/g, this.formatDateBR(now))
      .replace(/\{\{user_name\}\}/g, userInfo.name || 'Colaborador')
      .replace(/\{\{user_role\}\}/g, userInfo.role || 'Equipe SCI');
  },

  /**
   * Debounce para limitar frequência de execução.
   */
  debounce(fn, ms) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), ms);
    };
  },

  /**
   * Logger centralizado com níveis.
   */
  log(level, message, data) {
    const prefix = '[kan2sci]';
    const method = ['error', 'warn'].includes(level) ? level : 'log';
    const entry = { timestamp: new Date().toISOString(), level, message, data };
    if (data) {
      console[method](prefix, message, data);
    } else {
      console[method](prefix, message);
    }
    return entry;
  },

  /**
   * Verifica se um elemento é um campo de texto editável.
   */
  isEditableElement(element) {
    if (!element) return false;
    const tag = element.tagName;
    const editable = element.isContentEditable;
    const isInput = tag === 'INPUT' || tag === 'TEXTAREA';
    const isRichEditor = editable || element.getAttribute('role') === 'textbox';
    return isInput || isRichEditor;
  },

  /**
   * Sanitiza texto para inserção segura.
   */
  sanitizeText(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },

  // ============================================================
  // Suporte a Snippets Interativos (Modal Assistido)
  // ============================================================

  /**
   * Extrai campos editáveis de um template de snippet.
   *
   * Tipos de campo:
   *  - 'line'   → um <input>/<textarea> substitui exatamente uma linha (ex: URL, Admin).
   *  - 'block'  → uma única <textarea> (um item por linha) substitui um GRUPO de linhas
   *               consecutivas (passos numerados ou bullets vazios). Basta o template ter
   *               UMA linha "1. " ou "- " sob o título — o modal gera quantos itens o
   *               usuário precisar, sem ficar preso à contagem de linhas do template.
   *  - 'select' → escolha única entre opções em checkbox no formato
   *               "**Rótulo:** [ ] Opção A | [ ] Opção B" (ex: Ambiente, Dependência).
   *               Renderiza como botões (pills) no modal; ao inserir, marca "[x]" na
   *               opção escolhida e mantém as demais como "[ ]".
   *  - 'access' → lista dinâmica de acessos. Marcada no template com a linha literal
   *               "{{acessos}}". Renderiza linhas + botão "select" e vira "- Tipo: valor"
   *               apenas para os itens que o usuário efetivamente preencheu.
   *
   * Cada campo carrega `section` (o título ## mais próximo acima) para permitir
   * agrupar visualmente o formulário do jeito que o ticket é organizado.
   *
   * OBRIGATORIEDADE — definida direto no snippets.yml, sem tocar em código:
   *  - Usa-se "!" (nunca "*") como marcador, justamente para não se confundir com o
   *    "**negrito**" que já aparece em todo o resto do template.
   *  - Campos 'line' e 'select' ficam obrigatórios com um "!" logo após o rótulo,
   *    antes do fechamento do negrito ou dos dois-pontos:
   *      "- **URL!:** https://"          (bold)
   *      "**Ambiente!:** [ ] Produção..." (select)
   *      "- Cliente!: "                   (sem negrito)
   *  - Campos 'block' (passos numerados / bullets) não têm rótulo próprio, então o
   *    "!" vai no título da seção e vale para todos os blocos daquela seção:
   *      "## COMO REPRODUZIR!"
   *  - Campos 'access' ficam obrigatórios com "!" no subtítulo em negrito acima do
   *    "{{acessos}}" (sem dois-pontos, é só um rótulo): "**Acessos para Teste!**"
   *    (exige ao menos 1 acesso preenchido).
   *  - O "!" é sempre removido do texto antes de virar rótulo ou ser inserido no
   *    ticket final — ele nunca aparece no resultado, é só sinalização de template.
   *
   * @param {string} template - Texto bruto do snippet
   * @returns {Array} Lista de campos editáveis
   */
  extractEditableFields(template) {
    const fields = [];
    const lines = template.split('\n');

    // "**Rótulo:** [ ] Opção A | [ ] Opção B | ..." → campo de seleção única (pills).
    // O "!" opcional logo após o rótulo (antes do fechamento do negrito) marca o campo
    // como obrigatório — ex: "**Ambiente!:** [ ] Produção | [ ] Homologação".
    // Usamos "!" (e não "*") justamente para não se misturar com o "**negrito**" do template.
    const selectFieldRegex = /^(\s*[-*]?\s*\*\*([^*]+?)(!)?(?::\*\*|\*\*:)\s*)(\[[ xX]?\]\s*.+)$/;
    // "{{acessos}}" isolado em uma linha → campo dinâmico de acessos.
    const accessLineRegex = /^\s*\{\{\s*acessos\s*\}\}\s*$/i;
    // Aceita "**Label:**" (dois-pontos dentro do negrito, formato usado no snippets.yml)
    // e "**Label**:" (dois-pontos fora). Exige o ":" colado ao "**" para não confundir
    // títulos de seção (ex: "**Acessos para Teste**", sem dois-pontos) com campos.
    // Mesmo marcador "!" de obrigatoriedade do select acima se aplica aqui.
    const boldFieldRegex   = /^(\s*[-*]?\s*\*\*([^*]+?)(!)?(?::\*\*|\*\*:)\s*)(\{\{[^}]+\}\}|https?:\/\/|)\s*$/;
    const plainFieldRegex  = /^(\s*[-*]\s+)([^:\[\]]+?)(!)?(:\s*)$/;
    const stepLineRegex    = /^\s*\d+\.\s*$/;
    const emptyBulletLine  = /^\s*[-*]\s*$/;
    // O "!" opcional ao final do título de seção marca TODOS os blocos (passos/bullets)
    // daquela seção como obrigatórios — ex: "## COMO REPRODUZIR!". Blocos não têm um
    // rótulo próprio onde colocar o marcador, então ele fica no título da seção.
    const headingRegex     = /^(#{1,3})\s+(.+)$/;

    // Remove o marcador "!" de obrigatoriedade que fica colado ao "**" de fechamento
    // (ex: "URL!:**" -> "URL:**"), sem afetar os "**" do negrito em si.
    const stripRequiredMarker = (str) => str.replace(/!(?=:\*\*|\*\*:)/, '');

    let currentHeading = '';
    let currentHeadingRequired = false;
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      const headingMatch = line.match(headingRegex);
      if (headingMatch) {
        let headingText = headingMatch[2].trim();
        currentHeadingRequired = headingText.endsWith('!');
        if (currentHeadingRequired) headingText = headingText.slice(0, -1).trim();
        currentHeading = headingText;
        i++;
        continue;
      }

      let m;

      // 1) Campo de acessos dinâmico: "{{acessos}}"
      if (accessLineRegex.test(line)) {
        // Usa o subtítulo em negrito imediatamente acima como rótulo
        // (ex: "**Acessos para Teste**" -> "Acessos para Teste"), já que o
        // título de seção (##) normalmente engloba outros campos também.
        // Um "!" antes do fechamento do negrito marca a lista como obrigatória
        // (pelo menos um acesso deve ser preenchido).
        let label = 'Acessos';
        let required = false;
        for (let k = i - 1; k >= 0; k--) {
          const prevTrimmed = lines[k].trim();
          if (prevTrimmed === '') continue;
          const boldOnly = prevTrimmed.match(/^\*\*([^*]+?)(!)?\*\*$/);
          if (boldOnly) {
            label = boldOnly[1].trim();
            required = !!boldOnly[2];
          }
          break;
        }
        fields.push({
          type: 'access',
          startLine: i,
          endLine: i,
          label,
          section: currentHeading,
          currentValue: [],
          required,
          placeholder: ''
        });
        i++;
        continue;
      }

      // 2) Campo de seleção única: "**Rótulo:** [ ] Opção A | [ ] Opção B"
      if ((m = line.match(selectFieldRegex))) {
        const label = m[2].trim();
        const rawOptions = m[4].split('|').map(s => s.trim());
        const options = rawOptions.map(opt => {
          const checked = /^\[[xX]\]/.test(opt);
          const text = opt.replace(/^\[[ xX]?\]\s*/, '').trim();
          return { text, checked };
        }).filter(o => o.text);
        const defaultOption = options.find(o => o.checked);

        fields.push({
          type: 'select',
          lineIndex: i,
          label,
          section: currentHeading,
          prefix: stripRequiredMarker(m[1]),
          options: options.map(o => o.text),
          currentValue: defaultOption ? defaultOption.text : '',
          required: !!m[3],
          placeholder: ''
        });
        i++;
        continue;
      }

      // 3) Campo em negrito: "- **Label:** valor|{{..}}|https://"
      if ((m = line.match(boldFieldRegex))) {
        const label = m[2].trim();
        fields.push({
          type: 'line',
          lineIndex: i,
          label,
          section: currentHeading,
          prefix: stripRequiredMarker(m[1]),
          currentValue: m[4] || '',
          required: !!m[3],
          placeholder: this.inferPlaceholder(label)
        });
        i++;
        continue;
      }

      // 4) Campo simples sem negrito: "- Admin: ", "- Cliente*: "
      if ((m = line.match(plainFieldRegex))) {
        const label = m[2].trim();
        fields.push({
          type: 'line',
          lineIndex: i,
          label,
          section: currentHeading,
          prefix: m[1] + label + m[4],
          currentValue: '',
          required: !!m[3],
          placeholder: this.inferPlaceholder(label)
        });
        i++;
        continue;
      }

      // 5) Bloco de passos numerados consecutivos ("1.", "2.", "3.") → 1 campo dinâmico.
      //    Basta o template ter uma única linha "1. " — o modal cuida da numeração final.
      //    Obrigatoriedade vem do título da seção (ex: "## COMO REPRODUZIR*").
      if (stepLineRegex.test(line)) {
        const start = i;
        let j = i;
        while (j < lines.length && stepLineRegex.test(lines[j])) j++;
        const label = currentHeading || 'Passos';
        fields.push({
          type: 'block',
          bulletStyle: 'numbered',
          startLine: start,
          endLine: j - 1,
          label,
          section: currentHeading,
          currentValue: '',
          required: currentHeadingRequired,
          placeholder: 'Acesse o módulo X\nClique em "Y"\nObserve o erro Z'
        });
        i = j;
        continue;
      }

      // 6) Bloco de bullets vazios consecutivos ("- ") sob uma seção → 1 campo dinâmico.
      //    Obrigatoriedade também vem do título da seção.
      if (emptyBulletLine.test(line) && currentHeading) {
        const start = i;
        let j = i;
        while (j < lines.length && emptyBulletLine.test(lines[j])) j++;
        fields.push({
          type: 'block',
          bulletStyle: 'bullet',
          startLine: start,
          endLine: j - 1,
          label: currentHeading,
          section: currentHeading,
          currentValue: '',
          required: currentHeadingRequired,
          placeholder: 'opcional...'
        });
        i = j;
        continue;
      }

      i++;
    }

    return fields;
  },

  /**
   * Sugere um placeholder de input baseado no nome do campo.
   *
   * @param {string} label - Nome do campo (ex: "URL", "Caminho")
   * @returns {string} Texto placeholder para o <input>
   */
  inferPlaceholder(label) {
    const map = {
      'URL': 'https://www.sciweb.com.br/...',
      'Caminho': 'Módulo > Submenu',
      'Comportamento Atual': 'Descreva o que acontece...',
      'Comportamento Esperado': 'Descreva o que deveria acontecer...',
      'Comportamento Obtido': 'Descreva o que aconteceu no teste...',
      'Motivo': 'Descreva o motivo...',
      'Dúvida': 'Qual é a dúvida?',
      'Correção Principal': 'O que foi corrigido?',
      'Cenários Relacionados / Regressão': 'Quais cenários foram testados?',
      'O que foi feito': 'Liste as alterações realizadas...',
      'Onde/como testar': 'Descreva o cenário de teste...',
      'Impactos/alterações adicionais': 'Houve impacto em outros módulos?',
      'Cenário Principal': 'Descreva o cenário principal de teste...',
      'Cenário Atual': 'O que acontece hoje?'
    };
    return map[label] || `Preencha ${label.toLowerCase()}...`;
  },

  /**
   * Reconstroi o template substituindo os campos editáveis pelos valores preenchidos.
   *
   * - Campos 'line' e 'select' ocupam exatamente uma linha de saída.
   * - Campos 'block' e 'access' são "expansíveis": podem gerar mais, menos ou nenhuma
   *   linha de saída, dependendo do que o usuário preencheu no modal.
   *
   * @param {string} template - Template original
   * @param {Array} fields - Campos extraídos por extractEditableFields
   * @param {Object} values - Objeto { label: valorPreenchido } (string, ou array para 'access')
   * @returns {string} Template com valores aplicados
   */
  applyFieldValues(template, fields, values) {
    const lines = template.split('\n');

    const lineFields = new Map();
    const expandableFields = [];
    fields.forEach(f => {
      if (f.type === 'block' || f.type === 'access') expandableFields.push(f);
      else lineFields.set(f.lineIndex, f);
    });
    expandableFields.sort((a, b) => a.startLine - b.startLine);

    const output = [];
    let i = 0;
    let expPtr = 0;

    while (i < lines.length) {
      const exp = expandableFields[expPtr];

      if (exp && exp.startLine === i) {
        if (exp.type === 'block') {
          const raw = values[exp.label] !== undefined ? values[exp.label] : exp.currentValue;
          const items = String(raw || '')
            .split('\n')
            .map(s => s.trim())
            .filter(s => s.length > 0);

          if (items.length === 0) {
            // Mantém uma linha vazia no formato original para não quebrar a estrutura do template.
            output.push(exp.bulletStyle === 'numbered' ? '1. ' : '- ');
          } else {
            items.forEach((item, idx) => {
              const bullet = exp.bulletStyle === 'numbered' ? `${idx + 1}. ` : '- ';
              output.push(bullet + item);
            });
          }
        } else if (exp.type === 'access') {
          const raw = values[exp.label] !== undefined ? values[exp.label] : exp.currentValue;
          const entries = Array.isArray(raw) ? raw : [];
          entries
            .filter(e => e && String(e.value || '').trim().length > 0)
            .forEach(e => output.push(`- ${e.type}: ${String(e.value).trim()}`));
          // Sem entradas preenchidas: nenhuma linha é gerada (mostra apenas o que foi inserido).
        }

        i = exp.endLine + 1;
        expPtr++;
        continue;
      }

      if (lineFields.has(i)) {
        const field = lineFields.get(i);

        if (field.type === 'select') {
          const selected = values[field.label] !== undefined ? values[field.label] : field.currentValue;
          // No ticket final entra só a opção escolhida (texto puro), não a lista
          // inteira de checkboxes — isso só existe como UI de seleção no modal.
          output.push(field.prefix + (selected || ''));
        } else {
          const value = values[field.label] !== undefined ? values[field.label] : field.currentValue;
          const sep = value && !/\s$/.test(field.prefix) ? ' ' : '';
          output.push(field.prefix + sep + value);
        }
      } else {
        output.push(lines[i]);
      }
      i++;
    }

    return output.join('\n');
  },

  /**
   * Verifica se um snippet deve ser expandido no modo assistido (modal).
   * Útil para decidir entre expansão direta ou abertura do painel.
   *
   * @param {Object} snippet - Objeto do snippet
   * @returns {boolean}
   */
  isInteractiveSnippet(snippet) {
    return snippet && snippet.interactive === true;
  }
};

// Exporta para uso em módulos ou scripts tradicionais
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SCIUtils;
}