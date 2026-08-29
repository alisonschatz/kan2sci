const SCIYamlParser = {
  /**
   * Extrai blocos de snippet a partir do texto YAML bruto.
   * Suporta delimitadores com e sem aspas.
   */
  parse(yamlText) {
    if (!yamlText || typeof yamlText !== 'string') {
      throw new Error('Conteudo YAML invalido ou vazio.');
    }

    const snippets = [];
    const lines = yamlText.split(/\r?\n/);

    let currentSnippet = null;
    let inReplaceBlock = false;
    let replaceIndent = 0;
    let replaceLines = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Ignora comentários e linhas vazias fora de blocos
      if (!inReplaceBlock && (trimmed.startsWith('#') || trimmed === '')) {
        continue;
      }

      // Detecta inicio de novo snippet
      if (trimmed.startsWith('- trigger:')) {
        // Salva snippet anterior se existir
        if (currentSnippet) {
          if (replaceLines.length > 0) {
            currentSnippet.replace = this.dedent(replaceLines).join('\n');
          }
          snippets.push(this.validateAndClean(currentSnippet));
        }

        const triggerValue = this.extractValue(trimmed, 'trigger');
        currentSnippet = {
          trigger: triggerValue,
          name: triggerValue,
          replace: '',
          interactive: false  // padrão
        };
        inReplaceBlock = false;
        replaceLines = [];
        continue;
      }

      if (!currentSnippet) continue;

      // Extrai nome
      if (trimmed.startsWith('name:')) {
        currentSnippet.name = this.extractValue(trimmed, 'name') || currentSnippet.trigger;
        continue;
      }

      // Extrai interactive
      if (trimmed.startsWith('interactive:')) {
        const val = this.extractValue(trimmed, 'interactive');
        currentSnippet.interactive = (val === 'true' || val === true);
        continue;
      }

      // Detecta inicio do bloco replace
      if (trimmed.startsWith('replace:')) {
        const afterReplace = trimmed.substring('replace:'.length).trim();
        if (afterReplace === '|' || afterReplace === '') {
          inReplaceBlock = true;
          replaceIndent = this.getIndentLevel(line) + 2;
          replaceLines = [];
        } else {
          // replace inline (sem pipe)
          currentSnippet.replace = this.unquote(afterReplace);
          inReplaceBlock = false;
        }
        continue;
      }

      // Acumula linhas do bloco replace
      if (inReplaceBlock) {
        if (trimmed === '' || this.getIndentLevel(line) >= replaceIndent) {
          replaceLines.push(line);
        } else if (trimmed.startsWith('- ') || trimmed.startsWith('trigger:') || trimmed.startsWith('name:') || trimmed.startsWith('interactive:')) {
          // Fim do bloco detectado (novo item ou novo snippet)
          if (replaceLines.length > 0) {
            currentSnippet.replace = this.dedent(replaceLines).join('\n');
          }
          snippets.push(this.validateAndClean(currentSnippet));

          // Reinicia para possivel novo snippet
          if (trimmed.startsWith('- trigger:')) {
            const triggerValue = this.extractValue(trimmed, 'trigger');
            currentSnippet = {
              trigger: triggerValue,
              name: triggerValue,
              replace: '',
              interactive: false
            };
            inReplaceBlock = false;
            replaceLines = [];
          } else {
            currentSnippet = null;
            inReplaceBlock = false;
          }
        } else {
          replaceLines.push(line);
        }
      }
    }

    // Processa ultimo snippet
    if (currentSnippet) {
      if (replaceLines.length > 0) {
        currentSnippet.replace = this.dedent(replaceLines).join('\n');
      }
      snippets.push(this.validateAndClean(currentSnippet));
    }

    return snippets;
  },

  /**
   * Extrai valor de uma chave YAML, removendo aspas se presentes.
   */
  extractValue(line, key) {
    const prefix = `${key}:`;
    const idx = line.indexOf(prefix);
    if (idx === -1) return '';
    let value = line.substring(idx + prefix.length).trim();
    return this.unquote(value);
  },

  /**
   * Remove aspas simples ou duplas de uma string.
   */
  unquote(str) {
    if ((str.startsWith('"') && str.endsWith('"')) ||
        (str.startsWith("'") && str.endsWith("'"))) {
      return str.slice(1, -1);
    }
    return str;
  },

  /**
   * Retorna nivel de indentacao em espacos.
   */
  getIndentLevel(line) {
    let count = 0;
    for (const ch of line) {
      if (ch === ' ') count++;
      else if (ch === '\t') count += 2;
      else break;
    }
    return count;
  },

  /**
   * Remove indentacao comum de um array de linhas.
   */
  dedent(lines) {
    const nonEmpty = lines.filter(l => l.trim() !== '');
    if (nonEmpty.length === 0) return lines;

    const minIndent = Math.min(...nonEmpty.map(l => this.getIndentLevel(l)));
    return lines.map(l => {
      if (l.trim() === '') return '';
      return l.substring(minIndent);
    });
  },

  /**
   * Valida e limpa um snippet antes de adicionar a lista.
   */
  validateAndClean(snippet) {
    return {
      trigger: String(snippet.trigger || '').trim(),
      name: String(snippet.name || snippet.trigger || 'Snippet').trim(),
      replace: String(snippet.replace || '').trimEnd(),
      interactive: snippet.interactive === true
    };
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SCIYamlParser;
}