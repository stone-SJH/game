import path from 'node:path';
import { atomicJson, readJson, hashValue, agentEnvironment } from './modeling-io.mjs';
import { modelingInvocationArgs, validateSchema } from './modeling-evaluation.mjs';
import { executionPolicy, fileEvidence, modelingFailure } from './modeling-execution.mjs';

// A valid GAP is a completed review, not a reason to sample another answer.
export function createModelingReviewer({ execution, project, output, signal, step, invocation, evaluate }) {
  const policy = executionPolicy(invocation);
  return async function review({ name, schema, prompt, images = [], validate = value => value, maxCalls = 3, identity = {}, key }) {
    const evidence = await fileEvidence(images);
    const input = { schema, prompt, images, policy };
    return execution.run({ key: key || `${name}:${hashValue({ input, evidence })}`, stage: 'REVIEW', identity: { name, ...identity }, input,
      evidence, maxCalls, timeoutMs: policy.reviewMs, totalMs: maxCalls * policy.reviewMs, retry: error => error.kind !== 'CONTRACT_INCOMPLETE' },
    async ({ callId, timeoutMs, previousError }) => {
      const tag = `${name}-${callId}`;
      const schemaFile = path.join(output, `${tag}-schema.json`), responseFile = path.join(output, `${tag}-response.json`);
      await atomicJson(schemaFile, schema);
      const effectivePrompt = [prompt, `Required JSON schema (all required keys must be present): ${JSON.stringify(schema)}`,
        ...(previousError ? [`The preceding call failed validation/execution: ${previousError.message}. Return a fresh response for the SAME evidence. Do not alter the original requirements.`] : [])].join('\n');
      // Prompts and images are immutable inputs. Each repair prompt and raw response gets its own call id.
      await atomicJson(path.join(output, `${tag}-request.json`), { callId, name, identity, prompt: effectivePrompt,
        schemaHash: hashValue(schema), evidence, timeoutMs });
      let supplied, phase = 'invoke';
      try {
        signal?.throwIfAborted();
        if (evaluate) supplied = await evaluate({ name, schema, prompt: effectivePrompt, images });
        if (supplied !== undefined) await atomicJson(responseFile, supplied);
        else {
          const args = modelingInvocationArgs(invocation, project, schemaFile, responseFile, images);
          if (process.env.MODELING_AGENT_MODEL) args.splice(args.length - 1, 0, '--model', process.env.MODELING_AGENT_MODEL);
          await step(tag, invocation.command, args, timeoutMs, project, undefined, { input: effectivePrompt, env: agentEnvironment() });
        }
        signal?.throwIfAborted();
        phase = 'schema';
        const value = await readJson(responseFile);
        validateSchema(value, schema);
        validate(value);
        return value;
      } catch (error) {
        if (phase === 'schema' && !error.code && !error.kind) {
          throw modelingFailure('REVIEW_SCHEMA_INVALID', error.message, { responseFile });
        }
        throw error;
      }
    });
  };
}
