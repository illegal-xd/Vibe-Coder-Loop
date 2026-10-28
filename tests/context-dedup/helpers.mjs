/**
 * Test fixtures built from the installed @opencode-ai/sdk message types.
 * These are not invented provider-neutral shapes: they are the shapes the
 * experimental.chat.messages.transform hook receives.
 */

export const SESSION_ID = "ses_test";

export function textPart({ id = "prt_text", messageID = "msg_assistant", text = "" } = {}) {
  return {
    id,
    sessionID: SESSION_ID,
    messageID,
    type: "text",
    text,
    time: { start: 1, end: 2 },
  };
}

export function toolPart({
  id = `prt_${Math.random().toString(36).slice(2)}`,
  messageID = "msg_assistant",
  callID,
  tool = "read",
  input = { filePath: "a.txt" },
  output = "same output",
  status = "completed",
  error = "boom",
  title = `${tool} call`,
  metadata = {},
} = {}) {
  const state =
    status === "completed"
      ? {
          status,
          input,
          output,
          title,
          metadata,
          time: { start: 1, end: 2 },
        }
      : status === "error"
        ? {
            status,
            input,
            error,
            metadata,
            time: { start: 1, end: 2 },
          }
        : status === "running"
          ? { status, input, title, metadata, time: { start: 1 } }
          : { status: "pending", input, raw: "" };

  return {
    id,
    sessionID: SESSION_ID,
    messageID,
    type: "tool",
    callID,
    tool,
    state,
  };
}

export function assistantMessage({
  id = "msg_assistant",
  parentID = "msg_user",
  cwd = "/repo",
  root = "/repo",
  parts = [],
} = {}) {
  const info = {
    id,
    sessionID: SESSION_ID,
    role: "assistant",
    time: { created: 1, completed: 2 },
    parentID,
    modelID: "test-model",
    providerID: "test-provider",
    mode: "default",
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    finish: "stop",
  };
  if (cwd !== null) info.path = { cwd, root: root ?? cwd };
  return { info, parts };
}

export function userMessage({ id = "msg_user", text = "continue" } = {}) {
  return {
    info: {
      id,
      sessionID: SESSION_ID,
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "test-provider", modelID: "test-model" },
    },
    parts: [textPart({ id: `${id}_part`, messageID: id, text })],
  };
}

export function toolRecord({
  id,
  order,
  tool = "read",
  args = { filePath: "a.txt" },
  cwd = "/repo",
  root = "/repo",
  status = "completed",
  output = "same output",
} = {}) {
  return {
    id,
    order,
    tool,
    args,
    env: { cwd, root },
    status,
    output,
  };
}

export function clone(value) {
  return structuredClone(value);
}
