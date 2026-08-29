# kan2sci

## Funcionalidades

- **Expansão de snippets por gatilho** — digite um atalho como `:abrir` em qualquer input, textarea ou editor rico (contentEditable) e o texto é expandido automaticamente.
- **Modal assistido (snippets interativos)** — snippets marcados como `interactive: true` abrem um formulário guiado em vez de colar o template cru, com campos de linha, blocos (passos/bullets), seleção única (pills) e lista dinâmica de acessos.
- **Menu de contexto** — clique com o botão direito em qualquer campo editável para inserir um snippet sem precisar digitar o gatilho.
- **Sincronização automática** — a lista de snippets é buscada de um arquivo YAML remoto (GitHub) na instalação, no início do navegador e a cada 30 minutos, sem ação manual.
- **Perfil do usuário** — nome, cargo e setor, usados para preencher variáveis como `{{assinatura}}` nos templates.
- **Mais usados** — atalhos usados com mais frequência aparecem como chips de acesso rápido no topo do popup.
- **Nova Solicitação SCI (Kanboard)** — em `kanboard.sci.com.br`, um botão flutuante abre um formulário que, ao confirmar, preenche e envia a solicitação real na Intranet (Etapa 1) e, quando possível, também a tela de Classificação/Criticidade/Status (Etapa 2), automaticamente em uma aba de segundo plano.

## Instalação

1. Baixe e descompacte o `.zip` da extensão.
2. Acesse `chrome://extensions` no Chrome.
3. Ative o **Modo do desenvolvedor** (canto superior direito).
4. Clique em **Carregar sem compactação** e selecione a pasta descompactada.

> A pasta `icons/` precisa conter `icon16.png`, `icon32.png`, `icon48.png`, `icon128.png` e `sci-logo.png` — esses arquivos binários não fazem parte deste pacote de código-fonte e devem ser adicionados manualmente antes de carregar a extensão.

## Estrutura do projeto

```
manifest.json              Configuração da extensão (MV3)
background.js               Service worker: sincronização, menu de contexto, automação Kanboard
content/
  content.js                 Detecta gatilhos e expande snippets na página
  content-assistant.js        Modal assistido (formulário guiado) para snippets interativos
  kanboard-request.js         Botão flutuante + modal "Nova Solicitação SCI" no Kanboard
  kanboard-request.css        Estilos do botão flutuante e do toast de sucesso
lib/
  utils.js                    Funções compartilhadas: variáveis de template, extração/aplicação de campos
  yaml-parser.js               Parser do YAML de snippets (sem dependência externa)
popup/
  popup.html / .css / .js     Interface do ícone da extensão (perfil, lista, busca)
data/
  snippets.yml                Snippets padrão usados em desenvolvimento (modo dev)
icons/                       Ícones da extensão (não incluídos neste pacote — ver acima)
```

## Formato dos snippets (`snippets.yml`)

```yaml
- trigger: ":abrir"
  name: "Abertura de Solicitação"
  interactive: true
  replace: |
    ## CONTEXTUALIZAÇÃO DO REQUISITO
    - **URL!:** https://
    ...
```

- `trigger` — texto digitado que aciona a expansão (também usado no menu de contexto).
- `name` — nome amigável exibido no popup e no menu de contexto.
- `interactive` — `true` abre o modal assistido; `false`/ausente cola o template direto.
- `replace` — template em Markdown. Suporta variáveis `{{current_date}}`, `{{user_name}}`, `{{user_role}}`, `{{user_sector}}` e `{{assinatura}}` (monta nome + linha de assinatura de uma vez).

### Campos editáveis do modal assistido

O modal extrai campos automaticamente a partir da formatação do template:

| Padrão no template | Tipo de campo | Exemplo |
|---|---|---|
| `- **Rótulo:** valor` | linha única | `- **URL:** https://` |
| `- Rótulo: ` (sem negrito) | linha única | `- Cliente: ` |
| `**Rótulo:** [ ] A \| [ ] B` | seleção única (pills) | `**Ambiente:** [ ] Produção \| [ ] Homologação` |
| `1. ` (linhas numeradas consecutivas) | bloco dinâmico | passos de reprodução |
| `- ` (bullets vazios consecutivos) | bloco dinâmico | critérios de aceite |
| `{{acessos}}` | lista dinâmica de acessos | usa o subtítulo em negrito acima como rótulo |

**Obrigatoriedade:** adicione `!` logo antes do fechamento do negrito ou dos dois-pontos para marcar um campo como obrigatório. O `!` nunca aparece no texto final:

```
- **URL!:** https://              → campo obrigatório
**Ambiente!:** [ ] Produção...    → seleção obrigatória
## COMO REPRODUZIR!               → todos os blocos da seção são obrigatórios
**Acessos para Teste!**           → exige pelo menos 1 acesso preenchido
{{acessos}}
```

Uma seção `## Evidências` (qualquer nível de cabeçalho) é tratada como aviso fixo no modal, não como campo — lembra o usuário de anexar print/vídeo ao card.

## Configuração

- **Fonte dos snippets:** `background.js` → `CONFIG.GITHUB_YAML_URL`. Em modo desenvolvedor (extensão carregada via "Carregar sem compactação"), usa `data/snippets.yml` local; em produção, busca de `raw.githubusercontent.com/<repo>/main/snippets.yml`. Ajuste o repositório conforme necessário.
- **Intervalo de sincronização:** `CONFIG.SYNC_INTERVAL_MINUTES` (padrão: 30).
- **URL do formulário Kanboard → SCI:** `KANBOARD_REQUEST_FORM_URL` em `background.js`.

## Permissões usadas

| Permissão | Motivo |
|---|---|
| `storage` | Guardar snippets, perfil, estatísticas de uso e status de sincronização. |
| `alarms` | Agendar a sincronização periódica em segundo plano. |
| `contextMenus` | Menu de botão direito para inserir snippets. |
| `scripting` | Preencher o formulário real da Intranet numa aba em segundo plano (automação da Solicitação SCI). |
| `tabs` | Criar/atualizar a aba de automação e aguardar seu carregamento. |
| `host_permissions` (`raw.githubusercontent.com`, `s1991.com.br`, `kanboard.sci.com.br`) | Buscar o YAML de snippets e automatizar o formulário real da Intranet. |

Os content scripts de expansão de snippets (`content.js`, `content-assistant.js`) rodam em `<all_urls>`, pois o objetivo é funcionar em qualquer campo de texto da web usado pela equipe.