export type FlagSeverity = 'high' | 'medium' | 'low';

export interface RedFlag {
  flag: string;
  definition: string;
  severity: FlagSeverity;
}

export interface AuditResult {
  redFlags: RedFlag[];
  fairnessScore: number;
  reDraft: string;
  isLogicallyVoid: boolean;
  verdictRule: string;
  logicalAssessment: string;
}

export class AuditParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditParseError';
  }
}

/**
 * Filters out blank/whitespace-only answer slots so unused UI inputs
 * are never sent to the model as "[Empty]".
 */
export function filterFilledAnswers(answers: unknown): string[] {
  if (!Array.isArray(answers)) return [];
  return answers
    .map((a) => (typeof a === 'string' ? a.trim() : ''))
    .filter((a) => a.length > 0);
}

/**
 * Builds the user prompt numbering only non-empty answer options.
 */
export function formatAuditPrompt(questionText: string, filledAnswers: string[]): string {
  const trimmedQuestion = questionText.trim();
  const answersBlock =
    filledAnswers.length > 0
      ? `Provided Answer Options (${filledAnswers.length} total — evaluate ONLY these options; do not expect additional slots):\n${filledAnswers
          .map((a, i) => `${i + 1}. ${a}`)
          .join('\n')}`
      : 'Provided Answer Options: [None supplied — audit the question stem alone and do not flag missing answer options]';

  return [
    'Audit the following examination item for logic gaps, implied context, undefined variables, and guesswork traps.',
    '',
    `Question: "${trimmedQuestion || '[No question stem provided — evaluate the logical consistency of the answer options]'}"`,
    answersBlock,
    '',
    'Audit requirements:',
    '- Identify hazardous assumptions, implied environments/platforms, undefined variables, or multiple-correct-answer collisions.',
    '- Assign severity strictly as:',
    '  * "high": Forces student guesswork, admits multiple valid answers, or omits context required to identify the intended answer.',
    '  * "medium": Notable ambiguity or undefined scope that weakens precision without making the answer unrecoverable.',
    '  * "low": Minor wording or scope imprecision.',
    '- Provide a "fairnessScore" integer from 1 to 100.',
    '- Provide a "reDraft" rewriting the question so all required context and variables are explicit.',
    '- Provide a "logicalAssessment" paragraph summarizing the logical relationship between the question and the provided options.',
    '- Output ONLY a single valid JSON object matching the schema. Do not include markdown code fences, thinking commentary, or placeholder ellipses ("...").',
  ].join('\n');
}

/**
 * Deterministic rule deriving pass/void status strictly from flag severities.
 * Rule: Logically Void when 1 or more HIGH-severity flags are present.
 */
export function deriveAuditVerdict(redFlags: RedFlag[]): {
  isLogicallyVoid: boolean;
  verdictRule: string;
} {
  const highCount = redFlags.filter((f) => f.severity === 'high').length;
  if (highCount >= 1) {
    return {
      isLogicallyVoid: true,
      verdictRule: `Rule: Void (${highCount} high-severity ${highCount === 1 ? 'flag' : 'flags'} ≥ 1 threshold)`,
    };
  }
  return {
    isLogicallyVoid: false,
    verdictRule: 'Rule: Passed (0 high-severity flags; void threshold is ≥ 1 high)',
  };
}

/**
 * Extracts text from a @google/genai response while stripping any thought parts.
 */
export function extractNonThoughtText(response: {
  text?: string;
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string; thought?: boolean }>;
    };
  }>;
}): string {
  const parts = response?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts) && parts.length > 0) {
    const nonThought = parts
      .filter((part) => part && part.thought !== true && typeof part.text === 'string')
      .map((part) => part.text as string)
      .join('');
    if (nonThought.trim().length > 0) {
      return nonThought;
    }
  }
  return typeof response?.text === 'string' ? response.text : '';
}

function stripThinkingBlocks(raw: string): string {
  return raw
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .trim();
}

/**
 * Scans a string for balanced top-level `{ ... }` JSON object candidates,
 * properly ignoring braces inside quoted JSON strings.
 */
function findBalancedJsonCandidates(input: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let startIdx = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      if (depth === 0) {
        startIdx = i;
      }
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && startIdx !== -1) {
          candidates.push(input.slice(startIdx, i + 1));
          startIdx = -1;
        }
      }
    }
  }

  return candidates;
}

function parseJsonObjectFromRaw(rawText: string): Record<string, unknown> {
  const stripped = stripThinkingBlocks(rawText);
  if (!stripped) {
    throw new AuditParseError('Empty response text from model.');
  }

  const tryParsePlainObject = (candidate: string): Record<string, unknown> | null => {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Continue trying fallback extractors
    }
    return null;
  };

  // 1. Direct parse for clean structured-output responses
  const direct = tryParsePlainObject(stripped);
  if (direct) return direct;

  // 2. Extract from markdown code fences (```json ... ``` or ``` ... ```)
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let fenceMatch: RegExpExecArray | null;
  while ((fenceMatch = fenceRegex.exec(stripped)) !== null) {
    const fencedContent = fenceMatch[1].trim();
    const parsedFence = tryParsePlainObject(fencedContent);
    if (parsedFence) return parsedFence;

    for (const candidate of findBalancedJsonCandidates(fencedContent)) {
      const parsedCandidate = tryParsePlainObject(candidate);
      if (parsedCandidate) return parsedCandidate;
    }
  }

  // 3. Extract balanced JSON object surrounded by chatty prose
  for (const candidate of findBalancedJsonCandidates(stripped)) {
    const parsedCandidate = tryParsePlainObject(candidate);
    if (parsedCandidate) return parsedCandidate;
  }

  throw new AuditParseError('Could not extract a valid JSON object from model output.');
}

function isPlaceholderText(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (/^(?:\.{2,}|…+|n\/a|none|null|undefined|tbd|\[empty\]|-+)$/i.test(trimmed)) {
    return true;
  }
  const alnumCount = (trimmed.match(/[a-z0-9]/gi) ?? []).length;
  return alnumCount < 2;
}

function hasRunawayOrFenceCorruption(value: string): boolean {
  if (value.includes('```')) return true;
  if (/<\/?(?:thought|thinking)>/i.test(value)) return true;
  if (
    /"(?:redFlags|fairnessScore|reDraft|logicalAssessment|isLogicallyVoid)"\s*:/.test(
      value
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Defensively parses and validates raw model text into a clean AuditResult,
 * stripping code fences / chatty wrappers and rejecting runaway or placeholder fields.
 */
export function parseAndValidateAuditResponse(rawText: string): AuditResult {
  const obj = parseJsonObjectFromRaw(rawText);

  if (!Array.isArray(obj.redFlags)) {
    throw new AuditParseError('Missing or non-array "redFlags" field.');
  }
  if (obj.redFlags.length > 25) {
    throw new AuditParseError('"redFlags" exceeds maximum expected count.');
  }

  const validatedFlags: RedFlag[] = obj.redFlags.map((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new AuditParseError(`redFlags[${idx}] is not an object.`);
    }
    const rec = item as Record<string, unknown>;
    const flag = typeof rec.flag === 'string' ? rec.flag.trim() : '';
    const definition = typeof rec.definition === 'string' ? rec.definition.trim() : '';
    const rawSeverity =
      typeof rec.severity === 'string' ? rec.severity.trim().toLowerCase() : '';

    if (
      flag.length < 2 ||
      flag.length > 200 ||
      isPlaceholderText(flag) ||
      hasRunawayOrFenceCorruption(flag)
    ) {
      throw new AuditParseError(`redFlags[${idx}].flag is invalid or corrupted.`);
    }

    if (
      definition.length < 8 ||
      definition.length > 1600 ||
      isPlaceholderText(definition) ||
      hasRunawayOrFenceCorruption(definition)
    ) {
      throw new AuditParseError(`redFlags[${idx}].definition is invalid or corrupted.`);
    }

    if (rawSeverity !== 'high' && rawSeverity !== 'medium' && rawSeverity !== 'low') {
      throw new AuditParseError(`redFlags[${idx}].severity is invalid.`);
    }

    return {
      flag,
      definition,
      severity: rawSeverity,
    };
  });

  if (
    typeof obj.fairnessScore !== 'number' ||
    !Number.isFinite(obj.fairnessScore) ||
    obj.fairnessScore < 1 ||
    obj.fairnessScore > 100
  ) {
    throw new AuditParseError('"fairnessScore" must be a finite number between 1 and 100.');
  }
  const fairnessScore = Math.round(obj.fairnessScore);

  const reDraft = typeof obj.reDraft === 'string' ? obj.reDraft.trim() : '';
  if (
    reDraft.length < 10 ||
    reDraft.length > 3000 ||
    isPlaceholderText(reDraft) ||
    hasRunawayOrFenceCorruption(reDraft)
  ) {
    throw new AuditParseError('"reDraft" is missing, placeholder-only, or corrupted.');
  }

  const logicalAssessment =
    typeof obj.logicalAssessment === 'string' ? obj.logicalAssessment.trim() : '';
  if (
    logicalAssessment.length < 15 ||
    logicalAssessment.length > 4000 ||
    isPlaceholderText(logicalAssessment) ||
    hasRunawayOrFenceCorruption(logicalAssessment)
  ) {
    throw new AuditParseError(
      '"logicalAssessment" is missing, placeholder-only, or corrupted.'
    );
  }

  const { isLogicallyVoid, verdictRule } = deriveAuditVerdict(validatedFlags);

  return {
    redFlags: validatedFlags,
    fairnessScore,
    reDraft,
    isLogicallyVoid,
    verdictRule,
    logicalAssessment,
  };
}
