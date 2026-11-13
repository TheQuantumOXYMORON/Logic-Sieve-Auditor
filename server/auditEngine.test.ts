import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AuditParseError,
  deriveAuditVerdict,
  extractNonThoughtText,
  filterFilledAnswers,
  formatAuditPrompt,
  parseAndValidateAuditResponse,
} from './auditEngine.ts';

test('parses a fenced, chatty model response and strips thinking blocks', () => {
  const chattyFencedResponse = `
<thought>
Let me check if the shell environment is defined before formatting JSON.
</thought>
Here is the structured audit result you requested! I formatted it as JSON below:

\`\`\`json
{
  "logicalAssessment": "All four commands list files in different shells (Bash, CMD, PowerShell), forcing the student to guess the target operating system.",
  "redFlags": [
    {
      "flag": "Implied Operating System & Shell",
      "definition": "The stem asks which command lists all files without specifying Linux/Bash, Windows CMD, or PowerShell.",
      "severity": "HIGH"
    },
    {
      "flag": "Undefined Scope of 'All Files'",
      "definition": "It is unclear whether hidden dotfiles or '.' and '..' entries are expected in the output.",
      "severity": "medium"
    }
  ],
  "fairnessScore": 18,
  "reDraft": "In a standard Linux Bash shell, which command lists all entries (including hidden files) in the current working directory?"
}
\`\`\`

Let me know if you want another variation!
  `;

  const result = parseAndValidateAuditResponse(chattyFencedResponse);

  assert.equal(result.redFlags.length, 2);
  assert.equal(result.redFlags[0].flag, 'Implied Operating System & Shell');
  assert.equal(result.redFlags[0].severity, 'high');
  assert.equal(result.fairnessScore, 18);
  assert.equal(result.isLogicallyVoid, true);
  assert.match(result.verdictRule, /1 high-severity flag/i);
  assert.ok(!result.reDraft.includes('```'));
});

test('rejects runaway JSON / self-talk leaked into a flag definition with ellipsis placeholders', () => {
  const corruptedRunawayResponse = JSON.stringify({
    redFlags: [
      {
        flag: 'Implied Platform',
        definition:
          'The question omits the OS.", "severity": "high"}, {"flag": "Multiple Answers", "fairnessScore": 15, "reDraft": "In Linux..." Wait, let me fix the JSON formatting:\n```json\n{"fairnessScore": 15}\n```',
        severity: 'high',
      },
    ],
    fairnessScore: 15,
    reDraft: '...',
    logicalAssessment: '…',
  });

  assert.throws(
    () => parseAndValidateAuditResponse(corruptedRunawayResponse),
    AuditParseError
  );
});

test('filters blank answer slots and numbers only filled options in the prompt', () => {
  const rawAnswers = ['ls -la', 'dir /a', 'Get-ChildItem -Force', 'find . -maxdepth 1', '', '   '];
  const filled = filterFilledAnswers(rawAnswers);

  assert.deepEqual(filled, [
    'ls -la',
    'dir /a',
    'Get-ChildItem -Force',
    'find . -maxdepth 1',
  ]);

  const prompt = formatAuditPrompt('Which command lists all files?', filled);
  assert.ok(prompt.includes('Provided Answer Options (4 total'));
  assert.ok(prompt.includes('4. find . -maxdepth 1'));
  assert.ok(!prompt.includes('5.'));
  assert.ok(!prompt.includes('[Empty]'));
});

test('derives pass/void deterministically from red flag severities and strips thought parts', () => {
  const passed = deriveAuditVerdict([
    { flag: 'Minor wording', definition: 'Slightly informal phrasing in stem.', severity: 'low' },
    { flag: 'Broad scope', definition: 'Term could be narrower.', severity: 'medium' },
  ]);
  assert.equal(passed.isLogicallyVoid, false);

  const voided = deriveAuditVerdict([
    { flag: 'Missing OS', definition: 'Requires guessing Linux vs Windows.', severity: 'high' },
  ]);
  assert.equal(voided.isLogicallyVoid, true);

  const extracted = extractNonThoughtText({
    candidates: [
      {
        content: {
          parts: [
            { text: 'Internal reasoning draft...', thought: true },
            { text: '{"fairnessScore":90}', thought: false },
          ],
        },
      },
    ],
  });
  assert.equal(extracted, '{"fairnessScore":90}');
});
