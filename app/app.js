const $ = id => document.getElementById(id);
let session, registering = false, selected, cursor, stream, poll, refreshTimer, refreshInFlight = false, refreshAgain = false, refreshNeedsList = false, generation = 0;
let items = [];
let previewObserver;
const completedArtifactCache = new Map();
function notice(message = '') { $('notice').textContent = message; $('notice').hidden = !message; }
function signedOut() {
  generation++; session = null; stream?.close(); clearInterval(poll); clearTimeout(refreshTimer); refreshTimer = null; refreshInFlight = false; refreshAgain = false; refreshNeedsList = false; previewObserver?.disconnect(); completedArtifactCache.clear(); items = []; selected = null;
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
function lazyPreview(url, alt) {
  const image = node('img'); image.alt = alt; image.loading = 'lazy'; image.decoding = 'async'; image.fetchPriority = 'low'; image.dataset.src = url;
  if ('IntersectionObserver' in window) {
    previewObserver ||= new IntersectionObserver(entries => entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const target = entry.target; target.src = target.dataset.src; target.removeAttribute('data-src'); previewObserver.unobserve(target);
    }), { rootMargin: '240px' });
    previewObserver.observe(image);
  } else image.src = url;
  return image;
}
function releaseLazyPreviews(root) {
  root?.querySelectorAll('img[data-src]').forEach(image => previewObserver?.unobserve(image));
}
function progressPercent(progress) {
  const serverPercent = Number(progress?.percent);
  if (Number.isFinite(serverPercent)) return Math.max(0, Math.min(100, Math.round(serverPercent)));
  const phase = String(progress?.phase || '').toLowerCase(), currentStatus = String(progress?.status || '').toLowerCase();
  const completed = Number(progress?.steps?.completed), total = Number(progress?.steps?.total);
  const stepPercent = Number.isFinite(completed) && Number.isFinite(total) && total > 0 ? Math.round(Math.max(0, Math.min(1, completed / total)) * 100) : 0;
  const phasePercent = { preparing: 5, planning: 15, thinking: 30, crafting: 50, building: 70, evaluating: 90, completed: 100, failed: 95, canceled: 95 }[phase] || 0;
  const iteration = Number(progress?.iteration), iterationTotal = Number(progress?.iterationTotal);
  if (Number.isFinite(iteration) && Number.isFinite(iterationTotal) && iterationTotal > 0) return Math.max(phasePercent, Math.round(Math.max(0, Math.min(1, (iteration - 1 + stepPercent / 100) / iterationTotal)) * 100), currentStatus === 'running' ? 1 : 0);
  return Math.max(stepPercent, phasePercent, currentStatus === 'running' ? 1 : 0);
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
    const list = node('div', undefined, 'screenshot-grid');
    for (const entry of progress.screenshots) {
      const row = node('figure', undefined, 'screenshot-card');
      if (entry.previewUrl && entry.downloadUrl) {
        const link = node('a'); link.href = entry.downloadUrl; link.target = '_blank'; link.rel = 'noopener'; link.append(lazyPreview(entry.previewUrl, entry.name || entry.path)); row.append(link);
      } else if (entry.downloadUrl) {
        const link = node('a', entry.name || entry.path); link.href = entry.downloadUrl; link.target = '_blank'; link.rel = 'noopener'; row.append(link);
      } else row.append(node('strong', entry.name || entry.path));
      row.append(node('figcaption', `${entry.name || entry.path || 'Unnamed image'}${entry.updatedAt ? ` · ${date(entry.updatedAt)}` : ''}`)); list.append(row);
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
function iterationSummaryRow(summary, task, index) {
    const row = node('li', undefined, `iteration-summary ${String(summary.status || '').toLowerCase()}`);
    const heading = node('div', undefined, 'iteration-summary-heading');
    heading.append(node('strong', summary.iteration === null ? `Run ${index + 1}` : `Iteration ${summary.iteration}`), status(summary.status || 'RUNNING'));
    row.append(heading);
    if (summary.step) row.append(node('div', `Stage: ${summary.step}`, 'iteration-summary-step'));
    const goal = node('div', undefined, 'iteration-summary-goal'); goal.append(node('dt', 'Goal'), node('dd', summary.goal || task.objective));
    const result = node('div', undefined, 'iteration-summary-result'); result.append(node('dt', 'Result'), node('dd', summary.summary || 'No result summary yet.'));
    row.append(goal, result);
    const failures = Array.isArray(summary.failureReasons) ? summary.failureReasons : [];
    if (failures.length) {
      const diagnostics = node('ul', undefined, 'iteration-diagnostics');
      for (const failure of failures) {
        const item = node('li');
        const facts = [failure.category, failure.stage, failure.attempt ? `attempt ${failure.attempt}` : '', Number.isInteger(failure.exitCode) ? `exit ${failure.exitCode}` : '', failure.timedOut ? 'timed out' : '', failure.variantCount > 1 ? `observed in ${failure.variantCount} telemetry variants` : ''].filter(Boolean);
        item.append(node('strong', facts.join(' · ') || 'Failure diagnostic'), node('p', failure.message || 'No diagnostic message.'));
        if (failure.command) item.append(node('div', `Command: ${failure.command}`, 'iteration-summary-step'));
        if (failure.completedSteps?.length) item.append(node('div', `Completed before failure: ${failure.completedSteps.join(', ')}`, 'iteration-summary-step'));
        if (failure.noOutput) item.append(node('div', 'No process output was captured; inspect the recorded stage logs and exit code.', 'iteration-summary-warning'));
        if (failure.logFiles?.length) item.append(node('div', `Logs: ${failure.logFiles.join(', ')}`, 'iteration-summary-step'));
        if (failure.stderr || failure.stdout) {
          const output = document.createElement('details'); output.append(node('summary', 'Process output'));
          if (failure.stderr) output.append(node('pre', `stderr\n${failure.stderr}`));
          if (failure.stdout) output.append(node('pre', `stdout\n${failure.stdout}`));
          item.append(output);
        }
        diagnostics.append(item);
      }
      row.append(diagnostics);
    } else if (summary.diagnosticMissing) row.append(node('div', 'Worker did not report a failure diagnostic for this retry.', 'iteration-summary-warning'));
    if (summary.diagnosticArtifactId) {
      const link = node('a', 'Download full failure report'); link.href = `/artifacts/${encodeURIComponent(summary.diagnosticArtifactId)}`; link.target = '_blank'; link.rel = 'noopener'; link.className = 'iteration-diagnostic-download'; row.append(link);
    }
    if (summary.updatedAt) row.append(node('time', date(summary.updatedAt)));
    return row;
}
function iterationSummaryBuckets(task) {
  const summaries = Array.isArray(task.iterationSummaries) ? task.iterationSummaries : [];
  const latestRunAt = Date.parse(task.runs?.[0]?.createdAt || '');
  if (!Number.isFinite(latestRunAt)) return { current: summaries, archived: [] };
  const current = [], archived = [];
  for (const summary of summaries) {
    const updatedAt = Date.parse(summary.updatedAt || '');
    if (Number.isFinite(updatedAt) && updatedAt < latestRunAt) archived.push(summary);
    else current.push(summary);
  }
  return { current, archived };
}
function iterationSummaryPanel(task) {
  const section = node('section', undefined, 'iteration-summaries'); section.append(node('h3', 'Current iteration summaries'));
  const { current, archived } = iterationSummaryBuckets(task);
  if (!current.length && !archived.length) { section.append(node('div', 'No completed iteration summary yet', 'empty')); return section; }
  if (current.length) {
    const list = node('ol');
    current.forEach((summary, index) => list.append(iterationSummaryRow(summary, task, index)));
    section.append(list);
  }
  if (archived.length) {
    const history = document.createElement('details'); history.className = 'iteration-history';
    history.append(node('summary', `Archived previous-run iterations (${archived.length})`));
    let loaded = false;
    history.addEventListener('toggle', () => {
      if (!history.open || loaded) return;
      loaded = true;
      const list = node('ol');
      archived.forEach((summary, index) => list.append(iterationSummaryRow(summary, task, index)));
      history.append(list);
    });
    section.append(history);
  }
  return section;
}
function artifactPanel(task, taskId) {
  const section = node('section', undefined, 'artifact-panel'), heading = node('div', undefined, 'artifact-heading');
  heading.append(node('h3', 'Artifacts'));
  const count = Number(task.artifactCount || 0), bytes = Number(task.artifactBytes || 0);
  const summary = node('small', count ? `${task.artifacts.length} of ${count} · ${bytes.toLocaleString()} bytes` : 'No artifacts yet'); heading.append(summary); section.append(heading);
  const grid = node('div', undefined, 'artifacts');
  const append = artifact => {
    const figure = node('figure', undefined, 'artifact');
    if (artifact.content_type?.startsWith('image/')) {
      if (artifact.previewUrl) {
        const imageLink = node('a'); imageLink.href = artifact.downloadUrl; imageLink.target = '_blank'; imageLink.rel = 'noopener'; imageLink.append(lazyPreview(artifact.previewUrl, artifact.name)); figure.append(imageLink);
      } else figure.append(node('div', 'Open image to load', 'artifact-placeholder'));
    }
    const caption = node('figcaption'), link = node('a', artifact.name); link.href = artifact.downloadUrl;
    const packageFile = /\.(?:zip|7z|tar(?:\.gz)?|exe)$/i.test(artifact.name);
    if (artifact.content_type?.startsWith('image/')) { link.target = '_blank'; link.rel = 'noopener'; }
    else { link.download = artifact.name; caption.append(node('span', packageFile ? 'Playable package / download' : 'Download', 'artifact-kind')); }
    caption.append(link, node('small', `${Number(artifact.size_bytes).toLocaleString()} bytes`), node('small', `SHA-256 ${artifact.sha256}`)); figure.append(caption); grid.append(figure);
  };
  if (!task.artifacts.length) grid.append(node('div', 'No artifacts yet', 'empty'));
  else task.artifacts.forEach(append);
  section.append(grid);
  let nextCursor = task.artifactsNextCursor;
  if (nextCursor) {
    const more = node('button', 'Load more artifacts'); more.className = 'artifact-more';
    more.onclick = async () => {
      more.disabled = true;
      try {
        const page = await api(`/v1/tasks/${encodeURIComponent(taskId)}/artifacts?cursor=${encodeURIComponent(nextCursor)}`);
        if (selected !== taskId) return;
        page.artifacts.forEach(append); nextCursor = page.nextCursor; more.hidden = !nextCursor;
        summary.textContent = `${grid.querySelectorAll('.artifact').length} of ${Number(page.count).toLocaleString()} · ${Number(page.bytes).toLocaleString()} bytes`;
      } catch (error) { notice(error.message); } finally { more.disabled = false; }
    };
    section.append(more);
  }
  return section;
}
function isPlayablePackage(artifact) {
  return /(?:^|-)playable-package-.*\.(?:zip|7z|tar\.gz)$/i.test(artifact.name || '') || /\.(?:zip|7z|tar\.gz)$/i.test(artifact.name || '');
}
function isFeaturedArtifact(artifact) {
  return isPlayablePackage(artifact) || /(?:\.exe|\.uproject)$/i.test(artifact.name || '') || /^(?:scene-preview|acceptance-report|production-report|workspace-manifest|asset-manifest|stage-manifest|playtest-evidence)\.json(?:\.png)?$/i.test(artifact.name || '') || /^(?:scene-preview)\.(?:png|jpe?g|webp)$/i.test(artifact.name || '');
}
function featuredArtifactCard(artifact, packageArtifact = false) {
  const figure = node('figure', undefined, `completed-output${packageArtifact ? ' completed-output-package' : ''}`);
  if (artifact.content_type?.startsWith('image/')) {
    if (artifact.previewUrl) {
      const imageLink = node('a'); imageLink.href = artifact.downloadUrl; imageLink.target = '_blank'; imageLink.rel = 'noopener'; imageLink.append(lazyPreview(artifact.previewUrl, artifact.name)); figure.append(imageLink);
    } else figure.append(node('div', 'Open image to load', 'artifact-placeholder'));
  }
  const caption = node('figcaption'), link = node('a', artifact.name); link.href = artifact.downloadUrl; link.download = artifact.name;
  caption.append(link, node('small', `${Number(artifact.size_bytes).toLocaleString()} bytes`));
  if (packageArtifact) caption.append(node('strong', 'Playable package', 'completed-output-label'));
  figure.append(caption);
  return figure;
}
function completedOutputsPanel(task) {
  if (task.status !== 'COMPLETED') return null;
  const section = node('section', undefined, 'completed-outputs');
  const heading = node('div', undefined, 'completed-outputs-heading');
  heading.append(node('h3', 'Completed outputs'), node('span', 'Ready to download'));
  section.append(heading);
  const artifacts = Array.isArray(task.completedArtifacts) ? task.completedArtifacts : task.artifacts || [];
  const packages = artifacts.filter(isPlayablePackage).sort((a, b) => String(b.name).localeCompare(String(a.name)));
  const keyArtifacts = artifacts.filter(item => !isPlayablePackage(item) && isFeaturedArtifact(item)).slice(0, 8);
  const packageGroup = node('div', undefined, 'completed-output-group');
  packageGroup.append(node('h4', 'Playable packages'));
  if (!packages.length) packageGroup.append(node('p', 'No playable package was uploaded for this task.', 'completed-outputs-empty'));
  else { const grid = node('div', undefined, 'completed-output-list'); packages.forEach(item => grid.append(featuredArtifactCard(item, true))); packageGroup.append(grid); }
  section.append(packageGroup);
  if (keyArtifacts.length) {
    const keyGroup = node('div', undefined, 'completed-output-group'); keyGroup.append(node('h4', 'Key artifacts'));
    const grid = node('div', undefined, 'completed-output-list'); keyArtifacts.forEach(item => grid.append(featuredArtifactCard(item))); keyGroup.append(grid); section.append(keyGroup);
  }
  return section;
}
async function loadCompletedArtifacts(task, taskId) {
  if (task.status !== 'COMPLETED' || Number(task.artifactCount || 0) <= (task.artifacts?.length || 0)) return task;
  const cached = completedArtifactCache.get(taskId);
  if (cached) return { ...task, completedArtifacts: cached };
  try {
    const page = await api(`/v1/tasks/${encodeURIComponent(taskId)}/artifacts?limit=100`);
    completedArtifactCache.set(taskId, page.artifacts || []);
    return { ...task, completedArtifacts: page.artifacts || [] };
  } catch { return task; }
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
  const displayTask = await loadCompletedArtifacts(task, target);
  if (epoch !== generation || target !== selected) return;
  const pane = $('detail');
  const summarySignature = `${task.runs?.[0]?.createdAt || ''}|${(task.iterationSummaries || []).map(item => `${item.iteration}:${item.status}:${item.goal}:${item.summary}:${item.step}:${item.diagnosticMissing}:${item.diagnosticArtifactId || ''}:${item.updatedAt || ''}:${JSON.stringify(item.failureReasons || [])}`).join('|')}`;
  const artifactSignature = `${task.artifactCount}:${task.artifacts?.[0]?.artifact_id || ''}:${task.artifactsNextCursor || ''}`;
  const completedOutputSignature = `${displayTask.completedArtifacts?.length || 0}:${displayTask.completedArtifacts?.[0]?.artifact_id || ''}`;
  if (pane.dataset.taskId === target && pane.dataset.status === task.status) {
    const progress = pane.querySelector('.worker-progress');
    releaseLazyPreviews(progress); progress?.replaceWith(progressPanel(task));
    if (pane.dataset.summarySignature !== summarySignature) pane.querySelector('.iteration-summaries')?.replaceWith(iterationSummaryPanel(task));
    if (pane.dataset.artifactSignature !== artifactSignature) {
      const artifacts = pane.querySelector('.artifact-panel'); releaseLazyPreviews(artifacts); artifacts?.replaceWith(artifactPanel(task, target));
    }
    if (pane.dataset.completedOutputSignature !== completedOutputSignature) {
      const outputs = pane.querySelector('.completed-outputs'); releaseLazyPreviews(outputs); const replacement = completedOutputsPanel(displayTask); replacement ? outputs?.replaceWith(replacement) : outputs?.remove();
    }
    pane.dataset.summarySignature = summarySignature; pane.dataset.artifactSignature = artifactSignature;
    pane.dataset.completedOutputSignature = completedOutputSignature;
    return task;
  }
  previewObserver?.disconnect(); pane.replaceChildren(); pane.dataset.taskId = target; pane.dataset.status = task.status;
  pane.dataset.summarySignature = summarySignature; pane.dataset.artifactSignature = artifactSignature; pane.dataset.completedOutputSignature = completedOutputSignature;
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
  const completedOutputs = completedOutputsPanel(displayTask);
  pane.append(...(completedOutputs ? [completedOutputs] : []), details, progressPanel(task), iterationSummaryPanel(task), artifactPanel(task, target));
  if (task.result) { pane.append(node('h3','Result'),node('pre',JSON.stringify(task.result,null,2),'result')); }
  return task;
}
function scheduleMonitorRefresh(includeList = false, delay = 250) {
  if (!session || !selected) return;
  refreshNeedsList ||= includeList;
  if (refreshTimer) return;
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    if (refreshInFlight) { refreshAgain = true; return; }
    refreshInFlight = true;
    const shouldLoadList = refreshNeedsList; refreshNeedsList = false;
    try {
      if (shouldLoadList) await loadTasks();
      await refreshDetail();
    } catch (error) { notice(error.message); }
    finally {
      refreshInFlight = false;
      if (refreshAgain) { refreshAgain = false; scheduleMonitorRefresh(refreshNeedsList, 500); }
    }
  }, delay);
}
async function selectTask(taskId) {
  selected=taskId; location.hash=taskId; stream?.close(); clearTimeout(refreshTimer); refreshTimer = null; refreshNeedsList = false; refreshAgain = false; renderList(); const task=await refreshDetail();
  if (!session || selected!==taskId) return;
  stream=new EventSource(`/v1/tasks/${taskId}/events?after=${task.eventCursor}`);
  stream.onmessage=event=>{
    let payload;
    try { payload = JSON.parse(event.data); } catch { return; }
    const eventType = payload.event_type || '';
    const progressEvent = eventType === 'WORKER_PROGRESS';
    scheduleMonitorRefresh(!progressEvent, progressEvent ? 3000 : 0);
  };
}
async function signedIn(value) {
  generation++; session=value; notice(); $('auth').hidden=true; $('workspace').hidden=false; $('account').hidden=false; $('username').textContent=value.user.username;
  $('password').value=''; $('invite').value='';
  const requested=location.hash.slice(1);
  selected=null; await loadTasks();
  if (/^task-[a-zA-Z0-9-]+$/.test(requested) && requested!==selected) {
    try { await selectTask(requested); } catch { if(items[0])await selectTask(items[0].task_id); }
  }
  clearInterval(poll); poll=setInterval(()=>scheduleMonitorRefresh(true),60000);
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
