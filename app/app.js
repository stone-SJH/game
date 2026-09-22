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
  createReferences.clear(false); followupReferences.clear(false);
}
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'content-type': 'application/json', ...(session ? { 'x-csrf-token': session.csrfToken } : {}), ...options.headers } });
  const value = await response.json();
  if (!response.ok) { if (response.status === 401) signedOut(); throw new Error(value.error || 'Request failed.'); }
  return value;
}
function node(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
function referencePicker(prefix) {
  let entries = [];
  const input = $(`${prefix}-files`), list = $(`${prefix}-file-list`), progress = $(`${prefix}-upload-status`);
  const discard = entry => { if (entry.referenceId && session) api(`/v1/references/${entry.referenceId}`, { method: 'DELETE' }).catch(() => {}); };
  const render = () => {
    list.replaceChildren();
    entries.forEach(entry => {
      const row = node('li');
      row.append(node('span', `${entry.file.name} · ${(entry.file.size / 1024 / 1024).toFixed(2)} MB`));
      const remove = node('button', 'Remove'); remove.type = 'button'; remove.setAttribute('aria-label', `Remove ${entry.file.name}`);
      remove.onclick = () => { entries = entries.filter(item => item !== entry); discard(entry); render(); };
      row.append(remove); list.append(row);
    });
  };
  input.onchange = () => {
    const added = [...input.files]; input.value = '';
    const error = entries.length + added.length > 5 ? 'You can attach at most 5 files per request.' :
      added.some(file => file.size > 20 * 1024 * 1024) ? 'Each file must be at most 20 MB.' : '';
    $(`${prefix}-error`).textContent = error;
    if (error) return;
    entries.push(...added.map(file => ({ file }))); render();
  };
  return {
    clear(discardFiles = true) { if (discardFiles) entries.forEach(discard); entries = []; input.value = ''; progress.textContent = ''; render(); },
    async upload() {
      for (const [index, entry] of entries.entries()) {
        if (entry.referenceId) continue;
        progress.textContent = `Uploading ${index + 1} / ${entries.length}: ${entry.file.name}`;
        const result = await api('/v1/references', { method: 'POST', body: entry.file,
          headers: { 'content-type': entry.file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(entry.file.name) } });
        entry.referenceId = result.referenceId;
      }
      progress.textContent = entries.length ? `${entries.length} file(s) uploaded. Submitting task…` : '';
      return entries.map(entry => entry.referenceId);
    },
    failed() { progress.textContent = ''; },
  };
}
function referencePanel(task) {
  const panel = node('section', undefined, 'task-references');
  if (!task.references?.length) return panel;
  panel.append(node('h3', 'Reference files'));
  const list = node('ul', undefined, 'reference-files');
  for (const reference of task.references) {
    const row = node('li'), link = node('a', reference.name);
    link.href = `/v1/references/${encodeURIComponent(reference.referenceId)}`;
    row.append(link, node('small', `Revision ${reference.taskRevision} · ${(reference.sizeBytes / 1024 / 1024).toFixed(2)} MB`)); list.append(row);
  }
  panel.append(list); return panel;
}
function submitting(prefix, busy) {
  for (const control of $(`${prefix}-form`).elements) control.disabled = busy;
  $(`${prefix}-dialog`).oncancel = event => { if (busy) event.preventDefault(); };
}
function status(value) { return node('span', value.replaceAll('_', ' '), `status ${value.toLowerCase()}`); }
function date(value) { return new Date(value).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }); }
function timestamp(value) {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString([], { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false }) : '';
}
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
    const label = summary.iteration === null ? `Run ${index + 1}` : `Task revision ${summary.taskRevision || '?'} · Iteration ${summary.iteration}`;
    heading.append(node('strong', label), status(summary.status || 'RUNNING'));
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
const artifactTypeLabels = { all: 'All', image: 'Images', log: 'Logs', 'playable-package': 'Playable packages', executable: 'Executables', report: 'Reports', other: 'Other' };
function artifactTypeOf(artifact) {
  if (artifact.artifactType && artifactTypeLabels[artifact.artifactType]) return artifact.artifactType;
  const name = String(artifact.name || '').toLowerCase(), contentType = String(artifact.content_type || '').toLowerCase();
  if (/\.(?:zip|7z|tar(?:\.gz)?)$/.test(name) || /playable-package/.test(name)) return 'playable-package';
  if (/\.exe$/.test(name)) return 'executable';
  if (contentType.startsWith('image/') || /\.(?:png|jpe?g|webp|bmp|gif)$/.test(name)) return 'image';
  if (/\.(?:log|jsonl|txt|out|err)$/.test(name) || /(?:stderr|stdout|session|diagnostic|log)/.test(name)) return 'log';
  if (contentType === 'application/json' || /\.json$/.test(name)) return 'report';
  return 'other';
}
function artifactCard(artifact) {
  const figure = node('figure', undefined, 'artifact');
  if (artifact.content_type?.startsWith('image/')) {
    if (artifact.previewUrl) {
      const imageLink = node('a'); imageLink.href = artifact.downloadUrl; imageLink.target = '_blank'; imageLink.rel = 'noopener'; imageLink.append(lazyPreview(artifact.previewUrl, artifact.name)); figure.append(imageLink);
    } else figure.append(node('div', 'Open image to load', 'artifact-placeholder'));
  }
  const caption = node('figcaption'), link = node('a', artifact.name); link.href = artifact.downloadUrl;
  const type = artifactTypeOf(artifact);
  if (artifact.content_type?.startsWith('image/')) { link.target = '_blank'; link.rel = 'noopener'; }
  else { link.download = artifact.name; caption.append(node('span', `${artifactTypeLabels[type]} / download`, 'artifact-kind')); }
  caption.append(link, node('small', `${Number(artifact.size_bytes).toLocaleString()} bytes`));
  const metadata = [timestamp(artifact.created_at || artifact.createdAt) ? `Created ${timestamp(artifact.created_at || artifact.createdAt)}` : ''];
  if (Number.isInteger(artifact.taskRevision)) metadata.push(`Task revision ${artifact.taskRevision}`);
  if (Number.isInteger(artifact.iteration)) metadata.push(`Iteration ${artifact.iteration}`);
  if (metadata.filter(Boolean).length) caption.append(node('small', metadata.filter(Boolean).join(' · ')));
  caption.append(node('small', `SHA-256 ${artifact.sha256}`)); figure.append(caption); return figure;
}
function artifactPanel(task, taskId) {
  const section = node('section', undefined, 'artifact-panel'), heading = node('div', undefined, 'artifact-heading');
  heading.append(node('h3', 'All artifacts'));
  const summary = node('small'); heading.append(summary); section.append(heading);
  const facets = Array.isArray(task.artifactFacets) && task.artifactFacets.length ? task.artifactFacets : [{ taskRevision: task.taskRevision, count: task.artifactCount || 0, bytes: task.artifactBytes || 0, types: {} }];
  const revisionKey = value => Number.isInteger(value) ? String(value) : 'legacy';
  let activeRevision = revisionKey(Number.isInteger(task.taskRevision) ? task.taskRevision : facets[0]?.taskRevision);
  let activeType = 'all', loadedArtifacts = [], nextCursor = null, loadedKey = '';
  const revisionFilters = node('div', undefined, 'artifact-revision-filters'), typeFilters = node('div', undefined, 'artifact-filters');
  const groups = node('div', undefined, 'artifact-groups');
  const more = node('button', 'Load more artifacts'); more.className = 'artifact-more'; more.hidden = true;
  function facet() { return facets.find(item => revisionKey(item.taskRevision) === activeRevision) || { taskRevision: null, count: 0, bytes: 0, types: {} }; }
  function query() {
    const revision = activeRevision === 'legacy' ? 'legacy' : activeRevision;
    return `revision=${encodeURIComponent(revision)}&type=${encodeURIComponent(activeType)}&limit=5`;
  }
  function render() {
    const current = facet(), typeCounts = current.types || {}, total = activeType === 'all' ? Number(current.count || 0) : Number(typeCounts[activeType]?.count || 0);
    summary.textContent = `${loadedArtifacts.length} shown · ${total} total · ${Number(activeType === 'all' ? current.bytes : typeCounts[activeType]?.bytes || 0).toLocaleString()} bytes`;
    revisionFilters.replaceChildren();
    for (const item of facets) {
      const key = revisionKey(item.taskRevision), label = Number.isInteger(item.taskRevision) ? `Task Revision ${item.taskRevision}` : 'Legacy / unassigned';
      const button = node('button', `${label} (${Number(item.count || 0)})`); button.type = 'button'; button.className = 'artifact-filter'; button.setAttribute('aria-pressed', key === activeRevision ? 'true' : 'false');
      button.onclick = () => { if (key === activeRevision) return; activeRevision = key; activeType = 'all'; load(true); }; revisionFilters.append(button);
    }
    typeFilters.replaceChildren();
    for (const [type, label] of Object.entries(artifactTypeLabels)) {
      const amount = type === 'all' ? Number(current.count || 0) : Number(typeCounts[type]?.count || 0);
      const button = node('button', `${label} (${amount})`); button.type = 'button'; button.className = 'artifact-filter'; button.setAttribute('aria-pressed', type === activeType ? 'true' : 'false');
      button.onclick = () => { if (type === activeType) return; activeType = type; load(true); }; typeFilters.append(button);
    }
    groups.replaceChildren();
    if (!loadedArtifacts.length) groups.append(node('div', 'No artifacts in this category', 'empty'));
    else {
      const group = node('section', undefined, 'artifact-group');
      group.append(node('h4', Number.isInteger(current.taskRevision) ? `Task Revision ${current.taskRevision}` : 'Legacy / unassigned'));
      const grid = node('div', undefined, 'artifacts'); loadedArtifacts.forEach(item => grid.append(artifactCard(item))); group.append(grid); groups.append(group);
    }
    more.hidden = !nextCursor;
  }
  async function load(reset = false) {
    const key = `${activeRevision}:${activeType}`;
    if (reset) { loadedArtifacts = []; nextCursor = null; loadedKey = ''; render(); }
    if (loadedKey === key && !reset) return;
    more.disabled = true;
    try {
      const page = await api(`/v1/tasks/${encodeURIComponent(taskId)}/artifacts?${query()}`);
      if (selected !== taskId || key !== `${activeRevision}:${activeType}`) return;
      loadedArtifacts = page.artifacts || []; nextCursor = page.nextCursor; loadedKey = key; render();
    } catch (error) { notice(error.message); } finally { more.disabled = false; }
  }
  more.onclick = async () => {
    if (!nextCursor) return;
    more.disabled = true;
    try {
      const page = await api(`/v1/tasks/${encodeURIComponent(taskId)}/artifacts?${query()}&cursor=${encodeURIComponent(nextCursor)}`);
      if (selected !== taskId) return;
      const seen = new Set(loadedArtifacts.map(item => item.artifact_id)); loadedArtifacts.push(...(page.artifacts || []).filter(item => !seen.has(item.artifact_id)));
      nextCursor = page.nextCursor; render();
    } catch (error) { notice(error.message); } finally { more.disabled = false; }
  };
  section.append(revisionFilters, typeFilters, groups, more);
  const initialKey = `${activeRevision}:all`, initial = (task.artifacts || []).filter(item => revisionKey(item.taskRevision) === activeRevision);
  if (activeType === 'all' && initial.length) { loadedArtifacts = initial; nextCursor = task.artifactsNextCursor; loadedKey = initialKey; render(); }
  else load(true);
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
  const metadata = [timestamp(artifact.created_at || artifact.createdAt) ? `Created ${timestamp(artifact.created_at || artifact.createdAt)}` : ''];
  if (Number.isInteger(artifact.taskRevision)) metadata.push(`Task revision ${artifact.taskRevision}`);
  if (Number.isInteger(artifact.iteration)) metadata.push(`Iteration ${artifact.iteration}`);
  if (metadata.filter(Boolean).length) caption.append(node('small', metadata.filter(Boolean).join(' · ')));
  if (packageArtifact) caption.append(node('strong', 'Playable package', 'completed-output-label'));
  figure.append(caption);
  return figure;
}
function completedOutputsPanel(task) {
  if (task.status !== 'COMPLETED') return null;
  const section = node('section', undefined, 'completed-outputs');
  const heading = node('div', undefined, 'completed-outputs-heading');
  heading.append(node('h3', 'Current run outputs'), node('span', 'Latest run · ready to download'));
  section.append(heading);
  const artifacts = (Array.isArray(task.completedArtifacts) ? task.completedArtifacts : task.artifacts || [])
    .filter(artifact => !task.runId || !artifact.run_id || artifact.run_id === task.runId);
  const packages = artifacts.filter(isPlayablePackage);
  const finalPackage = packages.reduce((latest, item) => {
    if (!latest) return item;
    const currentIteration = Number.isInteger(item.iteration) ? item.iteration : -1;
    const latestIteration = Number.isInteger(latest.iteration) ? latest.iteration : -1;
    return currentIteration > latestIteration || (currentIteration === latestIteration && Date.parse(item.created_at || item.createdAt || 0) > Date.parse(latest.created_at || latest.createdAt || 0)) ? item : latest;
  }, null);
  const intermediate = item => artifactTypeOf(item) === 'log' || /^worker-screenshot-|^iteration-(?:monitor|diagnosis)-/i.test(item.name || '');
  const finalArtifacts = artifacts.filter(item => !intermediate(item) && (!isPlayablePackage(item) || item === finalPackage));
  const packageGroup = node('div', undefined, 'completed-output-group');
  packageGroup.append(node('h4', 'Playable packages'));
  if (!finalPackage) packageGroup.append(node('p', 'No playable package was uploaded for this task.', 'completed-outputs-empty'));
  else { const grid = node('div', undefined, 'completed-output-list'); grid.append(featuredArtifactCard(finalPackage, true)); packageGroup.append(grid); }
  section.append(packageGroup);
  const keyArtifacts = finalArtifacts.filter(item => !isPlayablePackage(item));
  if (keyArtifacts.length) {
    const keyGroup = node('div', undefined, 'completed-output-group'); keyGroup.append(node('h4', 'Final passing deliverables'));
    const grid = node('div', undefined, 'completed-output-list'); keyArtifacts.forEach(item => grid.append(featuredArtifactCard(item))); keyGroup.append(grid); section.append(keyGroup);
  }
  return section;
}
async function loadCompletedArtifacts(task, taskId) {
  if (task.status !== 'COMPLETED' || Number(task.artifactCount || 0) <= (task.artifacts?.length || 0)) return task;
  const cacheKey = `${taskId}:${task.runId || ''}`;
  const cached = completedArtifactCache.get(cacheKey);
  if (cached) return { ...task, completedArtifacts: cached };
  try {
    const revisionQuery = Number.isInteger(task.taskRevision) ? `&revision=${encodeURIComponent(task.taskRevision)}` : '';
    const page = await api(`/v1/tasks/${encodeURIComponent(taskId)}/artifacts?limit=100${revisionQuery}`);
    completedArtifactCache.set(cacheKey, page.artifacts || []);
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
  const summarySignature = `${task.runs?.[0]?.createdAt || ''}|${(task.iterationSummaries || []).map(item => `${item.taskRevision}:${item.iteration}:${item.status}:${item.goal}:${item.summary}:${item.step}:${item.diagnosticMissing}:${item.diagnosticArtifactId || ''}:${item.updatedAt || ''}:${JSON.stringify(item.failureReasons || [])}`).join('|')}`;
  const artifactSignature = `${task.taskRevision || ''}:${JSON.stringify(task.artifactFacets || [])}:${task.artifacts?.[0]?.artifact_id || ''}:${task.artifactsNextCursor || ''}`;
  const completedOutputSignature = `${task.runId || ''}:${displayTask.completedArtifacts?.length || 0}:${displayTask.completedArtifacts?.[0]?.artifact_id || ''}`;
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
    rerun.onclick = () => { followupReferences.clear(); $('followup-error').textContent = ''; $('followup-prompt').value = ''; $('followup-dialog').dataset.taskId = target; $('followup-dialog').showModal(); $('followup-prompt').focus(); };
    top.append(rerun);
  }
  pane.append(top, node('h2', task.objective));
  const details = node('dl', undefined, 'details');
  for (const [label, value] of [['Worker',task.workerId || 'Waiting for assigned worker'], ['Created',date(task.createdAt)], ['Workspace',task.workspaceId || 'Unassigned'], ['Task revision',task.taskRevision || '1'], ['Run request',task.currentPrompt || 'Initial task'], ['Task',task.taskId]]) {
    const group = node('div'); group.append(node('dt',label),node('dd',value)); details.append(group);
  }
  const completedOutputs = completedOutputsPanel(displayTask);
  pane.append(...(completedOutputs ? [completedOutputs] : []), details, referencePanel(task), progressPanel(task), iterationSummaryPanel(task), artifactPanel(task, target));
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
const createReferences = referencePicker('create'), followupReferences = referencePicker('followup');
$('create-form').onsubmit=async event=>{
  event.preventDefault(); if ($('create-submit').disabled) return; submitting('create', true); $('create-error').textContent='';
  try{
    const references = await createReferences.upload();
    const task=await api('/v1/tasks',{method:'POST',body:JSON.stringify({objective:$('objective').value, references})});
    createReferences.clear(false); $('create-dialog').close();$('objective').value='';await loadTasks();await selectTask(task.taskId);
  }catch(error){createReferences.failed(); $('create-error').textContent=error.message;}finally{submitting('create', false);}
};
$('followup-form').onsubmit=async event=>{
  event.preventDefault(); if ($('followup-submit').disabled) return; const taskId=$('followup-dialog').dataset.taskId; submitting('followup', true); $('followup-error').textContent='';
  try { const references = await followupReferences.upload(); await api(`/v1/tasks/${taskId}/rerun`, { method:'POST', body:JSON.stringify({ prompt:$('followup-prompt').value, references }) }); followupReferences.clear(false); $('followup-dialog').close(); $('followup-prompt').value=''; await loadTasks(); await selectTask(taskId); }
  catch(error) { followupReferences.failed(); $('followup-error').textContent=error.message; } finally { submitting('followup', false); }
};
api('/v1/auth/me').then(signedIn).catch(()=>signedOut());
