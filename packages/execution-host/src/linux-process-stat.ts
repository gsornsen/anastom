/** Process fields needed for identity and optional process-group ownership on Linux. */
export interface LinuxProcessStat {
  state: string;
  startToken: string;
  processGroupId?: number;
}

/**
 * Parse `/proc/<pid>/stat` without requiring a usable process-group identifier.
 *
 * Public lease identity needs only the state and start token. Callers that signal a process group
 * must separately require its positive identifier.
 */
export function parseLinuxProcessStat(value: string): LinuxProcessStat {
  const commandEnd = value.lastIndexOf(")");
  if (commandEnd < 2) {
    throw new Error("Linux process stat is malformed");
  }
  const fields = value
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/);
  const state = fields[0];
  const startToken = fields[19];
  if (!state || !startToken) {
    throw new Error("Linux process identity is malformed");
  }
  const group = Number(fields[2]);
  const processGroupId = Number.isSafeInteger(group) && group > 0 ? group : undefined;
  return { state, startToken, ...(processGroupId === undefined ? {} : { processGroupId }) };
}
