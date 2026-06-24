# Notion ↔ Google Chat — sincronização automática (Labyus)

Motor que lê a base **"Ações labyus"** no Notion e, automaticamente:

- posta no **grupo do Google Chat do projeto** quando uma ação é **criada, muda de status, de prazo, de responsável ou é concluída**;
- **menciona (@)** o responsável de verdade;
- quando aparece um **projeto novo** (opção nova na propriedade *Projeto*), **cria o grupo** no Chat e **adiciona o time** sozinho.

Roda como um **Google Apps Script** dentro do Workspace da Labyus, com um gatilho de tempo (a cada 5 min).
Nenhum segredo fica no código — tudo vai em **Propriedades do Script**.

---

## Pré-requisitos
- Ser **admin** do Google Workspace (para resolver @menções e criar grupos via API).
- A base **"Ações labyus"** no Notion (database id `48d269118a104c95af5de42e69b879b9`).
- Os webhooks dos grupos que já existem (1 por projeto).

---

## Parte A — Sincronização + @menção (o essencial)

### 1. Criar a integração do Notion
1. Acesse <https://www.notion.so/my-integrations> → **New integration** (interna).
2. Em **Capabilities**, marque *Read content* e **Read user information including email addresses** (necessário para a @menção).
3. Copie o **Internal Integration Token** (`secret_...`).
4. Abra a base **"Ações labyus"** no Notion → menu `•••` → **Connections** → conecte a integração.

### 2. Criar o projeto Apps Script
1. Acesse <https://script.google.com> → **Novo projeto**.
2. Cole o conteúdo de [`Code.gs`](./Code.gs) no arquivo de código.
3. Ative o **manifesto**: ⚙️ *Configurações do projeto* → marque *Mostrar arquivo de manifesto "appsscript.json"* e cole o conteúdo de [`appsscript.json`](./appsscript.json).

### 3. Habilitar as APIs (serviços avançados)
No editor do Apps Script, em **Serviços (+)**, adicione:
- **Google Chat API** (`Chat`)
- **Admin SDK API / Directory** (`AdminDirectory`)

> Pode ser necessário associar um **projeto do Google Cloud** ao script e habilitar nele as APIs *Google Chat API* e *Admin SDK API* (⚙️ Configurações do projeto → Projeto do Google Cloud).

### 4. Configurar as Propriedades do Script
⚙️ *Configurações do projeto* → **Propriedades do script** → adicione:

| Propriedade | Valor |
|---|---|
| `NOTION_TOKEN` | `secret_...` (token da etapa 1) |
| `NOTION_DATABASE_ID` | `48d269118a104c95af5de42e69b879b9` |
| `TEAM_EMAILS` | `axel@labyus.com, gabrielaaprigio@labyus.com, gustavomb@labyus.com, iago@labyus.com, lucaslopes@labyus.com, luiz@labyus.com, tamiris@labyus.com, gestao@labyus.com` |
| `WEBHOOKS_JSON` | mapa **Projeto → URL do webhook** (veja abaixo) |

Formato do `WEBHOOKS_JSON` (uma linha; troque pelos webhooks reais de cada grupo):

```json
{
  "MDA DR": "https://chat.googleapis.com/v1/spaces/XXX/messages?key=...&token=...",
  "MDA WHITE": "https://chat.googleapis.com/v1/spaces/XXX/messages?key=...&token=...",
  "MDA WEBNAR": "https://chat.googleapis.com/v1/spaces/XXX/messages?key=...&token=...",
  "SECRETOS DE PARIS": "https://chat.googleapis.com/v1/spaces/XXX/messages?key=...&token=...",
  "CHEGUEI LÁ!": "https://chat.googleapis.com/v1/spaces/XXX/messages?key=...&token=...",
  "CHEGUEI LÁ! - LATAM": "https://chat.googleapis.com/v1/spaces/XXX/messages?key=...&token=...",
  "MIDIAS": "https://chat.googleapis.com/v1/spaces/XXX/messages?key=...&token=...",
  "TESTES": "https://chat.googleapis.com/v1/spaces/XXX/messages?key=...&token=...",
  "GERAL": "https://chat.googleapis.com/v1/spaces/XXX/messages?key=...&token=..."
}
```

> ⚠️ As chaves (`MDA DR`, `MIDIAS`, `GERAL`, …) precisam bater **exatamente** com as opções da propriedade *Projeto* no Notion.

### 5. Testar e ligar
1. No editor, selecione a função **`testConnection`** → **Executar**. Autorize as permissões quando pedir. O log deve mostrar "OK! N tarefas encontradas".
2. Selecione **`createTrigger`** → **Executar**. Pronto: roda a cada 5 min.
   - A **1ª execução** apenas "fotografa" as tarefas atuais (não posta nada) — isso evita inundar os grupos.
   - A partir daí, qualquer mudança vira mensagem no grupo do projeto.

---

## Parte B — Criação automática de grupos (Fase 2)

Já está no código: se uma ação tiver um **Projeto sem webhook** em `WEBHOOKS_JSON`, o script
**cria o grupo** (Chat API), **adiciona** os e-mails de `TEAM_EMAILS` e passa a postar ali.
Requer apenas que a **Google Chat API** e o **Admin SDK** estejam habilitados (Parte A, etapa 3) e a conta autorizadora seja admin.

> Os grupos recém-criados são guardados em `SPACES_JSON` (gerado pelo próprio script).

---

## Funções úteis
| Função | Para quê |
|---|---|
| `testConnection` | Confere token/leitura do Notion |
| `createTrigger`  | Liga a execução automática (5 min) |
| `resetState`     | Zera as "fotos" (a próxima execução re-fotografa sem postar) |

## Notas
- As mensagens nos grupos **existentes** saem pelo webhook (remetente do webhook); grupos **criados** pelo script postam via Chat API.
- ⚠️ **@menção que notifica ("ping") só funciona via Chat API** (grupos criados pelo script). Pelo **webhook**, o Google **não permite** marcar uma pessoa específica — a menção sai só como **nome em negrito**, sem notificar. (Limitação do Google: <https://issuetracker.google.com/issues/329815971>.) Para ping de verdade em todos os grupos, use o caminho da Chat API (Parte B) ou adicione o app do Chat aos grupos existentes.
- Cadência: 5 min (ajuste em `createTrigger`, `everyMinutes`).
- Se a @menção não "pingar", confirme que a integração do Notion tem a permissão de **ler e-mails** e que a conta do Apps Script é **admin** (para o Admin SDK resolver `e-mail → ID`).
