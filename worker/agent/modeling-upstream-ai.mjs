// Diagnostics only: never change retry budgets, acceptance or task state.
// Read CLI error events, not tool output or model prose quoting historical errors.
export function isAiInvocation(stage, args = []) {
  return /^(?:production-orchestrator|quality-review|iteration-diagnosis)(?:-\d+)?$/.test(stage) ||
    stage.startsWith('modeling-') && args.includes('exec');
}

function transportDiagnostic(text, stage) {
  if (typeof text !== 'string') return null;
  const http = text.match(/(?:unexpected\s+status|HTTP(?:\/[\d.]+)?(?:\s+status)?|status(?:\s+code)?)[\s:=]+([45]\d{2})\b/i);
  const status = http ? Number(http[1]) : null;
  let code, cause;
  if (status) {
    const descriptions = { 400: '请求被拒绝', 401: '身份验证失败', 403: '访问被拒绝', 408: '请求超时',
      429: '请求受限', 500: '服务内部错误', 502: '网关错误', 503: '服务暂不可用', 504: '网关超时' };
    const names = { 429: 'Too Many Requests', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' };
    code = 'HTTP_' + status;
    cause = 'HTTP ' + status + (names[status] ? ' ' + names[status] : '') + '（' + (descriptions[status] || '服务返回错误') + '）';
  } else if (/stream disconnected|stream (?:closed|ended) before (?:response\.completed|completion)|response stream (?:closed|interrupted)/i.test(text)) {
    code = 'STREAM_DISCONNECTED'; cause = '响应流中断（stream disconnected），未收到完整 AI 响应';
  } else if (/\bECONNRESET\b|connection reset by peer/i.test(text)) {
    code = 'CONNECTION_RESET'; cause = 'AI 服务连接被重置（ECONNRESET）';
  } else if (/\bETIMEDOUT\b|(?:request|connection|connect) timed out/i.test(text)) {
    code = 'REQUEST_TIMEOUT'; cause = 'AI 服务请求超时';
  } else if (/\b(?:EAI_AGAIN|ENOTFOUND)\b|dns (?:error|resolution failed)/i.test(text)) {
    code = 'DNS_ERROR'; cause = 'AI 服务域名解析失败';
  } else if (/\bECONNREFUSED\b|connection refused/i.test(text)) {
    code = 'CONNECTION_REFUSED'; cause = 'AI 服务连接被拒绝';
  } else if (/error sending request for url/i.test(text)) {
    code = 'REQUEST_SEND_FAILED'; cause = '无法向 AI 服务发送请求';
  } else return null;
  let endpoint;
  const rawUrl = text.match(/https?:\/\/[^\s<>"')\]}]+/i)?.[0]?.replace(/[,.;]+$/, '');
  if (rawUrl) try {
    const url = new URL(rawUrl);
    // Exclude credentials, query strings, fragments and arbitrary secret-bearing paths.
    endpoint = url.origin + (/^\/(?:v\d+\/)?(?:responses|chat\/completions)\/?$/.test(url.pathname) ? url.pathname : '');
  } catch { /* The cause remains useful without an unparseable endpoint. */ }
  const requestId = text.match(/request[ _-]?id\s*[:=]\s*([a-z0-9][a-z0-9._:-]{0,119})/i)?.[1];
  const reconnect = text.match(/Reconnecting\.{0,3}\s*(\d{1,3})\/(\d{1,3})/i);
  const retry = reconnect ? { attempt: Number(reconnect[1]), limit: Number(reconnect[2]) } : null;
  const message = '上游 AI 服务调用失败：' + cause + '。' + (stage ? '阶段：' + stage + '。' : '') +
    (endpoint ? '服务：' + endpoint + '。' : '') + (requestId ? '请求 ID：' + requestId + '。' : '') +
    (retry ? '正在重连（' + retry.attempt + '/' + retry.limit + '）。' : '');
  return { category: 'upstream-ai', code, message, stage,
    ...(status ? { httpStatus: status } : {}), ...(endpoint ? { endpoint } : {}),
    ...(requestId ? { requestId } : {}), ...(retry ? { retry } : {}) };
}

export function upstreamAiEvent(event, stage) {
  if (event?.type !== 'error' && event?.type !== 'turn.failed') return null;
  return transportDiagnostic(event.message || event.error?.message, stage);
}

export function diagnoseUpstreamAI(error, { stage = '', ai = false } = {}) {
  const result = error?.result || {};
  if (error?.executionFence || error?.stopConfirmed === false || result.stopConfirmed === false || result.canceled || result.timedOut ||
      /spawn |ENOENT|EACCES/i.test(result.error || '')) return null;
  if (!ai && !isAiInvocation(stage, result.args)) return null;
  if (error?.upstreamAI?.category === 'upstream-ai') return error.upstreamAI;
  // Runtime/CLI failures can quote source lines containing historical HTTP errors.
  if (/(?:^|\n)(?:SyntaxError|ReferenceError|TypeError|RangeError|Error \[ERR_[A-Z_]+\]):/m.test(result.stderr || '') ||
      /(?:^|\n)error: (?:unexpected argument|the following required arguments|invalid value)/m.test(result.stderr || '')) return null;
  let latest = null, terminal = false, sawEvents = false;
  for (const line of String(result.stdout || '').split(/\r?\n/)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (typeof event?.type !== 'string') continue;
    sawEvents = true;
    if (event.type === 'turn.completed') { latest = null; terminal = true; }
    if (event.type === 'error' || event.type === 'turn.failed') {
      latest = upstreamAiEvent(event, stage); terminal = event.type === 'turn.failed';
    }
  }
  if (terminal || latest) return latest;
  // Without a terminal error, don't attribute quoted tool/model diagnostics to AI.
  for (const source of [result.stderr, ...(!sawEvents ? [error?.message, typeof error === 'string' ? error : ''] : [])]) {
    for (const line of String(source || '').split(/\r?\n/).reverse()) {
      try { JSON.parse(line); continue; } catch { /* Plain CLI diagnostics only. */ }
      const diagnostic = transportDiagnostic(line, stage);
      if (diagnostic) return diagnostic;
    }
  }
  return null;
}
