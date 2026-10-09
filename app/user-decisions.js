// The authenticated API owns question identity and answer acceptance. A draft is
// scoped to this account, task and immutable question, never a default approval.
window.renderUserDecision = function ({ task, userId, api, node, refresh }) {
  const question = task.inputRequest;
  const panel = node('section', undefined, 'user-decision');
  panel.setAttribute('aria-labelledby', 'decision-title');
  const heading = node('h3', 'Waiting for your answer · 等待你的回答'); heading.id = 'decision-title';
  panel.append(heading, node('h4', question.title), node('p', question.reason));
  panel.append(node('p', '当前工作已保存。等待期间不重试生成、不增加生产迭代。回答后只修改已授权的要求，并重新验证受影响的结果。'));
  const facts = node('dl');
  for (const [label, value] of [['Affected assets / 资产', question.assetIds.join(', ') || 'Project'], ['Stage / 阶段', question.stage],
    ['Expected / 当前要求', question.expected], ['Actual / 实际结果', question.actual]]) {
    facts.append(node('dt', label), node('dd', value));
  }
  panel.append(facts);
  const input = question.generationInput;
  if (input) {
    panel.append(node('p', '服务未提供具体触发词或图像区域。请修改实际内容；新输入仍会经过服务审核。'));
    const original = node('details'); original.open = true;
    original.append(node('summary', 'Actual submitted prompt / 实际提交的 prompt'), node('pre', input.prompt || 'No text prompt was submitted.'));
    original.append(node('p', [input.provider, input.code, input.requestId].filter(Boolean).join(' / ')));
    if (input.submittedImage) original.append(node('p', `Actual submitted image: ${input.submittedImage.path} · SHA-256 ${input.submittedImage.sha256}`));
    panel.append(original);
  }
  const report = node('button', 'Download input report / 下载输入报告'); report.type = 'button';
  report.onclick = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(question, null, 2)], { type: 'application/json' }));
    const link = node('a'); link.href = url; link.download = 'user-input-required.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  panel.append(report);
  const storageKey = `decision:${userId}:${task.taskId}:${question.requestId}`;
  let draft = {};
  try { draft = JSON.parse(sessionStorage.getItem(storageKey) || '{}'); } catch { /* Storage may be unavailable. */ }
  const form = node('form'); form.className = 'decision-form';
  const options = node('fieldset'); options.append(node('legend', '选择明确方案，或填写自定义回答（不自动选择）'));
  for (const option of question.options) {
    const label = node('label', undefined, 'decision-option'), radio = node('input');
    radio.type = 'radio'; radio.name = 'decision-option'; radio.value = option.id; radio.checked = draft.optionId === option.id;
    const description = node('span'); description.append(node('strong', option.label), node('p', option.consequences));
    const amendment = node('details'); amendment.append(node('summary', 'Exact amendment / 完整变更'), node('p', option.instruction));
    description.append(amendment); label.append(radio, description); options.append(label);
  }
  const customLabel = node('label', undefined, 'decision-option'), custom = node('input');
  custom.type = 'radio'; custom.name = 'decision-option'; custom.value = ''; custom.checked = draft.optionId === '';
  customLabel.append(custom, node('span', '自定义回答')); options.append(customLabel); form.append(options);
  const label = node('label', input ? '完整的新视觉描述（不要只写“继续”或“允许修改”）' : '补充说明或完整的自定义决定');
  const editor = node('textarea'); editor.name = 'decision-text'; editor.maxLength = 6000; editor.rows = 6; editor.value = draft.text || '';
  label.append(editor); form.append(label);
  const references = node('fieldset');
  if (input?.referenceImages.length) {
    references.append(node('legend', '用于下一次生成的参考图；取消选择会将其移出生成输入'));
    for (const reference of input.referenceImages) {
      const row = node('label', undefined, 'decision-option'), check = node('input');
      check.type = 'checkbox'; check.name = 'reference'; check.value = reference.path;
      check.checked = draft.referencePaths ? draft.referencePaths.includes(reference.path) : true;
      row.append(check, node('span', `${reference.path} · SHA-256 ${reference.sha256}`)); references.append(row);
    }
    form.append(references);
  }
  const budgetLabel = node('label', undefined, 'decision-option'), budget = node('input');
  budget.type = 'checkbox'; budget.name = 'grant-budget'; budget.checked = draft.grantNewBudget === true;
  budgetLabel.append(budget, node('span', '额外授权每个资产最多 3 次制作调用、10 次生产迭代。默认继承剩余预算；历史消耗仍保留。')); form.append(budgetLabel);
  const error = node('p', '', 'decision-error'); error.setAttribute('role', 'alert');
  const submit = node('button', '提交回答并继续'); submit.className = 'primary'; submit.type = 'submit';
  form.append(error, submit); panel.append(form);
  function values() {
    return { optionId: form.querySelector('input[name="decision-option"]:checked')?.value || '', text: editor.value,
      referencePaths: [...references.querySelectorAll('input:checked')].map(el => el.value), grantNewBudget: budget.checked };
  }
  function save() {
    const next = values();
    if (JSON.stringify(next) !== JSON.stringify(draft.values)) draft = { ...next, values: next, idempotencyKey: crypto.randomUUID() };
    try { sessionStorage.setItem(storageKey, JSON.stringify(draft)); } catch { /* The form still works without persistence. */ }
    return next;
  }
  form.addEventListener('input', save);
  form.onsubmit = async event => {
    event.preventDefault(); const answer = save();
    error.textContent = '';
    for (const control of form.elements) control.disabled = true;
    try {
      await api(`/v1/tasks/${encodeURIComponent(task.taskId)}/answer`, { method: 'POST', body: JSON.stringify({ ...answer,
        requestId: question.requestId, revisionId: question.revisionId, basePlanHash: question.basePlanHash,
        effectiveInputHash: question.effectiveInputHash, idempotencyKey: draft.idempotencyKey }) });
      try { sessionStorage.removeItem(storageKey); } catch { /* Optional local draft. */ }
      await refresh();
    } catch (failure) {
      error.textContent = failure.message + ' 回答草稿已保留。网络中断可再次提交；问题已变化时请刷新任务。';
    } finally { for (const control of form.elements) control.disabled = false; }
  };
  return panel;
};
