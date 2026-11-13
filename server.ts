import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type, ThinkingLevel } from '@google/genai';
import dotenv from 'dotenv';
import {
  AuditParseError,
  AuditResult,
  extractNonThoughtText,
  filterFilledAnswers,
  formatAuditPrompt,
  parseAndValidateAuditResponse,
} from './server/auditEngine.ts';

dotenv.config();

const app = express();
const PORT = 3000;

// Valid active Gemini models (server-side only)
const PRIMARY_MODEL = 'gemini-4-hydrogen';
const FALLBACK_MODEL = 'gemini-3.1-flash-lite';

const MAX_PRIMARY_ATTEMPTS = 3;
const MAX_FALLBACK_ATTEMPTS = 2;
const BASE_BACKOFF_MS = 1000;

app.use(express.json());

// Server-side only Gemini AI client
function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is not configured');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorDetails(err: unknown): {
  status?: number;
  code?: string;
  rawMessage: string;
} {
  const anyErr = err as Record<string, unknown> | null | undefined;
  const rawMessage =
    typeof anyErr?.message === 'string' ? anyErr.message : String(err ?? '');

  let status: number | undefined =
    typeof anyErr?.status === 'number'
      ? anyErr.status
      : typeof anyErr?.code === 'number'
        ? anyErr.code
        : undefined;

  let code: string | undefined =
    typeof anyErr?.status === 'string'
      ? anyErr.status
      : typeof anyErr?.code === 'string'
        ? anyErr.code
        : undefined;

  try {
    const jsonStart = rawMessage.indexOf('{');
    if (jsonStart !== -1) {
      const parsed = JSON.parse(rawMessage.slice(jsonStart)) as Record<
        string,
        unknown
      >;
      const inner =
        (parsed?.error as Record<string, unknown> | undefined) ?? parsed;
      if (typeof inner?.code === 'number' && status === undefined) {
        status = inner.code;
      }
      if (typeof inner?.status === 'string' && !code) {
        code = inner.status;
      }
    }
  } catch {
    // Ignore non-JSON error messages
  }

  return { status, code, rawMessage };
}

function isRetryableOverloadOrRateLimit(err: unknown): boolean {
  const { status, code, rawMessage } = getErrorDetails(err);
  const upperCode = (code ?? '').toUpperCase();
  const upperMsg = rawMessage.toUpperCase();

  if (status === 503 || status === 429) return true;
  if (upperCode === 'UNAVAILABLE' || upperCode === 'RESOURCE_EXHAUSTED') {
    return true;
  }
  if (
    upperMsg.includes('503') ||
    upperMsg.includes('UNAVAILABLE') ||
    upperMsg.includes('429') ||
    upperMsg.includes('RESOURCE_EXHAUSTED') ||
    upperMsg.includes('HIGH DEMAND') ||
    upperMsg.includes('OVERLOADED')
  ) {
    return true;
  }

  return false;
}

function isFatalAuthOrConfigError(err: unknown): boolean {
  const { status, code, rawMessage } = getErrorDetails(err);
  const upperCode = (code ?? '').toUpperCase();
  const upperMsg = rawMessage.toUpperCase();

  return (
    status === 401 ||
    status === 403 ||
    upperCode === 'PERMISSION_DENIED' ||
    upperCode === 'UNAUTHENTICATED' ||
    upperMsg.includes('API_KEY_INVALID') ||
    upperMsg.includes('GEMINI_API_KEY ENVIRONMENT VARIABLE IS NOT CONFIGURED')
  );
}

const AUDIT_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    logicalAssessment: {
      type: Type.STRING,
      description:
        'Plain-prose paragraph summarizing the logical alignment between the question stem and provided options. Never use ellipses or markdown.',
    },
    redFlags: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          flag: {
            type: Type.STRING,
            description: 'Concise title of the specific logic issue (e.g., Implied Platform).',
          },
          definition: {
            type: Type.STRING,
            description:
              'Plain-prose explanation of the logic gap or ambiguity. No code fences or JSON.',
          },
          severity: {
            type: Type.STRING,
            enum: ['high', 'medium', 'low'],
          },
        },
        required: ['flag', 'definition', 'severity'],
        propertyOrdering: ['flag', 'severity', 'definition'],
      },
    },
    fairnessScore: {
      type: Type.INTEGER,
      description: 'Integer fairness score from 1 to 100.',
    },
    reDraft: {
      type: Type.STRING,
      description:
        'Suggested unambiguous rewrite of the question with explicit context and defined variables. Plain prose only.',
    },
  },
  required: ['logicalAssessment', 'redFlags', 'fairnessScore', 'reDraft'],
  propertyOrdering: ['logicalAssessment', 'redFlags', 'fairnessScore', 'reDraft'],
};

function buildAuditRequest(model: string, questionText: string, filledAnswers: string[]) {
  // gemini-4-hydrogen supports LOW as its minimum thinking level; gemini-3.1-flash-lite supports MINIMAL.
  const thinkingLevel =
    model === PRIMARY_MODEL ? ThinkingLevel.LOW : ThinkingLevel.MINIMAL;

  return {
    model,
    contents: formatAuditPrompt(questionText, filledAnswers),
    config: {
      systemInstruction:
        'You are an examination logic auditor. Return strictly a single JSON object conforming to the schema. Write clean, complete plain-text sentences inside every string property—never output markdown code fences, self-correction commentary, or placeholder ellipses ("...").',
      thinkingConfig: {
        thinkingLevel,
        includeThoughts: false,
      },
      responseMimeType: 'application/json',
      responseSchema: AUDIT_RESPONSE_SCHEMA,
    },
  };
}

async function callModelWithOverloadRetry(
  ai: GoogleGenAI,
  model: string,
  questionText: string,
  filledAnswers: string[],
  maxAttempts: number
): Promise<string> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await ai.models.generateContent(
        buildAuditRequest(model, questionText, filledAnswers)
      );
      return extractNonThoughtText(response);
    } catch (err) {
      lastError = err;

      if (!isRetryableOverloadOrRateLimit(err) || attempt === maxAttempts) {
        throw err;
      }

      const jitterMs = Math.floor(Math.random() * 250);
      const delayMs = BASE_BACKOFF_MS * Math.pow(2, attempt - 1) + jitterMs;
      console.warn(
        `[Audit] Model "${model}" returned transient 503/429 on attempt ${attempt}/${maxAttempts}. Retrying in ${delayMs}ms...`
      );
      await sleep(delayMs);
    }
  }

  throw lastError;
}

async function generateRawWithModelFallback(
  ai: GoogleGenAI,
  questionText: string,
  filledAnswers: string[]
): Promise<string> {
  try {
    return await callModelWithOverloadRetry(
      ai,
      PRIMARY_MODEL,
      questionText,
      filledAnswers,
      MAX_PRIMARY_ATTEMPTS
    );
  } catch (primaryErr) {
    if (isFatalAuthOrConfigError(primaryErr)) {
      throw primaryErr;
    }

    console.warn(
      `[Audit] Primary model "${PRIMARY_MODEL}" failed after retries. Falling back to "${FALLBACK_MODEL}".`
    );

    return await callModelWithOverloadRetry(
      ai,
      FALLBACK_MODEL,
      questionText,
      filledAnswers,
      MAX_FALLBACK_ATTEMPTS
    );
  }
}

/**
 * Runs the audit with transient 503/429 backoff + model fallback, validates the
 * structured output, and on a parse/schema failure retries once before failing cleanly.
 */
async function executeValidatedAudit(
  ai: GoogleGenAI,
  questionText: string,
  filledAnswers: string[]
): Promise<AuditResult> {
  const maxParseAttempts = 2; // Initial attempt + 1 retry on parse/schema failure

  for (let parseAttempt = 1; parseAttempt <= maxParseAttempts; parseAttempt++) {
    const rawText = await generateRawWithModelFallback(ai, questionText, filledAnswers);
    try {
      return parseAndValidateAuditResponse(rawText);
    } catch (parseErr) {
      console.warn(
        `[Audit] Structured response validation failed on parse attempt ${parseAttempt}/${maxParseAttempts}:`,
        parseErr instanceof Error ? parseErr.message : parseErr
      );
      if (parseAttempt === maxParseAttempts) {
        throw parseErr instanceof AuditParseError
          ? parseErr
          : new AuditParseError('Model response failed schema validation.');
      }
    }
  }

  throw new AuditParseError('Model response failed schema validation.');
}

function toFriendlyErrorResponse(err: unknown): {
  httpStatus: number;
  message: string;
} {
  if (err instanceof AuditParseError) {
    return {
      httpStatus: 502,
      message:
        'The audit model returned an incomplete or improperly formatted response, even after an automatic retry. Your inputs are saved—please click Retry Audit to run again.',
    };
  }

  const { status, code, rawMessage } = getErrorDetails(err);
  const upperCode = (code ?? '').toUpperCase();
  const upperMsg = rawMessage.toUpperCase();

  if (
    status === 503 ||
    upperCode === 'UNAVAILABLE' ||
    upperMsg.includes('UNAVAILABLE') ||
    upperMsg.includes('HIGH DEMAND') ||
    upperMsg.includes('OVERLOADED')
  ) {
    return {
      httpStatus: 503,
      message:
        'The audit service is currently experiencing high demand. Your question and answers are still saved—please wait a moment and click Retry.',
    };
  }

  if (
    status === 429 ||
    upperCode === 'RESOURCE_EXHAUSTED' ||
    upperMsg.includes('RESOURCE_EXHAUSTED') ||
    upperMsg.includes('RATE LIMIT') ||
    upperMsg.includes('QUOTA')
  ) {
    return {
      httpStatus: 429,
      message:
        'The audit service reached a temporary rate limit. Your inputs are preserved—please wait a few seconds and click Retry.',
    };
  }

  if (isFatalAuthOrConfigError(err)) {
    return {
      httpStatus: 500,
      message:
        'The server could not authenticate with the Gemini API. Please check the server API key in Settings > Secrets.',
    };
  }

  return {
    httpStatus: 500,
    message:
      'We could not complete the audit right now due to a temporary service error. Your inputs have been kept—please try again.',
  };
}

// Health check endpoint
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Audit endpoint
app.post('/api/audit', async (req, res) => {
  try {
    const { question, answers } = req.body ?? {};

    const questionText = typeof question === 'string' ? question : '';
    const filledAnswers = filterFilledAnswers(answers);

    if (!questionText.trim() && filledAnswers.length === 0) {
      return res.status(400).json({
        error: 'Please enter a question or at least one answer to audit.',
      });
    }

    const ai = getGeminiClient();
    const auditData = await executeValidatedAudit(ai, questionText, filledAnswers);
    return res.json(auditData);
  } catch (err: unknown) {
    console.error('Audit API error:', err);
    const { httpStatus, message } = toFriendlyErrorResponse(err);
    return res.status(httpStatus).json({ error: message });
  }
});

// Vite middleware in dev or static serving in prod
async function start() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Logic Sieve server running on http://0.0.0.0:${PORT}`);
  });
}

start();
