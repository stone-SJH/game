// Resume the exact conversation after a transport failure. Replaying the original
// prompt after tool activity can duplicate edits or paid provider operations.
export function codexServiceSession(args) {
  const enabled = args.includes('exec') && args.includes('--json') && args.at(-1) === '-';
  const initialArgs = enabled ? args.filter(arg => arg !== '--ephemeral') : args;
  let threadId = null, toolStarted = false, uncertainTool = false;
  const activeTools = new Set();
  return {
    observe(event) {
      if (event.type === 'thread.started' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(event.thread_id)) {
        if (threadId && threadId !== event.thread_id) uncertainTool = true;
        else threadId = event.thread_id;
      }
      if (!['command_execution', 'mcp_tool_call', 'file_change'].includes(event.item?.type)) return;
      toolStarted = true;
      if (!event.item.id) { uncertainTool = true; return; }
      if (event.type === 'item.started') activeTools.add(event.item.id);
      if (event.type === 'item.completed') {
        activeTools.delete(event.item.id);
        // A returned MCP error can contain an unconfirmed child shutdown.
        if (event.item.type === 'mcp_tool_call' && /"stopConfirmed"\s*:\s*false/.test(JSON.stringify(event.item).replaceAll('\\"', '"'))) uncertainTool = true;
      }
    },
    retrySafe(result) {
      return result.stopConfirmed === true && !result.canceled && !result.timedOut && !uncertainTool && !activeTools.size &&
        (!toolStarted || enabled && Boolean(threadId));
    },
    invocation(attempt, remainingMs) {
      if (!enabled || !attempt || !threadId) return { args: initialArgs };
      // Initial images are already in the saved conversation. Keep exec options
      // before the resume subcommand (not all are accepted by resume itself).
      const resumeArgs = [];
      for (let i = 0; i < initialArgs.length - 1; i++) {
        if (['--image', '-i'].includes(initialArgs[i])) { i++; continue; }
        resumeArgs.push(initialArgs[i]);
      }
      return { args: [...resumeArgs, 'resume', threadId, '-'], input: [
        'The host is continuing this same stage after a temporary upstream AI service interruption.',
        'Retain completed tool results and saved files. Inspect existing outputs and continue only unfinished work; do not repeat completed side effects or restart the stage.',
        `The original requirements and acceptance gates still apply. Remaining host time: ${Math.floor(remainingMs / 1000)} seconds. Return the required final response when finished.`,
      ].join('\n') };
    },
    get threadId() { return threadId; },
  };
}
