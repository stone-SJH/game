const $ = id => document.getElementById(id);
let session, registering = false, selected, cursor, stream, poll, generation = 0;
let items = [];
function notice(message = '') { $('notice').textContent = message; $('notice').hidden = !message; }
function signedOut() {
  generation++; session = null; stream?.close(); clearInterval(poll); items = []; selected = null;
  $('auth').hidden = false; $('workspace').hidden = true; $('account').hidden = true;
  $('task-list').replaceChildren(); $('detail').replaceChildren(); $('create-dialog').close(); $('followup-dialog').close();
}
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'content-type': 'application/json', ...(session ? { 'x-csrf-token': session.csrfToken } : {}), ...options.headers } });
  const value = await response.json();
  if (!response.ok) { if (response.status === 401) signedOut(); throw new Error(value.error || 'Request failed.'); }
  return value;
}
function node(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
function status(value) { return node('span', value.replaceAll('_', ' '), `status ${value.toLowerCase()}`); }
function date(value) { return new Date(value).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }); }
function dateOrDash(value) { return value ? date(value) : 'No update yet'; }
function progressPercent(progress) {
  const completed = progress?.steps?.completed, total = progress?.steps?.total;
  return Number.isInteger(completed) && Number.isInteger(total) && total > 0 ? Math.max(0, Math.min(100, Math.round(completed / total * 100))) : null;
}
function fileList(title, entries, emptyText = 'No files reported yet') {
  const section = node('section', undefined, 'telemetry-files');
  section.append(node('h4', title));
  if (!entries?.length) { section.append(node('div', emptyText, 'empty')); return section; }
  const list = node('ul');
  for (const entry of entries) {
    const row = node('li');
    const name = node('strong', entry.name || entry.path || 'Unnamed file');
    const meta = node('small', `${entry.path || ''}${entry.updatedAt ? ` · ${date(entry.updatedAt)}` : ''}${Number.isFinite(Number(entry.size)) ? ` · ${Number(entry.size).toLocaleString()} bytes` : ''}`);
    row.append(name, meta); list.append(row);
  }
  section.append(list); return section;
}
function progressPanel(task) {
  const panel = node('section', undefined, 'worker-progress');
  const heading = node('div', undefined, 'progress-heading'); heading.append(node('h3', 'Worker progress'));
  const worker = task.worker;
  if (worker) {
    const stale = !worker.lastSeenAt || Date.now() - Date.parse(worker.lastSeenAt) > 15000;
    heading.append(status(stale ? 'STALE' : worker.status || 'OFFLINE'));
  }
  panel.append(heading);
  const progress = task.progress;
  if (!progress) { panel.append(node('div', 'Waiting for worker telemetry', 'empty')); return panel; }
  const percent = progressPercent(progress);
  const meter = node('div', undefined, 'progress-track');
  const fill = node('span'); fill.style.width = `${percent ?? 0}%`; meter.append(fill);
  const stepText = progress.steps?.total ? `${progress.steps.completed ?? 0} / ${progress.steps.total} steps` : 'Steps pending';
  const meterMeta = node('div', undefined, 'progress-meter-meta'); meterMeta.append(node('strong', percent === null ? stepText : `${percent}%`), node('span', stepText));
  panel.append(meter, meterMeta);
  const facts = node('div', undefined, 'progress-facts');
  for (const [label, value] of [['Phase', progress.phase || 'working'], ['Current step', progress.step || 'Waiting'], ['Iteration', progress.iteration ? `${progress.iteration}${progress.iterationTotal ? ` / ${progress.iterationTotal}` : ''}` : 'Not reported'], ['Tool', progress.tool || 'Not reported'], ['Last update', dateOrDash(progress.receivedAt || progress.observedAt)]]) {
    const fact = node('div'); fact.append(node('dt', label), node('dd', value)); facts.append(fact);
  }
  panel.append(facts);
  const goal = node('div', undefined, 'progress-goal'); goal.append(node('dt', 'Current goal'), node('dd', progress.goal || task.objective)); panel.append(goal);
  if (progress.error) panel.append(node('div', progress.error, 'progress-error'));
  if (progress.command) panel.append(node('code', progress.command, 'progress-command'));
  if (progress.prompt) {
    const prompt = document.createElement('details'); prompt.className = 'progress-prompt';
    prompt.append(node('summary', 'Codex prompt'), node('pre', progress.prompt)); panel.append(prompt);
  }
  const screenshots = node('section', undefined, 'telemetry-files'); screenshots.append(node('h4', 'Recent screenshots'));
  if (!progress.screenshots?.length) screenshots.append(node('div', 'No screenshots reported yet', 'empty'));
  else {
    const list = node('ul');
    for (const entry of progress.screenshots) {
      const row = node('li');
      if (entry.downloadUrl) { const link = node('a', entry.name || entry.path); link.href = entry.downloadUrl; link.target = '_blank'; link.rel = 'noopener'; row.append(link); }
      else row.append(node('strong', entry.name || entry.path));
      row.append(node('small', `${entry.path || ''}${entry.updatedAt ? ` · ${date(entry.updatedAt)}` : ''}`)); list.append(row);
    }
    screenshots.append(list);
  }
  panel.append(screenshots, fileList('Recent project files', progress.projectFiles), fileList('Recent log files', progress.logFiles));
  if (worker) {
    const workerMeta = node('div', undefined, 'worker-meta');
    workerMeta.append(node('span', `Worker ${worker.workerId}`), node('span', `Last heartbeat ${dateOrDash(worker.lastSeenAt)}`), node('span', `Attempt ${worker.attempt || 0}`));
    panel.append(workerMeta);
  }
  return panel;
}
function runHistory(task) {
  if (!task.runs?.length) return node('div');
  const section = node('section', undefined, 'run-history'); section.append(node('h3', 'Runs'));
  const list = node('ol');
  for (const run of task.runs) {
    const row = node('li');
    const title = node('strong', `${run.status.replaceAll('_', ' ')} · ${date(run.createdAt)}`);
    row.append(title);
    if (run.followUpPrompt) row.append(node('p', run.followUpPrompt));
    list.append(row);
  }
  section.append(list); return section;
}
function renderList() {
  const list = $('task-list'); list.replaceChildren();
  if (!items.length) list.append(node('div', 'No tasks yet', 'empty'));
  for (const task of items) {
    const row = node('button', undefined, `task-row${selected === task.task_id ? ' selected' : ''}`);
    row.append(node('span', task.objective, 'task-title'));
    if (task.progress?.phase) row.append(node('span', `${task.progress.phase}${task.progress.steps?.total ? ` · ${task.progress.steps.completed ?? 0}/${task.progress.steps.total}` : ''}`, 'task-progress'));
    const meta = node('span', undefined, 'task-meta'); meta.append(status(task.status), node('time', date(task.created_at))); row.append(meta);
    row.onclick = () => selectTask(task.task_id).catch(error => notice(error.message)); list.append(row);
  }
  $('more').hidden = !cursor;
}
async function loadTasks(more = false) {
  const epoch = generation;
  const value = await api(`/v1/tasks${more && cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
  if (epoch !== generation) return;
  const merged = new Map((more ? items : []).map(item => [item.task_id, item]));
  for (const item of value.tasks) merged.set(item.task_id, item);
  items = [...merged.values()]; cursor = value.nextCursor; renderList();
  if (!selected && items.length) await selectTask(items[0].task_id);
}
async function refreshDetail() {
  if (!selected || !session) return;
  const target = selected, epoch = generation;
  const task = await api(`/v1/tasks/${target}`);
  if (epoch !== generation || target !== selected) return;
  const pane = $('detail'); pane.replaceChildren();
  const top = node('div', undefined, 'detail-top'); top.append(status(task.status));
  if (task.allowedActions.includes('cancel')) {
    const cancel = node('button', 'Cancel task'); cancel.onclick = async () => {
      cancel.disabled = true;
      try { await api(`/v1/tasks/${target}/cancel`, { method:'POST', body:'{}' }); await refreshDetail(); await loadTasks(); } catch(error) { notice(error.message); cancel.disabled=false; }
    }; top.append(cancel);
  }
  if (task.allowedActions.includes('rerun')) {
    const rerun = node('button', 'Continue task'); rerun.className = 'primary';
    rerun.onclick = () => { $('followup-error').textContent = ''; $('followup-prompt').value = ''; $('followup-dialog').showModal(); $('followup-prompt').focus(); };
    top.append(rerun);
  }
  pane.append(top, node('h2', task.objective));
  const details = node('dl', undefined, 'details');
  for (const [label, value] of [['Worker',task.workerId || 'Waiting for assigned worker'], ['Created',date(task.createdAt)], ['Workspace',task.workspaceId || 'Unassigned'], ['Run request',task.currentPrompt || 'Initial task'], ['Task',task.taskId]]) {
    const group = node('div'); group.append(node('dt',label),node('dd',value)); details.append(group);
  }
  pane.append(details, progressPanel(task), runHistory(task), node('h3','Activity'));
  const activity = node('ol', undefined, 'activity');
  for (const event of task.events.slice(-12)) {
    const row = node('li'); row.append(node('time',new Date(event.created_at).toLocaleTimeString()),node('span',event.event_type.replaceAll('_',' '))); activity.append(row);
  }
  pane.append(activity,node('h3','Artifacts'));
  if (!task.artifacts.length) pane.append(node('div','No artifacts yet','empty'));
  const artifacts = node('div',undefined,'artifacts');
  for (const artifact of task.artifacts) {
    const figure = node('figure',undefined,'artifact');
    const image = ['image/png','image/jpeg','image/webp'].includes(artifact.content_type);
    if (image) { const img = node('img'); img.src=artifact.downloadUrl; img.alt=artifact.name; img.loading='lazy'; figure.append(img); }
    const packageFile = /\.(?:zip|7z|tar(?:\.gz)?|exe)$/i.test(artifact.name);
    const caption=node('figcaption'), link=node('a',artifact.name); link.href=artifact.downloadUrl;
    if (image) { link.target='_blank'; link.rel='noopener'; }
    else { link.download=artifact.name; caption.append(node('span', packageFile ? 'Playable package / download' : 'Download', 'artifact-kind')); }
    caption.append(link,node('small',`${Number(artifact.size_bytes).toLocaleString()} bytes`),node('small',`SHA-256 ${artifact.sha256}`)); figure.append(caption); artifacts.append(figure);
  }
  pane.append(artifacts);
  if (task.result) { pane.append(node('h3','Result'),node('pre',JSON.stringify(task.result,null,2),'result')); }
  return task;
}
async function selectTask(taskId) {
  selected=taskId; location.hash=taskId; stream?.close(); renderList(); const task=await refreshDetail();
  if (!session || selected!==taskId) return;
  stream=new EventSource(`/v1/tasks/${taskId}/events?after=${task.eventCursor}`);
  stream.onmessage=()=>refreshDetail().catch(error=>notice(error.message));
}
async function signedIn(value) {
  generation++; session=value; notice(); $('auth').hidden=true; $('workspace').hidden=false; $('account').hidden=false; $('username').textContent=value.user.username;
  $('password').value=''; $('invite').value='';
  const requested=location.hash.slice(1);
  selected=null; await loadTasks();
  if (/^task-[a-zA-Z0-9-]+$/.test(requested) && requested!==selected) {
    try { await selectTask(requested); } catch { if(items[0])await selectTask(items[0].task_id); }
  }
  clearInterval(poll); poll=setInterval(()=>{ loadTasks().then(refreshDetail).catch(error=>notice(error.message)); },5000);
}
function mode(register) {
  registering=register; $('invite-field').hidden=!register; $('invite').required=register;
  $('login-tab').setAttribute('aria-selected',String(!register)); $('register-tab').setAttribute('aria-selected',String(register));
  $('auth-submit').textContent=register?'Create account':'Log in'; $('password').autocomplete=register?'new-password':'current-password'; notice();
}
$('login-tab').onclick=()=>mode(false); $('register-tab').onclick=()=>mode(true);
$('auth-form').onsubmit=async event=>{
  event.preventDefault(); $('auth-submit').disabled=true; notice();
  try { await signedIn(await api(`/v1/auth/${registering?'register':'login'}`, {method:'POST',body:JSON.stringify({username:$('auth-username').value,password:$('password').value,code:$('invite').value})})); }
  catch(error){notice(error.message);} finally{$('auth-submit').disabled=false;}
};
$('logout').onclick=async()=>{try{await api('/v1/auth/logout',{method:'POST',body:'{}'});signedOut();notice();}catch(error){notice(error.message);}};
$('new-task').onclick=()=>{$('create-error').textContent='';$('create-dialog').showModal();$('objective').focus();};
$('close-dialog').onclick=()=>$('create-dialog').close();
$('close-followup').onclick=()=>$('followup-dialog').close();
$('more').onclick=()=>loadTasks(true).catch(error=>notice(error.message));
$('create-form').onsubmit=async event=>{
  event.preventDefault();$('create-submit').disabled=true;$('create-error').textContent='';
  try{
    const task=await api('/v1/tasks',{method:'POST',body:JSON.stringify({objective:$('objective').value})});
    $('create-dialog').close();$('objective').value='';await loadTasks();await selectTask(task.taskId);
  }catch(error){$('create-error').textContent=error.message;}finally{$('create-submit').disabled=false;}
};
$('followup-form').onsubmit=async event=>{
  event.preventDefault(); const taskId=selected; $('followup-submit').disabled=true; $('followup-error').textContent='';
  try { await api(`/v1/tasks/${taskId}/rerun`, { method:'POST', body:JSON.stringify({ prompt:$('followup-prompt').value }) }); $('followup-dialog').close(); $('followup-prompt').value=''; await loadTasks(); await selectTask(taskId); }
  catch(error) { $('followup-error').textContent=error.message; } finally { $('followup-submit').disabled=false; }
};
api('/v1/auth/me').then(signedIn).catch(()=>signedOut());
