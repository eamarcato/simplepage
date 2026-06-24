/**
 * ETAPA 1 (versão simples) — Notion -> Google Chat via webhooks.
 *
 * Faz: a cada 5 min, vê o que mudou na base "Ações labyus" e posta no grupo
 * do projeto (pelo webhook). A menção do responsável sai em NEGRITO (sem "ping").
 *
 * NÃO precisa de Google Cloud / Admin SDK / Chat API. É só colar este arquivo,
 * preencher as Propriedades do Script e rodar. (A @menção real e a criação
 * automática de grupos ficam para a Etapa 2, com o arquivo Code.gs.)
 *
 * Propriedades do Script necessárias:
 *   NOTION_TOKEN, NOTION_DATABASE_ID, WEBHOOKS_JSON
 */

var NOTION_VERSION = '2022-06-28';

function cfg_(k) { return PropertiesService.getScriptProperties().getProperty(k); }
function cfgJson_(k, d) { var v = cfg_(k); if (!v) return d; try { return JSON.parse(v); } catch (e) { return d; } }

function syncNotionToChat() {
  var props = PropertiesService.getScriptProperties();
  var token = cfg_('NOTION_TOKEN'), db = cfg_('NOTION_DATABASE_ID');
  if (!token || !db) { Logger.log('Configure NOTION_TOKEN e NOTION_DATABASE_ID nas Propriedades do Script.'); return; }

  var init = cfg_('INITIALIZED') === 'true', last = cfg_('LAST_RUN'), now = new Date().toISOString();
  var since = (init && last) ? new Date(new Date(last).getTime() - 120000).toISOString() : null;
  var pages = notionQuery_(token, db, since);

  if (!init) { // 1ª vez: só fotografa, não posta (evita inundar os grupos)
    pages.forEach(function (pg) { saveSnap_(parse_(pg)); });
    props.setProperty('INITIALIZED', 'true'); props.setProperty('LAST_RUN', now);
    Logger.log('Inicializado: ' + pages.length + ' tarefas fotografadas (nada enviado).');
    return;
  }

  pages.forEach(function (pg) {
    var c = parse_(pg), ev = diff_(loadSnap_(c.id), c);
    if (ev.length) { try { post_(c, ev); } catch (e) { Logger.log('Erro "' + c.title + '": ' + e); } }
    saveSnap_(c);
  });
  props.setProperty('LAST_RUN', now);
}

function notionQuery_(token, db, since) {
  var url = 'https://api.notion.com/v1/databases/' + db + '/query', out = [], cur = null, g = 0;
  do {
    var body = { page_size: 100, sorts: [{ timestamp: 'last_edited_time', direction: 'ascending' }] };
    if (since) body.filter = { timestamp: 'last_edited_time', last_edited_time: { after: since } };
    if (cur) body.start_cursor = cur;
    var r = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token, 'Notion-Version': NOTION_VERSION },
      payload: JSON.stringify(body), muteHttpExceptions: true
    });
    if (r.getResponseCode() >= 300) { Logger.log('Notion erro ' + r.getResponseCode() + ': ' + r.getContentText()); break; }
    var d = JSON.parse(r.getContentText());
    out = out.concat(d.results || []);
    cur = d.has_more ? d.next_cursor : null;
  } while (cur && ++g < 20);
  return out;
}

function parse_(p) {
  var pr = p.properties || {};
  function sel(n) { return (pr[n] && pr[n].select) ? pr[n].select.name : ''; }
  function dt(n) { return (pr[n] && pr[n].date) ? pr[n].date.start : ''; }
  var ow = ((pr['Responsável'] || {}).people) || [];
  return {
    id: p.id, url: p.url,
    title: ((pr['Tarefa'] || {}).title || []).map(function (x) { return x.plain_text; }).join('') || '(sem título)',
    projeto: sel('Projeto'), status: sel('Status'), categoria: sel('Categoria'), prazo: dt('Prazo'),
    owners: ow.map(function (u) { return { name: u.name || '', email: (u.person && u.person.email) || '' }; })
  };
}

function snapKey_(id) { return 'snap_' + String(id).replace(/-/g, ''); }
function loadSnap_(id) { var v = cfg_(snapKey_(id)); if (!v) return null; try { return JSON.parse(v); } catch (e) { return null; } }
function saveSnap_(t) {
  PropertiesService.getScriptProperties().setProperty(snapKey_(t.id), JSON.stringify({
    status: t.status, prazo: t.prazo, projeto: t.projeto,
    owners: t.owners.map(function (o) { return o.email || o.name; }).sort().join(',')
  }));
}

function diff_(prev, cur) {
  var ev = [], co = cur.owners.map(function (o) { return o.email || o.name; }).sort().join(',');
  if (!prev) { ev.push({ type: 'nova' }); return ev; }
  if (prev.status !== cur.status) ev.push((cur.status || '').toLowerCase() === 'concluído' ? { type: 'concluida' } : { type: 'status', from: prev.status, to: cur.status });
  if (prev.prazo !== cur.prazo) ev.push({ type: 'prazo', to: cur.prazo });
  if (prev.owners !== co) ev.push({ type: 'responsavel' });
  return ev;
}

function headline_(t, ev) {
  return ev.map(function (e) {
    if (e.type === 'nova') return '🆕 Nova ação';
    if (e.type === 'concluida') return '✅ Concluída';
    if (e.type === 'status') return '🔄 Status: ' + (e.from || '—') + ' → ' + (e.to || '—');
    if (e.type === 'prazo') return '📅 Prazo: ' + (e.to ? fmt_(e.to) : 'removido');
    if (e.type === 'responsavel') return '👤 Responsável atualizado';
    return '✏️ Atualizada';
  }).join('  ·  ');
}

function post_(t, ev) {
  var wh = cfgJson_('WEBHOOKS_JSON', {}), proj = t.projeto || 'GERAL';
  if (!wh[proj]) { Logger.log('Sem webhook para o projeto "' + proj + '" — pulando.'); return; }
  var head = headline_(t, ev);
  var men = t.owners.map(function (o) { return '*' + (o.name || o.email) + '*'; }).join(' ');
  var text = (men ? men + ' — ' : '') + head;
  var w = [];
  w.push({ decoratedText: { topLabel: 'Tarefa', text: '<b>' + esc_(t.title) + '</b>' } });
  w.push({ decoratedText: { topLabel: 'Mudança', text: esc_(head) } });
  if (t.owners.length) w.push({ decoratedText: { topLabel: 'Responsável', text: esc_(t.owners.map(function (o) { return o.name || o.email; }).join(', ')) } });
  w.push({ decoratedText: { topLabel: 'Status', text: esc_(t.status || '—') } });
  if (t.prazo) w.push({ decoratedText: { topLabel: 'Prazo', text: fmt_(t.prazo) } });
  if (t.categoria) w.push({ decoratedText: { topLabel: 'Categoria', text: esc_(t.categoria) } });
  w.push({ buttonList: { buttons: [{ text: 'Abrir no Notion', onClick: { openLink: { url: t.url } } }] } });
  var card = { cardId: 'a' + String(t.id).replace(/-/g, ''), card: { header: { title: proj, subtitle: 'Ações labyus · Notion' }, sections: [{ widgets: w }] } };
  UrlFetchApp.fetch(wh[proj], { method: 'post', contentType: 'application/json; charset=UTF-8', payload: JSON.stringify({ text: text, cardsV2: [card] }), muteHttpExceptions: true });
}

function esc_(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function fmt_(iso) { if (!iso) return '—'; var p = String(iso).substring(0, 10).split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }

// ----- rodar manualmente uma vez -----
function testConnection() {
  var token = cfg_('NOTION_TOKEN'), db = cfg_('NOTION_DATABASE_ID');
  if (!token || !db) { Logger.log('Configure NOTION_TOKEN e NOTION_DATABASE_ID primeiro.'); return; }
  var pages = notionQuery_(token, db, null);
  Logger.log('OK! ' + pages.length + ' tarefas encontradas.');
}
function createTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (tr) { if (tr.getHandlerFunction() === 'syncNotionToChat') ScriptApp.deleteTrigger(tr); });
  ScriptApp.newTrigger('syncNotionToChat').timeBased().everyMinutes(5).create();
  Logger.log('Pronto! Executa a cada 5 minutos.');
}
function resetState() {
  var p = PropertiesService.getScriptProperties();
  p.getKeys().forEach(function (k) { if (k.indexOf('snap_') === 0) p.deleteProperty(k); });
  p.deleteProperty('INITIALIZED'); p.deleteProperty('LAST_RUN');
  Logger.log('Estado limpo.');
}
