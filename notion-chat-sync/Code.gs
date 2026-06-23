/**
 * Notion ↔ Google Chat — sincronização automática (Labyus)
 * Base no Notion: "Ações labyus"
 *
 * A cada execução (gatilho de tempo, ex.: 5 min):
 *   1. Busca no Notion as ações criadas/alteradas desde a última checagem.
 *   2. Descobre o que mudou (nova, status, prazo, responsável, conclusão) comparando
 *      com a "foto" anterior guardada nas Propriedades do Script.
 *   3. Descobre o Projeto -> grupo do Google Chat.
 *        - Se o projeto AINDA não tem grupo, cria o grupo e adiciona o time (Fase 2).
 *   4. Posta um card no grupo, com @menção real do(s) responsável(eis).
 *
 * IMPORTANTE: toda a configuração (tokens, webhooks, e-mails) fica em
 * "Configurações do projeto > Propriedades do script" — NUNCA no código.
 * Veja o README.md.
 */

var NOTION_VERSION = '2022-06-28';

// ---------- Helpers de configuração ----------
function cfg_(k) { return PropertiesService.getScriptProperties().getProperty(k); }
function cfgJson_(k, def) { var v = cfg_(k); if (!v) return def; try { return JSON.parse(v); } catch (e) { return def; } }
function setCfgJson_(k, o) { PropertiesService.getScriptProperties().setProperty(k, JSON.stringify(o)); }

// ============================================================
// ENTRADA PRINCIPAL (ligada ao gatilho de tempo)
// ============================================================
function syncNotionToChat() {
  var props = PropertiesService.getScriptProperties();
  var token = cfg_('NOTION_TOKEN');
  var dbId  = cfg_('NOTION_DATABASE_ID');
  if (!token || !dbId) { Logger.log('Faltam NOTION_TOKEN / NOTION_DATABASE_ID nas Propriedades do Script.'); return; }

  var initialized = cfg_('INITIALIZED') === 'true';
  var lastRun = cfg_('LAST_RUN');
  var nowIso = new Date().toISOString();

  // Na 1ª vez busca tudo; depois, só o que mudou desde a última execução (com 2 min de folga).
  var sinceIso = (initialized && lastRun)
    ? new Date(new Date(lastRun).getTime() - 2 * 60 * 1000).toISOString()
    : null;

  var pages = notionQueryChanged_(token, dbId, sinceIso);

  // 1ª execução: apenas fotografa o estado atual, SEM postar (evita inundar os grupos).
  if (!initialized) {
    pages.forEach(function (p) { saveSnap_(parsePage_(p)); });
    props.setProperty('INITIALIZED', 'true');
    props.setProperty('LAST_RUN', nowIso);
    Logger.log('Inicializado: ' + pages.length + ' tarefas fotografadas (nenhuma mensagem enviada).');
    return;
  }

  pages.forEach(function (p) {
    var cur = parsePage_(p);
    var prev = loadSnap_(cur.id);
    var events = detectChanges_(prev, cur);
    if (events.length) {
      try { notifyProject_(cur, events); }
      catch (err) { Logger.log('Erro ao notificar "' + cur.title + '": ' + err); }
    }
    saveSnap_(cur);
  });

  props.setProperty('LAST_RUN', nowIso);
}

// ============================================================
// NOTION
// ============================================================
function notionQueryChanged_(token, dbId, sinceIso) {
  var url = 'https://api.notion.com/v1/databases/' + dbId + '/query';
  var results = [], cursor = null, guard = 0;
  do {
    var body = { page_size: 100, sorts: [{ timestamp: 'last_edited_time', direction: 'ascending' }] };
    if (sinceIso) body.filter = { timestamp: 'last_edited_time', last_edited_time: { after: sinceIso } };
    if (cursor) body.start_cursor = cursor;

    var resp = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token, 'Notion-Version': NOTION_VERSION },
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() >= 300) { Logger.log('Notion query erro ' + resp.getResponseCode() + ': ' + resp.getContentText()); break; }
    var data = JSON.parse(resp.getContentText());
    results = results.concat(data.results || []);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor && ++guard < 20);
  return results;
}

function richText_(arr) { return (arr || []).map(function (x) { return x.plain_text; }).join(''); }

function parsePage_(p) {
  var pr = p.properties || {};
  function sel(name)  { return (pr[name] && pr[name].select) ? pr[name].select.name : ''; }
  function date(name) { return (pr[name] && pr[name].date)   ? pr[name].date.start  : ''; }
  var owners = ((pr['Responsável'] || {}).people) || [];
  return {
    id: p.id,
    url: p.url,
    edited: p.last_edited_time,
    title: richText_((pr['Tarefa'] || {}).title) || '(sem título)',
    projeto: sel('Projeto'),
    status: sel('Status'),
    categoria: sel('Categoria'),
    prazo: date('Prazo'),
    owners: owners.map(function (u) { return { name: u.name || '', email: (u.person && u.person.email) || '' }; })
  };
}

// ============================================================
// SNAPSHOT (estado anterior, para detectar o que mudou)
// ============================================================
function snapKey_(id) { return 'snap_' + String(id).replace(/-/g, ''); }
function loadSnap_(id) { var v = cfg_(snapKey_(id)); if (!v) return null; try { return JSON.parse(v); } catch (e) { return null; } }
function saveSnap_(t) {
  var snap = {
    status: t.status, prazo: t.prazo, projeto: t.projeto,
    owners: t.owners.map(function (o) { return o.email || o.name; }).sort().join(',')
  };
  PropertiesService.getScriptProperties().setProperty(snapKey_(t.id), JSON.stringify(snap));
}

function detectChanges_(prev, cur) {
  var ev = [];
  var curOwners = cur.owners.map(function (o) { return o.email || o.name; }).sort().join(',');
  if (!prev) { ev.push({ type: 'nova' }); return ev; }
  if (prev.status !== cur.status) {
    if ((cur.status || '').toLowerCase() === 'concluído') ev.push({ type: 'concluida' });
    else ev.push({ type: 'status', from: prev.status, to: cur.status });
  }
  if (prev.prazo !== cur.prazo)   ev.push({ type: 'prazo', to: cur.prazo });
  if (prev.owners !== curOwners)  ev.push({ type: 'responsavel' });
  return ev;
}

// ============================================================
// GOOGLE CHAT
// ============================================================
// e-mail -> ID do usuário no Chat (via Admin SDK Directory; requer conta admin)
function resolveUserId_(email) {
  if (!email) return null;
  try { var u = AdminDirectory.Users.get(email); return (u && u.id) ? u.id : null; }
  catch (e) { Logger.log('Não resolveu ID de ' + email + ': ' + e); return null; }
}

function mentionFor_(owners) {
  // Menção que "pinga" de verdade (<users/ID>); se não resolver o ID, cai no nome em negrito.
  return owners.map(function (o) {
    var id = resolveUserId_(o.email);
    return id ? ('<users/' + id + '>') : ('*' + (o.name || o.email) + '*');
  }).join(' ');
}

function notifyProject_(t, events) {
  var webhooks = cfgJson_('WEBHOOKS_JSON', {});
  var spaces   = cfgJson_('SPACES_JSON', {});
  var projeto  = t.projeto || 'GERAL';

  var headline = buildHeadline_(t, events);
  var mention  = mentionFor_(t.owners);
  var text     = (mention ? mention + ' — ' : '') + headline;
  var card     = buildCard_(t, events, headline);

  // 1) Projeto já tem webhook configurado -> usa o webhook (remetente "Notion")
  if (webhooks[projeto]) { postWebhook_(webhooks[projeto], text, card); return; }

  // 2) Projeto sem grupo -> cria o grupo + adiciona o time (Fase 2) e posta via Chat API
  var spaceName = spaces[projeto];
  if (!spaceName) {
    spaceName = createSpaceForProject_(projeto);
    if (spaceName) { spaces[projeto] = spaceName; setCfgJson_('SPACES_JSON', spaces); }
  }
  if (spaceName) postChatApi_(spaceName, text, card);
  else Logger.log('Sem grupo para o projeto "' + projeto + '" e não foi possível criar.');
}

function createSpaceForProject_(projeto) {
  try {
    var space = Chat.Spaces.create({ displayName: projeto, spaceType: 'SPACE' });

    var emails = (cfg_('TEAM_EMAILS') || '').split(',').map(function (s) { return s.trim(); }).filter(String);
    emails.forEach(function (em) {
      var id = resolveUserId_(em);
      if (!id) return;
      try { Chat.Spaces.Members.create({ member: { name: 'users/' + id, type: 'HUMAN' } }, space.name); }
      catch (e) { Logger.log('Não adicionou ' + em + ' a "' + projeto + '": ' + e); }
    });

    postChatApi_(space.name, '🆕 Grupo do projeto *' + projeto + '* criado automaticamente.', null);
    Logger.log('Grupo criado para "' + projeto + '": ' + space.name);
    return space.name;
  } catch (e) { Logger.log('Falha ao criar grupo "' + projeto + '": ' + e); return null; }
}

function postWebhook_(url, text, card) {
  var payload = { text: text };
  if (card) payload.cardsV2 = [card];
  UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json; charset=UTF-8',
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
}

function postChatApi_(spaceName, text, card) {
  var msg = { text: text };
  if (card) msg.cardsV2 = [card];
  Chat.Spaces.Messages.create(msg, spaceName);
}

// ============================================================
// CARDS
// ============================================================
function buildHeadline_(t, events) {
  return events.map(function (e) {
    if (e.type === 'nova')        return '🆕 Nova ação';
    if (e.type === 'concluida')   return '✅ Concluída';
    if (e.type === 'status')      return '🔄 Status: ' + (e.from || '—') + ' → ' + (e.to || '—');
    if (e.type === 'prazo')       return '📅 Prazo: ' + (e.to ? formatDate_(e.to) : 'removido');
    if (e.type === 'responsavel') return '👤 Responsável atualizado';
    return '✏️ Atualizada';
  }).join('  ·  ');
}

function buildCard_(t, events, headline) {
  var w = [];
  w.push({ decoratedText: { topLabel: 'Tarefa', text: '<b>' + escapeHtml_(t.title) + '</b>' } });
  w.push({ decoratedText: { topLabel: 'Mudança', text: escapeHtml_(headline) } });
  if (t.owners.length) w.push({ decoratedText: { topLabel: 'Responsável', text: escapeHtml_(t.owners.map(function (o) { return o.name || o.email; }).join(', ')) } });
  w.push({ decoratedText: { topLabel: 'Status', text: escapeHtml_(t.status || '—') } });
  if (t.prazo)     w.push({ decoratedText: { topLabel: 'Prazo', text: formatDate_(t.prazo) } });
  if (t.categoria) w.push({ decoratedText: { topLabel: 'Categoria', text: escapeHtml_(t.categoria) } });
  w.push({ buttonList: { buttons: [{ text: 'Abrir no Notion', onClick: { openLink: { url: t.url } } }] } });

  return {
    cardId: 'acao-' + String(t.id).replace(/-/g, ''),
    card: {
      header: { title: (t.projeto || 'GERAL'), subtitle: 'Ações labyus · Notion' },
      sections: [{ widgets: w }]
    }
  };
}

function escapeHtml_(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function formatDate_(iso) { if (!iso) return '—'; var p = String(iso).substring(0, 10).split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }

// ============================================================
// SETUP / UTILITÁRIOS (rodar manualmente uma vez)
// ============================================================

// Cria o gatilho de tempo. Rode 1x (vai pedir autorização das permissões).
function createTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (tr) {
    if (tr.getHandlerFunction() === 'syncNotionToChat') ScriptApp.deleteTrigger(tr);
  });
  ScriptApp.newTrigger('syncNotionToChat').timeBased().everyMinutes(5).create();
  Logger.log('Gatilho criado: executa a cada 5 minutos.');
}

// Testa a conexão com o Notion e mostra quantas tarefas existem.
function testConnection() {
  var token = cfg_('NOTION_TOKEN'), dbId = cfg_('NOTION_DATABASE_ID');
  if (!token || !dbId) { Logger.log('Configure NOTION_TOKEN e NOTION_DATABASE_ID primeiro.'); return; }
  var pages = notionQueryChanged_(token, dbId, null);
  Logger.log('OK! ' + pages.length + ' tarefas encontradas na base.');
  if (pages.length) Logger.log('Exemplo: ' + JSON.stringify(parsePage_(pages[0]), null, 2));
}

// Zera o estado (fotos + flags). A próxima execução re-fotografa SEM postar.
function resetState() {
  var props = PropertiesService.getScriptProperties();
  props.getKeys().forEach(function (k) { if (k.indexOf('snap_') === 0) props.deleteProperty(k); });
  props.deleteProperty('INITIALIZED');
  props.deleteProperty('LAST_RUN');
  Logger.log('Estado limpo.');
}

// ============================================================
// TEMPO REAL (push) — recebe o webhook da automação do Notion
// Publicar como "App da Web" (Implantar > Nova implantação > App da Web).
// Opcional: defina a propriedade WEBHOOK_SECRET e use a URL com ?key=SECRET.
// ============================================================
function doPost(e) {
  try {
    var secret = cfg_('WEBHOOK_SECRET');
    if (secret && (!e || !e.parameter || e.parameter.key !== secret)) {
      return ContentService.createTextOutput('forbidden');
    }
    var body = (e && e.postData && e.postData.contents) ? JSON.parse(e.postData.contents) : {};
    var pageId = (body.data && body.data.id) || body.id || (body.page && body.page.id);
    if (!pageId) return ContentService.createTextOutput('sem page id');

    var page = notionGetPage_(cfg_('NOTION_TOKEN'), pageId);
    if (!page) return ContentService.createTextOutput('pagina nao encontrada');

    var cur = parsePage_(page);
    var events = detectChanges_(loadSnap_(cur.id), cur);
    if (events.length) {
      try { notifyProject_(cur, events); } catch (err) { Logger.log('Erro notify (push): ' + err); }
    }
    saveSnap_(cur);
    return ContentService.createTextOutput('ok');
  } catch (err) {
    Logger.log('doPost erro: ' + err);
    return ContentService.createTextOutput('erro');
  }
}

function notionGetPage_(token, pageId) {
  var resp = UrlFetchApp.fetch('https://api.notion.com/v1/pages/' + pageId, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + token, 'Notion-Version': NOTION_VERSION },
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() >= 300) { Logger.log('Notion get page erro ' + resp.getResponseCode() + ': ' + resp.getContentText()); return null; }
  return JSON.parse(resp.getContentText());
}
