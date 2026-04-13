/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { GoogleGenAI, Type } from "@google/genai";
import { 
  AlertTriangle, 
  CheckCircle2, 
  ShieldAlert, 
  FileText, 
  RefreshCw, 
  Search, 
  Scale, 
  Info,
  ArrowRight,
  AlertCircle
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// Initialize Gemini API
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

interface RedFlag {
  flag: string;
  definition: string;
  severity: 'high' | 'medium' | 'low';
}

interface AuditResult {
  redFlags: RedFlag[];
  fairnessScore: number;
  reDraft: string;
  isLogicallyVoid: boolean;
  logicalAssessment: string;
}

export default function App() {
  const [question, setQuestion] = useState('');
  const [answers, setAnswers] = useState(['', '', '', '', '', '']);
  const [isAuditing, setIsAuditing] = useState(false);
  const [result, setResult] = useState<AuditResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleAnswerChange = (index: number, value: string) => {
    const newAnswers = [...answers];
    newAnswers[index] = value;
    setAnswers(newAnswers);
  };

  const runAudit = async () => {
    if (!question.trim() && answers.every(a => !a.trim())) {
      setError('Please enter a question or at least one answer to audit.');
      return;
    }

    setIsAuditing(true);
    setError(null);
    setResult(null);

    try {
      const response = await ai.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents: `
          Audit the following examination question and its provided answers for logic gaps, implied context, undefined variables, and guesswork traps.
          
          Question: "${question || '[No question provided]'}"
          Answers:
          ${answers.map((a, i) => `${i + 1}. ${a || '[Empty]'}`).join('\n')}

          Your goal:
          1. Identify "Hazardous Assumptions" and "Guesswork Traps".
          2. Flag terms that aren't explicitly defined.
          3. Identify where a student must guess the examiner's environment/intent.
          4. If the question is fundamentally flawed such that a student must guess to find the 'correct' answer, mark it as LOGICALLY VOID.
          5. Provide a "Fairness Score" (1-100).
          6. Provide a "Re-Draft" that is factually deterministic.
          7. For each flag, provide a clear definition of the logical fallacy or issue.
          8. Provide a "Logical Assessment": A brief paragraph summarizing the logical relationship between the question and answers, even if no major red flags are found. If the question is missing, assess the logical consistency of the answers themselves.

          Return the result in JSON format.
        `,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              redFlags: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    flag: { type: Type.STRING, description: "The specific issue identified (e.g., Implied Platform)." },
                    definition: { type: Type.STRING, description: "Definition of the fallacy or logic gap." },
                    severity: { type: Type.STRING, enum: ["high", "medium", "low"] }
                  },
                  required: ["flag", "definition", "severity"]
                }
              },
              fairnessScore: { type: Type.NUMBER, description: "Rating from 1-100." },
              reDraft: { type: Type.STRING, description: "A deterministic version of the question." },
              isLogicallyVoid: { type: Type.BOOLEAN, description: "True if the question is fundamentally flawed." },
              logicalAssessment: { type: Type.STRING, description: "A brief logical assessment of the inputs." }
            },
            required: ["redFlags", "fairnessScore", "reDraft", "isLogicallyVoid", "logicalAssessment"]
          }
        }
      });

      const auditData = JSON.parse(response.text || '{}') as AuditResult;
      setResult(auditData);
    } catch (err) {
      console.error('Audit failed:', err);
      setError('The audit process encountered an error. Please try again.');
    } finally {
      setIsAuditing(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#E4E3E0] text-[#141414] font-sans selection:bg-[#141414] selection:text-[#E4E3E0]">
      {/* Header */}
      <header className="border-b border-[#141414] p-6 flex justify-between items-center bg-[#E4E3E0] sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="bg-[#141414] p-2 rounded-sm">
            <Search className="w-6 h-6 text-[#E4E3E0]" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tighter uppercase italic font-serif">Logic Sieve</h1>
            <p className="text-[10px] uppercase tracking-widest opacity-60 font-mono">Ambiguity & Context Auditor v1.0</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="hidden md:flex flex-col items-end">
            <span className="text-[10px] uppercase font-mono opacity-50">System Status</span>
            <span className="text-xs font-mono flex items-center gap-1.5">
              <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
              Operational
            </span>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left Column: Input */}
        <div className="lg:col-span-5 space-y-8">
          <section className="space-y-4">
            <div className="flex items-center gap-2 border-b border-[#141414] pb-2">
              <FileText className="w-4 h-4" />
              <h2 className="text-sm font-bold uppercase tracking-wider font-mono">Input: Suspect Question</h2>
            </div>
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Paste the examiner's question here..."
              className="w-full h-48 bg-white/50 border border-[#141414] p-4 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-[#141414] transition-all resize-none"
            />
          </section>

          <section className="space-y-4">
            <div className="flex items-center gap-2 border-b border-[#141414] pb-2">
              <CheckCircle2 className="w-4 h-4" />
              <h2 className="text-sm font-bold uppercase tracking-wider font-mono">Input: Provided Answers</h2>
            </div>
            <div className="grid grid-cols-1 gap-3">
              {answers.map((answer, index) => (
                <div key={index} className="flex gap-2">
                  <span className="flex items-center justify-center w-8 h-10 border border-[#141414] font-mono text-xs bg-white/30">
                    {index + 1}
                  </span>
                  <input
                    type="text"
                    value={answer}
                    onChange={(e) => handleAnswerChange(index, e.target.value)}
                    placeholder={`Answer option ${index + 1}...`}
                    className="flex-1 bg-white/50 border border-[#141414] px-3 h-10 text-sm focus:outline-none focus:ring-1 focus:ring-[#141414]"
                  />
                </div>
              ))}
            </div>
          </section>

          <div className="flex gap-4">
            <button
              onClick={runAudit}
              disabled={isAuditing}
              className="flex-1 bg-[#141414] text-[#E4E3E0] py-4 flex items-center justify-center gap-3 hover:bg-opacity-90 transition-all disabled:opacity-50 disabled:cursor-not-allowed group"
            >
              {isAuditing ? (
                <RefreshCw className="w-5 h-5 animate-spin" />
              ) : (
                <ShieldAlert className="w-5 h-5 group-hover:scale-110 transition-transform" />
              )}
              <span className="font-bold uppercase tracking-widest text-sm">Initiate Logic Audit</span>
            </button>
            <button
              onClick={() => {
                setQuestion('');
                setAnswers(['', '', '', '', '', '']);
                setResult(null);
                setError(null);
              }}
              disabled={isAuditing}
              className="px-6 border border-[#141414] hover:bg-[#141414] hover:text-[#E4E3E0] transition-all disabled:opacity-50"
              title="Reset Form"
            >
              <RefreshCw className="w-5 h-5" />
            </button>
          </div>

          {error && (
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="p-4 bg-red-100 border border-red-400 text-red-700 text-sm flex items-start gap-3"
            >
              <AlertCircle className="w-5 h-5 shrink-0" />
              <p>{error}</p>
            </motion.div>
          )}
        </div>

        {/* Right Column: Results */}
        <div className="lg:col-span-7">
          <AnimatePresence mode="wait">
            {!result && !isAuditing ? (
              <motion.div 
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="h-full border-2 border-dashed border-[#141414]/20 flex flex-col items-center justify-center p-12 text-center space-y-4"
              >
                <div className="p-6 rounded-full bg-[#141414]/5">
                  <Search className="w-12 h-12 opacity-20" />
                </div>
                <div className="max-w-xs">
                  <h3 className="font-serif italic text-xl">Awaiting Audit Data</h3>
                  <p className="text-xs opacity-50 font-mono mt-2 uppercase tracking-tight">
                    Input a question and answers to begin the logical ambiguity analysis.
                  </p>
                </div>
              </motion.div>
            ) : isAuditing ? (
              <motion.div 
                key="loading"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="h-full flex flex-col items-center justify-center p-12 space-y-6"
              >
                <div className="relative">
                  <RefreshCw className="w-16 h-16 animate-spin opacity-20" />
                  <div className="absolute inset-0 flex items-center justify-center">
                    <Search className="w-6 h-6 animate-pulse" />
                  </div>
                </div>
                <div className="text-center space-y-2">
                  <h3 className="font-serif italic text-xl">Scanning for Logic Gaps...</h3>
                  <div className="flex gap-1 justify-center">
                    {[0, 1, 2].map(i => (
                      <motion.div
                        key={i}
                        animate={{ opacity: [0.2, 1, 0.2] }}
                        transition={{ duration: 1, repeat: Infinity, delay: i * 0.2 }}
                        className="w-1.5 h-1.5 bg-[#141414] rounded-full"
                      />
                    ))}
                  </div>
                </div>
              </motion.div>
            ) : (
              <motion.div 
                key="result"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                className="space-y-8"
              >
                {/* Score and Status */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="border border-[#141414] p-6 bg-white flex flex-col items-center justify-center text-center space-y-2">
                    <span className="text-[10px] uppercase font-mono opacity-50 tracking-widest">Fairness Score</span>
                    <div className="relative flex items-center justify-center">
                      <Scale className="w-24 h-24 opacity-5 absolute" />
                      <span className="text-6xl font-serif italic font-bold">{result.fairnessScore}</span>
                      <span className="text-xs opacity-50 font-mono self-end mb-2">/100</span>
                    </div>
                  </div>
                  <div className={`border border-[#141414] p-6 flex flex-col items-center justify-center text-center space-y-2 ${result.isLogicallyVoid ? 'bg-red-50' : 'bg-green-50'}`}>
                    <span className="text-[10px] uppercase font-mono opacity-50 tracking-widest">Audit Status</span>
                    {result.isLogicallyVoid ? (
                      <>
                        <ShieldAlert className="w-12 h-12 text-red-600" />
                        <span className="text-xl font-bold uppercase tracking-tighter text-red-600">Logically Void</span>
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="w-12 h-12 text-green-600" />
                        <span className="text-xl font-bold uppercase tracking-tighter text-green-600">Audit Passed</span>
                      </>
                    )}
                  </div>
                </div>

                {/* Logical Assessment Summary */}
                <section className="space-y-4">
                  <div className="flex items-center gap-2 border-b border-[#141414] pb-2">
                    <Info className="w-4 h-4" />
                    <h2 className="text-sm font-bold uppercase tracking-wider font-mono">Auditor's Assessment</h2>
                  </div>
                  <div className="p-5 border border-[#141414] bg-white/80 font-mono text-xs leading-relaxed">
                    <p>{result.logicalAssessment}</p>
                  </div>
                </section>

                {/* Red Flags */}
                <section className="space-y-4">
                  <div className="flex items-center gap-2 border-b border-[#141414] pb-2">
                    <AlertTriangle className="w-4 h-4" />
                    <h2 className="text-sm font-bold uppercase tracking-wider font-mono">Audit Report: Red Flags</h2>
                  </div>
                  <div className="space-y-3">
                    {result.redFlags.length > 0 ? (
                      result.redFlags.map((flag, i) => (
                        <motion.div 
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: i * 0.1 }}
                          key={i} 
                          className={`p-4 border border-[#141414] bg-white group hover:bg-[#141414] hover:text-[#E4E3E0] transition-all duration-300`}
                        >
                          <div className="flex items-start gap-4">
                            <div className={`mt-1 p-1 rounded-sm border border-[#141414] group-hover:border-[#E4E3E0] ${
                              flag.severity === 'high' ? 'bg-red-100 text-red-600' : 
                              flag.severity === 'medium' ? 'bg-orange-100 text-orange-600' : 
                              'bg-blue-100 text-blue-600'
                            }`}>
                              <AlertTriangle className="w-4 h-4" />
                            </div>
                            <div className="space-y-1">
                              <h4 className="font-bold uppercase tracking-tight text-sm">Flag: {flag.flag}</h4>
                              <p className="text-xs opacity-70 leading-relaxed font-mono">{flag.definition}</p>
                            </div>
                          </div>
                        </motion.div>
                      ))
                    ) : (
                      <div className="p-8 border border-dashed border-[#141414]/20 text-center">
                        <p className="text-sm opacity-50 italic">No red flags identified. The question appears logically sound.</p>
                      </div>
                    )}
                  </div>
                </section>

                {/* Re-Draft */}
                <section className="space-y-4">
                  <div className="flex items-center gap-2 border-b border-[#141414] pb-2">
                    <RefreshCw className="w-4 h-4" />
                    <h2 className="text-sm font-bold uppercase tracking-wider font-mono">Deterministic Re-Draft</h2>
                  </div>
                  <div className="p-6 border border-[#141414] bg-white relative overflow-hidden group">
                    <div className="absolute top-0 right-0 p-2 opacity-10 group-hover:opacity-20 transition-opacity">
                      <Info className="w-12 h-12" />
                    </div>
                    <p className="text-sm font-serif leading-relaxed italic relative z-10">
                      "{result.reDraft}"
                    </p>
                    <div className="mt-4 flex items-center gap-2 text-[10px] uppercase font-mono opacity-40">
                      <ArrowRight className="w-3 h-3" />
                      <span>This version removes implied context and defines all variables.</span>
                    </div>
                  </div>
                </section>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>

      {/* Footer */}
      <footer className="mt-12 border-t border-[#141414] p-8 text-center bg-[#141414] text-[#E4E3E0]">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row justify-between items-center gap-4">
          <div className="text-left">
            <h3 className="text-lg font-serif italic">Logic Sieve</h3>
            <p className="text-[10px] uppercase tracking-widest opacity-50">Precision Examination Auditing</p>
          </div>
          <div className="flex gap-8 text-[10px] uppercase tracking-widest font-mono opacity-50">
            <span>© 2026 Logic Sieve</span>
            <span>Security Verified</span>
            <span>Deterministic Engine</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
